// Chess Playground server, behind Caddy at https://jgame.duckdns.org/chess_playground/ (prefix stripped).
//
//  - static files from public/
//  - GET /status       -> whether server-hosted games are available (only when this machine is idle)
//  - WebSocket /ws
//      server-hosted games: the server runs the GameRoom (src/room-core.js)
//      player-hosted games: the creator's browser runs the GameRoom; the server only introduces
//                           peers (WebRTC signaling) and relays traffic when a direct link fails
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { GameRoom } from './src/room-core.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3100);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// Server-hosted games are offered only while the machine is nearly idle.
const MAX_LOAD_PER_CPU = Number(process.env.MAX_LOAD_PER_CPU ?? 0.5);
const MIN_MEM_AVAILABLE = Number(process.env.MIN_MEM_AVAILABLE ?? 0.25);
const MAX_SERVER_GAMES = Number(process.env.MAX_SERVER_GAMES ?? 10);
const FORCE_HOSTING = process.env.SERVER_HOSTING; // 'on' | 'off' overrides the load check (tests)

// STUN servers handed to browsers for player-hosted games. Ours is preferred; the fallback is
// only advertised while ours doesn't answer on its public address (e.g. port not forwarded yet).
const STUN_SELF = process.env.STUN_SELF ?? 'stun:jgame.duckdns.org:3478';
const STUN_FALLBACK = process.env.STUN_FALLBACK ?? 'stun:stun.cloudflare.com:3478';
let stunSelfOk = false;

const MAX_ROOMS = 5000;
const MAX_PEERS = 20; // per player-hosted room (players + spectators)
const ROOM_IDLE_MS = 24 * 3600 * 1000;
const EMPTY_ROOM_MS = 2 * 3600 * 1000;
const ID_RE = /^[A-Za-z0-9]{4,16}$/;

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
  '.gz': 'application/gzip',
  '.map': 'application/json',
};

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return res.writeHead(400).end();
  }
  if (urlPath === '/healthz') {
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`ok server=${serverRooms.size} p2p=${p2pRooms.size}\n`);
  }
  if (urlPath === '/status') {
    return res
      .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ serverHosting: serverHosting(), stun: stunServers() }));
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return res.writeHead(403).end();
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- load check
let hostingCache = { at: 0, value: null };
function memAvailableRatio() {
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = Number(info.match(/MemTotal:\s+(\d+)/)[1]);
    const avail = Number(info.match(/MemAvailable:\s+(\d+)/)[1]);
    return avail / total;
  } catch {
    return os.freemem() / os.totalmem();
  }
}

function serverHosting() {
  if (FORCE_HOSTING === 'on') return { available: true };
  if (FORCE_HOSTING === 'off') return { available: false, reason: 'Server-hosted games are turned off.' };
  if (Date.now() - hostingCache.at < 5000) return hostingCache.value;
  const [l1, l5] = os.loadavg();
  const load = Math.max(l1, l5) / os.cpus().length;
  const mem = memAvailableRatio();
  let active = 0;
  for (const r of serverRooms.values()) if (r.status !== 'over' && r.conns.size) active++;
  let value = { available: true };
  if (load > MAX_LOAD_PER_CPU || mem < MIN_MEM_AVAILABLE) value = { available: false, reason: 'The server is busy right now.' };
  else if (active >= MAX_SERVER_GAMES) value = { available: false, reason: 'All server-hosted game slots are in use.' };
  hostingCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------- STUN self-check
function stunServers() {
  const list = [];
  if (STUN_SELF) list.push(STUN_SELF);
  if (!stunSelfOk && STUN_FALLBACK) list.push(STUN_FALLBACK);
  return list;
}

/** Send a STUN binding request to our own public STUN address; true if it answers. */
async function probeStun(url, timeoutMs = 2500) {
  const m = /^stun:([^:]+):(\d+)$/.exec(url || '');
  if (!m) return false;
  let address;
  try {
    ({ address } = await dns.lookup(m[1], { family: 4 }));
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const req = Buffer.alloc(20);
    req.writeUInt16BE(0x0001, 0);
    req.writeUInt32BE(0x2112a442, 4);
    crypto.randomBytes(12).copy(req, 8);
    const done = (ok) => {
      clearTimeout(timer);
      sock.close();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.on('message', (msg) => done(msg.length >= 20 && msg.readUInt16BE(0) === 0x0101 && msg.subarray(8, 20).equals(req.subarray(8, 20))));
    sock.on('error', () => done(false));
    sock.send(req, Number(m[2]), address);
  });
}

async function checkStun() {
  const ok = await probeStun(STUN_SELF);
  if (ok !== stunSelfOk) console.log(`own STUN ${ok ? 'reachable' : 'NOT reachable'} at ${STUN_SELF}`);
  stunSelfOk = ok;
}
if (STUN_SELF && process.env.NODE_ENV === 'production') {
  checkStun();
  setInterval(checkStun, 10 * 60 * 1000).unref();
}

// ---------------------------------------------------------------- rooms
/** @type {Map<string, GameRoom>} server-hosted games */
const serverRooms = new Map();
/** @type {Map<string, {id, secret, host, peers: Map<string, any>, hostGoneAt, lastActive}>} player-hosted games */
const p2pRooms = new Map();

const randomId = (n) => {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += abc[bytes[i] % abc.length];
  return s;
};
const roomIdTaken = (id) => serverRooms.has(id) || p2pRooms.has(id);
const io = { send: (ws, msg) => send(ws, msg) };
const randomToken = () => crypto.randomBytes(16).toString('hex');

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// Drop whatever this socket was attached to.
function detach(ws) {
  if (ws.room) {
    const room = ws.room;
    ws.room = null;
    room.detach(ws);
    if (!room.conns.size) room.emptySince = Date.now();
    room.broadcast();
  }
  if (ws.p2pHost) {
    const r = ws.p2pHost;
    ws.p2pHost = null;
    if (r.host === ws) {
      r.host = null;
      r.hostGoneAt = Date.now();
      for (const p of r.peers.values()) send(p, { t: 'host-gone' });
    }
  }
  if (ws.p2p) {
    const r = ws.p2p;
    ws.p2p = null;
    r.peers.delete(ws.peerId);
    if (r.host) send(r.host, { t: 'peer-left', peerId: ws.peerId });
  }
}

function closeP2p(r, notify = true) {
  p2pRooms.delete(r.id);
  if (r.host) r.host.p2pHost = null;
  for (const p of r.peers.values()) {
    if (notify) send(p, { t: 'room-closed' });
    p.p2p = null;
  }
}

function handle(ws, msg) {
  switch (msg.t) {
    // ------------------------------------------------ server-hosted
    case 'create': {
      const hosting = serverHosting();
      if (!hosting.available) return send(ws, { t: 'error', code: 'busy', error: hosting.reason });
      if (serverRooms.size + p2pRooms.size >= MAX_ROOMS) return send(ws, { t: 'error', error: 'Server is full, try again later.' });
      let id = randomId(8);
      while (roomIdTaken(id)) id = randomId(8);
      const pref = ['white', 'black', 'random'].includes(msg.color) ? msg.color : 'random';
      const color = pref === 'random' ? (crypto.randomInt(2) ? 'white' : 'black') : pref;
      const room = new GameRoom({ id, tc: msg.tc, io, randomToken });
      serverRooms.set(id, room);
      detach(ws);
      ws.room = room;
      room.claimSeat(ws, color, msg.name);
      room.broadcast();
      hostingCache.at = 0;
      return;
    }
    case 'join': {
      const id = String(msg.room || '');
      const room = serverRooms.get(id);
      if (room) {
        detach(ws);
        ws.room = room;
        room.emptySince = null;
        room.join(ws, msg);
        room.broadcast();
        return;
      }
      const r = p2pRooms.get(id);
      if (r) {
        if (r.peers.size >= MAX_PEERS) return send(ws, { t: 'error', error: 'This game is full.', fatal: true });
        detach(ws);
        ws.peerId = randomId(10);
        ws.p2p = r;
        ws.joinData = { token: msg.token || null, name: msg.name, spectate: !!msg.spectate };
        r.peers.set(ws.peerId, ws);
        r.lastActive = Date.now();
        send(ws, { t: 'p2p-joined', room: id, peerId: ws.peerId, hostOnline: !!r.host });
        if (r.host) send(r.host, { t: 'peer-join', peerId: ws.peerId, data: ws.joinData });
        return;
      }
      // A participant (has a seat token) may be early: e.g. the host is still reconnecting after a restart.
      return send(ws, {
        t: 'error',
        code: 'unknown-room',
        fatal: !msg.token,
        error: msg.token ? 'Waiting for the game host to reconnect…' : 'This game link is invalid or has expired.',
      });
    }

    // ------------------------------------------------ player-hosted: signaling + relay
    case 'host': {
      const id = String(msg.room || '');
      const secret = String(msg.secret || '');
      // Hosting "epoch": bumped when a guest takes over from a vanished host. The highest epoch
      // hosts; a returning older host is told to rejoin as a player instead.
      const epoch = Math.max(0, Math.floor(Number(msg.epoch) || 0));
      if (!ID_RE.test(id) || secret.length < 16 || secret.length > 128) return send(ws, { t: 'error', error: 'Bad host request.' });
      let r = p2pRooms.get(id);
      if (r) {
        if (r.secret !== secret) return send(ws, { t: 'error', code: 'taken', error: 'That game id belongs to someone else.', fatal: true });
        if (epoch < r.epoch) return send(ws, { t: 'error', code: 'superseded', error: 'Another player is now hosting this game.' });
        if (r.host && r.host !== ws) {
          send(r.host, { t: 'error', code: 'superseded', error: 'This game is now hosted elsewhere.' });
          r.host.p2pHost = null;
        }
        r.epoch = epoch;
      } else {
        if (serverRooms.has(id)) return send(ws, { t: 'error', code: 'taken', error: 'That game id is taken.', fatal: true });
        if (serverRooms.size + p2pRooms.size >= MAX_ROOMS) return send(ws, { t: 'error', error: 'Server is full, try again later.' });
        r = { id, secret, epoch, host: null, peers: new Map(), hostGoneAt: null, lastActive: Date.now() };
        p2pRooms.set(id, r);
      }
      if (ws.p2pHost !== r) detach(ws);
      r.host = ws;
      r.hostGoneAt = null;
      r.lastActive = Date.now();
      ws.p2pHost = r;
      send(ws, { t: 'hosting', room: id });
      // Re-introduce everyone who is waiting (e.g. after the host refreshed or this server restarted).
      for (const [peerId, p] of r.peers) {
        send(p, { t: 'host-back' });
        send(ws, { t: 'peer-join', peerId, data: p.joinData });
      }
      return;
    }
    case 'fwd': {
      if (!msg.data || typeof msg.data !== 'object') return;
      if (ws.p2pHost) {
        const p = ws.p2pHost.peers.get(String(msg.to));
        if (p) send(p, { t: 'fwd', from: 'host', data: msg.data });
        ws.p2pHost.lastActive = Date.now();
      } else if (ws.p2p) {
        const r = ws.p2p;
        if (r.host) send(r.host, { t: 'fwd', from: ws.peerId, data: msg.data });
        else send(ws, { t: 'host-gone' });
        r.lastActive = Date.now();
      }
      return;
    }
    case 'peer-token':
      // A guest reports the seat token its host gave it, so re-introductions (host refresh,
      // server restart) put it back in its seat instead of joining as a newcomer.
      if (ws.p2p && ws.joinData && typeof msg.token === 'string' && msg.token.length <= 64) ws.joinData.token = msg.token;
      return;
    case 'close':
      if (ws.p2pHost) closeP2p(ws.p2pHost);
      return;
    case 'leave':
      detach(ws);
      return;
  }
  // ------------------------------------------------ in-game messages for server-hosted rooms
  if (ws.room) ws.room.handle(ws, msg);
}

// ---------------------------------------------------------------- wiring
const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384 });

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.msgTimes = [];
  ws.on('pong', () => (ws.alive = true));
  ws.on('message', (data) => {
    const now = Date.now();
    ws.msgTimes = ws.msgTimes.filter((t) => now - t < 1000);
    if (ws.msgTimes.length > 40) return; // crude flood protection (ICE candidates come in bursts)
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
  for (const [id, r] of serverRooms) {
    if (now - r.lastActive > ROOM_IDLE_MS || (r.emptySince && now - r.emptySince > EMPTY_ROOM_MS)) {
      r.destroy();
      serverRooms.delete(id);
    }
  }
  for (const r of p2pRooms.values()) {
    if (now - r.lastActive > ROOM_IDLE_MS || (!r.host && now - r.hostGoneAt > EMPTY_ROOM_MS)) closeP2p(r);
  }
}, 30000).unref();

server.listen(PORT, HOST, () => console.log(`chess playground on http://${HOST}:${server.address().port}`));
