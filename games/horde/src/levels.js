// Level generation. Each level is a run of segments (gate choices, hordes, the vault gauntlet,
// crates, pump gates) sized from the squad the player is expected to have at that point (gen.E),
// so numbers stay exciting whether the squad is 8 or 800. Endless mode appends segments lazily.
import { LANES, LANE_W, HALF_W, addEnemy, newId, applyGate, clamp } from './sim.js';

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
      const brute = d >= 4 && i % 15 === 7;
      const x = x0 + pad + c * SPACING + (rand() - 0.5) * 0.12;
      const z = zStart + r * SPACING + (rand() - 0.5) * 0.12;
      addEnemy(g, x, z, brute ? 'brute' : 'grunt', brute ? hp * 6 : hp);
    }
  return rows * SPACING;
}

// Firepower-seconds a horde soaks up: grows slowly with difficulty.
// `ramp` only grows in endless mode, where the run should end eventually.
const early = (d) => Math.min(1, 0.45 + 0.15 * d); // the first few levels go easy
const soak = (gen, base) =>
  gen.E * gen.perSoldier * base * 2.2 * early(gen.d) * (1 + Math.min(gen.d, 40) * 0.03) * (gen.ramp || 1);
const lose = (gen, frac) => (gen.E = Math.max(3, gen.E * (1 - frac)));

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

const WEIGHTS = [
  ['horde', 3, 1],
  ['choice', 2, 1],
  ['gauntlet', 2.2, 2],
  ['crate', 1.2, 2],
  ['pump', 1, 3],
];

function pickSegment(rand, d, last) {
  const opts = WEIGHTS.filter(([name, , min]) => d >= min && name !== last);
  let total = opts.reduce((s, o) => s + o[1], 0);
  let r = rand() * total;
  for (const [name, w] of opts) if ((r -= w) <= 0) return name;
  return opts[0][0];
}

function addBoss(g, z) {
  const gen = g.gen;
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
    active: false,
    contact: false,
    dead: false,
  };
}

export const isBossLevel = (level) => level % 5 === 0;

/** Campaign level: lay out every segment now. Returns the finish z. */
export function buildLevel(g) {
  const gen = g.gen;
  const d = g.level;
  const plan =
    d === 1
      ? ['choice', 'horde', 'choice', 'gauntlet']
      : ['choice', ...Array.from({ length: 2 + Math.min(8, Math.floor(d * 0.5)) }, () => null)];
  let z = 8;
  let last = null;
  for (let [i, name] of plan.entries()) {
    name ||= pickSegment(gen.rand, d, last);
    const len = SEGMENTS[name](g, z, i === 0);
    g.segs.push({ name, z0: z, z1: z + len });
    z += len;
    last = name;
  }
  if (isBossLevel(d)) {
    addBoss(g, z + 14);
    return z + 16;
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
  const name = gen.n === 1 ? 'choice' : pickSegment(gen.rand, Math.min(gen.d, 3), gen.last);
  gen.last = name;
  return SEGMENTS[name](g, z0, gen.n === 1);
}
