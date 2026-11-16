// Player-hosted games: the server only introduces peers and relays. A Node "host" runs the
// GameRoom here (as the creator's browser would) and talks to guests through the relay.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, makeClient, sleep } from './helpers.js';
import { GameRoom } from '../src/room-core.js';

let srv;
before(async () => (srv = await startServer({ SERVER_HOSTING: 'off' })));
after(() => srv?.stop());

const SECRET = 's3cret-s3cret-s3cret';

// Wire a host socket to a GameRoom, exactly like the browser host does over the relay.
async function startHost(room = 'p2pRoom1', saved = null) {
  const ws = await makeClient(srv.base);
  const io = { send: (conn, msg) => (conn === 'local' ? ws.local.push(msg) : ws.cmd({ t: 'fwd', to: conn, data: msg })) };
  const opts = { io, randomToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') };
  ws.local = [];
  ws.game = saved ? GameRoom.fromJSON(saved, opts) : new GameRoom({ id: room, tc: '5+0', ...opts });
  if (saved) ws.game.attach('local', 'white');
  else ws.game.claimSeat('local', 'white', 'Hosty');
  ws.onmsg = (m) => {
    if (m.t === 'peer-join') {
      ws.game.join(m.peerId, m.data);
      ws.game.broadcast();
    } else if (m.t === 'peer-left') {
      ws.game.detach(m.peerId);
      ws.game.broadcast();
    } else if (m.t === 'fwd') ws.game.handle(m.from, m.data);
  };
  ws.cmd({ t: 'host', room, secret: SECRET });
  await ws.waitMsg((m) => m.t === 'hosting');
  return ws;
}

// Guest sees host messages as `fwd` from 'host'.
async function startGuest(room = 'p2pRoom1', extra = {}) {
  const ws = await makeClient(srv.base);
  ws.hostStates = () => ws.msgs.filter((m) => m.t === 'fwd' && m.data.t === 'state').map((m) => m.data);
  ws.untilHost = async (pred, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = ws.hostStates().at(-1);
      if (s && pred(s)) return s;
      await sleep(10);
    }
    throw new Error(`timeout; last host state ${JSON.stringify(ws.hostStates().at(-1))}`);
  };
  ws.toHost = (data) => ws.cmd({ t: 'fwd', to: 'host', data });
  ws.cmd({ t: 'join', room, name: 'Guesty', ...extra });
  await ws.waitMsg((m) => m.t === 'p2p-joined' || m.t === 'error');
  return ws;
}

test('status reports server hosting off; create is refused when unavailable', async () => {
  const res = await fetch(`http://${srv.base}/status`);
  assert.equal((await res.json()).serverHosting.available, false);
  const c = await makeClient(srv.base);
  c.cmd({ t: 'create', tc: 'none', color: 'white' });
  const err = await c.waitMsg((m) => m.t === 'error');
  assert.equal(err.code, 'busy');
  c.close();
});

test('guest joins a player-hosted game and plays through the relay', async () => {
  const host = await startHost();
  const guest = await startGuest();
  assert.equal(guest.msgs.find((m) => m.t === 'p2p-joined').hostOnline, true);
  const s = await guest.untilHost((s) => s.you === 'black' && s.status === 'playing');
  assert.equal(s.players.white.name, 'Hosty');
  host.game.handle('local', { t: 'move', from: 'e2', to: 'e4' });
  await guest.untilHost((s) => s.moves.length === 1);
  guest.toHost({ t: 'move', from: 'e7', to: 'e5' });
  await guest.untilHost((s) => s.moves.length === 2);
  assert.equal(host.game.moves[1].san, 'e5');
  // signaling payloads are relayed untouched in both directions
  guest.toHost({ t: 'signal', sdp: { type: 'offer', sdp: 'v=0' } });
  await host.waitMsg((m) => m.t === 'fwd' && m.data.t === 'signal');
  host.cmd({ t: 'fwd', to: host.msgs.find((m) => m.t === 'peer-join').peerId, data: { t: 'signal', candidate: { candidate: 'x' } } });
  await guest.waitMsg((m) => m.t === 'fwd' && m.data.t === 'signal');
  host.cmd({ t: 'close' });
  await guest.waitMsg((m) => m.t === 'room-closed');
  [host, guest].forEach((w) => w.close());
});

test('host drop and return (refresh / server restart) re-introduces waiting guests', async () => {
  let host = await startHost('p2pRoom2');
  const guest = await startGuest('p2pRoom2');
  const first = await guest.untilHost((s) => s.you === 'black');
  guest.cmd({ t: 'peer-token', token: first.token }); // what the browser guest does on getting a seat
  await sleep(50);
  host.game.handle('local', { t: 'move', from: 'd2', to: 'd4' });
  await guest.untilHost((s) => s.moves.length === 1);
  const saved = JSON.parse(JSON.stringify(host.game.toJSON()));
  host.game.destroy();
  host.close();
  await guest.waitMsg((m) => m.t === 'host-gone');

  host = await startHost('p2pRoom2', saved); // same id + secret, restored game
  await guest.waitMsg((m) => m.t === 'host-back');
  const s = await guest.untilHost((s) => s.seq > saved.seq && s.you === 'black');
  assert.equal(s.moves[0].san, 'd4');
  [host, guest].forEach((w) => w.close());
});

test('room ids are protected by the host secret', async () => {
  const host = await startHost('p2pRoom3');
  const thief = await makeClient(srv.base);
  thief.cmd({ t: 'host', room: 'p2pRoom3', secret: 'wrong-secret-wrong-secret' });
  const err = await thief.waitMsg((m) => m.t === 'error');
  assert.equal(err.code, 'taken');
  [host, thief].forEach((w) => w.close());
});

test('a participant arriving before the host gets a retryable error', async () => {
  const early = await makeClient(srv.base);
  early.cmd({ t: 'join', room: 'notHereYet', token: 'abc' });
  const err = await early.waitMsg((m) => m.t === 'error');
  assert.equal(err.code, 'unknown-room');
  assert.equal(err.fatal, false);
  early.close();
});
