// Level generation. Each level is a run of segments (gate choices, hordes, the vault gauntlet,
// crates, pump gates) sized from the squad the player is expected to have at that point (gen.E),
// so numbers stay exciting whether the squad is 8 or 800. Endless mode appends segments lazily.
import { LANES, LANE_W, HALF_W, TIDE_SPEED, GATE_HOLD, addEnemy, squadRadius, newId, applyGate, clamp } from './sim.js';

const SPACING = 0.62;

/** Round to a number that reads well on a gate. */
export function nice(n) {
  n = Math.max(1, n);
  if (n < 12) return Math.round(n);
  if (n < 60) return Math.round(n / 5) * 5;
  if (n < 300) return Math.round(n / 10) * 10;
  if (n < 1500) return Math.round(n / 50) * 50;
  return Math.round(n / 100) * 100;
}

const hpUnit = (d) => 1 + Math.floor((d - 1) / 4);
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];
const laneRange = (i) => [LANES[i] - LANE_W / 2, LANES[i] + LANE_W / 2];

/** Fill [x0,x1] from zStart with enemies worth about `budget` damage. Returns the horde depth. */
function placeHorde(g, budget, x0, x1, zStart) {
  const { rand, d } = g.gen;
  const cols = Math.max(1, Math.floor((x1 - x0) / SPACING));
  const hp = Math.max(hpUnit(d), Math.ceil(budget / 650));
  const n = clamp(Math.round(budget / hp), 6, 700);
  const rows = Math.ceil(n / cols);
  const pad = (x1 - x0 - (cols - 1) * SPACING) / 2;
  let i = 0;
  for (let r = 0; r < rows && i < n; r++)
    for (let c = 0; c < cols && i < n; c++, i++) {
      const x = x0 + pad + c * SPACING + (rand() - 0.5) * 0.12;
      const z = zStart + r * SPACING + (rand() - 0.5) * 0.12;
      addEnemy(g, x, z, 'grunt', hp);
    }
  // elites lead the horde out, a couple of steps in front of it
  const elites = d < 2 && !g.gen.tutorialElite ? 0 : d < 6 ? 1 : d < 12 ? 2 : 3;
  for (let k = 0; k < elites && budget > 40; k++) {
    const x = x0 + ((k + 1) / (elites + 1)) * (x1 - x0);
    addEnemy(g, x, zStart - 1.6 - rand() * 0.8, 'elite', Math.ceil(g.gen.E * g.gen.perSoldier * 0.6));
  }
  return rows * SPACING;
}

// Firepower-seconds a horde soaks up: grows slowly with difficulty.
// `ramp` only grows in endless mode, where the run should end eventually.
const early = (d) => Math.min(1, 0.45 + 0.15 * d); // the first few levels go easy
const soak = (gen, base) =>
  gen.E * gen.perSoldier * base * 2.2 * early(gen.d) * (1 + Math.min(gen.d, 40) * 0.03) * (gen.ramp || 1);
const lose = (gen, frac) => (gen.E = Math.max(3, gen.E * (1 - frac)));

/** A brute sized for a squad of about E: a few seconds of its full fire, and he hits hard. */
function addBrute(g, x, z, E) {
  const { perSoldier, d } = g.gen;
  const hp = Math.ceil(E * perSoldier * (2.5 + Math.min(d, 30) * 0.04) * (g.gen.ramp || 1));
  return addEnemy(g, x, z, 'brute', hp, Math.ceil(4 + E * 0.12));
}

function gate(g, x0, x1, z, op, value, extra = {}) {
  const gt = { id: newId(g), x0, x1, z, op, value, used: false, ...extra };
  g.gates.push(gt);
  return gt;
}

// ------------------------------------------------------------------ segments
const SEGMENTS = {
  // Two or three gates side by side: take exactly one.
  choice(g, z0, first = false) {
    const { rand, E, d } = g.gen;
    const good = () =>
      rand() < (E < 250 ? 0.35 : 0.15) ? ['x', d > 6 && rand() < 0.25 ? 3 : 2] : ['+', nice(E * (0.5 + rand() * 0.6) + 2)];
    const bad = () => (d >= 3 && rand() < 0.35 ? ['/', 2] : ['-', nice(E * (0.25 + rand() * 0.3) + 1)]);
    const three = d >= 2 && rand() < 0.4;
    let opts = three ? [good(), good(), bad()] : rand() < 0.75 ? [good(), bad()] : [good(), good()];
    for (let i = opts.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [opts[i], opts[j]] = [opts[j], opts[i]];
    }
    const w = (2 * HALF_W) / opts.length;
    const group = newId(g);
    opts.forEach(([op, v], i) => gate(g, -HALF_W + i * w, -HALF_W + (i + 1) * w, z0 + 10, op, v, { group }));
    g.gen.E = Math.max(...opts.map(([op, v]) => applyGate(Math.round(E), op, v))) * 0.92;
    let len = 22;
    if (!first && d >= 2 && rand() < 0.5) {
      const [x0, x1] = laneRange(Math.floor(rand() * 3));
      len += placeHorde(g, soak(g.gen, 1.2), x0, x1, z0 + 20) + 6;
      lose(g.gen, 0.08);
    }
    return len;
  },

  // A block of enemies marching down one lane, two lanes, or the whole bridge.
  horde(g, z0) {
    const { rand, d } = g.gen;
    const r = rand();
    let x0;
    let x1;
    if (r < 0.45 || d < 2) [x0, x1] = laneRange(Math.floor(rand() * 3));
    else if (r < 0.8) [x0, x1] = rand() < 0.5 ? [-HALF_W, 1.5] : [-1.5, HALF_W];
    else [x0, x1] = [-HALF_W, HALF_W];
    const depth = placeHorde(g, soak(g.gen, 2.2), x0, x1, z0 + 14);
    if (d >= 10 && rand() < 0.3) {
      addBrute(g, (x0 + x1) / 2, z0 + 10.5, g.gen.E);
      lose(g.gen, 0.06);
    }
    lose(g.gen, 0.12);
    return depth + 22;
  },

  // The classic: a lane of small + gates, the horde down the middle, and a vault guarding a
  // walled lane of big gold gates. Shoot the vault open, or deal with the horde first?
  gauntlet(g, z0) {
    const { rand, E } = g.gen;
    const side = rand() < 0.5 ? 0 : 2;
    const vaultLane = 2 - side;
    const L = Math.round(34 + rand() * 16);
    const small = Math.max(1, nice(E / 30));
    const [sx0, sx1] = laneRange(side);
    let n = 0;
    for (let z = z0 + 6; z < z0 + L; z += 2.2, n++) gate(g, sx0, sx1, z, '+', small, { row: true });
    const [vx0, vx1] = laneRange(vaultLane);
    const vault = { id: newId(g), x0: vx0 + 0.1, x1: vx1 - 0.1, z: z0 + 6, depth: 1.4, hp: 0, maxHp: 0 };
    const look = rand();
    if (look < 0.35) vault.sack = true;
    else if (look < 0.65) vault.steel = true;
    vault.hp = vault.maxHp = Math.ceil(E * g.gen.perSoldier * (2.6 + rand() * 1.6));
    g.vaults.push(vault);
    const gold = nice(E * 0.1 + 2);
    let m = 0;
    for (let z = z0 + 9; z < z0 + L; z += 3, m++) gate(g, vx0, vx1, z, '+', gold, { lockedBy: vault.id, gold: true });
    const wx = vaultLane === 0 ? -LANE_W / 2 : LANE_W / 2;
    g.walls.push({ x: wx, z0: z0 + 6 - 0.7, z1: z0 + L + 1 });
    placeHorde(g, soak(g.gen, 2.4), -LANE_W / 2, LANE_W / 2, z0 + 15);
    g.gen.E = E + n * small * 0.45 + m * gold * 0.35;
    lose(g.gen, 0.1);
    return L + 10;
  },

  // A crate with a power-up in one lane; a small horde with an explosive barrel in another.
  crate(g, z0) {
    const { rand, E, d } = g.gen;
    const lane = Math.floor(rand() * 3);
    const [x0, x1] = laneRange(lane);
    const kind = pick(rand, ['rate', 'dmg', 'spread', 'troops']);
    const hp = Math.ceil(E * g.gen.perSoldier * 1.3);
    g.crates.push({ id: newId(g), x: (x0 + x1) / 2, z: z0 + 12, hp, maxHp: hp, kind, value: nice(E * 0.5 + 2) });
    const other = (lane + 1 + Math.floor(rand() * 2)) % 3;
    const [hx0, hx1] = laneRange(other);
    const depth = placeHorde(g, soak(g.gen, 1.5), hx0, hx1, z0 + 16);
    const bhp = hpUnit(d) * 2;
    g.barrels.push({ id: newId(g), x: (hx0 + hx1) / 2, z: z0 + 15.2, hp: bhp, blast: hpUnit(d) * 6 + 2 });
    if (kind === 'troops') g.gen.E += E * 0.3;
    else g.gen.perSoldier *= 1.1;
    lose(g.gen, 0.08);
    return Math.max(26, depth + 22);
  },

  // A gate that starts bad and improves while you shoot it, next to a plain decent gate.
  pump(g, z0) {
    const { rand, E } = g.gen;
    const left = rand() < 0.5;
    const half = left ? [-HALF_W, 0] : [0, HALF_W];
    const otherHalf = left ? [0, HALF_W] : [-HALF_W, 0];
    const group = newId(g);
    const start = nice(E * 0.3 + 1);
    const pumpStep = g.gen.perSoldier / 0.14;
    gate(g, half[0], half[1], z0 + 18, '-', start, { group, pump: true, acc: 0, step: pumpStep });
    gate(g, otherHalf[0], otherHalf[1], z0 + 18, '+', nice(E * 0.3 + 2), { group });
    g.gen.E = E * 1.3;
    return 28;
  },
};

// The set piece: a concrete slab covered in gates, raised over a garage full of the horde. One
// pillar is already down (the slab tilts to that side, and a strip of small gates runs along that
// edge); the other pillar has HP and holds the slab up. The squad must stop in front of the slab,
// survive the horde pouring out, and shoot the pillar. Then the slab slams flat, crushing what's
// still underneath, and its field of gates is open: small + gates in every column, gold ones in the
// column on the pillar's side.
SEGMENTS.collapse = function (g, z0) {
  const { rand, E } = g.gen;
  const tilt = rand() < 0.5 ? -1 : 1; // side that is already down
  const pillarSide = -tilt;
  // approach: small gates along the low edge
  const L1 = 30; // the strip ends before the hold line (sim HOLD = 10)
  const ex0 = tilt < 0 ? -HALF_W : HALF_W - 1.6;
  const small = Math.max(1, nice(E / 30));
  let n = 0;
  for (let z = z0 + 4; z < z0 + L1 - 12; z += 1.8, n++) gate(g, ex0, ex0 + 1.6, z, '+', small, { row: true });
  g.gen.E = E + n * small * 0.6;
  // slab, pillar and the garage horde
  const sz0 = z0 + L1;
  const D = 24 + Math.round(rand() * 8);
  const slab = { id: newId(g), z0: sz0, z1: sz0 + D, tiltSide: tilt, pillar: 0, down: false, fellAt: null };
  const [px0, px1] = pillarSide < 0 ? [-HALF_W + 0.15, -HALF_W + 1.9] : [HALF_W - 1.9, HALF_W - 0.15];
  const hp = Math.ceil(g.gen.E * g.gen.perSoldier * (3 + rand() * 1.5));
  const pillar = { id: newId(g), x0: px0, x1: px1, z: sz0, depth: 1.6, hp, maxHp: hp, pillar: true, slab: slab.id };
  slab.pillar = pillar.id;
  g.vaults.push(pillar);
  g.slabs.push(slab);
  // the garage horde shuffles out more slowly than an open-road horde
  const before = g.dormant.length;
  g.gen.tutorialElite = true;
  placeHorde(g, soak(g.gen, 2.2), -HALF_W + 0.3, HALF_W - 0.3, sz0 + 1);
  g.gen.tutorialElite = false;
  for (let i = before; i < g.dormant.length; i++) {
    g.dormant[i].speed *= 0.6;
    g.dormant[i].garage = slab.id;
  }
  lose(g.gen, 0.12);
  // the field on top
  const cols = 5;
  const w = (2 * HALF_W) / cols;
  const goldCol = pillarSide < 0 ? 0 : cols - 1;
  const fieldSmall = Math.max(1, nice(g.gen.E / 25));
  const gold = nice(g.gen.E * 0.08 + 3);
  let rows = 0;
  for (let z = sz0 + 2; z < sz0 + D - 1; z += 2.4, rows++)
    for (let c = 0; c < cols; c++)
      gate(g, -HALF_W + c * w, -HALF_W + (c + 1) * w, z, '+', c === goldCol ? gold : fieldSmall, {
        lockedBy: pillar.id,
        slab: slab.id,
        gold: c === goldCol,
      });
  g.gen.E += rows * gold * 0.85; // players run the gold column
  return L1 + D + 6;
};

// A strip of small + gates hugging one rail, one after another (each is its own pickup), with a
// horde marching down the rest of the bridge. Stay on the ladder and grow, or step out to shoot.
SEGMENTS.ladder = function (g, z0) {
  const { rand, E } = g.gen;
  const left = rand() < 0.5;
  const [x0, x1] = left ? [-HALF_W, -HALF_W + 1.6] : [HALF_W - 1.6, HALF_W];
  const v = Math.max(1, nice(E / 12));
  const L = Math.round(30 + rand() * 12);
  let n = 0;
  for (let z = z0 + 4; z < z0 + L; z += 1.7, n++) gate(g, x0, x1, z, '+', v, { ladder: true });
  const [hx0, hx1] = left ? [-HALF_W + 1.9, HALF_W] : [-HALF_W, HALF_W - 1.9];
  placeHorde(g, soak(g.gen, 1.8), hx0, hx1, z0 + 16);
  g.gen.E = E + n * v * 0.6;
  lose(g.gen, 0.1);
  return L + 8;
};

// The tide: a huge packed horde fills the road and creeps at you; you can't get past its front.
// A ladder of small + gates runs along one rail, below the tide and then buried in it, so the squad
// grows only as fast as it chews its way up the rail. On the far side, a walled lane of big gold gates is
// plugged by sacks: shoot them open (while the tide creeps in) and run the gold lane past it all.
const HOLD_FRAC = 0.35;
SEGMENTS.tide = function (g, z0) {
  const { rand, E } = g.gen;
  const ladderLeft = rand() < 0.5;
  const sgn = ladderLeft ? 1 : -1; // + toward the gold lane
  const rail = -sgn * HALF_W; // the ladder's rail
  const wallX = sgn * (HALF_W - 2); // the gold lane is 2 wide
  // the ladder: starts on the open road below the tide and runs the tide's length
  const lx = [rail, rail + sgn * 1.5].sort((a, b) => a - b);
  const v = Math.max(1, nice(E / 30));
  const front = z0 + 20;
  const depth = Math.round(22 + rand() * 6);
  let n = 0;
  for (let z = z0 + 2; z < front + depth - 1; z += 1.5, n++) gate(g, lx[0], lx[1], z, '+', v, { ladder: true });
  const Eavg = E + n * v * 0.55;
  // the tide itself, beside the ladder strip and up to the gold lane's wall
  const td = { id: newId(g), wallX, goldSide: sgn, z1: front + depth, front: Infinity, held: false, cleared: false };
  g.tides.push(td);
  const [tx0, tx1] = [rail + sgn * 0.3, wallX - sgn * 0.6].sort((a, b) => a - b);
  const sp = SPACING * 0.85;
  const cols = Math.floor((tx1 - tx0) / sp);
  const budget = soak({ ...g.gen, E: Eavg }, 1.7);
  // always densely packed: a weak tide is many weak bodies, not a sparse one
  const rows = Math.floor(depth / sp);
  const hp = Math.max(0.5, budget / (cols * rows));
  const gap = (depth - 1) / rows;
  const pad = (tx1 - tx0 - (cols - 1) * sp) / 2;
  // creep so that holding the front takes about HOLD_FRAC of the squad's fire on arrival (it has
  // the ladder gates below the front by then): shoot it and it recedes, look away and it comes on
  const E0 = E + Math.floor((front - 6 - z0 - 2) / 1.5) * v;
  const speed = clamp((HOLD_FRAC * E0 * g.gen.perSoldier * gap) / (Math.min(cols, 5) * hp), 0.2, TIDE_SPEED);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const e = addEnemy(g, tx0 + pad + c * sp + (rand() - 0.5) * 0.08, front + r * gap + (rand() - 0.5) * 0.08, 'grunt', hp);
      e.speed = speed;
      e.pack = td.id;
      e.walled = true;
    }
  // a brute waits at the back and wades in once the tide is worn down
  const br = addBrute(g, (tx0 + tx1) / 2, front + depth + 0.5, Eavg);
  br.waitFor = td.id;
  // the sacks and the gold lane behind them
  const gx = [wallX, sgn * HALF_W].sort((a, b) => a - b);
  const sackHp = Math.ceil(Eavg * g.gen.perSoldier * (1.1 + rand() * 0.4));
  const sz = front;
  const sacks = { id: newId(g), x0: gx[0] + 0.1, x1: gx[1] - 0.1, z: sz, depth: 1.4, hp: sackHp, maxHp: sackHp, sack: true };
  g.vaults.push(sacks);
  g.walls.push({ x: wallX, z0: sz - 0.7, z1: front + depth + 1 });
  const gold = nice(Eavg * 0.3 + 3);
  let m = 0;
  for (let z = sz + 4; z < front + depth - 1; z += 5, m++) gate(g, gx[0], gx[1], z, '+', gold, { lockedBy: sacks.id, gold: true });
  g.gen.E = Eavg + m * gold * 0.5;
  lose(g.gen, 0.12);
  return 20 + depth + 10;
};

// The gatehouse: a steel wall across the road, with the horde queued behind it. They come out of
// the door in a steady stream (a brute last); the squad holds in front of the wall until he is down
// and the wall drops. A ladder of + plates runs along one rail; on the other, a steel strongbox
// plugs a slot into a walled gold lane: shoot it out and you can slip through early.
const GATE_FRAC = 0.35; // share of the squad's fire it takes to keep up with the stream
SEGMENTS.gatehouse = function (g, z0) {
  const { rand, E, d } = g.gen;
  const sgn = rand() < 0.5 ? 1 : -1; // the strongbox's side
  const rail = -sgn * HALF_W;
  const wz = z0 + 30;
  const v = Math.max(1, nice(E / 30));
  const lx = [rail, rail + sgn * 1.5].sort((a, b) => a - b);
  let n = 0;
  for (let z = z0 + 2; z < wz - GATE_HOLD - 0.5; z += 1.5, n++) gate(g, lx[0], lx[1], z, '+', v, { ladder: true });
  const E0 = E + n * v * 0.8;
  const ps = g.gen.perSoldier;
  const slot = [sgn * (HALF_W - 2), sgn * HALF_W].sort((a, b) => a - b);
  const dc = -sgn * 0.4;
  const door = [dc - 1.1, dc + 1.1];
  // the queue behind the door
  const budget = soak({ ...g.gen, E: E0 }, 2.0);
  const unit = hpUnit(d);
  const count = clamp(Math.round(budget / unit), 30, 240);
  const hp = Math.max(unit, budget / count);
  const sp = SPACING * 0.85;
  const cols = Math.floor((door[1] - door[0] - 0.2) / sp) + 1;
  const pad = (door[1] - door[0] - (cols - 1) * sp) / 2;
  const gh = { id: newId(g), z: wz, door, slot, box: 0, queue: [], cols, sp, pad, acc: 0, woke: false, open: false, held: false };
  // the stream starts as the squad walks up the ladder: size it for the squad halfway up
  gh.rate = clamp((GATE_FRAC * (E + n * v * 0.4) * ps) / hp, 1.5, 10);
  const pack = newId(g);
  const queue = (e) => {
    e.held = gh.id;
    e.from = gh.id;
    e.pack = pack;
    e.walled = true;
    gh.queue.push(e);
  };
  for (let i = 0; i < count; i++)
    queue(addEnemy(g, door[0] + pad + (i % cols) * sp, wz + 0.7 + Math.floor(i / cols) * sp, 'grunt', hp));
  const depth = Math.ceil(count / cols) * sp + 2;
  queue(addBrute(g, dc, wz + depth, E0));
  // the strongbox and the gold lane behind it
  const boxHp = Math.ceil(E0 * ps * (1.4 + rand() * 0.4));
  const box = { id: newId(g), x0: slot[0] + 0.1, x1: slot[1] - 0.1, z: wz, depth: 1.4, hp: boxHp, maxHp: boxHp, steel: true };
  gh.box = box.id;
  g.vaults.push(box);
  g.walls.push({ x: sgn * (HALF_W - 2), z0: wz - 0.7, z1: wz + depth + 2 });
  const gold = nice(E0 * 0.3 + 3);
  let m = 0;
  for (let z = wz + 3; z < wz + depth; z += 5, m++) gate(g, slot[0], slot[1], z, '+', gold, { lockedBy: box.id, gold: true });
  g.gatehouses.push(gh);
  g.gen.E = E0 + m * gold * 0.15; // most players hold the door rather than take the slot
  lose(g.gen, 0.12);
  return 30 + depth + 8;
};

const WEIGHTS = [
  ['horde', 3, 1],
  ['choice', 2, 1],
  ['gauntlet', 2.2, 2],
  ['crate', 1.2, 2],
  ['pump', 1, 3],
  ['collapse', 1.3, 3],
  ['ladder', 1, 1],
  ['tide', 0.7, 4],
  ['gatehouse', 0.7, 7],
];
const SET_PIECES = ['tide', 'gatehouse']; // long: at most one of each per level

function pickSegment(rand, d, last, used = []) {
  // the tide is a long set piece: at most one per level
  const opts = WEIGHTS.filter(([name, , min]) => d >= min && name !== last && !(SET_PIECES.includes(name) && used.includes(name)));
  let total = opts.reduce((s, o) => s + o[1], 0);
  let r = rand() * total;
  for (const [name, w] of opts) if ((r -= w) <= 0) return name;
  return opts[0][0];
}

function addBoss(g, z) {
  const gen = g.gen;
  // a small escort trails the boss
  const before = g.dormant.length;
  placeHorde(g, soak(gen, 0.5), -2.2, 2.2, z + 2.5);
  for (let i = before; i < g.dormant.length; i++) g.dormant[i].speed = 1.4;
  const hp = Math.ceil(gen.E * gen.perSoldier * 5 * (1 + Math.min(gen.d, 40) * 0.02) * (gen.ramp || 1));
  g.boss = {
    x: 0,
    z,
    r: 1.6,
    hp,
    maxHp: hp,
    speed: 1.4,
    drain: 3 + gen.E * 0.08,
    drainAcc: 0,
    slam: null, // { x, z, r, t, dur } while a slam is winding up
    slamCd: 1.2,
    slamEvery: 3.2,
    slamPower: 4 + gen.E * 0.25,
    active: false,
    contact: false,
    dead: false,
  };
}

export const isBossLevel = (level) => level % 5 === 0;
/** Every third non-boss level opens with the tide, and the squad starts nearly from one. */
export const isTideLevel = (level) => level % 3 === 0 && !isBossLevel(level);
/** Every fourth level (that isn't a boss or tide level) opens with a gatehouse. */
export const isGateLevel = (level) => level % 4 === 0 && !isBossLevel(level) && !isTideLevel(level);

/** Campaign level: lay out every segment now. Returns the finish z. */
export function buildLevel(g) {
  const gen = g.gen;
  const d = g.level;
  const plan =
    d === 1
      ? ['choice', 'horde', 'collapse']
      : d === 2
        ? ['choice', 'gauntlet', 'collapse']
        : [isTideLevel(d) ? 'tide' : isGateLevel(d) ? 'gatehouse' : 'choice', ...Array.from({ length: 2 + Math.min(8, Math.floor(d * 0.5)) }, () => null)];
  if (isTideLevel(d)) {
    // upgrades still count: 1 soldier plus one per squad upgrade
    const s = g.squad;
    s.count = Math.max(1, s.count - 4);
    s.r = squadRadius(s.count);
    g.stats.peak = s.count;
    gen.E = Math.max(1, gen.E - 4);
  }
  if (isBossLevel(d) && plan[plan.length - 1] !== 'collapse') plan.push('collapse');
  let z = 8;
  let last = null;
  for (let [i, name] of plan.entries()) {
    name ||= pickSegment(gen.rand, d, last, g.segs.map((x) => x.name));
    const len = SEGMENTS[name](g, z, i === 0);
    g.segs.push({ name, z0: z, z1: z + len });
    z += len;
    last = name;
  }
  if (isBossLevel(d)) {
    // the boss waits at the far end of the slab and steps out once it falls
    addBoss(g, z + 6);
    return z + 8;
  }
  const len = placeHorde(g, soak(gen, 3), -HALF_W, HALF_W, z + 12) + 16;
  g.segs.push({ name: 'final', z0: z, z1: z + len });
  return z + len;
}

/** Endless mode: append one segment at z0 and return its length. */
export function endlessSegment(g, z0) {
  const gen = g.gen;
  gen.d = 1 + z0 / 70;
  gen.ramp = 1 + z0 / 500;
  gen.E = Math.max(5, (gen.E + g.squad.count) / 2);
  gen.n = (gen.n || 0) + 1;
  if (gen.n % 7 === 0 && (!g.boss || g.boss.dead)) {
    addBoss(g, z0 + 20);
    return 30;
  }
  // a set piece at most every eighth segment
  const recent = gen.n - (gen.setAt ?? -99) < 8 ? SET_PIECES : [];
  const name = gen.n === 1 ? 'choice' : pickSegment(gen.rand, Math.min(gen.d, 7), gen.last, recent);
  if (SET_PIECES.includes(name)) gen.setAt = gen.n;
  gen.last = name;
  return SEGMENTS[name](g, z0, gen.n === 1);
}
