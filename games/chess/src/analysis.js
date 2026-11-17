// Engine analysis for the Analysis view: scoring math (pure, unit-tested) and two Stockfish
// wrappers — GamePass (one quick search per position of a game, in the background) and
// LiveAnalyzer (continuously deepening MultiPV search of the position on the board).
//
// Scores are always from WHITE's point of view: {cp: centipawns} or {mate: n} (n > 0 = white mates).

// ------------------------------------------------------------------ math
/** White's winning chances 0..100 for a score (logistic curve calibrated on real games, as lichess uses). */
export function winPct(score) {
  if (!score) return 50;
  if (score.mate != null) {
    if (score.mate === 0) return score.winner === 'white' ? 100 : score.winner === 'black' ? 0 : 50; // mate on the board
    return score.mate > 0 ? 100 : 0;
  }
  const cp = Math.max(-1000, Math.min(1000, score.cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** Per-move accuracy 0..100 from the mover's win% drop (lichess formula). */
export function moveAccuracy(drop) {
  const a = 103.1668 * Math.exp(-0.04354 * Math.max(0, drop)) - 3.1669;
  return Math.max(0, Math.min(100, a));
}

export const CLASSES = {
  best: { label: 'Best move', glyph: '★' },
  excellent: { label: 'Excellent', glyph: '!' },
  good: { label: 'Good', glyph: '✓' },
  inaccuracy: { label: 'Inaccuracy', glyph: '?!' },
  mistake: { label: 'Mistake', glyph: '?' },
  blunder: { label: 'Blunder', glyph: '??' },
  forced: { label: 'Only move', glyph: '□' },
  book: { label: 'Book move', glyph: '' }, // opening theory; drawn as a book icon
};

/**
 * Classify a move.
 * @param {object} o
 * @param {{score,best}} o.before  analysis of the position before the move
 * @param {{score}} o.after        analysis of the position after the move
 * @param {'white'|'black'} o.mover
 * @param {string} o.played        uci of the move
 * @param {number} o.legalCount    legal moves available before the move
 * @returns {{cls: string, drop: number, accuracy: number}|null}
 */
export function classifyMove({ before, after, mover, played, legalCount }) {
  if (!before?.score || !after?.score) return null;
  const wb = mover === 'white' ? winPct(before.score) : 100 - winPct(before.score);
  const wa = mover === 'white' ? winPct(after.score) : 100 - winPct(after.score);
  const drop = Math.max(0, wb - wa);
  let cls;
  if (legalCount === 1) cls = 'forced';
  else if (before.best && played === before.best) cls = 'best';
  else if (drop <= 2) cls = 'excellent';
  else if (drop <= 5) cls = 'good';
  else if (drop <= 10) cls = 'inaccuracy';
  else if (drop <= 20) cls = 'mistake';
  else cls = 'blunder';
  return { cls, drop, accuracy: moveAccuracy(drop) };
}

/** '+1.3', '−0.4', '0.0', 'M3', '−M2', '#' (mate on board). */
export function formatScore(score) {
  if (!score) return '…';
  if (score.mate != null) {
    if (score.mate === 0) return '#';
    return (score.mate > 0 ? '' : '−') + 'M' + Math.abs(score.mate);
  }
  const v = score.cp / 100;
  if (Math.abs(v) < 0.05) return '0.0';
  return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(1);
}

/** Parse a UCI "info" line. Score is from the side to move, as the engine reports it. */
export function parseInfo(line) {
  if (!line.startsWith('info') || !line.includes(' pv ')) return null;
  const depth = line.match(/\bdepth (\d+)/);
  const sc = line.match(/\bscore (cp|mate) (-?\d+)/);
  const pv = line.match(/ pv (.+)$/);
  if (!depth || !sc || !pv) return null;
  if (/\b(lowerbound|upperbound)\b/.test(line)) return null;
  const mpv = line.match(/\bmultipv (\d+)/);
  return {
    depth: Number(depth[1]),
    multipv: mpv ? Number(mpv[1]) : 1,
    score: sc[1] === 'cp' ? { cp: Number(sc[2]) } : { mate: Number(sc[2]) },
    pv: pv[1].trim().split(/\s+/),
  };
}

/** Convert an engine score (side to move) to white's point of view. */
export function toWhite(score, fen) {
  const black = fen.split(' ')[1] === 'b';
  if (!black) return score;
  return score.mate != null ? { mate: -score.mate } : { cp: -score.cp };
}

// ------------------------------------------------------------------ engines
class UciWorker {
  constructor(url) {
    this.w = new Worker(url);
    this.w.onmessage = (e) => this.onLine(String(e.data));
    this.w.onerror = () => this.onError?.();
    this.ready = new Promise((resolve) => (this._ready = resolve));
    this.post('uci');
  }
  post(cmd) {
    this.w.postMessage(cmd);
  }
  onLine(line) {
    if (line === 'uciok') this.post('isready');
    else if (line === 'readyok' && this._ready) {
      this._ready();
      this._ready = null;
    } else this.handle(line);
  }
  handle() {}
  destroy() {
    this.w.terminate();
  }
}

/** Analyze a list of positions one by one (quick fixed-depth searches). */
export class GamePass extends UciWorker {
  constructor(url, { depth = 12 } = {}) {
    super(url);
    this.depth = depth;
    this.queue = [];
    this.current = null;
  }

  /** jobs: [{key, fen}] — onResult(key, {score, best, pv, depth}) for each, in order. */
  run(jobs, onResult, onDone) {
    this.queue = jobs.slice();
    this.onResult = onResult;
    this.onDone = onDone;
    this.ready.then(() => this.next());
  }

  next() {
    const job = this.queue.shift();
    if (!job) {
      this.current = null;
      return this.onDone?.();
    }
    this.current = { ...job, info: null };
    this.post('ucinewgame');
    this.post(`position fen ${job.fen}`);
    this.post(`go depth ${this.depth}`);
  }

  handle(line) {
    if (!this.current) return;
    const info = parseInfo(line);
    if (info && info.multipv === 1) this.current.info = info;
    else if (line.startsWith('bestmove')) {
      const { key, fen, info: i } = this.current;
      const best = line.split(' ')[1];
      this.onResult?.(key, {
        score: i ? toWhite(i.score, fen) : null,
        best: best && best !== '(none)' ? best : null,
        pv: i ? i.pv.slice(0, 12) : [],
        depth: i?.depth || 0,
      });
      this.next();
    }
  }
}

/** Continuously analyze one position with several lines; call analyze(fen) whenever it changes. */
export class LiveAnalyzer extends UciWorker {
  constructor(url, { multipv = 3, maxDepth = 22, onUpdate } = {}) {
    super(url);
    this.multipv = multipv;
    this.maxDepth = maxDepth;
    this.onUpdate = onUpdate;
    this.searching = false;
    this.stopping = false;
    this.pending = null;
    this.cur = null;
    this.ready.then(() => this.post(`setoption name MultiPV value ${multipv}`));
  }

  analyze(fen) {
    if (this.cur?.fen === fen && (this.searching || this.cur.done)) return;
    this.pending = fen;
    if (this.searching) {
      if (!this.stopping) {
        this.stopping = true;
        this.post('stop');
      }
    } else this.ready.then(() => this.start());
  }

  stop() {
    this.pending = null;
    if (this.searching && !this.stopping) {
      this.stopping = true;
      this.post('stop');
    }
  }

  start() {
    const fen = this.pending;
    this.pending = null;
    if (!fen || this.searching) return;
    this.cur = { fen, depth: 0, lines: [], done: false };
    this.searching = true;
    this.post(`position fen ${fen}`);
    this.post(`go depth ${this.maxDepth}`);
  }

  handle(line) {
    if (line.startsWith('bestmove')) {
      this.searching = false;
      const wasStopping = this.stopping;
      this.stopping = false;
      if (this.cur && !wasStopping) {
        this.cur.done = true;
        this.emit(true);
      }
      if (this.pending) this.start();
      return;
    }
    if (this.stopping || !this.cur) return;
    const info = parseInfo(line);
    if (!info) return;
    const c = this.cur;
    c.lines[info.multipv - 1] = { score: toWhite(info.score, c.fen), pv: info.pv, depth: info.depth };
    // A depth is complete once its last line arrives; report then (keeps the display stable).
    if (info.multipv === this.multipv || info.multipv >= c.lines.length) {
      c.depth = info.depth;
      this.emit(false);
    }
  }

  emit(final) {
    const c = this.cur;
    this.onUpdate?.({ fen: c.fen, depth: c.depth, lines: c.lines.filter(Boolean), final });
  }
}
