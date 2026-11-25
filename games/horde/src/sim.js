// Horde Gate game simulation: pure, deterministic, no DOM. The browser renders it (render.js);
// tests and the title-screen demo drive it headless. Fixed timestep DT; call step(game, input).
//
// World: x runs across the bridge (-HALF_W..HALF_W, three lanes), z runs forward. The squad
// advances on its own and fires straight ahead; the player only steers x.
import { buildLevel, endlessSegment } from './levels.js';
import { expectedStats } from './progress.js';

export const HALF_W = 4.5;
export const LANES = [-3, 0, 3];
export const LANE_W = 3;
export const DT = 1 / 60;
export const RANGE = 30; // bullet reach
export const BULLET_SPEED = 45;
export const MAX_COUNT = 9999;
export const BASE_SPEED = 6;
export const BASE_RATE = 2.5; // shots per soldier per second
const ACTIVATE = 40; // enemies start marching when the squad is this close
const MAX_VISIBLE_BULLETS = 30;
const ENEMY_R = 0.3;

/** Small seeded PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function applyGate(count, op, value) {
  let n = count;
  if (op === '+') n = count + value;
  else if (op === '-') n = count - value;
  else if (op === 'x') n = count * value;
  else if (op === '/') n = Math.floor(count / value);
  return clamp(Math.round(n), 0, MAX_COUNT);
}

export const gateLabel = (g) => ({ '+': '+', '-': '−', x: '×', '/': '÷' })[g.op] + g.value;
export const gateGood = (g) => g.op === '+' || g.op === 'x';
export const squadRadius = (count) => Math.min(2.4, 0.45 + 0.2 * Math.sqrt(count));

/**
 * opts: { mode: 'campaign'|'endless'|'demo', level, seed, start (squad size), dmg, rate, coinMult }
 */
export function createGame(opts = {}) {
  const mode = opts.mode || 'campaign';
  const level = opts.level || 1;
  const seed = opts.seed ?? level * 7919 + 13;
  const start = opts.start ?? 5;
  const g = {
    mode,
    level,
    seed,
    rand: rng(seed),
    t: 0,
    status: 'play', // 'play' | 'won' | 'lost'
    squad: { x: 0, tx: 0, z: 0, count: start, r: squadRadius(start), speed: BASE_SPEED },
    dmg: opts.dmg ?? 1,
    rate: (opts.rate ?? 1) * BASE_RATE,
    spread: 0,
    enemies: [],
    dormant: [], // enemies waiting to start marching, sorted by z
    bullets: [],
    gates: [],
    vaults: [],
    walls: [],
    crates: [],
    barrels: [],
    boss: null,
    segs: [], // { name, z0, z1 } for each generated segment
    length: Infinity,
    genZ: 0, // endless: track generated up to here
    gen: null,
    fireAcc: 0,
    nextId: 1,
    events: [],
    stats: { kills: 0, gates: 0, peak: start, shots: 0 },
    result: null,
  };
  // Campaign levels are sized for the upgrades a typical player has by then (not the player's
  // own), so buying upgrades makes a level easier. Endless runs scale from the player's stats.
  const ref = mode === 'endless' ? { start, rate: opts.rate ?? 1, dmg: opts.dmg ?? 1 } : expectedStats(level);
  g.gen = { rand: rng(seed ^ 0x9e3779b9), E: ref.start, d: level, perSoldier: BASE_RATE * ref.rate * ref.dmg };
  if (mode === 'endless') {
    g.gen.d = 1;
    while (g.genZ < 200) g.genZ += endlessSegment(g, g.genZ);
  } else {
    g.length = buildLevel(g);
  }
  sortDormant(g);
  return g;
}

export const newId = (g) => g.nextId++;

function sortDormant(g) {
  g.dormant.sort((a, b) => b.z - a.z); // farthest first; pop() takes the nearest
}

export function addEnemy(g, x, z, kind, hp) {
  const brute = kind === 'brute';
  g.dormant.push({
    id: newId(g),
    x,
    z,
    hp,
    maxHp: hp,
    kind,
    r: brute ? 0.55 : ENEMY_R,
    power: brute ? 3 : 1,
    speed: brute ? 1.7 : 2.4,
  });
}

/** Seconds of full-squad fire a target with `hp` would absorb. */
export const dps = (g) => g.squad.count * g.rate * g.dmg;

// ------------------------------------------------------------------ step
export const BOOST = 2; // forward speed multiplier while the player holds boost

/**
 * Advance one tick. input: { tx, boost } — tx is the squad's target x (omit to keep the current
 * target); boost doubles forward speed. Or null for no input.
 */
export function step(g, input) {
  g.events.length = 0;
  if (g.status !== 'play') return;
  g.t += DT;
  const s = g.squad;
  if (input && typeof input.tx === 'number' && Number.isFinite(input.tx)) s.tx = input.tx;
  s.tx = clamp(s.tx, -HALF_W + 0.4, HALF_W - 0.4);

  if (g.mode === 'endless') {
    while (g.genZ < s.z + 200) g.genZ += endlessSegment(g, g.genZ);
    sortDormant(g);
  }

  // wake enemies that are now close enough to march
  while (g.dormant.length && g.dormant[g.dormant.length - 1].z < s.z + ACTIVATE) g.enemies.push(g.dormant.pop());

  // ---- squad movement
  const prevX = s.x;
  const dx = s.tx - s.x;
  s.x += clamp(dx, -14 * DT, 14 * DT);
  let nearest = Infinity;
  for (const e of g.enemies) if (e.z > s.z && e.z - s.z < nearest) nearest = e.z - s.z;
  const boss = g.boss;
  if (boss && !boss.dead && boss.active) nearest = Math.min(nearest, boss.z - boss.r - s.z);
  s.boost = !!(input && input.boost);
  s.speed = BASE_SPEED * (s.boost ? BOOST : 1) * clamp((nearest - 7) / 12, 0.3, 1);
  if (boss && !boss.dead && boss.contact) s.speed = 0;
  const prevZ = s.z;
  s.z += s.speed * DT;

  // walls (lane rails): the squad's center can't cross them
  for (const w of g.walls) {
    if (s.z < w.z0 || s.z > w.z1) continue;
    if (prevX <= w.x && s.x > w.x) s.x = w.x - 0.001;
    else if (prevX >= w.x && s.x < w.x) s.x = w.x + 0.001;
  }
  // closed vaults block their lane: push the squad out sideways
  for (const v of g.vaults) {
    if (v.hp <= 0) continue;
    if (s.z + 0.3 < v.z - v.depth / 2 || prevZ - 0.3 > v.z + v.depth / 2) continue;
    if (s.x > v.x0 && s.x < v.x1) {
      s.x = s.x - v.x0 < v.x1 - s.x ? v.x0 - 0.05 : v.x1 + 0.05;
      if (s.x > HALF_W - 0.4 || s.x < -HALF_W + 0.4) s.x = s.x > 0 ? v.x0 - 0.05 : v.x1 + 0.05;
      s.tx = s.x;
    }
  }
  s.x = clamp(s.x, -HALF_W + 0.4, HALF_W - 0.4);

  // ---- gates
  for (const gate of g.gates) {
    if (gate.used || gate.z > s.z || gate.z <= prevZ) continue;
    if (s.x < gate.x0 || s.x > gate.x1) continue;
    const lock = gate.lockedBy && g.vaults.find((v) => v.id === gate.lockedBy);
    if (lock && lock.hp > 0) continue;
    gate.used = true;
    const before = s.count;
    s.count = applyGate(s.count, gate.op, gate.value);
    g.stats.gates++;
    g.events.push({ t: 'gate', id: gate.id, good: s.count >= before, delta: s.count - before, label: gateLabel(gate), x: s.x, z: gate.z });
    // the other gates of a choice row are gone once one is taken
    if (gate.group) for (const o of g.gates) if (o.group === gate.group) o.used = true;
  }

  // ---- barrels you run into explode on the squad
  for (const b of g.barrels) {
    if (b.dead || Math.abs(b.z - s.z) > 0.6 || Math.abs(b.x - s.x) > s.r + 0.4) continue;
    explodeBarrel(g, b);
    const loss = Math.min(s.count, 4 + Math.ceil(g.gen.d / 2));
    s.count -= loss;
    g.events.push({ t: 'hurt', n: loss, x: s.x, z: s.z });
  }

  fire(g);
  moveBullets(g);
  moveEnemies(g);
  moveBoss(g);

  s.r = squadRadius(s.count);
  if (s.count > g.stats.peak) g.stats.peak = s.count;
  g.bullets = g.bullets.filter((b) => b.dmg > 0 && b.life > 0);
  g.gates = g.gates.filter((x) => x.z > s.z - 15);
  g.crates = g.crates.filter((x) => !x.dead && x.z > s.z - 15);
  g.barrels = g.barrels.filter((x) => !x.dead && x.z > s.z - 15);
  g.walls = g.walls.filter((x) => x.z1 > s.z - 15);
  g.vaults = g.vaults.filter((x) => x.z > s.z - 15 || g.gates.some((gt) => gt.lockedBy === x.id));

  if (s.count <= 0) {
    s.count = 0;
    g.status = 'lost';
    g.result = { won: false, distance: Math.floor(s.z) };
    g.events.push({ t: 'lost' });
  } else if (s.z >= g.length && (!boss || boss.dead)) {
    g.status = 'won';
    g.result = { won: true, survivors: s.count, mult: finishMultiplier(s.count, g.level) };
    g.events.push({ t: 'won' });
  }
}

/** The finish ramp: more survivors climb to a higher coin multiplier (×1..×5). */
export function finishMultiplier(count, level) {
  const unit = 8 + level * 3;
  let mult = 1;
  let need = unit;
  let left = count;
  while (mult < 5 && left >= need) {
    left -= need;
    mult++;
    need = Math.round(need * 1.6);
  }
  return mult;
}

// ------------------------------------------------------------------ shooting
function fire(g) {
  const s = g.squad;
  if (s.count <= 0) return;
  const shotsPerSec = s.count * g.rate;
  const visible = Math.min(shotsPerSec, MAX_VISIBLE_BULLETS + 12 * g.spread);
  if (visible <= 0) return;
  const dmgEach = (shotsPerSec * g.dmg) / visible;
  g.fireAcc += visible * DT;
  while (g.fireAcc >= 1) {
    g.fireAcc -= 1;
    const x = s.x + (g.rand() - 0.5) * 1.6 * s.r;
    let vx = 0;
    if (g.spread) {
      const k = Math.floor(g.rand() * (1 + 2 * g.spread)) - g.spread; // -spread..spread
      vx = k * 4;
    }
    g.bullets.push({ x, z: s.z + 0.6, vx, dmg: dmgEach, life: RANGE / BULLET_SPEED });
    g.stats.shots++;
  }
}

// Spatial grid of marching enemies near the squad, rebuilt each tick for bullet hits.
const GRID_COLS = 10;
function buildGrid(g) {
  const z0 = Math.floor(g.squad.z) - 2;
  const rows = RANGE + 8;
  const cells = new Array(rows * GRID_COLS);
  for (const e of g.enemies) {
    const r = Math.floor(e.z) - z0;
    if (r < 0 || r >= rows) continue;
    const c = clamp(Math.floor(e.x + HALF_W), 0, GRID_COLS - 1);
    const k = r * GRID_COLS + c;
    (cells[k] ||= []).push(e);
  }
  return { z0, rows, cells };
}

function moveBullets(g) {
  const grid = buildGrid(g);
  for (const b of g.bullets) {
    const za = b.z;
    const zb = b.z + BULLET_SPEED * DT;
    const xb = b.x + b.vx * DT;
    b.life -= DT;
    let from = za;
    // a bullet keeps going with whatever damage its kills didn't use
    for (let guard = 0; guard < 40 && b.dmg > 0; guard++) {
      const hit = firstHit(g, grid, b, from, zb);
      if (!hit) break;
      from = hit.z;
      damage(g, hit, b);
      if (hit.absorb) b.dmg = 0;
    }
    b.z = zb;
    b.x = xb;
    if (Math.abs(b.x) > HALF_W + 1) b.life = 0;
  }
}

// Nearest thing a bullet touches between z=from and z=to.
function firstHit(g, grid, b, from, to) {
  let best = null;
  let bz = Infinity;
  const consider = (z, obj) => {
    if (z >= from && z <= to && z < bz) {
      bz = z;
      best = obj;
    }
  };
  // enemies
  const r0 = Math.floor(from - 0.6) - grid.z0;
  const r1 = Math.floor(to + 0.6) - grid.z0;
  const c0 = clamp(Math.floor(b.x - 0.7 + HALF_W), 0, GRID_COLS - 1);
  const c1 = clamp(Math.floor(b.x + 0.7 + HALF_W), 0, GRID_COLS - 1);
  for (let r = Math.max(0, r0); r <= Math.min(grid.rows - 1, r1); r++)
    for (let c = c0; c <= c1; c++) {
      const cell = grid.cells[r * GRID_COLS + c];
      if (!cell) continue;
      for (const e of cell) {
        if (e.hp <= 0 || Math.abs(e.x - b.x) > e.r + 0.1) continue;
        consider(e.z - e.r, { kind: 'enemy', obj: e, z: e.z - e.r });
      }
    }
  for (const v of g.vaults)
    if (v.hp > 0 && b.x > v.x0 && b.x < v.x1) consider(v.z - v.depth / 2, { kind: 'vault', obj: v, z: v.z - v.depth / 2, absorb: true });
  for (const c of g.crates)
    if (!c.dead && Math.abs(c.x - b.x) < 0.8) consider(c.z - 0.6, { kind: 'crate', obj: c, z: c.z - 0.6 });
  for (const br of g.barrels)
    if (!br.dead && Math.abs(br.x - b.x) < 0.5) consider(br.z - 0.4, { kind: 'barrel', obj: br, z: br.z - 0.4 });
  for (const gt of g.gates)
    if (gt.pump && !gt.used && b.x > gt.x0 && b.x < gt.x1) consider(gt.z, { kind: 'pump', obj: gt, z: gt.z, absorb: true });
  const boss = g.boss;
  if (boss && !boss.dead && Math.abs(boss.x - b.x) < boss.r) consider(boss.z - boss.r, { kind: 'boss', obj: boss, z: boss.z - boss.r, absorb: true });
  return best;
}

function damage(g, hit, b) {
  const o = hit.obj;
  if (hit.kind === 'enemy' || hit.kind === 'crate' || hit.kind === 'barrel') {
    const used = Math.min(b.dmg, o.hp);
    o.hp -= used;
    b.dmg -= used;
    if (o.hp > 1e-9) return;
    o.hp = 0;
    if (hit.kind === 'enemy') {
      g.stats.kills++;
      g.events.push({ t: 'kill', x: o.x, z: o.z, brute: o.kind === 'brute' });
    } else if (hit.kind === 'crate') {
      o.dead = true;
      openCrate(g, o);
    } else explodeBarrel(g, o);
    return;
  }
  if (hit.kind === 'vault') {
    o.hp = Math.max(0, o.hp - b.dmg);
    g.events.push({ t: 'vaultHit', id: o.id, x: b.x, z: hit.z });
    if (o.hp <= 0) g.events.push({ t: 'vaultOpen', id: o.id, x: (o.x0 + o.x1) / 2, z: o.z });
  } else if (hit.kind === 'pump') {
    o.acc += b.dmg;
    while (o.acc >= o.step) {
      o.acc -= o.step;
      if (o.op === '-' && o.value <= 1) {
        o.op = '+';
        o.value = 1;
      } else if (o.op === '-') o.value--;
      else o.value++;
      g.events.push({ t: 'pump', id: o.id });
    }
  } else if (hit.kind === 'boss') {
    o.hp = Math.max(0, o.hp - b.dmg);
    if (o.hp <= 0) {
      o.dead = true;
      g.events.push({ t: 'bossDown', x: o.x, z: o.z });
    }
  }
}

function openCrate(g, c) {
  const s = g.squad;
  if (c.kind === 'rate') g.rate *= 1.3;
  else if (c.kind === 'dmg') g.dmg *= 1.35;
  else if (c.kind === 'spread') g.spread = Math.min(2, g.spread + 1);
  else if (c.kind === 'troops') s.count = applyGate(s.count, '+', c.value);
  g.events.push({ t: 'crate', kind: c.kind, value: c.value, x: c.x, z: c.z });
}

function explodeBarrel(g, b) {
  b.dead = true;
  b.hp = 0;
  const R = 3.2;
  let kills = 0;
  for (const e of g.enemies) {
    if (e.hp <= 0) continue;
    if ((e.x - b.x) ** 2 + (e.z - b.z) ** 2 < R * R) {
      e.hp -= b.blast;
      if (e.hp <= 0) {
        kills++;
        g.stats.kills++;
        g.events.push({ t: 'kill', x: e.x, z: e.z, brute: e.kind === 'brute', quiet: true });
      }
    }
  }
  g.events.push({ t: 'boom', x: b.x, z: b.z, kills });
}

// ------------------------------------------------------------------ enemies & boss
function moveEnemies(g) {
  const s = g.squad;
  for (const e of g.enemies) {
    if (e.hp <= 0) continue;
    e.z -= e.speed * DT;
    const dz = e.z - s.z;
    if (dz < 9) {
      const dx = s.x - e.x;
      e.x += clamp(dx, -1.6 * DT, 1.6 * DT);
    }
    // contact: each enemy that reaches the squad takes soldiers with it
    if (Math.abs(dz) < s.r * 0.7 + e.r && Math.abs(s.x - e.x) < s.r + e.r) {
      const loss = Math.min(s.count, e.power);
      s.count -= loss;
      e.hp = 0;
      g.events.push({ t: 'clash', x: e.x, z: e.z, n: loss });
    }
  }
  g.enemies = g.enemies.filter((e) => e.hp > 0 && e.z > s.z - 4);
}

function moveBoss(g) {
  const b = g.boss;
  const s = g.squad;
  if (!b || b.dead) return;
  if (!b.active && b.z - s.z < ACTIVATE - 5) {
    b.active = true;
    g.events.push({ t: 'bossWake' });
  }
  if (!b.active) return;
  const dist = b.z - s.z;
  b.contact = dist < b.r + s.r * 0.6;
  if (!b.contact) b.z -= b.speed * DT;
  b.x += clamp(s.x - b.x, -1.5 * DT, 1.5 * DT);
  if (b.contact) {
    b.drainAcc += b.drain * DT;
    if (b.drainAcc >= 1) {
      const n = Math.min(s.count, Math.floor(b.drainAcc));
      b.drainAcc -= n;
      s.count -= n;
      g.events.push({ t: 'clash', x: s.x, z: s.z + s.r, n, boss: true });
    }
  }
}

/** Progress 0..1 through a campaign level. */
export const progress = (g) => (g.length === Infinity ? 0 : clamp(g.squad.z / g.length, 0, 1));
