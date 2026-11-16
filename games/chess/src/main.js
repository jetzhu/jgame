import { Chessground } from 'chessground';
import { Chess } from 'chess.js';
import { Engine } from './engine.js';
import { sound } from './sound.js';
import { Net } from './net.js';
import { GameRoom } from './room-core.js';
import { DirectLink, webrtcSupported } from './p2p.js';

// ------------------------------------------------------------------ constants
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ROLE = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };

// Bot levels: Stockfish "Skill Level" + search limit, plus a chance of a random move at the bottom end.
const LEVELS = [
  { name: 'Beginner', skill: 0, depth: 1, random: 0.55, delay: 700 },
  { name: 'Novice', skill: 0, depth: 1, random: 0.3, delay: 700 },
  { name: 'Casual', skill: 1, depth: 2, random: 0.15, delay: 650 },
  { name: 'Intermediate', skill: 3, depth: 3, random: 0.06, delay: 600 },
  { name: 'Club player', skill: 6, depth: 5, random: 0, delay: 600 },
  { name: 'Strong club', skill: 9, depth: 7, delay: 500 },
  { name: 'Advanced', skill: 12, depth: 9, delay: 450 },
  { name: 'Expert', skill: 15, depth: 11, delay: 400 },
  { name: 'Master', skill: 18, movetime: 800, delay: 200 },
  { name: 'Maximum', skill: 20, movetime: 1500, delay: 0 },
];

const TIME_CONTROLS = [
  ['none', 'No clock'],
  ['1+0', '1 min'],
  ['3+0', '3 min'],
  ['3+2', '3 | 2'],
  ['5+0', '5 min'],
  ['10+0', '10 min'],
  ['15+10', '15 | 10'],
  ['30+0', '30 min'],
];

// Board palettes; colors live in style.css under [data-board="..."].
const THEMES = [
  ['green', 'Green', '#ebecd0', '#739552'],
  ['walnut', 'Walnut', '#f0d9b5', '#b58863'],
  ['ocean', 'Ocean', '#dee3e6', '#8ca2ad'],
  ['slate', 'Slate', '#d9dde3', '#6f7a8a'],
  ['amethyst', 'Amethyst', '#ece4f3', '#9278b4'],
  ['coral', 'Coral', '#f6e8d8', '#cd8566'],
  ['mint', 'Mint', '#e8f1e6', '#5f9e8f'],
  ['night', 'Night', '#9fa6ad', '#4b5563'],
];

const REASON = {
  checkmate: 'by checkmate',
  resignation: 'by resignation',
  timeout: 'on time',
  agreement: 'by agreement',
  stalemate: 'by stalemate',
  'insufficient material': 'by insufficient material',
  'threefold repetition': 'by repetition',
  '50-move rule': 'by the 50-move rule',
  'timeout vs insufficient material': 'timeout vs insufficient material',
  aborted: '',
};

// ------------------------------------------------------------------ helpers
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const opp = (c) => (c === 'white' ? 'black' : 'white');
const colorName = (c) => (c === 'w' ? 'white' : 'black');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uci = (m) => m.from + m.to + (m.promotion || '');
const parseUci = (s) => ({ from: s.slice(0, 2), to: s.slice(2, 4), promotion: s[4] || undefined });
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const incOf = (tc) => (tc && tc !== 'none' ? Number(tc.split('+')[1]) * 1000 : 0);

const store = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
  return e;
}

function myName() {
  let n = store.get('cp.name');
  if (!n) {
    n = 'Guest' + Math.floor(1000 + Math.random() * 9000);
    store.set('cp.name', n);
  }
  return n;
}

// ------------------------------------------------------------------ state
const S = {
  mode: null, // null (menu) | 'bot' | 'local' | 'online'
  chess: new Chess(),
  fens: [START_FEN],
  viewPly: null, // null = live position
  orientation: 'white',
  over: null, // {winner: 'white'|'black'|null, reason}
  gen: 0, // bumps on new game / takeback to invalidate pending bot work
  tc: 'none',
  clock: null, // {white, black, running: color|null, since: ms, inc: ms}
  bot: { color: 'black', level: 4, thinking: false },
  local: { autoFlip: false },
  online: null, // {room, you, players, status, drawOffer, rematchOffer, spectators, gameNo, pending, create}
  netStatus: 'closed',
  overShown: null,
};

let engine = null;
const getEngine = () => (engine ||= new Engine('vendor/stockfish-19-lite-single.js'));

const hist = () => S.chess.history({ verbose: true });
const turn = () => colorName(S.chess.turn());

// ------------------------------------------------------------------ board
const cg = Chessground($('#board'), {
  fen: START_FEN,
  orientation: 'white',
  coordinates: true,
  ranksPosition: 'left',
  animation: { enabled: true, duration: 180 },
  highlight: { lastMove: true, check: true },
  movable: { free: false, color: undefined, dests: new Map(), showDests: true, events: { after: onUserMove } },
  premovable: { enabled: true, showDests: true, castle: true },
  draggable: { enabled: true, showGhost: true },
  drawable: { enabled: true, visible: true },
});
new ResizeObserver(() => cg.redrawAll()).observe($('#board'));

function legalDests() {
  const d = new Map();
  for (const m of S.chess.moves({ verbose: true })) {
    if (!d.has(m.from)) d.set(m.from, []);
    d.get(m.from).push(m.to);
  }
  return d;
}

// Which color the person at this screen may move (or premove) right now.
function controlColor() {
  if (S.over || !S.mode) return undefined;
  if (S.mode === 'bot') return opp(S.bot.color);
  if (S.mode === 'local') return turn();
  if (S.mode === 'online') return S.online?.status === 'playing' && S.online.you ? S.online.you : undefined;
}

function syncBoard() {
  const h = hist();
  const ply = S.viewPly ?? h.length;
  const live = ply === h.length;
  const pos = live ? S.chess : new Chess(S.fens[ply]);
  const last = h[ply - 1];
  const color = live ? controlColor() : undefined;
  if (!live || !color) cg.cancelPremove();
  cg.setAutoShapes([]);
  cg.set({
    fen: S.fens[ply],
    orientation: S.orientation,
    turnColor: colorName(pos.turn()),
    lastMove: last ? [last.from, last.to] : undefined,
    check: pos.inCheck(),
    movable: { color, dests: color && color === turn() ? legalDests() : new Map() },
    premovable: { enabled: S.mode === 'bot' || S.mode === 'online' },
  });
}

function onUserMove(orig, dest, meta) {
  const piece = S.chess.get(orig);
  if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
    if (meta?.premove) return userMove(orig, dest, 'q');
    askPromotion(dest, colorName(piece.color)).then((p) => (p ? userMove(orig, dest, p) : syncBoard()));
  } else userMove(orig, dest);
}

function askPromotion(dest, color) {
  return new Promise((resolve) => {
    const box = $('#promo');
    const file = dest.charCodeAt(0) - 97;
    const col = S.orientation === 'white' ? file : 7 - file;
    const fromTop = (dest[1] === '8') === (S.orientation === 'white');
    box.innerHTML = '';
    const list = h('div', { class: 'promo-list', style: `left:${col * 12.5}%;${fromTop ? 'top:0' : 'bottom:0;flex-direction:column-reverse'}` });
    for (const r of ['q', 'n', 'r', 'b']) {
      list.append(
        h('button', {
          class: `promo-btn`,
          'aria-label': ROLE[r],
          onclick: (e) => {
            e.stopPropagation();
            done(r);
          },
        }, h('span', { class: `pc ${ROLE[r]} ${color}` })),
      );
    }
    box.append(list);
    box.hidden = false;
    const done = (r) => {
      box.hidden = true;
      box.onclick = null;
      resolve(r);
    };
    box.onclick = () => done(null);
  });
}

// ------------------------------------------------------------------ moves & game flow
function playSound(m) {
  if (S.chess.inCheck()) sound.check();
  else if (m.captured) sound.capture();
  else if (m.flags.includes('k') || m.flags.includes('q')) sound.castle();
  else sound.move();
}

function applyMove(mv, { silent = false } = {}) {
  let m;
  try {
    m = S.chess.move(mv);
  } catch {
    return null;
  }
  S.fens.push(S.chess.fen());
  S.viewPly = null;
  clockAfterMove(colorName(m.color));
  if (!silent) playSound(m);
  return m;
}

function resetTo(uciMoves) {
  S.chess = new Chess();
  S.fens = [START_FEN];
  S.viewPly = null;
  for (const u of uciMoves) {
    const m = S.chess.move(parseUci(u));
    S.fens.push(S.chess.fen());
    if (!m) break;
  }
}

function endState(chess) {
  if (chess.isCheckmate()) return { winner: opp(colorName(chess.turn())), reason: 'checkmate' };
  if (chess.isStalemate()) return { winner: null, reason: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { winner: null, reason: 'insufficient material' };
  if (chess.isThreefoldRepetition()) return { winner: null, reason: 'threefold repetition' };
  if (chess.isDrawByFiftyMoves()) return { winner: null, reason: '50-move rule' };
  return null;
}

function canMate(chess, color) {
  let minors = 0;
  for (const row of chess.board())
    for (const sq of row) {
      if (!sq || sq.color !== color[0] || sq.type === 'k') continue;
      if ('pqr'.includes(sq.type)) return true;
      minors++;
    }
  return minors >= 2;
}

function userMove(from, to, promotion) {
  sound.unlock();
  const m = applyMove({ from, to, promotion });
  if (!m) return syncBoard();
  if (S.mode === 'online') {
    Object.assign(S.online, { pending: uci(m), pendingMove: { from, to, promotion }, pendingAt: Date.now() });
    sendGame({ t: 'move', from, to, promotion });
  }
  afterMove();
}

function afterMove() {
  if (S.mode !== 'online') {
    const end = endState(S.chess);
    if (end) return finish(end);
  }
  if (S.mode === 'local' && S.local.autoFlip) S.orientation = turn();
  syncBoard();
  render();
  save();
  if (S.mode === 'bot') maybeBotMove();
  else if (S.mode === 'online' && turn() === S.online?.you) cg.playPremove();
}

function finish(result, { silent = false } = {}) {
  S.over = result;
  stopClock();
  if (S.mode === 'bot') {
    S.gen++;
    engine?.stop();
    S.bot.thinking = false;
  }
  if (!silent) sound.end();
  syncBoard();
  render();
  save();
  showResult();
}

function newGameState() {
  S.gen++;
  engine?.stop();
  S.bot.thinking = false;
  S.chess = new Chess();
  S.fens = [START_FEN];
  S.viewPly = null;
  S.over = null;
  cg.cancelPremove();
}

// ------------------------------------------------------------------ clock
function remaining(color) {
  const c = S.clock;
  if (!c) return null;
  const t = c[color] - (c.running === color ? Date.now() - c.since : 0);
  return Math.max(0, t);
}

function clockAfterMove(color) {
  const c = S.clock;
  if (!c) return;
  const now = Date.now();
  if (c.running === color) c[color] = Math.max(0, c[color] - (now - c.since)) + c.inc;
  c.running = !S.over && S.chess.history().length >= 2 ? turn() : null;
  c.since = now;
}

function stopClock() {
  const c = S.clock;
  if (!c || !c.running) return;
  c[c.running] = remaining(c.running);
  c.running = null;
}

function fmtClock(ms) {
  if (ms == null) return '';
  if (ms < 20000) {
    const s = Math.floor(ms / 1000);
    return `0:${String(s).padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}`;
  }
  const total = Math.ceil(ms / 1000);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

let lowTimeWarned = {};
let flagSentAt = 0;
setInterval(() => {
  if (!S.clock) return;
  renderClocks();
  const r = S.clock.running;
  if (!r || S.over) return;
  const left = remaining(r);
  const mine = S.mode === 'local' || (S.mode === 'online' && S.online?.you === r);
  if (mine && left < 10000 && !lowTimeWarned[r]) {
    lowTimeWarned[r] = true;
    sound.lowTime();
  }
  if (left > 0) return;
  if (S.mode === 'local') {
    S.clock[r] = 0;
    const winner = opp(r);
    const ok = canMate(S.chess, winner);
    finish({ winner: ok ? winner : null, reason: ok ? 'timeout' : 'timeout vs insufficient material' });
  } else if (S.mode === 'online' && Date.now() - flagSentAt > 1000) {
    flagSentAt = Date.now();
    sendGame({ t: 'flag' });
  }
}, 100);

// ------------------------------------------------------------------ bot
function greedyMove(legal) {
  // Fallback when the engine is unavailable: prefer the most valuable capture.
  const best = Math.max(...legal.map((m) => (m.captured ? VALUE[m.captured] : 0)));
  return pick(legal.filter((m) => (m.captured ? VALUE[m.captured] : 0) === best));
}

let engineWarned = false;
async function maybeBotMove() {
  if (S.mode !== 'bot' || S.over || turn() !== S.bot.color || S.bot.thinking) return;
  const gen = S.gen;
  const ply = S.chess.history().length;
  S.bot.thinking = true;
  render();
  const lvl = LEVELS[S.bot.level - 1];
  const t0 = Date.now();
  const legal = S.chess.moves({ verbose: true });
  let mv = null;
  if (Math.random() < (lvl.random || 0)) mv = pick(legal);
  else {
    try {
      const r = await getEngine().search(S.chess.fen(), lvl);
      if (r.move) mv = parseUci(r.move);
    } catch {
      if (!engineWarned) {
        engineWarned = true;
        toast('Chess engine failed to load; using a simple bot instead.');
      }
    }
  }
  const wait = (lvl.delay ?? 500) - (Date.now() - t0);
  if (wait > 0) await sleep(wait);
  if (gen !== S.gen || ply !== S.chess.history().length) return;
  S.bot.thinking = false;
  if (!mv || !applyMove(mv)) {
    mv = greedyMove(legal);
    applyMove(mv);
  }
  afterMove();
  if (!S.over) cg.playPremove();
}

async function hint() {
  if (S.mode !== 'bot' || S.over || turn() === S.bot.color) return;
  const gen = S.gen;
  const ply = S.chess.history().length;
  toast('Looking for a good move…', 1200);
  try {
    const r = await getEngine().search(S.chess.fen(), { skill: 20, depth: 14 });
    if (gen !== S.gen || ply !== S.chess.history().length || !r.move) return;
    const m = parseUci(r.move);
    cg.setAutoShapes([{ orig: m.from, dest: m.to, brush: 'green' }]);
  } catch {
    toast('Engine unavailable.');
  }
}

// ------------------------------------------------------------------ actions
function undoOne() {
  S.chess.undo();
  S.fens.pop();
}

function takeback() {
  if (S.mode === 'bot') {
    const user = opp(S.bot.color);
    const h = hist();
    let idx = -1;
    for (let i = h.length - 1; i >= 0; i--)
      if (colorName(h[i].color) === user) {
        idx = i;
        break;
      }
    if (idx < 0) return;
    S.gen++;
    engine?.stop();
    S.bot.thinking = false;
    while (S.chess.history().length > idx) undoOne();
  } else if (S.mode === 'local') {
    if (!S.chess.history().length) return;
    undoOne();
    if (S.local.autoFlip) S.orientation = turn();
  } else return;
  S.over = null;
  S.viewPly = null;
  if (S.clock) {
    stopClock();
    S.clock.running = S.chess.history().length >= 2 ? turn() : null;
    S.clock.since = Date.now();
  }
  cg.cancelPremove();
  syncBoard();
  render();
  save();
  maybeBotMove();
}

function resign() {
  if (S.over) return;
  if (S.mode === 'online') {
    const abort = S.chess.history().length < 2;
    confirmBox(abort ? 'Abort this game?' : 'Resign this game?', abort ? 'Abort' : 'Resign', () => sendGame({ t: 'resign' }));
    return;
  }
  const loser = S.mode === 'bot' ? opp(S.bot.color) : turn();
  confirmBox(S.mode === 'local' ? `${cap(loser)} resigns?` : 'Resign this game?', 'Resign', () =>
    finish({ winner: opp(loser), reason: 'resignation' }),
  );
}

function offerDraw() {
  if (S.over) return;
  if (S.mode === 'local') confirmBox('Both players agree to a draw?', 'Agree draw', () => finish({ winner: null, reason: 'agreement' }));
  else if (S.mode === 'online') {
    sendGame({ t: 'draw' });
    if (S.online.drawOffer !== opp(S.online.you)) toast('Draw offer sent.');
  }
}

function flip() {
  S.orientation = opp(S.orientation);
  syncBoard();
  renderPlayers();
  save();
}

function goto(ply) {
  const n = S.chess.history().length;
  ply = Math.max(0, Math.min(n, ply));
  S.viewPly = ply === n ? null : ply;
  syncBoard();
  renderMoves();
  renderPlayers();
}

function pgn() {
  const c = new Chess();
  const names = { white: barName('white'), black: barName('black') };
  c.setHeader('Event', S.mode === 'online' ? 'Online casual game' : S.mode === 'bot' ? 'Game vs computer' : 'Pass & play');
  c.setHeader('Site', location.host || 'Chess Playground');
  c.setHeader('Date', new Date().toISOString().slice(0, 10).replaceAll('-', '.'));
  c.setHeader('White', names.white);
  c.setHeader('Black', names.black);
  for (const m of hist()) c.move(m.san);
  const res = S.over ? (S.over.winner === 'white' ? '1-0' : S.over.winner === 'black' ? '0-1' : S.over.reason === 'aborted' ? '*' : '1/2-1/2') : '*';
  c.setHeader('Result', res);
  if (S.tc !== 'none') c.setHeader('TimeControl', S.tc.replace(/^(\d+)\+/, (_, m) => `${m * 60}+`));
  return c.pgn() + (S.chess.history().length ? ` ${res}` : res);
}

async function copyText(text, msg = 'Copied!') {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(msg);
    } catch {
      toast('Copy failed — select and copy manually.');
    }
    ta.remove();
  }
}

// ------------------------------------------------------------------ persistence (bot & local)
function save() {
  if (S.mode !== 'bot' && S.mode !== 'local') return;
  store.set('cp.saved', {
    mode: S.mode,
    moves: hist().map(uci),
    bot: { color: S.bot.color, level: S.bot.level },
    local: S.local,
    tc: S.tc,
    clock: S.clock ? { white: remaining('white'), black: remaining('black'), inc: S.clock.inc } : null,
    orientation: S.orientation,
    over: S.over,
    at: Date.now(),
  });
}

function resume(saved) {
  S.mode = saved.mode;
  newGameState();
  S.bot = { ...S.bot, ...saved.bot, thinking: false };
  S.local = saved.local || { autoFlip: false };
  S.tc = saved.tc || 'none';
  S.orientation = saved.orientation || 'white';
  resetTo(saved.moves || []);
  S.over = saved.over || null;
  S.clock = saved.clock ? { ...saved.clock, since: Date.now(), running: null } : null;
  if (S.clock && !S.over && S.chess.history().length >= 2) S.clock.running = turn();
  if (S.mode === 'bot') getEngine().newGame();
  enterGame();
  maybeBotMove();
}

// ------------------------------------------------------------------ starting games
function startBot({ level, color }) {
  const user = color === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : color;
  S.mode = 'bot';
  newGameState();
  S.bot = { color: opp(user), level, thinking: false, pref: color };
  S.orientation = user;
  S.tc = 'none';
  S.clock = null;
  getEngine().newGame();
  enterGame();
  sound.start();
  save();
  maybeBotMove();
}

function startLocal({ tc, autoFlip }) {
  S.mode = 'local';
  newGameState();
  S.local = { autoFlip };
  S.orientation = 'white';
  S.tc = tc;
  S.clock = tc === 'none' ? null : { white: Number(tc.split('+')[0]) * 60000, black: Number(tc.split('+')[0]) * 60000, running: null, since: Date.now(), inc: incOf(tc) };
  lowTimeWarned = {};
  enterGame();
  sound.start();
  save();
}

// ------------------------------------------------------------------ online
// S.online.kind:
//   'server' : server-hosted game (the server runs the GameRoom)
//   'host'   : player-hosted game run by THIS browser (GameRoom lives in hostCtx)
//   'guest'  : joined a player-hosted game; talks to the host directly (WebRTC) or via the server relay
// The UI consumes 'state'/'chat' messages (onGameMsg) and sends game actions with sendGame().
let net = null;
let hostCtx = null; // {room, secret, links: Map<peerId, DirectLink>, serverPeers: Set, tick, lastTick, lastPeerMsgAt}
let guestLink = null; // DirectLink to the host

const hostingPref = () => (store.get('cp.hosting', 'player') === 'server' ? 'server' : 'player');
const relayOnly = () => store.get('cp.relayOnly', false) === true;
const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
function randomId(n) {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => abc[b % abc.length]).join('');
}

async function fetchHostingStatus() {
  try {
    const r = await fetch('status', { cache: 'no-store' });
    return (await r.json()).serverHosting;
  } catch {
    return { available: false, reason: 'Could not reach the server.' };
  }
}

function tokens() {
  return store.get('cp.tokens', {});
}
function saveToken(room, token) {
  const t = tokens();
  if (t[room] === token) return;
  t[room] = token;
  const keys = Object.keys(t);
  if (keys.length > 30) delete t[keys[0]];
  store.set('cp.tokens', t);
}

function ensureNet() {
  if (net) return net;
  net = new Net(onNet, (st) => {
    S.netStatus = st;
    if (S.mode === 'online') render();
  });
  net.onOpen = () => {
    const O = S.online;
    if (!O) return;
    if (O.kind === 'host') net.send({ t: 'host', room: O.room, secret: hostCtx.secret });
    else if (O.kind === 'server' && O.create) net.send({ t: 'create', ...O.create, name: myName() });
    else net.send({ t: 'join', room: O.room, token: tokens()[O.room], name: myName(), spectate: O.spectate });
  };
  net.connect();
  return net;
}
const connectNet = () => (net?.isOpen ? net.onOpen() : ensureNet());

function setUrlRoom(room) {
  const url = room ? `${location.pathname}?room=${room}` : location.pathname;
  if (location.pathname + location.search !== url) history.replaceState(null, '', url);
}

function inviteLink() {
  return `${location.origin}${location.pathname}?room=${S.online?.room}`;
}

function resetOnlineUi() {
  S.mode = 'online';
  newGameState();
  S.clock = null;
  chatSeen.clear();
  $('#chat-log').innerHTML = '';
}

async function createOnline({ tc, color }) {
  let kind = hostingPref() === 'server' ? 'server' : 'host';
  if (kind === 'server') {
    const st = await fetchHostingStatus();
    if (!st.available) {
      kind = 'host';
      toast(`${st.reason} Hosting this game in your browser instead.`, 3500);
    }
  }
  resetOnlineUi();
  S.tc = tc;
  if (kind === 'host') return startHosting({ tc, color });
  S.online = { kind: 'server', create: { tc, color }, room: null, you: null, players: {}, status: 'connecting', gameNo: 0 };
  S.orientation = color === 'black' ? 'black' : 'white';
  enterGame();
  connectNet();
}

function joinOnline(room, spectate = false) {
  resetOnlineUi();
  S.online = { kind: null, room, you: null, players: {}, status: 'connecting', gameNo: 0, spectate };
  enterGame();
  connectNet();
}

function leaveOnline() {
  guestLink?.close();
  guestLink = null;
  if (S.online?.kind === 'host') stopHosting(true);
  if (net) {
    net.send({ t: 'leave' });
    net.close();
    net = null;
  }
  S.online = null;
  setUrlRoom(null);
}

/** Send a game action (move, resign, chat…) to whoever runs the game. */
function sendGame(msg) {
  const O = S.online;
  if (!O) return false;
  if (O.kind === 'host') {
    hostCtx?.room.handle('local', msg);
    return true;
  }
  if (O.kind === 'guest') return guestLink?.send(msg) || !!net?.send({ t: 'fwd', to: 'host', data: msg });
  return !!net?.send(msg);
}

// ---------------------------------------------------------- hosting (this browser runs the game)
function startHosting({ tc, color }, saved = null) {
  stopHosting(false);
  const opts = { io: { send: hostSend }, randomToken: () => randomHex(16) };
  let room;
  try {
    room = saved ? GameRoom.fromJSON(saved.room, opts) : new GameRoom({ id: randomId(8), tc, ...opts });
  } catch {
    if (saved) store.del(`cp.host.${saved.room?.id}`);
    toast('Could not restore that game.');
    return showMenu();
  }
  hostCtx = { room, secret: saved?.secret || randomHex(16), links: new Map(), serverPeers: new Set(), lastTick: Date.now(), lastPeerMsgAt: 0 };
  hostCtx.tick = setInterval(hostTick, 1000);
  S.online = { kind: 'host', room: room.id, you: null, players: {}, status: 'connecting', gameNo: 0, registered: false };
  if (saved) room.attach('local', saved.hostSeat || null);
  else room.claimSeat('local', color === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : color, myName());
  enterGame();
  room.broadcast(); // local state right away; peers arrive once the server knows us
  connectNet();
}

function stopHosting(closeRoom) {
  if (!hostCtx) return;
  clearInterval(hostCtx.tick);
  for (const l of hostCtx.links.values()) l.close();
  if (closeRoom) {
    net?.send({ t: 'close' });
    store.del(`cp.host.${hostCtx.room.id}`);
  }
  hostCtx.room.destroy();
  hostCtx = null;
}

function saveHosted() {
  if (!hostCtx) return;
  const { room, secret } = hostCtx;
  store.set(`cp.host.${room.id}`, { secret, room: room.toJSON(), hostSeat: room.conns.get('local') || null, savedAt: Date.now() });
}

function hostSend(conn, msg) {
  if (!hostCtx) return;
  if (conn === 'local') {
    if (msg.t === 'state') saveHosted();
    queueMicrotask(() => onGameMsg(msg));
    return;
  }
  const out = msg.t === 'state' ? { ...msg, direct: !relayOnly() && webrtcSupported() } : msg;
  if (!hostCtx.links.get(conn)?.send(out)) net?.send({ t: 'fwd', to: conn, data: out });
}

function hostReceive(from, data) {
  if (!hostCtx || !data) return;
  hostCtx.lastPeerMsgAt = Date.now();
  if (data.t === 'signal') return hostSignal(from, data);
  hostCtx.room.handle(from, data);
}

function hostSignal(from, data) {
  if (relayOnly() || !webrtcSupported()) return;
  let link = hostCtx.links.get(from);
  if (data.sdp?.type === 'offer') {
    link?.close();
    link = new DirectLink({
      role: 'answer',
      sendSignal: (s) => net?.send({ t: 'fwd', to: from, data: { t: 'signal', ...s } }),
      onMessage: (m) => hostReceive(from, m),
      onState: (st) => {
        if (!hostCtx || hostCtx.links.get(from) !== link) return;
        if (st === 'closed') {
          hostCtx.links.delete(from);
          if (!hostCtx.serverPeers.has(from)) dropPeer(from);
        }
        render();
      },
    });
    hostCtx.links.set(from, link);
  }
  link?.signal(data);
}

function dropPeer(peerId) {
  hostCtx.links.get(peerId)?.close();
  hostCtx.links.delete(peerId);
  if (hostCtx.room.detach(peerId)) hostCtx.room.broadcast();
}

// If this tab was frozen (phone screen off, tab suspended) during the opponent's turn,
// their clock kept running in our room even though their moves couldn't reach us: refund it.
function hostTick() {
  const now = Date.now();
  const gap = now - hostCtx.lastTick;
  const quiet = hostCtx.lastPeerMsgAt < hostCtx.lastTick;
  hostCtx.lastTick = now;
  if (gap > 4000 && quiet) {
    const me = hostCtx.room.conns.get('local');
    if (me) {
      hostCtx.room.forgive(gap - 1000, opp(me));
      hostCtx.room.broadcast();
    }
  }
}

function hostOnNet(msg) {
  const room = hostCtx?.room;
  if (!room) return;
  switch (msg.t) {
    case 'hosting':
      S.online.registered = true;
      render();
      return;
    case 'peer-join':
      hostCtx.serverPeers.add(msg.peerId);
      room.join(msg.peerId, msg.data || {});
      room.broadcast();
      return;
    case 'peer-left':
      hostCtx.serverPeers.delete(msg.peerId);
      if (!hostCtx.links.get(msg.peerId)?.isOpen) dropPeer(msg.peerId);
      return;
    case 'fwd':
      if (room.conns.has(msg.from) || msg.data?.t === 'signal') hostReceive(msg.from, msg.data);
      return;
    case 'error':
      return handleNetError(msg);
  }
}

// ---------------------------------------------------------- guest of a player-hosted game
function maybeStartGuestLink() {
  const O = S.online;
  if (!O || O.kind !== 'guest' || guestLink || !O.hostDirect || relayOnly() || !webrtcSupported()) return;
  if (!O.hostOnline || (O.linkAttempts || 0) >= 3) return;
  O.linkAttempts = (O.linkAttempts || 0) + 1;
  const link = new DirectLink({
    role: 'offer',
    sendSignal: (s) => net?.send({ t: 'fwd', to: 'host', data: { t: 'signal', ...s } }),
    onMessage: (m) => guestReceive(m),
    onState: (st) => {
      if (guestLink !== link) return;
      if (st === 'closed') {
        guestLink = null;
        setTimeout(maybeStartGuestLink, 15000);
      } else S.online.linkAttempts = 0;
      render();
    },
  });
  guestLink = link;
}

function guestReceive(data) {
  if (!data) return;
  if (data.t === 'signal') return guestLink?.signal(data);
  onGameMsg(data);
}

let retryJoinTimer = null;
function handleNetError(msg) {
  const O = S.online;
  if (msg.code === 'busy' && O?.kind === 'server' && O.create) {
    toast(`${msg.error} Hosting this game in your browser instead.`, 3500);
    const { tc, color } = O.create;
    return startHosting({ tc, color });
  }
  if (msg.code === 'unknown-room' && !msg.fatal) {
    O.waitingHost = true;
    render();
    clearTimeout(retryJoinTimer);
    retryJoinTimer = setTimeout(() => S.online === O && net?.onOpen(), 3000);
    return;
  }
  if (msg.fatal) {
    const title = msg.code === 'host-moved' ? 'Game moved' : 'Game not available';
    if (O?.kind === 'host') stopHosting(false);
    leaveOnline();
    showMenu();
    modal({ title, body: esc(msg.error), actions: [{ label: 'OK', primary: true }] });
  } else toast(msg.error);
}

function onNet(msg) {
  if (S.mode !== 'online' || !S.online) return;
  const O = S.online;
  if (O.kind === 'host') return hostOnNet(msg);
  switch (msg.t) {
    case 'state':
    case 'chat':
      O.kind ||= 'server';
      if (O.kind === 'server') onGameMsg(msg);
      return;
    case 'p2p-joined':
      Object.assign(O, { kind: 'guest', peerId: msg.peerId, hostOnline: msg.hostOnline, waitingHost: false, reportedToken: null });
      render();
      return;
    case 'fwd':
      if (O.kind === 'guest') guestReceive(msg.data);
      return;
    case 'host-gone':
      O.hostOnline = false;
      render();
      return;
    case 'host-back':
      Object.assign(O, { hostOnline: true, lastSeq: null, linkAttempts: 0, reportedToken: null });
      render();
      return;
    case 'room-closed':
      guestLink?.close();
      guestLink = null;
      leaveOnline();
      showMenu();
      modal({ title: 'Game closed', body: 'The host ended this game.', actions: [{ label: 'OK', primary: true }] });
      return;
    case 'error':
      return handleNetError(msg);
  }
}

/** state/chat from whoever runs the game (server, our own hosted room, or the remote host). */
function onGameMsg(msg) {
  const O = S.online;
  if (!O) return;
  if (msg.t === 'state') {
    // The same state can arrive twice (direct link + relay); drop stale or duplicate ones.
    if (!msg.rejected && O.lastSeq != null && msg.gameNo === O.gameNo && msg.seq <= O.lastSeq) return;
    O.lastSeq = msg.seq;
    applyOnlineState(msg);
  } else if (msg.t === 'chat') addChat(msg.entries, msg.reset);
}

function applyOnlineState(st) {
  const O = S.online;
  const newGame = O.gameNo !== st.gameNo;
  const firstSync = O.gameNo === 0;
  const prevYou = O.you;
  const prevDraw = O.drawOffer;
  const prevRematch = O.rematchOffer;
  const hadOpponent = O.you && O.players?.[opp(O.you)];
  Object.assign(O, {
    room: st.room,
    you: st.you,
    players: st.players,
    status: st.status,
    drawOffer: st.drawOffer,
    rematchOffer: st.rematchOffer,
    spectators: st.spectators,
    gameNo: st.gameNo,
    create: null,
    waitingHost: false,
  });
  if (O.kind === 'guest') {
    O.hostDirect = !!st.direct;
    O.hostOnline = true;
  }
  if (st.token) {
    saveToken(st.room, st.token);
    if (O.kind === 'guest' && O.reportedToken !== st.token) {
      O.reportedToken = st.token;
      net?.send({ t: 'peer-token', token: st.token });
    }
  }
  setUrlRoom(st.room);
  S.tc = st.tc;
  if (newGame || prevYou !== st.you) S.orientation = st.you || 'white';
  if (newGame) lowTimeWarned = {};

  const local = hist().map(uci);
  const server = st.moves.map(uci);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  let added = false;
  if (newGame || st.rejected) {
    resetTo(server);
    if (newGame && !firstSync) {
      closeModal();
      sound.start();
    }
  } else if (same(local, server)) {
    // in sync
  } else if (local.length < server.length && same(local, server.slice(0, local.length))) {
    for (const u of server.slice(local.length)) applyMove(parseUci(u));
    added = true;
  } else if (O.pending && same(local, [...server, O.pending])) {
    // Our move hasn't been confirmed. If it's been a while, it was probably lost in a reconnect: resend.
    if (Date.now() - O.pendingAt > 2500 && st.status === 'playing') {
      O.pendingAt = Date.now();
      sendGame({ t: 'move', ...O.pendingMove });
    }
  } else resetTo(server);
  if (same(hist().map(uci), server)) O.pending = null;

  S.clock = st.clock ? { white: st.clock.white, black: st.clock.black, running: st.clock.running, since: Date.now(), inc: incOf(st.tc) } : null;
  if (O.pending && S.clock) S.clock.running = null; // our move is in flight: show our clock stopped
  S.over = st.status === 'over' ? st.result : null;

  if (O.you && !hadOpponent && O.players[opp(O.you)] && !firstSync) {
    sound.notify();
    toast(`${O.players[opp(O.you)].name} joined the game.`);
  }
  if (O.you && !firstSync) {
    if (O.drawOffer === opp(O.you) && prevDraw !== O.drawOffer) {
      sound.notify();
      toast('Your opponent offers a draw.');
    }
    if (O.rematchOffer === opp(O.you) && prevRematch !== O.rematchOffer) {
      sound.notify();
      toast('Your opponent wants a rematch.');
    }
  }

  syncBoard();
  render();
  if (added && !S.over && turn() === O.you) cg.playPremove();
  if (O.kind === 'guest') maybeStartGuestLink();

  const key = `${st.room}:${st.gameNo}`;
  if (S.over && S.overShown !== key) {
    S.overShown = key;
    if (!firstSync) sound.end();
    showResult();
  }
}

const chatSeen = new Set();
function addChat(entries, reset) {
  const log = $('#chat-log');
  if (reset) {
    log.innerHTML = '';
    chatSeen.clear();
  }
  let fresh = null;
  for (const e of entries) {
    if (e.id != null) {
      if (chatSeen.has(e.id)) continue;
      chatSeen.add(e.id);
    }
    fresh = e;
    log.append(h('div', { class: 'chat-line' }, h('b', { class: e.color ? `c-${e.color}` : '' }, e.from + ': '), e.text));
  }
  log.scrollTop = log.scrollHeight;
  if (fresh && !reset && S.online?.you && fresh.color !== S.online.you) sound.notify();
}

/** One-line description of how this browser is connected to the game. */
function connectionInfo() {
  const O = S.online;
  if (!O) return null;
  const netUp = S.netStatus === 'open';
  if (O.kind === 'server') return netUp ? { cls: 'ok', text: 'Server-hosted game' } : { cls: 'bad', text: 'Reconnecting to the server…' };
  if (O.kind === 'host') {
    const me = hostCtx?.room.conns.get('local');
    const theirs = [...(hostCtx?.room.conns || [])].filter(([c, s]) => c !== 'local' && s && s !== me).map(([c]) => c);
    if (!theirs.length) return { cls: netUp ? 'ok' : 'warn', text: netUp ? 'Hosting in your browser' : 'Hosting in your browser · reconnecting to the server…' };
    if (theirs.some((c) => hostCtx.links.get(c)?.isOpen)) return { cls: 'ok', text: 'Hosting in your browser · direct connection' };
    return netUp ? { cls: 'warn', text: 'Hosting in your browser · relayed via server' } : { cls: 'bad', text: 'Reconnecting to the server…' };
  }
  if (O.kind === 'guest') {
    if (guestLink?.isOpen) return { cls: 'ok', text: 'Player-hosted · direct connection' };
    if (!netUp) return { cls: 'bad', text: 'Reconnecting…' };
    if (!O.hostOnline) return { cls: 'bad', text: 'Player-hosted · host offline' };
    return { cls: 'warn', text: guestLink ? 'Player-hosted · connecting directly…' : 'Player-hosted · relayed via server' };
  }
  return { cls: 'warn', text: 'Connecting…' };
}

// ------------------------------------------------------------------ rendering
function barName(color) {
  if (S.mode === 'bot') return color === S.bot.color ? `Computer (Level ${S.bot.level})` : 'You';
  if (S.mode === 'local') return cap(color);
  if (S.mode === 'online') {
    const p = S.online?.players?.[color];
    return p ? p.name : 'Waiting for player…';
  }
  return color === 'white' ? 'You' : 'Opponent';
}

function material(fen) {
  const cnt = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const ch of fen.split(' ')[0]) {
    const l = ch.toLowerCase();
    if (l in VALUE) cnt[ch === l ? 'b' : 'w'][l]++;
  }
  return cnt;
}

function fillBar(bar, color) {
  const fen = S.fens[S.viewPly ?? S.fens.length - 1];
  const cnt = material(fen);
  const mine = color[0];
  const theirs = mine === 'w' ? 'b' : 'w';
  const capList = $('.p-captured', bar);
  capList.innerHTML = '';
  for (const t of ['p', 'b', 'n', 'r', 'q']) {
    const n = Math.max(0, START_COUNT[t] - cnt[theirs][t]);
    if (!n) continue;
    const grp = h('span', { class: 'cap-group' });
    for (let i = 0; i < n; i++) grp.append(h('span', { class: `pc ${ROLE[t]} ${opp(color)}` }));
    capList.append(grp);
  }
  const score = (s) => Object.entries(cnt[s]).reduce((a, [t, n]) => a + VALUE[t] * n, 0);
  const adv = score(mine) - score(theirs);
  $('.p-adv', bar).textContent = adv > 0 ? `+${adv}` : '';

  let name = barName(color);
  const nameEl = $('.p-name', bar);
  nameEl.textContent = name;
  const tag = $('.p-tag', bar);
  tag.textContent = '';
  if (S.mode === 'online' && S.online?.you === color) tag.textContent = 'you';
  else if (S.mode === 'bot' && color === S.bot.color) tag.textContent = LEVELS[S.bot.level - 1].name;

  const dot = $('.p-dot', bar);
  const p = S.mode === 'online' ? S.online?.players?.[color] : null;
  dot.hidden = !p;
  dot.classList.toggle('on', !!p?.online);
  dot.title = p?.online ? 'Online' : 'Offline';

  const isBot = S.mode === 'bot' && color === S.bot.color;
  const av = $('.p-avatar', bar);
  av.className = `p-avatar ${color}`;
  av.innerHTML = `<span class="pc ${isBot ? 'knight' : 'king'} ${color}"></span>`;
  bar.dataset.color = color;
  bar.classList.toggle('to-move', !!S.mode && !S.over && turn() === color);
  $('.p-clock', bar).hidden = !S.clock;
}

function renderPlayers() {
  fillBar($('#bar-bottom'), S.orientation);
  fillBar($('#bar-top'), opp(S.orientation));
  renderClocks();
}

function renderClocks() {
  for (const bar of [$('#bar-top'), $('#bar-bottom')]) {
    const clk = $('.p-clock', bar);
    if (!S.clock) {
      clk.hidden = true;
      continue;
    }
    const c = bar.dataset.color;
    const ms = remaining(c);
    clk.hidden = false;
    clk.textContent = fmtClock(ms);
    clk.classList.toggle('running', S.clock.running === c);
    clk.classList.toggle('low', ms < 20000);
  }
}

function renderMoves() {
  const list = $('#moves');
  const h0 = hist();
  const cur = S.viewPly ?? h0.length;
  list.innerHTML = '';
  if (!h0.length) {
    list.append(h('div', { class: 'moves-empty' }, S.mode === 'online' && S.online?.status === 'waiting' ? 'Moves will appear here.' : 'No moves yet.'));
  }
  for (let i = 0; i < h0.length; i += 2) {
    const row = h('div', { class: 'move-row' }, h('span', { class: 'move-no' }, `${i / 2 + 1}.`));
    for (const j of [i, i + 1]) {
      if (!h0[j]) break;
      row.append(h('button', { class: `mv${cur === j + 1 ? ' active' : ''}`, onclick: () => goto(j + 1) }, h0[j].san));
    }
    list.append(row);
  }
  if (S.over) list.append(h('div', { class: 'move-result' }, resultScore()));
  const active = $('.mv.active', list);
  if (S.viewPly == null) list.scrollTop = list.scrollHeight;
  else active?.scrollIntoView({ block: 'nearest' });
}

function resultScore() {
  if (!S.over) return '';
  if (S.over.reason === 'aborted') return 'Game aborted';
  return S.over.winner === 'white' ? '1–0' : S.over.winner === 'black' ? '0–1' : '½–½';
}

function resultTitle() {
  const o = S.over;
  if (!o) return '';
  if (o.reason === 'aborted') return 'Game aborted';
  if (!o.winner) return 'Draw';
  if (S.mode === 'bot') return o.winner === S.bot.color ? 'Computer won' : 'You won!';
  if (S.mode === 'online' && S.online?.you) return o.winner === S.online.you ? 'You won!' : 'You lost';
  return `${cap(o.winner)} won`;
}

function statusText() {
  if (S.over) return `${resultTitle()} ${REASON[S.over.reason] ?? ''}`.trim();
  if (S.mode === 'bot') return S.bot.thinking ? 'Computer is thinking…' : turn() === S.bot.color ? 'Computer to move' : 'Your move';
  if (S.mode === 'local') return `${cap(turn())} to move${S.chess.inCheck() ? ' — check!' : ''}`;
  if (S.mode === 'online') {
    const O = S.online;
    // A host, or a guest with a direct link, keeps playing while the server connection is down.
    const independent = O.kind === 'host' || (O.kind === 'guest' && guestLink?.isOpen);
    if (!independent && S.netStatus !== 'open') return S.netStatus === 'connecting' && !O.gameNo ? 'Connecting…' : 'Connection lost — reconnecting…';
    if (O.waitingHost) return 'Waiting for the host to come back online…';
    if (O.kind === 'guest' && !O.hostOnline && !guestLink?.isOpen) return 'The host is offline — waiting for them to return…';
    if (!O.gameNo) return 'Connecting…';
    if (O.status === 'waiting') return 'Waiting for your friend to join…';
    if (!O.you) return `Watching · ${cap(turn())} to move`;
    const them = O.players[opp(O.you)];
    if (them && !them.online) return turn() === O.you ? 'Your move (opponent disconnected)' : 'Opponent disconnected — waiting…';
    return turn() === O.you ? 'Your move' : "Opponent's move";
  }
  return '';
}

function button(label, onclick, cls = '', attrs = {}) {
  return h('button', { class: `btn ${cls}`, onclick, ...attrs }, label);
}

function renderActions() {
  const box = $('#actions');
  box.innerHTML = '';
  const over = !!S.over;
  const n = S.chess.history().length;
  if (S.mode === 'bot') {
    if (!over) {
      box.append(
        button('Hint', hint, '', { disabled: turn() === S.bot.color || null }),
        button('Takeback', takeback, '', { disabled: !hist().some((m) => colorName(m.color) !== S.bot.color) || null }),
        button('Resign', resign, 'danger'),
      );
    } else {
      box.append(button('Rematch', () => startBot({ level: S.bot.level, color: S.bot.pref || opp(S.bot.color) }), 'primary'));
    }
    box.append(button('New game', showMenu));
  } else if (S.mode === 'local') {
    if (!over) {
      box.append(button('Takeback', takeback, '', { disabled: !n || null }), button('Draw', offerDraw), button('Resign', resign, 'danger'));
    } else box.append(button('Play again', () => startLocal({ tc: S.tc, autoFlip: S.local.autoFlip }), 'primary'));
    box.append(button('New game', showMenu));
  } else if (S.mode === 'online') {
    const O = S.online;
    if (O.you && O.status === 'playing') {
      const theyOffer = O.drawOffer === opp(O.you);
      if (theyOffer) {
        box.append(button('Accept draw', offerDraw, 'primary'), button('Decline', () => sendGame({ t: 'declineDraw' })));
      } else if (n >= 2) {
        box.append(button(O.drawOffer === O.you ? 'Draw offered' : 'Offer draw', offerDraw, '', { disabled: O.drawOffer === O.you || null }));
      }
      box.append(button(n < 2 ? 'Abort' : 'Resign', resign, 'danger'));
    }
    if (O.you && O.status === 'over') {
      const theyAsk = O.rematchOffer === opp(O.you);
      const iAsked = O.rematchOffer === O.you;
      box.append(
        button(theyAsk ? 'Accept rematch' : iAsked ? 'Rematch offered' : 'Rematch', () => sendGame({ t: 'rematch' }), 'primary', {
          disabled: iAsked || !O.players[opp(O.you)] || null,
        }),
      );
    }
    box.append(
      button('Leave', () => {
        const go = () => {
          leaveOnline();
          showMenu();
        };
        if (O.kind === 'host' && O.status !== 'over' && O.players[opp(O.you)]) {
          modal({
            title: 'Leave and end this game?',
            body: '<p class="muted">The game runs in your browser, so leaving ends it for your opponent too.</p>',
            actions: [{ label: 'End game and leave', danger: true, onClick: go }, { label: 'Stay' }],
          });
        } else go();
      }),
    );
  }
}

function renderGamePanel() {
  const titles = {
    bot: `vs Computer · Level ${S.bot.level}`,
    local: `Pass & Play${S.tc !== 'none' ? ` · ${S.tc}` : ''}`,
    online: `Online${S.tc && S.tc !== 'none' ? ` · ${S.tc}` : ''}`,
  };
  $('#g-title').textContent = titles[S.mode] || '';
  const st = $('#g-status');
  st.textContent = statusText();
  st.classList.toggle('over', !!S.over);

  const O = S.online;
  const showInvite = S.mode === 'online' && O?.room && O.you && (O.status === 'waiting' || !O.players[opp(O.you)]);
  $('#g-invite').hidden = !showInvite;
  if (showInvite) $('#invite-link').value = inviteLink();
  $('#g-share').hidden = !(S.mode === 'online' && O?.room && !showInvite);
  const spec = S.mode === 'online' && O?.spectators ? `${O.spectators} watching` : '';
  $('#g-spectators').textContent = spec;
  const conn = S.mode === 'online' ? connectionInfo() : null;
  const connEl = $('#g-conn');
  connEl.hidden = !conn;
  if (conn) {
    connEl.className = `g-conn ${conn.cls}`;
    connEl.textContent = conn.text;
  }
  $('#chat').hidden = S.mode !== 'online';
  $('#chat-input').disabled = !(S.mode === 'online' && O?.room);
  renderActions();
}

function render() {
  if (!S.mode) return;
  renderPlayers();
  renderMoves();
  renderGamePanel();
  $('#sound-btn').classList.toggle('off', !sound.enabled);
}

// ------------------------------------------------------------------ views
function showView(name) {
  for (const v of $$('.view')) v.hidden = v.id !== `view-${name}`;
  document.body.dataset.view = name;
  if (name === 'friend') updateHostingLine();
}

function enterGame() {
  closeModal();
  showView('game');
  syncBoard();
  render();
}

function showMenu() {
  if (S.mode === 'bot') {
    S.gen++;
    engine?.stop();
    S.bot.thinking = false;
  }
  if (S.mode === 'online') leaveOnline();
  S.mode = null;
  S.chess = new Chess();
  S.fens = [START_FEN];
  S.viewPly = null;
  S.over = null;
  S.clock = null;
  S.orientation = 'white';
  closeModal();
  syncBoard();
  renderPlayers();
  const saved = store.get('cp.saved');
  const cont = $('#continue');
  if (saved && !saved.over && saved.moves?.length) {
    cont.hidden = false;
    $('#continue-label').textContent =
      saved.mode === 'bot' ? `vs Computer (Level ${saved.bot.level}) · move ${Math.ceil(saved.moves.length / 2)}` : `Pass & Play · move ${Math.ceil(saved.moves.length / 2)}`;
    cont.onclick = () => resume(saved);
  } else cont.hidden = true;
  showView('home');
}

// ------------------------------------------------------------------ modal & toast
function closeModal() {
  $('#modal').hidden = true;
}

function modal({ title, body = '', actions = [], dismissible = true }) {
  const m = $('#modal');
  $('#modal-title').textContent = title;
  const b = $('#modal-body');
  b.innerHTML = '';
  if (typeof body === 'string') b.innerHTML = body;
  else b.append(body);
  const act = $('#modal-actions');
  act.innerHTML = '';
  for (const a of actions) {
    act.append(
      button(a.label, () => {
        if (a.onClick?.() !== false) closeModal();
      }, a.primary ? 'primary' : a.danger ? 'danger' : ''),
    );
  }
  $('#modal-close').hidden = !dismissible;
  m.dataset.dismissible = dismissible ? '1' : '';
  m.hidden = false;
  $('button.primary', act)?.focus();
}

function confirmBox(text, okLabel, onOk) {
  modal({ title: text, actions: [{ label: okLabel, danger: true, onClick: onOk }, { label: 'Cancel' }] });
}

function showResult() {
  const reason = REASON[S.over.reason] ?? S.over.reason;
  const actions = [];
  if (S.mode === 'bot') actions.push({ label: 'Rematch', primary: true, onClick: () => startBot({ level: S.bot.level, color: S.bot.pref || opp(S.bot.color) }) });
  if (S.mode === 'local') actions.push({ label: 'Play again', primary: true, onClick: () => startLocal({ tc: S.tc, autoFlip: S.local.autoFlip }) });
  if (S.mode === 'online' && S.online?.you) actions.push({ label: 'Rematch', primary: true, onClick: () => sendGame({ t: 'rematch' }) });
  actions.push({ label: 'Review game' });
  modal({
    title: resultTitle(),
    body: `<div class="result-score">${resultScore()}</div>${reason ? `<p class="muted">${esc(reason)}</p>` : ''}`,
    actions,
  });
}

let toastTimer;
function toast(text, ms = 2200) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => (t.hidden = true), 250);
  }, ms);
}

// ------------------------------------------------------------------ settings
function applyTheme(id) {
  if (!THEMES.some((t) => t[0] === id)) id = 'green';
  document.documentElement.dataset.board = id;
  store.set('cp.theme', id);
}

function showSettings() {
  const current = document.documentElement.dataset.board || 'green';
  const grid = h('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': 'Board colors' });
  for (const [id, label, light, dark] of THEMES) {
    grid.append(
      h('button', {
        type: 'button',
        class: `theme-opt${id === current ? ' selected' : ''}`,
        role: 'radio',
        'aria-checked': id === current ? 'true' : 'false',
        onclick: (e) => {
          applyTheme(id);
          for (const b of $$('.theme-opt', grid)) {
            const on = b === e.currentTarget;
            b.classList.toggle('selected', on);
            b.setAttribute('aria-checked', on ? 'true' : 'false');
          }
        },
      }, h('span', { class: 'swatch', style: `--l:${light};--d:${dark}` }), label),
    );
  }
  modal({
    title: 'Settings',
    body: h('div', {}, h('p', { class: 'settings-label' }, 'Board colors'), grid, hostingSettings()),
    actions: [{ label: 'Done', primary: true }],
  });
}

// "Online games" section: who hosts new games, and whether to allow direct connections.
function hostingSettings() {
  const box = h('div', { class: 'hosting-settings' });
  const opts = h('div', { class: 'opt-list', role: 'radiogroup', 'aria-label': 'Who hosts new online games' });
  const card = (value, title, desc) =>
    h('button', { type: 'button', class: 'opt-card', role: 'radio', 'data-value': value }, h('b', {}, title), h('small', {}, desc), h('small', { class: 'opt-note' }));
  const player = card('player', 'Player-hosted (recommended)', 'The game runs in the browser of the player who creates it. Players connect directly when possible, so games keep going through server updates.');
  const serverOpt = card('server', 'Server-hosted', 'The game runs on this server, so it survives page refreshes and phones going to sleep. Only offered while the server is idle.');
  opts.append(player, serverOpt);
  const sync = () => {
    const cur = hostingPref();
    for (const b of [player, serverOpt]) {
      const on = b.dataset.value === cur;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    updateHostingLine();
  };
  opts.addEventListener('click', (e) => {
    const b = e.target.closest('.opt-card');
    if (!b || b.disabled) return;
    store.set('cp.hosting', b.dataset.value);
    sync();
  });
  const note = $('.opt-note', serverOpt);
  note.textContent = 'Checking availability…';
  serverOpt.disabled = true;
  fetchHostingStatus().then((st) => {
    serverOpt.disabled = !st.available;
    note.textContent = st.available ? 'Available now.' : `Unavailable: ${st.reason}`;
    note.classList.toggle('bad', !st.available);
    if (!st.available && hostingPref() === 'server') note.textContent += ' New games will be player-hosted for now.';
  });
  const relay = h('input', { type: 'checkbox', id: 'relay-only' });
  relay.checked = relayOnly();
  relay.onchange = () => {
    store.set('cp.relayOnly', relay.checked);
    updateHostingLine();
  };
  box.append(
    h('p', { class: 'settings-label' }, 'Online games'),
    opts,
    h('label', { class: 'toggle settings-toggle' }, relay, h('span', {}, h('b', {}, 'Hide my IP address'), h('small', {}, 'Send all game traffic through this server instead of connecting directly to the other player. They won\u2019t see your IP address; moves may arrive a little slower.'))),
  );
  sync();
  return box;
}

function updateHostingLine() {
  const el = $('#hosting-line-text');
  if (!el) return;
  const how = hostingPref() === 'server' ? 'Server-hosted' : 'Player-hosted (runs in your browser)';
  el.textContent = `${how}${relayOnly() ? ' · IP hidden' : ''}`;
}

// ------------------------------------------------------------------ setup forms
function tcGrid(container, initial) {
  container.innerHTML = '';
  for (const [v, label] of TIME_CONTROLS) {
    container.append(h('button', { type: 'button', class: `chip${v === initial ? ' selected' : ''}`, 'data-value': v }, label));
  }
  chipGroup(container);
}

function chipGroup(container) {
  container.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b || !container.contains(b)) return;
    $$('.chip', container).forEach((c) => c.classList.toggle('selected', c === b));
    container.dispatchEvent(new Event('change'));
  });
}
const chipValue = (container) => $('.chip.selected', container)?.dataset.value;

function initSetup() {
  // Bot
  const prefs = store.get('cp.prefs', {});
  const lv = $('#bot-level');
  lv.value = prefs.level || 4;
  const lvLabel = () => {
    $('#bot-level-name').textContent = `Level ${lv.value} · ${LEVELS[lv.value - 1].name}`;
  };
  lv.addEventListener('input', lvLabel);
  lvLabel();
  for (const g of $$('.chip-group')) chipGroup(g);
  const setChip = (group, val) => $$('.chip', group).forEach((c) => c.classList.toggle('selected', c.dataset.value === val));
  setChip($('#bot-color'), prefs.botColor || 'white');
  setChip($('#friend-color'), prefs.friendColor || 'random');
  tcGrid($('#local-tc'), prefs.localTc || 'none');
  tcGrid($('#friend-tc'), prefs.friendTc || '10+0');
  $('#local-flip').checked = !!prefs.autoFlip;
  $('#friend-name').value = myName();
  updateHostingLine();
  $('#hosting-change').onclick = showSettings;

  const savePrefs = (p) => store.set('cp.prefs', { ...store.get('cp.prefs', {}), ...p });

  $('#bot-start').onclick = () => {
    sound.unlock();
    const level = Number(lv.value);
    const color = chipValue($('#bot-color'));
    savePrefs({ level, botColor: color });
    startBot({ level, color });
  };
  $('#local-start').onclick = () => {
    sound.unlock();
    const tc = chipValue($('#local-tc'));
    const autoFlip = $('#local-flip').checked;
    savePrefs({ localTc: tc, autoFlip });
    startLocal({ tc, autoFlip });
  };
  $('#friend-start').onclick = () => {
    sound.unlock();
    const name = $('#friend-name').value.trim().slice(0, 20);
    if (name) store.set('cp.name', name);
    const tc = chipValue($('#friend-tc'));
    const color = chipValue($('#friend-color'));
    savePrefs({ friendTc: tc, friendColor: color });
    createOnline({ tc, color });
  };

  for (const b of $$('[data-goto]')) b.addEventListener('click', () => showView(b.dataset.goto));
}

// ------------------------------------------------------------------ wiring
function pruneHostedSaves() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith('cp.host.') && Date.now() - (store.get(k)?.savedAt || 0) > 24 * 3600 * 1000) localStorage.removeItem(k);
    }
  } catch {}
}

function init() {
  initSetup();
  $('#flip-btn').onclick = flip;
  $('#sound-btn').onclick = () => {
    sound.enabled = !sound.enabled;
    $('#sound-btn').classList.toggle('off', !sound.enabled);
    toast(sound.enabled ? 'Sound on' : 'Sound off', 1000);
  };
  $('#pgn-btn').onclick = () => copyText(pgn(), 'PGN copied to clipboard');
  $('#settings-btn').onclick = showSettings;
  $('#nav-first').onclick = () => goto(0);
  $('#nav-prev').onclick = () => goto((S.viewPly ?? S.chess.history().length) - 1);
  $('#nav-next').onclick = () => goto((S.viewPly ?? S.chess.history().length) + 1);
  $('#nav-last').onclick = () => goto(S.chess.history().length);
  $('#copy-link').onclick = () => copyText(inviteLink(), 'Invite link copied — send it to your friend');
  $('#g-share').onclick = () => copyText(inviteLink(), 'Game link copied');
  if (navigator.share) {
    $('#share-link').hidden = false;
    $('#share-link').onclick = () => navigator.share({ title: 'Play chess with me', url: inviteLink() }).catch(() => {});
  }
  $('#invite-link').onclick = (e) => e.target.select();
  $('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    const inp = $('#chat-input');
    const text = inp.value.trim();
    if (text && sendGame({ t: 'chat', text })) inp.value = '';
  };
  $('#modal-close').onclick = closeModal;
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal' && $('#modal').dataset.dismissible) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'Escape' && !$('#modal').hidden && $('#modal').dataset.dismissible) return closeModal();
    if (!S.mode) return;
    const cur = S.viewPly ?? S.chess.history().length;
    if (e.key === 'ArrowLeft') goto(cur - 1);
    else if (e.key === 'ArrowRight') goto(cur + 1);
    else if (e.key === 'ArrowUp') goto(0);
    else if (e.key === 'ArrowDown') goto(S.chess.history().length);
    else if (e.key === 'f') flip();
    else return;
    e.preventDefault();
  });

  pruneHostedSaves();
  const room = new URLSearchParams(location.search).get('room');
  const hosted = room && store.get(`cp.host.${room}`);
  if (hosted) {
    S.mode = 'online';
    newGameState();
    startHosting({}, hosted);
  } else if (room && /^[A-Za-z0-9]{4,16}$/.test(room)) {
    if (tokens()[room]) joinOnline(room);
    else {
      showMenu();
      const nameInput = h('input', { class: 'input', maxlength: 20, value: myName(), 'aria-label': 'Your name' });
      const body = h('div', {}, h('p', { class: 'muted' }, "You've been invited to a chess game. No account needed."), h('label', { class: 'field' }, h('span', {}, 'Your name'), nameInput));
      modal({
        title: 'Join game',
        body,
        dismissible: false,
        actions: [
          {
            label: 'Join game',
            primary: true,
            onClick: () => {
              const n = nameInput.value.trim().slice(0, 20);
              if (n) store.set('cp.name', n);
              sound.unlock();
              joinOnline(room);
            },
          },
          { label: 'Just watch', onClick: () => joinOnline(room, true) },
          { label: 'Cancel', onClick: () => setUrlRoom(null) },
        ],
      });
    }
  } else {
    if (room) setUrlRoom(null);
    showMenu();
  }
}

init();
