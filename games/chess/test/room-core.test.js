// Unit tests for the shared GameRoom (used by the server and by player-hosted browsers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../src/room-core.js';

function setup(tc = 'none') {
  let t = 1_000_000;
  const now = () => t;
  const inbox = new Map();
  const io = { send: (conn, msg) => inbox.set(conn, [...(inbox.get(conn) || []), msg]) };
  let n = 0;
  const room = new GameRoom({ id: 'abcd1234', tc, io, randomToken: () => `tok${++n}`.padEnd(16, 'x'), now });
  return { room, inbox, io, now, advance: (ms) => (t += ms), last: (c) => inbox.get(c).filter((m) => m.t === 'state').at(-1) };
}

test('seats, moves and state per connection', () => {
  const { room, last } = setup();
  room.claimSeat('host', 'white', 'Alice');
  assert.equal(room.join('p1', { name: 'Bob' }), 'black');
  assert.equal(room.join('p2', { name: 'Eve' }), null);
  room.broadcast();
  assert.equal(last('p1').you, 'black');
  assert.equal(last('p2').spectators, 1);
  room.handle('host', { t: 'move', from: 'e2', to: 'e4' });
  room.handle('p2', { t: 'move', from: 'e7', to: 'e5' }); // spectator cannot move
  assert.equal(last('p2').rejected, true);
  room.handle('p1', { t: 'move', from: 'e7', to: 'e5' });
  assert.deepEqual(last('host').moves.map((m) => m.san), ['e4', 'e5']);
  assert.ok(last('host').seq > 0);
});

test('a seat token reclaims the seat from a new connection', () => {
  const { room, last } = setup();
  room.claimSeat('host', 'white', 'Alice');
  room.join('p1', { name: 'Bob' });
  room.broadcast();
  const token = last('p1').token;
  room.detach('p1');
  assert.equal(room.join('p9', { token }), 'black');
});

test('toJSON/fromJSON round trip keeps the game and pauses clocks while saved', () => {
  const a = setup('5+3');
  a.room.claimSeat('host', 'white', 'Alice');
  a.room.join('p1', { name: 'Bob' });
  for (const [c, from, to] of [['host', 'e2', 'e4'], ['p1', 'e7', 'e5'], ['host', 'g1', 'f3']]) {
    a.advance(1000);
    a.room.handle(c, { t: 'move', from, to });
  }
  a.advance(4000); // black thinks 4s, then the host saves
  const saved = JSON.parse(JSON.stringify(a.room.toJSON()));
  assert.equal(saved.clock.black, 300000 - 4000);
  a.room.destroy();

  const b = setup('5+3');
  b.advance(60_000); // a minute passes while the host's page is closed
  const room = GameRoom.fromJSON(saved, { io: b.io, randomToken: () => 'x'.repeat(16), now: b.now });
  assert.equal(room.moves.length, 3);
  assert.equal(room.remaining('black'), 300000 - 4000); // downtime not charged
  assert.equal(room.seatOf(saved.seats.black.token), 'black');
  b.advance(2000);
  assert.equal(room.remaining('black'), 300000 - 6000);
  room.destroy();
});

test('forgive() refunds a frozen interval only to the given side', () => {
  const { room, advance } = setup('3+0');
  room.claimSeat('host', 'white', 'A');
  room.join('p1', {});
  room.handle('host', { t: 'move', from: 'e2', to: 'e4' });
  room.handle('p1', { t: 'move', from: 'e7', to: 'e5' }); // white's clock now runs
  advance(10_000);
  room.forgive(10_000, 'black'); // not running -> no effect
  assert.equal(room.remaining('white'), 170_000);
  room.forgive(10_000, 'white');
  assert.equal(room.remaining('white'), 180_000);
  room.destroy();
});

test('flag fall ends the game on time (draw vs lone king)', async () => {
  const { room, last } = setup('1+0');
  room.claimSeat('host', 'white', 'A');
  room.join('p1', {});
  room.handle('host', { t: 'move', from: 'e2', to: 'e4' });
  room.handle('p1', { t: 'move', from: 'e7', to: 'e5' });
  room.clock.white = 0;
  room.checkFlag();
  assert.deepEqual(last('p1').result, { winner: 'black', reason: 'timeout' });
});
