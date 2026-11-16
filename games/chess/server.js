// Chess Playground server: static files + WebSocket rooms for online play.
// Served behind Caddy at https://jgame.duckdns.org/chess_playground/ (prefix stripped).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Chess } from 'chess.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3100);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const MAX_ROOMS = 5000;
const ROOM_IDLE_MS = 24 * 3600 * 1000; // drop rooms idle this long
const EMPTY_ROOM_MS = 2 * 3600 * 1000; // drop rooms with nobody connected this long
const MAX_CHAT = 60;

// ---------------------------------------------------------------- static files
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`ok rooms=${rooms.size}\n`);
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(file);
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      // HTML must revalidate so new builds show up; versioned assets can cache.
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- rooms
/** @type {Map<string, Room>} */
const rooms = new Map();

const randomId = (n) => {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += abc[bytes[i] % abc.length];
  return s;
};
const other = (c) => (c === 'white' ? 'black' : 'white');
const colorOf = (turn) => (turn === 'w' ? 'white' : 'black');
const cleanName = (s) =>
  String(s || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 20) || 'Guest';

const TIME_CONTROLS = new Set(['none', '1+0', '2+1', '3+0', '3+2', '5+0', '5+3', '10+0', '10+5', '15+10', '30+0']);
function parseTc(tc) {
  if (!TIME_CONTROLS.has(tc) || tc === 'none') return null;
  const [m, inc] = tc.split('+').map(Number);
  return { initial: m * 60000, increment: inc * 1000, label: tc };
}

class Room {
  constructor(tc, creatorColor) {
    this.id = randomId(8);
    while (rooms.has(this.id)) this.id = randomId(8);
    this.tc = tc;
    this.seats = { white: null, black: null }; // {token, name}
    this.creatorColor = creatorColor;
    this.sockets = new Set();
    this.chat = [];
    this.gameNo = 0;
    this.lastActive = Date.now();
    this.emptySince = Date.now();
    this.timer = null;
    this.newGame();
  }

  newGame() {
    this.gameNo++;
    this.chess = new Chess();
    this.moves = []; // {from,to,promotion,san}
    this.status = this.seats.white && this.seats.black ? 'playing' : 'waiting';
    this.result = null; // {winner, reason}
    this.drawOffer = null;
    this.rematchOffer = null;
    this.clock = this.tc ? { white: this.tc.initial, black: this.tc.initial, since: null } : null;
    clearTimeout(this.timer);
  }

  // Clocks start once each side has made one move (both players are present by then).
  clockRunning() {
    return this.clock && this.status === 'playing' && this.moves.length >= 2 ? colorOf(this.chess.turn()) : null;
  }

  remaining(color) {
    if (!this.clock) return null;
    let t = this.clock[color];
    if (this.clock.since && this.clockRunning() === color) t -= Date.now() - this.clock.since;
    return Math.max(0, t);
  }

  scheduleFlag() {
    clearTimeout(this.timer);
    const running = this.clockRunning();
    if (!running) return;
    this.timer = setTimeout(() => this.checkFlag(), this.remaining(running) + 50);
  }

  checkFlag() {
    const running = this.clockRunning();
    if (!running || this.remaining(running) > 0) return this.scheduleFlag();
    this.clock[running] = 0;
    this.clock.since = null;
    const winner = other(running);
    // Flagging against a lone king (or king + one minor) is a draw.
    this.finish(canMate(this.chess, winner) ? winner : null, canMate(this.chess, winner) ? 'timeout' : 'timeout vs insufficient material');
    this.broadcast();
  }

  finish(winner, reason) {
    if (this.clock && this.clockRunning()) {
      const c = this.clockRunning();
      this.clock[c] = this.remaining(c);
    }
    if (this.clock) this.clock.since = null;
    this.status = 'over';
    this.result = { winner, reason };
    this.drawOffer = null;
    clearTimeout(this.timer);
  }

  seatOf(token) {
    if (!token) return null;
    for (const c of ['white', 'black']) if (this.seats[c]?.token === token) return c;
    return null;
  }

  connectedColors() {
    const set = new Set();
    for (const ws of this.sockets) if (ws.seat) set.add(ws.seat);
    return set;
  }

  stateFor(ws) {
    const online = this.connectedColors();
    const players = {};
    for (const c of ['white', 'black']) {
      players[c] = this.seats[c] ? { name: this.seats[c].name, online: online.has(c) } : null;
    }
    return {
      t: 'state',
      room: this.id,
      gameNo: this.gameNo,
      you: ws.seat || null,
      token: ws.seat ? this.seats[ws.seat].token : null,
      players,
      spectators: [...this.sockets].filter((s) => !s.seat).length,
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
    this.lastActive = Date.now();
    for (const ws of this.sockets) send(ws, this.stateFor(ws));
  }

  sendChat(entry) {
    this.chat.push(entry);
    if (this.chat.length > MAX_CHAT) this.chat.shift();
    for (const ws of this.sockets) send(ws, { t: 'chat', entries: [entry] });
  }
}

// Can `color` deliver mate with its remaining material (used for timeouts)?
function canMate(chess, color) {
  const c = color[0];
  let minors = 0;
  for (const row of chess.board())
    for (const sq of row) {
      if (!sq || sq.color !== c || sq.type === 'k') continue;
      if (sq.type === 'p' || sq.type === 'q' || sq.type === 'r') return true;
      minors++;
    }
  return minors >= 2;
}

function gameEndReason(chess) {
  if (chess.isCheckmate()) return { winner: colorOf(chess.turn()) === 'white' ? 'black' : 'white', reason: 'checkmate' };
  if (chess.isStalemate()) return { winner: null, reason: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { winner: null, reason: 'insufficient material' };
  if (chess.isThreefoldRepetition()) return { winner: null, reason: 'threefold repetition' };
  if (chess.isDrawByFiftyMoves()) return { winner: null, reason: '50-move rule' };
  return null;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function attach(ws, room, seat) {
  if (ws.room && ws.room !== room) detach(ws);
  ws.room = room;
  ws.seat = seat;
  room.sockets.add(ws);
  room.emptySince = null;
  send(ws, { t: 'chat', entries: room.chat, reset: true });
}

function detach(ws) {
  const room = ws.room;
  if (!room) return;
  room.sockets.delete(ws);
  ws.room = null;
  if (room.sockets.size === 0) room.emptySince = Date.now();
  room.broadcast();
}

function handle(ws, msg) {
  const room = ws.room;
  switch (msg.t) {
    case 'create': {
      if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', error: 'Server is busy, try again later.' });
      const pref = ['white', 'black', 'random'].includes(msg.color) ? msg.color : 'random';
      const color = pref === 'random' ? (crypto.randomInt(2) ? 'white' : 'black') : pref;
      const r = new Room(parseTc(msg.tc), color);
      rooms.set(r.id, r);
      r.seats[color] = { token: crypto.randomBytes(16).toString('hex'), name: cleanName(msg.name) };
      attach(ws, r, color);
      r.broadcast();
      return;
    }
    case 'join': {
      const r = rooms.get(String(msg.room || ''));
      if (!r) return send(ws, { t: 'error', error: 'This game link is invalid or has expired.', fatal: true });
      let seat = r.seatOf(msg.token);
      if (seat) {
        if (msg.name) r.seats[seat].name = cleanName(msg.name);
      } else if (!msg.spectate) {
        const free = ['white', 'black'].find((c) => !r.seats[c]);
        if (free) {
          r.seats[free] = { token: crypto.randomBytes(16).toString('hex'), name: cleanName(msg.name) };
          seat = free;
          if (r.status === 'waiting') r.status = 'playing';
        }
      }
      attach(ws, r, seat);
      r.broadcast();
      return;
    }
  }

  if (!room) return;
  const seat = ws.seat;

  switch (msg.t) {
    case 'move': {
      if (!seat || room.status !== 'playing' || colorOf(room.chess.turn()) !== seat) return send(ws, { ...room.stateFor(ws), rejected: true });
      let mv;
      try {
        mv = room.chess.move({ from: String(msg.from), to: String(msg.to), promotion: msg.promotion ? String(msg.promotion) : undefined });
      } catch {
        return send(ws, { ...room.stateFor(ws), rejected: true }); // illegal: resync this client
      }
      if (room.clock) {
        const now = Date.now();
        if (room.clock.since) {
          room.clock[seat] = Math.max(0, room.clock[seat] - (now - room.clock.since));
          if (room.clock[seat] <= 0) {
            room.chess.undo();
            room.checkFlag();
            return;
          }
        }
        if (room.moves.length >= 2) room.clock[seat] += room.tc.increment;
        room.moves.push({ from: mv.from, to: mv.to, promotion: mv.promotion || null, san: mv.san });
        room.clock.since = room.moves.length >= 2 ? now : null;
      } else {
        room.moves.push({ from: mv.from, to: mv.to, promotion: mv.promotion || null, san: mv.san });
      }
      room.drawOffer = room.drawOffer === seat ? seat : null; // a move declines an opponent's draw offer
      const end = gameEndReason(room.chess);
      if (end) room.finish(end.winner, end.reason);
      else room.scheduleFlag();
      room.broadcast();
      return;
    }
    case 'resign':
      if (seat && room.status === 'playing') {
        if (room.moves.length < 2) room.finish(null, 'aborted');
        else room.finish(other(seat), 'resignation');
        room.broadcast();
      }
      return;
    case 'draw':
      if (!seat || room.status !== 'playing' || room.moves.length < 2) return;
      if (room.drawOffer === other(seat)) room.finish(null, 'agreement');
      else room.drawOffer = seat;
      room.broadcast();
      return;
    case 'declineDraw':
      if (seat && room.drawOffer === other(seat)) {
        room.drawOffer = null;
        room.broadcast();
      }
      return;
    case 'flag':
      room.checkFlag();
      return;
    case 'rematch':
      if (!seat || room.status !== 'over') return;
      if (room.rematchOffer === other(seat)) {
        [room.seats.white, room.seats.black] = [room.seats.black, room.seats.white];
        for (const s of room.sockets) if (s.seat) s.seat = other(s.seat);
        room.newGame();
      } else room.rematchOffer = seat;
      room.broadcast();
      return;
    case 'chat': {
      const text = String(msg.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
      if (!text) return;
      const now = Date.now();
      ws.chatTimes = (ws.chatTimes || []).filter((t) => now - t < 10000);
      if (ws.chatTimes.length >= 5) return;
      ws.chatTimes.push(now);
      room.sendChat({ from: seat ? room.seats[seat].name : 'Spectator', color: seat, text, at: now });
      return;
    }
    case 'name':
      if (seat) {
        room.seats[seat].name = cleanName(msg.name);
        room.broadcast();
      }
      return;
    case 'leave':
      detach(ws);
      return;
  }
}

// ---------------------------------------------------------------- wiring
const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.msgTimes = [];
  ws.on('pong', () => (ws.alive = true));
  ws.on('message', (data) => {
    const now = Date.now();
    ws.msgTimes = ws.msgTimes.filter((t) => now - t < 1000);
    if (ws.msgTimes.length > 20) return; // crude flood protection
    ws.msgTimes.push(now);
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg && typeof msg.t === 'string') {
      if (msg.t === 'ping') return send(ws, { t: 'pong' });
      handle(ws, msg);
    }
  });
  ws.on('close', () => detach(ws));
});

// Heartbeat drops dead connections; sweep removes stale rooms.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (now - r.lastActive > ROOM_IDLE_MS || (r.emptySince && now - r.emptySince > EMPTY_ROOM_MS)) {
      clearTimeout(r.timer);
      rooms.delete(id);
    }
  }
}, 30000).unref();

server.listen(PORT, HOST, () => console.log(`chess playground on http://${HOST}:${server.address().port}`));
