// Meta progression: upgrades bought with coins between levels, rewards, and the save format.
// Pure functions; main.js stores the save in localStorage.

export const UPGRADES = [
  { key: 'squad', name: 'Recruits', desc: '+1 starting soldier', base: 40 },
  { key: 'power', name: 'Firepower', desc: '+10% damage', base: 50 },
  { key: 'rate', name: 'Fire rate', desc: '+7% shots per second', base: 50 },
  { key: 'coins', name: 'Loot', desc: '+10% coins', base: 80 },
];
export const MAX_UPGRADE = 40;

export const upgradeCost = (key, lvl) => {
  const u = UPGRADES.find((x) => x.key === key);
  return Math.round((u.base * 1.3 ** lvl) / 5) * 5;
};

/** Game options (createGame) for a set of upgrade levels. */
export function statsFor(upg = {}) {
  return {
    start: 5 + (upg.squad || 0),
    dmg: 1 + 0.1 * (upg.power || 0),
    rate: 1 + 0.07 * (upg.rate || 0),
    coinMult: 1 + 0.1 * (upg.coins || 0),
  };
}

/** Coins for a finished run. Wins pay by level and finish multiplier; losses pay a little for progress. */
export function reward({ won, level, mult = 1, progress = 0, kills = 0, mode = 'campaign', distance = 0 }, upg = {}) {
  const m = statsFor(upg).coinMult;
  if (mode === 'endless') return Math.round((distance / 12 + kills / 60) * m);
  if (won) return Math.round(((20 + 4 * level) * mult + kills / 25) * m);
  return Math.round(((15 + 4 * level) * progress + kills / 25) * m);
}

export function defaultSave() {
  return { v: 1, level: 1, coins: 0, upg: { squad: 0, power: 0, rate: 0, coins: 0 }, bestEndless: 0, sound: true, plays: 0 };
}

/** Accept whatever was stored; fall back field by field so a bad save can't break the game. */
export function loadSave(raw) {
  const d = defaultSave();
  let s;
  try {
    s = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return d;
  }
  if (!s || typeof s !== 'object') return d;
  const int = (v, lo, hi, def) => (Number.isInteger(v) && v >= lo && v <= hi ? v : def);
  d.level = int(s.level, 1, 9999, 1);
  d.coins = int(s.coins, 0, 1e12, 0);
  d.bestEndless = int(s.bestEndless, 0, 1e9, 0);
  d.plays = int(s.plays, 0, 1e9, 0);
  d.sound = s.sound !== false;
  for (const u of UPGRADES) d.upg[u.key] = int(s.upg?.[u.key], 0, MAX_UPGRADE, 0);
  return d;
}

/** Buy one level of an upgrade. Returns the new save, or null if not affordable. */
export function buy(save, key) {
  const lvl = save.upg[key];
  if (lvl === undefined || lvl >= MAX_UPGRADE) return null;
  const cost = upgradeCost(key, lvl);
  if (save.coins < cost) return null;
  return { ...save, coins: save.coins - cost, upg: { ...save.upg, [key]: lvl + 1 } };
}

/** Stats a typical player has bought by `level` (fractional). Campaign levels are sized for this. */
export function expectedStats(level, perLevel = 1) {
  const u = (perLevel * (level - 1)) / 3;
  return statsFor({ squad: u, power: u, rate: u });
}
