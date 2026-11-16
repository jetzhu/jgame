// Integration tests: start server.js on a random port and drive it over HTTP + WebSocket.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let proc;
let base;

before(async () => {
  proc = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, HOST: '127.0.0.1', PORT: '0' } });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
    proc.stdout.on('data', (d) => {
      const m = String(d).match(/http:\/\/([\d.]+:\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on('exit', (code) => reject(new Error(`server exited (${code})`)));
  });
});

after(() => proc?.kill());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A client that remembers the latest state message and can wait for a matching one.
function client() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/ws`);
    ws.states = [];
    ws.errors = [];
    ws.chats = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'state') ws.states.push(m);
      if (m.t === 'error') ws.errors.push(m);
      if (m.t === 'chat') ws.chats.push(...m.entries);
    });
    ws.cmd = (msg) => ws.send(JSON.stringify(msg));
    ws.last = () => ws.states[ws.states.length - 1];
    ws.until = async (pred, ms = 2000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const s = ws.last();
        if (s && pred(s)) return s;
        await sleep(10);
      }
      throw new Error(`timed out; last state: ${JSON.stringify(ws.last())}`);
    };
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function newGame(tc = 'none') {
  const a = await client();
  a.cmd({ t: 'create', tc, color: 'white', name: 'Alice' });
  const s = await a.until((s) => s.room);
  const b = await client();
  b.cmd({ t: 'join', room: s.room, name: 'Bob' });
  await b.until((s) => s.you === 'black');
  await a.until((s) => s.status === 'playing');
  return { a, b, room: s.room };
}

test('static files: index, wasm type, 404, no path traversal', async () => {
  const idx = await fetch(`http://${base}/`);
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /Chess Playground/);
  const about = await fetch(`http://${base}/about.html`);
  assert.equal(about.status, 200);
  assert.equal((await fetch(`http://${base}/nope.js`)).status, 404);
  const health = await fetch(`http://${base}/healthz`);
  assert.equal(health.status, 200);
  // raw request so the client does not normalize "../"
  const net = await import('node:net');
  const [host, port] = base.split(':');
  const raw = await new Promise((resolve) => {
    const sock = net.connect(Number(port), host, () => sock.write('GET /../server.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let buf = '';
    sock.on('data', (d) => (buf += d));
    sock.on('end', () => resolve(buf));
  });
  assert.doesNotMatch(raw, /^HTTP\/1\.1 200/);
});

test('create, join, spectate', async () => {
  const { a, b, room } = await newGame();
  assert.equal(a.last().you, 'white');
  assert.deepEqual(b.last().players, { white: { name: 'Alice', online: true }, black: { name: 'Bob', online: true } });
  const c = await client();
  c.cmd({ t: 'join', room, name: 'Carl' });
  const s = await c.until((s) => s.room === room);
  assert.equal(s.you, null);
  await a.until((s) => s.spectators === 1);
  [a, b, c].forEach((w) => w.close());
});

test('illegal and out-of-turn moves are rejected', async () => {
  const { a, b } = await newGame();
  b.cmd({ t: 'move', from: 'e7', to: 'e5' });
  assert.equal((await b.until((s) => s.rejected)).moves.length, 0);
  a.cmd({ t: 'move', from: 'e2', to: 'e5' });
  assert.equal((await a.until((s) => s.rejected)).moves.length, 0);
  [a, b].forEach((w) => w.close());
});

test("scholar's mate ends the game, rematch swaps colors", async () => {
  const { a, b } = await newGame();
  const seq = [[a, 'e2', 'e4'], [b, 'e7', 'e5'], [a, 'f1', 'c4'], [b, 'b8', 'c6'], [a, 'd1', 'h5'], [b, 'g8', 'f6'], [a, 'h5', 'f7']];
  for (const [w, from, to] of seq) {
    const n = w.last().moves.length;
    w.cmd({ t: 'move', from, to });
    await w.until((s) => s.moves.length === n + 1);
  }
  const end = await b.until((s) => s.status === 'over');
  assert.deepEqual(end.result, { winner: 'white', reason: 'checkmate' });
  assert.equal(end.moves.at(-1).san, 'Qxf7#');
  b.cmd({ t: 'rematch' });
  await a.until((s) => s.rematchOffer === 'black');
  a.cmd({ t: 'rematch' });
  const s = await a.until((s) => s.gameNo === 2);
  assert.equal(s.you, 'black');
  assert.equal((await b.until((s) => s.gameNo === 2)).you, 'white');
  [a, b].forEach((w) => w.close());
});

test('reconnecting with the seat token restores the seat', async () => {
  const { a, b, room } = await newGame();
  const token = a.last().token;
  a.close();
  await b.until((s) => s.players.white.online === false);
  const a2 = await client();
  a2.cmd({ t: 'join', room, token });
  assert.equal((await a2.until((s) => s.room === room)).you, 'white');
  await b.until((s) => s.players.white.online === true);
  [a2, b].forEach((w) => w.close());
});

test('draw offer and acceptance, resign, abort', async () => {
  let { a, b } = await newGame();
  a.cmd({ t: 'resign' }); // before 2 moves = abort
  assert.deepEqual((await b.until((s) => s.status === 'over')).result, { winner: null, reason: 'aborted' });
  [a, b].forEach((w) => w.close());

  ({ a, b } = await newGame());
  a.cmd({ t: 'move', from: 'e2', to: 'e4' });
  await b.until((s) => s.moves.length === 1);
  b.cmd({ t: 'move', from: 'e7', to: 'e5' });
  await a.until((s) => s.moves.length === 2);
  a.cmd({ t: 'draw' });
  await b.until((s) => s.drawOffer === 'white');
  b.cmd({ t: 'draw' });
  assert.deepEqual((await a.until((s) => s.status === 'over')).result, { winner: null, reason: 'agreement' });
  [a, b].forEach((w) => w.close());

  ({ a, b } = await newGame());
  a.cmd({ t: 'move', from: 'e2', to: 'e4' });
  await b.until((s) => s.moves.length === 1);
  b.cmd({ t: 'move', from: 'e7', to: 'e5' });
  await a.until((s) => s.moves.length === 2);
  b.cmd({ t: 'resign' });
  assert.deepEqual((await a.until((s) => s.status === 'over')).result, { winner: 'white', reason: 'resignation' });
  [a, b].forEach((w) => w.close());
});

test('clocks start after both first moves and add increment', async () => {
  const { a, b } = await newGame('3+2');
  assert.equal(a.last().clock.running, null);
  a.cmd({ t: 'move', from: 'e2', to: 'e4' });
  await b.until((s) => s.moves.length === 1);
  assert.equal(b.last().clock.running, null);
  b.cmd({ t: 'move', from: 'e7', to: 'e5' });
  const s = await a.until((s) => s.moves.length === 2);
  assert.equal(s.clock.running, 'white');
  await sleep(150);
  a.cmd({ t: 'move', from: 'g1', to: 'f3' });
  const s2 = await b.until((s) => s.moves.length === 3);
  assert.ok(s2.clock.white > 180000 && s2.clock.white < 182000, `white clock ${s2.clock.white}`);
  [a, b].forEach((w) => w.close());
});

test('chat is relayed and sanitized of control chars', async () => {
  const { a, b } = await newGame();
  b.cmd({ t: 'chat', text: 'good\nluck' });
  const end = Date.now() + 2000;
  while (!a.chats.some((c) => c.from === 'Bob') && Date.now() < end) await sleep(10);
  const msg = a.chats.find((c) => c.from === 'Bob');
  assert.equal(msg.text, 'good luck');
  [a, b].forEach((w) => w.close());
});

test('unknown room returns a fatal error', async () => {
  const x = await client();
  x.cmd({ t: 'join', room: 'nope1234' });
  const end = Date.now() + 2000;
  while (!x.errors.length && Date.now() < end) await sleep(10);
  assert.equal(x.errors[0]?.fatal, true);
  x.close();
});
