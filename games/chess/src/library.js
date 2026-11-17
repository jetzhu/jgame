// Browser-local game history and personal puzzle set (spaced repetition).
// Storage-agnostic: pass any {get(key, default), set(key, value)} store (main.js uses localStorage).

const DAY = 24 * 3600 * 1000;
/** When a puzzle comes back, by box: box 0 = just missed (soon), then growing gaps. */
export const PUZZLE_INTERVALS = [10 * 60 * 1000, 1 * DAY, 3 * DAY, 7 * DAY, 21 * DAY, 60 * DAY];
const MAX_GAMES = 100;
const MAX_PUZZLES = 300;

const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function createLibrary(store, now = () => Date.now()) {
  const games = () => store.get('cp.games', []) || [];
  const puzzles = () => store.get('cp.puzzles', []) || [];

  return {
    games,
    getGame: (id) => games().find((g) => g.id === id) || null,

    /** Save a finished game; entries with the same `key` (e.g. online room+game number) are saved once. */
    addGame(entry) {
      const list = games();
      const dup = entry.key && list.find((g) => g.key === entry.key);
      if (dup) return dup.id;
      const g = { id: rid(), at: now(), analysis: null, ...entry };
      list.unshift(g);
      store.set('cp.games', list.slice(0, MAX_GAMES));
      return g.id;
    },

    updateGame(id, patch) {
      const list = games();
      const g = list.find((x) => x.id === id);
      if (!g) return;
      Object.assign(g, patch);
      store.set('cp.games', list);
    },

    removeGame(id) {
      store.set('cp.games', games().filter((g) => g.id !== id));
    },

    puzzles,

    /** Add puzzles ({fen, bad, best, ...}); duplicates (same position + same bad move) are skipped. */
    addPuzzles(items) {
      const list = puzzles();
      const seen = new Set(list.map((p) => `${p.fen}|${p.bad}`));
      let added = 0;
      for (const it of items) {
        const k = `${it.fen}|${it.bad}`;
        if (seen.has(k)) continue;
        seen.add(k);
        list.push({ id: rid(), at: now(), box: 0, due: now(), tries: 0, solved: 0, ...it });
        added++;
      }
      // Keep the newest when over the cap.
      list.sort((a, b) => b.at - a.at);
      store.set('cp.puzzles', list.slice(0, MAX_PUZZLES));
      return added;
    },

    /** Puzzles due now, most overdue first. */
    due() {
      const t = now();
      return puzzles()
        .filter((p) => p.due <= t)
        .sort((a, b) => a.due - b.due);
    },

    /** Leitner grading: solved -> next box (longer gap); missed -> back to box 0 (soon). */
    grade(id, solved) {
      const list = puzzles();
      const p = list.find((x) => x.id === id);
      if (!p) return null;
      p.tries++;
      if (solved) {
        p.solved++;
        p.box = Math.min(p.box + 1, PUZZLE_INTERVALS.length - 1);
      } else p.box = 0;
      p.due = now() + PUZZLE_INTERVALS[p.box];
      store.set('cp.puzzles', list);
      return p;
    },

    removePuzzle(id) {
      store.set('cp.puzzles', puzzles().filter((p) => p.id !== id));
    },
  };
}
