// Authoritative game room shared by both hosting modes:
//   - server-hosted: server.js runs one GameRoom per online game
//   - player-hosted: the creator's browser runs it and peers talk to it over WebRTC / relay
// Transport-agnostic: connections are opaque keys, and io.send(conn, msg) delivers a message.
import { Chess } from 'chess.js';

export const TIME_CONTROLS = ['none', '1+0', '2+1', '3+0', '3+2', '5+0', '5+3', '10+0', '10+5', '15+10', '30+0'];
export const other = (c) => (c === 'white' ? 'black' : 'white');
const colorOf = (turn) => (turn === 'w' ? 'white' : 'black');
const MAX_CHAT = 60;

export function parseTc(tc) {
  if (!TIME_CONTROLS.includes(tc) || tc === 'none') return null;
  const [m, inc] = tc.split('+').map(Number);
  return { initial: m * 60000, increment: inc * 1000, label: tc };
}

export const cleanName = (s) =>
  String(s || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 20) || 'Guest';

// Can `color` still deliver mate with its material? (a flag against a lone king/minor is a draw)
export function canMate(chess, color) {
  let minors = 0;
  for (const row of chess.board())
    for (const sq of row) {
      if (!sq || sq.color !== color[0] || sq.type === 'k') continue;
      if ('pqr'.includes(sq.type)) return true;
      minors++;
    }
  return minors >= 2;
}

export function gameEndReason(chess) {
  if (chess.isCheckmate()) return { winner: other(colorOf(chess.turn())), reason: 'checkmate' };
  if (chess.isStalemate()) return { winner: null, reason: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { winner: null, reason: 'insufficient material' };
  if (chess.isThreefoldRepetition()) return { winner: null, reason: 'threefold repetition' };
  if (chess.isDrawByFiftyMoves()) return { winner: null, reason: '50-move rule' };
  return null;
}

export class GameRoom {
  /**
   * @param {object} o
   * @param {string} o.id           room id (shown in links)
   * @param {string} o.tc           time control label, e.g. '5+0' or 'none'
   * @param {{send(conn:any,msg:object):void}} o.io
   * @param {() => string} o.randomToken  unguessable seat token generator
   * @param {() => number} [o.now]
   */
  constructor({ id, tc, io, randomToken, now = () => Date.now() }) {
    this.id = id;
    this.tc = parseTc(tc);
    this.io = io;
    this.randomToken = randomToken;
    this.now = now;
    this.seats = { white: null, black: null }; // {token, name}
    this.conns = new Map(); // conn -> seat color | null (spectator)
    this.chat = [];
    this.chatId = 0;
    this.gameNo = 0;
    this.seq = 0;
    this.timer = null;
    this.lastActive = now();
    this.newGame();
  }

  newGame() {
    this.gameNo++;
    this.chess = new Chess();
    this.moves = []; // {from,to,promotion,san}
    this.status = this.seats.white && this.seats.black ? 'playing' : 'waiting';
    this.result = null;
    this.drawOffer = null;
    this.rematchOffer = null;
    this.clock = this.tc ? { white: this.tc.initial, black: this.tc.initial, since: null } : null;
    clearTimeout(this.timer);
  }

  // ------------------------------------------------------------ connections & seats
  claimSeat(conn, color, name) {
    this.seats[color] = { token: this.randomToken(), name: cleanName(name) };
    this.attach(conn, color);
    return color;
  }

  /** Join with an optional seat token. Returns the seat (or null = spectator). Caller broadcasts. */
  join(conn, { token, name, spectate } = {}) {
    let seat = this.seatOf(token);
    if (seat) {
      if (name) this.seats[seat].name = cleanName(name);
    } else if (!spectate) {
      const free = ['white', 'black'].find((c) => !this.seats[c]);
      if (free) {
        this.seats[free] = { token: this.randomToken(), name: cleanName(name) };
        seat = free;
        if (this.status === 'waiting') this.status = 'playing';
      }
    }
    this.attach(conn, seat || null);
    return seat || null;
  }

  attach(conn, seat) {
    this.conns.set(conn, seat);
    this.io.send(conn, { t: 'chat', entries: this.chat, reset: true });
  }

  /** Returns true if the connection was known. Caller broadcasts. */
  detach(conn) {
    return this.conns.delete(conn);
  }

  seatOf(token) {
    if (!token) return null;
    for (const c of ['white', 'black']) if (this.seats[c]?.token === token) return c;
    return null;
  }

  onlineSeats() {
    const set = new Set();
    for (const seat of this.conns.values()) if (seat) set.add(seat);
    return set;
  }

  // ------------------------------------------------------------ clocks
  // Clocks start once each side has made one move.
  clockRunning() {
    return this.clock && this.status === 'playing' && this.moves.length >= 2 ? colorOf(this.chess.turn()) : null;
  }

  remaining(color) {
    if (!this.clock) return null;
    let t = this.clock[color];
    if (this.clock.since && this.clockRunning() === color) t -= this.now() - this.clock.since;
    return Math.max(0, t);
  }

  scheduleFlag() {
    clearTimeout(this.timer);
    const running = this.clockRunning();
    if (!running || !this.clock.since) return;
    this.timer = setTimeout(() => this.checkFlag(), this.remaining(running) + 50);
    this.timer?.unref?.(); // Node: don't keep a process alive just for a flag timer
  }

  checkFlag() {
    const running = this.clockRunning();
    if (!running || !this.clock.since) return;
    if (this.remaining(running) > 0) return this.scheduleFlag();
    this.clock[running] = 0;
    this.clock.since = null;
    const winner = other(running);
    const ok = canMate(this.chess, winner);
    this.finish(ok ? winner : null, ok ? 'timeout' : 'timeout vs insufficient material');
    this.broadcast();
  }

  /** Don't charge `color`'s running clock for `ms` (e.g. the host's tab was frozen). */
  forgive(ms, color) {
    if (this.clock?.since && this.clockRunning() === color) {
      this.clock.since += ms;
      this.scheduleFlag();
    }
  }

  finish(winner, reason) {
    const c = this.clockRunning();
    if (c) this.clock[c] = this.remaining(c);
    if (this.clock) this.clock.since = null;
    this.status = 'over';
    this.result = { winner, reason };
    this.drawOffer = null;
    clearTimeout(this.timer);
  }

  // ------------------------------------------------------------ messages
  handle(conn, msg) {
    if (!this.conns.has(conn) || !msg || typeof msg.t !== 'string') return;
    const seat = this.conns.get(conn);
    this.lastActive = this.now();
    switch (msg.t) {
      case 'move':
        return this.move(conn, seat, msg);
      case 'resign':
        if (seat && this.status === 'playing') {
          if (this.moves.length < 2) this.finish(null, 'aborted');
          else this.finish(other(seat), 'resignation');
          this.broadcast();
        }
        return;
      case 'draw':
        if (!seat || this.status !== 'playing' || this.moves.length < 2) return;
        if (this.drawOffer === other(seat)) this.finish(null, 'agreement');
        else this.drawOffer = seat;
        this.broadcast();
        return;
      case 'declineDraw':
        if (seat && this.drawOffer === other(seat)) {
          this.drawOffer = null;
          this.broadcast();
        }
        return;
      case 'flag':
        this.checkFlag();
        return;
      case 'rematch':
        if (!seat || this.status !== 'over') return;
        if (this.rematchOffer === other(seat)) {
          [this.seats.white, this.seats.black] = [this.seats.black, this.seats.white];
          for (const [c, s] of this.conns) if (s) this.conns.set(c, other(s));
          this.newGame();
        } else this.rematchOffer = seat;
        this.broadcast();
        return;
      case 'chat': {
        const text = String(msg.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
        if (!text) return;
        const entry = { id: ++this.chatId, from: seat ? this.seats[seat].name : 'Spectator', color: seat, text, at: this.now() };
        this.chat.push(entry);
        if (this.chat.length > MAX_CHAT) this.chat.shift();
        for (const c of this.conns.keys()) this.io.send(c, { t: 'chat', entries: [entry] });
        return;
      }
      case 'name':
        if (seat) {
          this.seats[seat].name = cleanName(msg.name);
          this.broadcast();
        }
        return;
    }
  }

  move(conn, seat, msg) {
    const reject = () => this.io.send(conn, { ...this.stateFor(conn), rejected: true });
    if (!seat || this.status !== 'playing' || colorOf(this.chess.turn()) !== seat) return reject();
    let mv;
    try {
      mv = this.chess.move({ from: String(msg.from), to: String(msg.to), promotion: msg.promotion ? String(msg.promotion) : undefined });
    } catch {
      return reject();
    }
    const now = this.now();
    if (this.clock) {
      if (this.clock.since) {
        this.clock[seat] = Math.max(0, this.clock[seat] - (now - this.clock.since));
        if (this.clock[seat] <= 0) {
          this.chess.undo();
          this.checkFlag();
          return;
        }
      }
      if (this.moves.length >= 2) this.clock[seat] += this.tc.increment;
    }
    this.moves.push({ from: mv.from, to: mv.to, promotion: mv.promotion || null, san: mv.san });
    if (this.clock) this.clock.since = this.moves.length >= 2 ? now : null;
    if (this.drawOffer !== seat) this.drawOffer = null; // a move declines the opponent's offer
    const end = gameEndReason(this.chess);
    if (end) this.finish(end.winner, end.reason);
    else this.scheduleFlag();
    this.broadcast();
  }

  // ------------------------------------------------------------ output
  stateFor(conn) {
    const online = this.onlineSeats();
    const players = {};
    for (const c of ['white', 'black']) players[c] = this.seats[c] ? { name: this.seats[c].name, online: online.has(c) } : null;
    const you = this.conns.get(conn) || null;
    let spectators = 0;
    for (const s of this.conns.values()) if (!s) spectators++;
    return {
      t: 'state',
      seq: this.seq,
      room: this.id,
      gameNo: this.gameNo,
      you,
      token: you ? this.seats[you].token : null,
      players,
      spectators,
      moves: this.moves,
      status: this.status,
      result: this.result,
      drawOffer: this.drawOffer,
      rematchOffer: this.rematchOffer,
      tc: this.tc ? this.tc.label : 'none',
      clock: this.clock ? { white: this.remaining('white'), black: this.remaining('black'), running: this.clockRunning() } : null,
    };
  }

  broadcast() {
    this.seq++;
    this.lastActive = this.now();
    for (const conn of this.conns.keys()) this.io.send(conn, this.stateFor(conn));
  }

  destroy() {
    clearTimeout(this.timer);
    this.conns.clear();
  }

  // ------------------------------------------------------------ persistence (player-hosted resume)
  toJSON() {
    return {
      v: 1,
      id: this.id,
      tc: this.tc ? this.tc.label : 'none',
      seats: this.seats,
      moves: this.moves.map((m) => m.from + m.to + (m.promotion || '')),
      status: this.status,
      result: this.result,
      drawOffer: this.drawOffer,
      rematchOffer: this.rematchOffer,
      clock: this.clock ? { white: this.remaining('white'), black: this.remaining('black') } : null,
      gameNo: this.gameNo,
      seq: this.seq,
      chat: this.chat,
      chatId: this.chatId,
    };
  }

  /** Rebuild a room; time spent while it was saved is not charged to anyone. */
  static fromJSON(data, opts) {
    if (!data || data.v !== 1) throw new Error('unsupported saved room');
    const room = new GameRoom({ ...opts, id: data.id, tc: data.tc });
    room.seats = data.seats;
    for (const u of data.moves) {
      const mv = room.chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
      room.moves.push({ from: mv.from, to: mv.to, promotion: mv.promotion || null, san: mv.san });
    }
    Object.assign(room, {
      status: data.status,
      result: data.result,
      drawOffer: data.drawOffer,
      rematchOffer: data.rematchOffer,
      gameNo: data.gameNo,
      seq: data.seq,
      chat: data.chat || [],
      chatId: data.chatId || 0,
    });
    if (room.clock && data.clock) {
      room.clock.white = data.clock.white;
      room.clock.black = data.clock.black;
      room.clock.since = room.clockRunning() ? room.now() : null;
    }
    room.scheduleFlag();
    return room;
  }
}
