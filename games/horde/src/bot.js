// A simple, decent player. Used by the balance tests and by the demo behind the title screen.
import { LANES, LANE_W, HALF_W, RANGE, GATE_HOLD, applyGate, dps, clamp } from './sim.js';

const laneOf = (x) => (x < -LANE_W / 2 ? 0 : x > LANE_W / 2 ? 2 : 1);

// Best x for the gates over the next stretch, and whether a gate is about to be crossed.
function gatePlan(g) {
  const s = g.squad;
  const ahead = (z, lim) => z > s.z && z - s.z < lim;
  let best = null;
  let soon = false;
  // gates behind a tide's front can't be reached yet (except up the gold lane)
  const blocked = (gt) =>
    g.tides.length > 0 &&
    g.enemies.some((e) => e.pack && e.hp > 0 && e.z > s.z && e.z < gt.z && e.x > gt.x0 - 0.3 && e.x < gt.x1 + 0.3);
  const sorted = g.gates.filter((gt) => !gt.used && ahead(gt.z, 24) && !blocked(gt)).sort((a, b) => a.z - b.z);
  for (const gt of sorted) if (gt.z - s.z < 5) soon = true;
  for (const x of [...LANES, -2.25, 2.25]) {
    let c = s.count;
    let any = false;
    const lane = laneOf(x);
    // a walled lane you can't get into doesn't count
    if (g.walls.some((w) => s.z > w.z0 && s.z < w.z1 && laneOf(s.x) !== lane && Math.sign(w.x) === Math.sign(x) && lane !== 1)) continue;
    for (const gt of sorted) {
      if (x < gt.x0 || x > gt.x1) continue;
      const lock = gt.lockedBy && g.vaults.find((v) => v.id === gt.lockedBy);
      if (lock && lock.hp > 0) continue;
      c = applyGate(c, gt.op, gt.value);
      any = true;
    }
    const score = c + (any ? 0 : -0.5) - Math.abs(x - s.x) * 0.01;
    if (!best || score > best.score) best = { x, score };
  }
  return { best, soon };
}

/** Returns { tx } for the current state. `skill` 0..1 makes the bot slower to react / less greedy. */
export function botInput(g, skill = 1) {
  const s = g.squad;
  const ahead = (z, lim) => z > s.z && z - s.z < lim;
  const speed = Math.max(1, s.speed);

  // 0. a tide: shoot its front back; when it is far enough off, shoot the sacks or run the gold lane
  for (const td of g.tides) {
    if (td.cleared || !td.woke) continue;
    const inGold = td.goldSide > 0 ? s.x > td.wallX : s.x < td.wallX;
    const goldX = (td.wallX + td.goldSide * HALF_W) / 2;
    const sacks = g.vaults.find((v) => v.sack && v.hp > 0 && Math.abs((v.x0 + v.x1) / 2 - goldX) < 0.5 && ahead(v.z + 1, RANGE));
    if (inGold && !sacks) return { tx: goldX };
    if (skill > 0.5) {
      // break the sacks once the squad can do it quickly, while still below them
      if (sacks && s.z < sacks.z - 1 && sacks.hp < dps(g) * (1 + 4 * skill)) return { tx: goldX };
      if (!sacks && g.gates.some((gt) => gt.gold && !gt.used && ahead(gt.z, RANGE) && Math.abs((gt.x0 + gt.x1) / 2 - goldX) < 0.5))
        return { tx: goldX };
    }
    // otherwise chew up the ladder rail
    if (td.front - s.z < 12) return { tx: -td.goldSide * (HALF_W - Math.max(0.75, s.r * 0.8)) };
  }

  // a brute closing in comes first
  for (const e of g.enemies) if (e.kind === 'brute' && e.hp > 0 && !e.held && ahead(e.z + 1, 14 + 6 * skill)) return { tx: e.x };

  // a gatehouse: hold the stream at the door; break the strongbox when it's quick; then take the slot
  for (const gh of g.gatehouses) {
    if (gh.open || !gh.woke || s.z > gh.z) continue;
    const slotX = (gh.slot[0] + gh.slot[1]) / 2;
    const box = g.vaults.find((v) => v.id === gh.box && v.hp > 0);
    const near = g.enemies.some((e) => !e.held && e.hp > 0 && e.z > s.z - 1 && e.z - s.z < 8);
    if (!box) {
      // through the slot in a lull (or already on the way)
      if (skill > 0.5 && (!near || s.x > gh.slot[0] - 0.5 && s.x < gh.slot[1] + 0.5 && s.z > gh.z - GATE_HOLD + 1)) return { tx: slotX };
      continue;
    }
    // at the wall (the ladder is behind us by then), spend fire on the strongbox in a lull
    if (skill > 0.5 && !near && s.z > gh.z - GATE_HOLD - 1 && box.hp < dps(g) * (1 + 4 * skill)) return { tx: slotX };
  }

  const plan = gatePlan(g);
  if (plan.soon && plan.best && plan.best.score > s.count - 0.25) return { tx: plan.best.x };

  // 1. enemies close in front: shoot the nearest cluster
  let near = null;
  for (const e of g.enemies) if (ahead(e.z, 12 + 6 * skill) && (!near || e.z < near.z)) near = e;
  const boss = g.boss;
  if (boss && boss.active && !boss.dead) {
    // step out of a slam circle, toward the roomier side; otherwise shoot the boss
    const sl = boss.slam;
    if (sl && skill > 0.4 && Math.abs(s.x - sl.x) < sl.r + s.r * 0.4 + 0.3) {
      const side = sl.x > 0 ? -1 : 1;
      return { tx: sl.x + side * (sl.r + s.r * 0.4 + 0.8) };
    }
    return { tx: boss.x };
  }
  if (near) {
    let sx = 0;
    let n = 0;
    for (const e of g.enemies)
      if (e.z - near.z < 3 && e.z > s.z) {
        sx += e.x;
        n++;
      }
    return { tx: sx / n };
  }

  // 2a. stopped in front of a raised slab: bring its pillar down
  for (const v of g.vaults) {
    if (!v.slab || v.hp <= 0 || !ahead(v.z, RANGE)) continue;
    const sl = g.slabs.find((x) => x.id === v.slab);
    if (sl && !sl.down && sl.z0 - s.z < 16) return { tx: (v.x0 + v.x1) / 2 };
  }

  // 2. a vault whose gold lane is worth it and can be cracked in time
  if (skill > 0.5)
    for (const v of g.vaults) {
      if (v.hp <= 0 || !ahead(v.z, RANGE) || g.gatehouses.some((gh) => gh.box === v.id)) continue;
      const t = (v.z - s.z - 1) / speed;
      if (v.hp < dps(g) * t * 0.9) return { tx: (v.x0 + v.x1) / 2 };
    }

  // 3. crates and pump gates in range when the coast is clear
  if (skill > 0.7) {
    for (const c of g.crates) if (!c.dead && ahead(c.z, 22) && c.hp < dps(g) * ((c.z - s.z) / speed)) return { tx: c.x };
    for (const gt of g.gates)
      if (gt.pump && !gt.used && ahead(gt.z, 22) && gt.z - s.z > 5) return { tx: (gt.x0 + gt.x1) / 2 };
  }

  // 4. gates further out
  if (plan.best && plan.best.score > s.count - 0.25) return { tx: plan.best.x };

  // 5. drift toward whatever enemies are further out
  let far = null;
  for (const e of g.enemies) if (ahead(e.z, RANGE) && (!far || e.z < far.z)) far = e;
  if (far) return { tx: far.x };
  return { tx: clamp(s.x, -3, 3) };
}
