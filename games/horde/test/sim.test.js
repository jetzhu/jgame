// Rules of the simulation, on hand-built scenes (no level generator noise).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, applyGate, addEnemy, finishMultiplier, DT, BULLET_SPEED, HALF_W, HOLD, GATE_HOLD } from '../src/sim.js';

/** An empty campaign game: no generated content, a long track, the squad at the center. */
function blank(opts = {}) {
  const g = createGame({ level: 1, ...opts });
  Object.assign(g, { enemies: [], dormant: [], gates: [], vaults: [], slabs: [], tides: [], gatehouses: [], walls: [], crates: [], barrels: [], boss: null, length: 1e6 });
  return g;
}
const run = (g, secs, input = null) => {
  for (let i = 0; i < secs / DT && g.status === 'play'; i++) step(g, input);
};

test('gate math rounds and clamps', () => {
  assert.equal(applyGate(10, '+', 5), 15);
  assert.equal(applyGate(10, '-', 15), 0);
  assert.equal(applyGate(10, 'x', 3), 30);
  assert.equal(applyGate(11, '/', 2), 5);
  assert.equal(applyGate(9000, 'x', 2), 9999);
});

test('crossing a gate applies it once; the rest of its choice row disappears', () => {
  const g = blank({ start: 10 });
  g.gates.push({ id: 1, x0: -HALF_W, x1: 0, z: 3, op: '+', value: 7, group: 9, used: false });
  g.gates.push({ id: 2, x0: 0, x1: HALF_W, z: 3, op: 'x', value: 2, group: 9, used: false });
  run(g, 2, { tx: -2 });
  assert.equal(g.squad.count, 17);
  assert.ok(g.gates.every((x) => x.used));
});

test('one bullet carries leftover damage through several weak enemies', () => {
  const g = blank({ start: 1 });
  g.squad.count = 0; // nobody fires; we place the bullet by hand
  for (let i = 0; i < 3; i++) addEnemy(g, 0, 4.4 + i * 0.1, 'grunt', 1);
  g.enemies.push(...g.dormant.splice(0));
  g.bullets.push({ x: 0, z: 4, vx: 0, dmg: 2.5, life: 1 });
  g.squad.count = 1;
  g.rate = 0;
  step(g, null);
  const alive = g.enemies.filter((e) => e.hp > 0);
  assert.equal(alive.length, 1, 'two enemies killed by one bullet');
  assert.ok(alive[0].hp < 1, 'the third is wounded by the remainder');
});

test('total damage dealt per second scales with the squad, not with bullet count', () => {
  const dmgIn = (count) => {
    const g = blank({ start: count });
    g.vaults.push({ id: 1, x0: -HALF_W, x1: HALF_W, z: 20, depth: 1, hp: 1e9, maxHp: 1e9 });
    g.squad.z = 0;
    for (let i = 0; i < 120; i++) {
      g.squad.z = 0; // hold still so every bullet lands
      step(g, null);
    }
    return 1e9 - g.vaults[0].hp;
  };
  const a = dmgIn(10);
  const b = dmgIn(100);
  assert.ok(Math.abs(b / a - 10) < 1.5, `ratio ${b / a}`);
});

test('a closed vault blocks its lane and the gates behind it; shooting it open unlocks them', () => {
  const g = blank({ start: 10 });
  g.vaults.push({ id: 5, x0: 1.6, x1: 4.4, z: 8, depth: 1.4, hp: 1e9, maxHp: 1e9 });
  g.gates.push({ id: 6, x0: 1.5, x1: 4.5, z: 10, op: '+', value: 50, lockedBy: 5, used: false });
  while (g.squad.z < 8) step(g, { tx: 3 });
  assert.ok(g.squad.x < 1.6, 'pushed out of the vault lane');
  run(g, 2, { tx: 3 });
  assert.equal(g.squad.count, 10, 'the locked gate did nothing');

  const h = blank({ start: 40 });
  h.vaults.push({ id: 5, x0: 1.6, x1: 4.4, z: 20, depth: 1.4, hp: 30, maxHp: 30 });
  h.gates.push({ id: 6, x0: 1.5, x1: 4.5, z: 22, op: '+', value: 50, lockedBy: 5, used: false });
  run(h, 6, { tx: 3 });
  assert.equal(h.squad.count, 90);
});

test('walls keep the squad in (or out of) a lane', () => {
  const g = blank();
  g.walls.push({ x: 1.5, z0: 0, z1: 100 });
  run(g, 2, { tx: 3 });
  assert.ok(g.squad.x < 1.5);
});

test('enemies that reach the squad take soldiers with them; zero soldiers loses', () => {
  const g = blank({ start: 3 });
  g.rate = 0; // no shooting
  for (let i = 0; i < 5; i++) addEnemy(g, 0, 6 + i, 'grunt', 1);
  run(g, 10);
  assert.equal(g.status, 'lost');
  assert.equal(g.squad.count, 0);
});

test('reaching the finish wins; the multiplier grows with survivors', () => {
  const g = blank({ start: 30 });
  g.length = 20;
  run(g, 10);
  assert.equal(g.status, 'won');
  assert.ok(g.result.mult >= 2);
  assert.equal(finishMultiplier(0, 1), 1);
  assert.ok(finishMultiplier(1000, 1) === 5);
  assert.ok(finishMultiplier(30, 10) < finishMultiplier(30, 1) + 1);
});

test('a pump gate improves while shot', () => {
  const g = blank({ start: 20 });
  g.gates.push({ id: 7, x0: -1.5, x1: 1.5, z: 25, op: '-', value: 3, pump: true, acc: 0, step: 5, used: false });
  for (let i = 0; i < 90; i++) {
    g.squad.z = 0;
    step(g, null);
  }
  const gt = g.gates[0];
  assert.equal(gt.op, '+');
  assert.ok(gt.value > 1);
});

test('bullets fly straight at BULLET_SPEED', () => {
  const g = blank({ start: 1 });
  g.rate = 0;
  g.bullets.push({ x: 0, z: 0, vx: 0, dmg: 1, life: 1 });
  step(g, null);
  assert.ok(Math.abs(g.bullets[0].z - BULLET_SPEED * DT) < 1e-9);
});

test('same seed, same inputs, same game', () => {
  const play = () => {
    const g = createGame({ level: 7 });
    for (let i = 0; i < 1200; i++) step(g, { tx: Math.sin(i / 50) * 3 });
    return [g.squad.count, g.squad.z.toFixed(6), g.stats.kills, g.enemies.length];
  };
  assert.deepEqual(play(), play());
});

test('holding boost doubles forward speed', () => {
  const plain = blank();
  const fast = blank();
  run(plain, 1, { tx: 0 });
  run(fast, 1, { tx: 0, boost: true });
  assert.ok(Math.abs(fast.squad.z / plain.squad.z - 2) < 1e-9, `${fast.squad.z} vs ${plain.squad.z}`);
  // still slows down near enemies, just from a higher top speed
  const near = blank();
  addEnemy(near, 0, 12, 'grunt', 1e9);
  near.enemies.push(...near.dormant.splice(0));
  step(near, { tx: 0, boost: true });
  assert.ok(near.squad.speed < 2 * 6 && near.squad.speed > 0);
});

/** A raised slab at z=30..50 held by one pillar on the right, with a locked gate on top. */
function slabScene(pillarHp) {
  const g = blank({ start: 20 });
  g.slabs.push({ id: 1, z0: 30, z1: 50, tiltSide: -1, pillar: 2, down: false, fellAt: null });
  g.vaults.push({ id: 2, x0: 2.6, x1: 4.35, z: 30, depth: 1.6, hp: pillarHp, maxHp: pillarHp, pillar: true, slab: 1 });
  g.gates.push({ id: 3, x0: 1.8, x1: HALF_W, z: 40, op: '+', value: 50, lockedBy: 2, slab: 1, used: false });
  return g;
}

test('the squad holds in front of a raised slab', () => {
  const g = slabScene(1e9);
  run(g, 10, { tx: 0 });
  assert.ok(Math.abs(g.squad.z - (30 - HOLD)) < 1e-6, `stopped at ${g.squad.z}`);
  assert.equal(g.status, 'play');
});

test('shooting the pillar drops the slab: enemies under it are crushed, its gates open', () => {
  const g = slabScene(80);
  for (let i = 0; i < 6; i++) addEnemy(g, -3, 45 + i * 0.5, 'grunt', 1e6); // under the slab, far from the squad
  for (const e of g.dormant) e.speed = 0;
  let fell = null;
  for (let i = 0; i < 30 * 60 && g.status === 'play'; i++) {
    step(g, { tx: 3.4 });
    fell ||= g.events.find((e) => e.t === 'slabFall');
  }
  assert.ok(fell, 'slab fell');
  assert.equal(fell.crushed, 6);
  assert.equal(g.status, 'play');
  assert.ok(g.squad.z > 45, 'the squad walked on');
  assert.equal(g.squad.count, 70, 'took the gate on the slab');
});

/** A tide block straight ahead: `rows` x 6 grunts with `hp`, creeping at `speed`. */
function tideScene({ start = 10, hp = 1e9, speed = 0, rows = 6 } = {}) {
  const g = blank({ start });
  g.tides.push({ id: 50, wallX: 2.5, goldSide: 1, z1: 60, front: Infinity, held: false, cleared: false });
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < 6; c++) {
      const e = addEnemy(g, -3.2 + c * 0.6, 30 + r * 0.6, 'grunt', hp);
      e.speed = speed;
      e.pack = 50;
    }
  g.dormant.sort((a, b) => b.z - a.z);
  return g;
}

test('a tide wakes as one block and the squad cannot walk past its front', () => {
  const g = tideScene();
  run(g, 0.1, { tx: -1.5 });
  assert.equal(g.dormant.length, 0, 'the whole pack woke together');
  run(g, 10, { tx: -1.5 });
  assert.ok(g.squad.z < 30 - 3, `held at ${g.squad.z}`);
  assert.equal(g.status, 'play');
});

test('the gold lane beside a tide is not held, and tide enemies stay behind its wall', () => {
  const g = tideScene({ speed: 0.8 });
  g.walls.push({ x: 2.5, z0: 0, z1: 60 });
  g.squad.x = g.squad.tx = 3.5;
  run(g, 12, { tx: 3.5 });
  assert.ok(g.squad.z > 40, `walked on to ${g.squad.z}`);
  assert.ok(g.enemies.every((e) => e.x < 2.5));
});

test('shooting a tide back lets the squad advance; clearing it is announced', () => {
  const g = tideScene({ start: 30, hp: 1, speed: 0.3 });
  let cleared = false;
  for (let i = 0; i < 20 * 60 && g.status === 'play'; i++) {
    step(g, { tx: -1.5 });
    cleared ||= g.events.some((e) => e.t === 'tideClear');
  }
  assert.ok(cleared);
  assert.ok(g.squad.z > 40);
});

test('ladder gates taken one after another build a streak', () => {
  const g = blank({ start: 1 });
  for (let i = 0; i < 5; i++) g.gates.push({ id: 100 + i, x0: -1, x1: 1, z: 3 + i * 1.5, op: '+', value: 1, ladder: true, used: false });
  const streaks = [];
  for (let i = 0; i < 4 * 60; i++) {
    step(g, { tx: 0 });
    for (const e of g.events) if (e.t === 'gate') streaks.push(e.streak);
  }
  assert.deepEqual(streaks, [1, 2, 3, 4, 5]);
  assert.equal(g.squad.count, 6);
});

test('a brute smashes soldiers, staggers back, and keeps coming until shot down', () => {
  const g = blank({ start: 40 });
  g.rate = 0; // nobody shoots
  addEnemy(g, 0, 8, 'brute', 1e9, 5);
  const smashes = [];
  for (let i = 0; i < 20 * 60 && g.status === 'play'; i++) {
    step(g, { tx: 0 });
    for (const e of g.events) if (e.t === 'smash') smashes.push(e.n);
  }
  assert.ok(smashes.length >= 3, `smashed ${smashes.length} times`);
  assert.ok(smashes.every((n) => n === 5));
  const h = blank({ start: 60 });
  addEnemy(h, 0, 25, 'brute', 300, 5);
  let killed = false;
  for (let i = 0; i < 20 * 60 && !killed; i++) {
    step(h, { tx: 0 });
    killed = h.events.some((e) => e.t === 'kill' && e.brute);
  }
  assert.ok(killed, 'a squad can shoot him down');
});

test('a brute behind a tide waits until the tide is worn down', () => {
  const g = blank({ start: 10 });
  g.tides.push({ id: 7, wallX: 2.5, goldSide: 1, z1: 60, front: Infinity, held: false, cleared: false });
  for (let c = 0; c < 6; c++) {
    const e = addEnemy(g, -3 + c * 0.6, 30, 'grunt', 1e9);
    e.speed = 0;
    e.pack = 7;
  }
  const b = addEnemy(g, 0, 33, 'brute', 1e9, 5);
  b.waitFor = 7;
  g.dormant.sort((a, c) => c.z - a.z);
  run(g, 5, { tx: 0 });
  assert.equal(b.z, 33, 'still waiting');
  for (const e of g.enemies) if (e.pack) e.hp = 0;
  run(g, 1, { tx: 0 });
  assert.ok(b.z < 33, 'walks once the tide is gone');
});

/** A gatehouse at z=30: door in the middle, strongbox slot on the right, `n` queued grunts and a brute. */
function gateScene({ start = 30, n = 20, boxHp = 1e9, bruteHp = 50 } = {}) {
  const g = blank({ start });
  const gh = { id: 9, z: 30, door: [-1, 1], slot: [2.5, HALF_W], box: 10, queue: [], cols: 3, sp: 0.6, pad: 0.4, rate: 4, acc: 0, woke: false, open: false, held: false };
  const q = (e) => Object.assign(e, { held: 9, from: 9, walled: true }) && gh.queue.push(e);
  for (let i = 0; i < n; i++) q(addEnemy(g, -0.6 + (i % 3) * 0.6, 30.7 + Math.floor(i / 3) * 0.6, 'grunt', 1));
  q(addEnemy(g, 0, 30.7 + n / 3 + 1, 'brute', bruteHp, 5));
  g.enemies.push(...g.dormant.splice(0));
  g.vaults.push({ id: 10, x0: 2.6, x1: 4.4, z: 30, depth: 1.4, hp: boxHp, maxHp: boxHp, steel: true });
  g.walls.push({ x: 2.5, z0: 29.3, z1: 50 });
  g.gatehouses.push(gh);
  return g;
}

test('a gatehouse holds the squad while its queue streams out; beating its brute drops the wall', () => {
  const g = gateScene();
  let out = 0;
  let opened = false;
  for (let i = 0; i < 40 * 60 && g.status === 'play' && !opened; i++) {
    step(g, { tx: 0 });
    assert.ok(g.squad.z <= 30 - GATE_HOLD + 1e-6 || g.gatehouses[0].open, `walked through the wall at ${g.squad.z}`);
    out = Math.max(out, g.enemies.filter((e) => !e.held && e.hp > 0).length);
    opened = g.events.some((e) => e.t === 'gateOpen');
  }
  assert.ok(opened, 'the wall dropped');
  assert.ok(out > 0 && out < 20, `a stream, not a flood (${out} out at once)`);
  run(g, 3, { tx: 0 });
  assert.ok(g.squad.z > 31, 'walked on');
});

test('shooting out the strongbox lets the squad slip through the slot', () => {
  const g = gateScene({ boxHp: 40, n: 200, bruteHp: 1e9 });
  const box = g.vaults[0];
  run(g, 15, { tx: 3.5 });
  assert.ok(box.hp <= 0);
  assert.ok(g.squad.z > 35, `through the slot to ${g.squad.z}`);
  assert.ok(g.squad.x > 2.5);
});

test('bullets stop at a gatehouse wall except at the door and the slot', () => {
  const g = gateScene({ n: 0, bruteHp: 1e9 });
  g.enemies.length = 0; // nothing behind the door for the bullet to hit
  g.gatehouses[0].queue.length = 0;
  g.squad.z = 5; // far enough that the gatehouse hasn't woken (and found itself empty)
  g.rate = 0;
  g.bullets.push({ x: -3, z: 28, vx: 0, dmg: 5, life: 1 }, { x: 0, z: 28, vx: 0, dmg: 5, life: 1 });
  for (let i = 0; i < 4; i++) step(g, null);
  assert.equal(g.bullets.length, 1, 'the one at the wall is gone');
  assert.equal(g.bullets[0].x, 0);
});
