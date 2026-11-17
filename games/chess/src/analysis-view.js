// Analysis view: whole-game review (move quality, accuracy, eval graph), live top engine lines,
// free exploration (side variation) and a "retry your mistake" trainer.
//
// main.js owns the board and app shell; it hands us what we need through `ctx`.
import { Chess } from 'chess.js';
import { GamePass, LiveAnalyzer, CLASSES, classifyMove, formatScore, winPct } from './analysis.js';

const ENGINE_URL = 'vendor/stockfish-19-lite-single.js';
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PASS_DEPTH = 12; // per position in the whole-game pass
const LIVE_DEPTH = 22; // live analysis stops here to save battery
const MIN_EXPLORE_DEPTH = 12; // live depth needed before we grade an exploration move
const BAD = new Set(['inaccuracy', 'mistake', 'blunder']);
const CLASS_COLOR = {
  best: '#5ec26a',
  excellent: '#7ab55c',
  good: '#93a87f',
  inaccuracy: '#e6b23a',
  mistake: '#e88a3c',
  blunder: '#d9473b',
  forced: '#8b8987',
};

const parseUci = (s) => ({ from: s.slice(0, 2), to: s.slice(2, 4), promotion: s[4] || undefined });
const colorName = (c) => (c === 'w' ? 'white' : 'black');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const hashKey = (s) => {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return (x >>> 0).toString(36);
};

function terminalEval(chess) {
  if (chess.isCheckmate()) return { score: { mate: 0, winner: chess.turn() === 'w' ? 'black' : 'white' }, best: null, pv: [], depth: 99 };
  if (chess.isGameOver()) return { score: { cp: 0 }, best: null, pv: [], depth: 99 }; // stalemate / draw rules
  return null;
}

function legalDests(chess) {
  const d = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!d.has(m.from)) d.set(m.from, []);
    d.get(m.from).push(m.to);
  }
  return d;
}

/** "12." / "12…" prefix for the move made from `fen`. */
function moveNo(fen) {
  const [, side, , , , full] = fen.split(' ');
  return side === 'w' ? `${full}.` : `${full}…`;
}

export function createAnalysis(ctx) {
  const { cg, $, h, esc, store, sound, toast, copyText, askPromotion, paintBar, getOrientation, setOrientation } = ctx;
  let A = null; // analysis state while open
  let pass = null;
  let live = null;
  const cache = new Map(); // fen -> deepest known {score, best, pv, depth}
  let renderQueued = false;
  let movesKey = '';

  $('#an-lines').addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.pv-move');
    if (!b || !A || b.dataset.fen !== curFen()) return;
    e.preventDefault();
    playLine(b.dataset.pv.split(' '), Number(b.dataset.j));
  });
  $('#an-graph').addEventListener('click', (e) => {
    if (!A || A.fens.length < 2) return;
    const r = e.currentTarget.getBoundingClientRect();
    goto(Math.round(((e.clientX - r.left) / r.width) * (A.fens.length - 1)), 0);
  });

  // ---------------------------------------------------------------- state helpers
  // (count explicitly: Array.every() skips the empty slots of a fresh array)
  const passComplete = () => A.evals.filter(Boolean).length === A.fens.length;
  const curFen = () => (A.ex > 0 ? A.explore.moves[A.ex - 1].fen : A.fens[A.ply]);
  const prevFen = () => (A.ex > 1 ? A.explore.moves[A.ex - 2].fen : A.ex === 1 ? A.fens[A.ply] : A.fens[A.ply - 1]);
  const curMove = () => (A.ex > 0 ? A.explore.moves[A.ex - 1] : A.main[A.ply - 1]);
  const engineOn = () => store.get('cp.engineOn', true) !== false;
  const retryHidden = () => A.retry && A.ply === A.retry.ply && A.ex === 0;
  const showEngine = () => engineOn() && !retryHidden();

  function remember(fen, r) {
    if (!r?.score) return;
    const old = cache.get(fen);
    if (!old || (r.depth || 0) >= (old.depth || 0)) cache.set(fen, r);
  }

  /** Classification of mainline move i (uses the stable whole-game pass results). */
  function mainClass(i) {
    if (!A.evals[i] || !A.evals[i + 1]) return null;
    return classifyMove({ before: A.evals[i], after: A.evals[i + 1], mover: A.main[i].color, played: A.main[i].uci, legalCount: A.legal[i] });
  }

  /** Classification of exploration move k (needs reasonably deep analysis on both sides). */
  function exploreClass(k) {
    const m = A.explore.moves[k];
    const beforeFen = k === 0 ? A.fens[A.explore.from] : A.explore.moves[k - 1].fen;
    const before = cache.get(beforeFen) || A.evals[A.explore.from];
    const after = cache.get(m.fen);
    if (!before || !after || (after.depth || 0) < MIN_EXPLORE_DEPTH) return null;
    return classifyMove({ before, after, mover: m.color, played: m.uci, legalCount: m.legalBefore });
  }

  const currentClass = () => (A.ex > 0 ? exploreClass(A.ex - 1) : A.ply > 0 ? mainClass(A.ply - 1) : null);

  function sanOf(fen, u) {
    try {
      return new Chess(fen).move(parseUci(u)).san;
    } catch {
      return u;
    }
  }

  // ---------------------------------------------------------------- open / close
  function open(input) {
    close(false);
    const startFen = input.startFen || START_FEN;
    const chess = new Chess(startFen);
    const main = [];
    const fens = [chess.fen()];
    const legal = [chess.moves().length];
    for (const u of input.moves) {
      let m;
      try {
        m = chess.move(parseUci(u));
      } catch {
        break;
      }
      main.push({ uci: u, san: m.san, color: colorName(m.color), from: m.from, to: m.to, captured: m.captured, flags: m.flags });
      fens.push(chess.fen());
      legal.push(chess.moves().length);
    }
    const key = hashKey(startFen + '|' + main.map((m) => m.uci).join(' '));
    A = { input, key, main, fens, legal, evals: new Array(fens.length), explore: null, ply: 0, ex: 0, live: null, retry: null, mistakeIdx: -1, passDone: 0 };
    setOrientation(input.userColor || 'white');

    // Reuse a previous pass of this game if we have one.
    const saved = (store.get('cp.anCache', []) || []).find((c) => c.key === key);
    fens.forEach((fen, i) => {
      const t = terminalEval(new Chess(fen));
      if (t) A.evals[i] = t;
      else if (saved?.evals?.[i]) A.evals[i] = saved.evals[i];
      if (A.evals[i]) remember(fen, A.evals[i]);
    });
    A.passDone = A.evals.filter(Boolean).length;
    const jobs = fens.map((fen, i) => ({ key: i, fen })).filter((j) => !A.evals[j.key]);
    if (jobs.length) {
      pass = new GamePass(ENGINE_URL, { depth: PASS_DEPTH });
      pass.onError = () => toast('The analysis engine failed to load.');
      pass.run(
        jobs,
        (i, r) => {
          if (!A) return;
          A.evals[i] = r;
          A.passDone++;
          remember(fens[i], r);
          queueRender();
        },
        () => {
          if (!A) return;
          savePass();
          queueRender();
        },
      );
    }
    live = new LiveAnalyzer(ENGINE_URL, { multipv: 3, maxDepth: LIVE_DEPTH, onUpdate: onLive });
    movesKey = '';
    ctx.showView('analysis');
    $('#an-title').textContent = input.title || 'Analysis';
    $('#an-sub').textContent = input.subtitle || '';
    summaryKey = infoKey = '';
    renderActions();
    goto(0, 0);
  }

  function savePass() {
    if (!passComplete()) return;
    const list = (store.get('cp.anCache', []) || []).filter((c) => c.key !== A.key);
    list.unshift({ key: A.key, evals: A.evals.map((e) => ({ score: e.score, best: e.best, pv: (e.pv || []).slice(0, 6), depth: e.depth })) });
    store.set('cp.anCache', list.slice(0, 8));
  }

  function close(notify = true) {
    pass?.destroy();
    live?.destroy();
    pass = live = null;
    cache.clear();
    A = null;
    $('#evalbar').hidden = true;
    if (notify) ctx.onClose();
  }

  const isOpen = () => !!A;

  // ---------------------------------------------------------------- navigation
  function goto(ply, ex = 0) {
    ply = Math.max(0, Math.min(A.main.length, ply));
    if (ex > 0 && !(A.explore && A.explore.from === ply)) ex = 0;
    if (A.explore) ex = Math.min(ex, ply === A.explore.from ? A.explore.moves.length : 0);
    const leavingRetry = A.retry && !(ply === A.retry.ply);
    if (leavingRetry) A.retry = null;
    A.ply = ply;
    A.ex = ex;
    afterPositionChange();
  }

  function step(dir) {
    if (dir > 0) {
      if (A.ex > 0 && A.ex < A.explore.moves.length) return goto(A.ply, A.ex + 1);
      if (A.ex === 0 && A.ply < A.main.length) return goto(A.ply + 1, 0);
    } else {
      if (A.ex > 0) return goto(A.ply, A.ex - 1);
      if (A.ply > 0) return goto(A.ply - 1, 0);
    }
  }

  function afterPositionChange() {
    sync();
    const fen = curFen();
    const t = terminalEval(new Chess(fen));
    if (t) {
      remember(fen, t);
      live.stop();
      A.live = { fen, depth: 0, lines: [] };
    } else {
      A.live = A.live?.fen === fen ? A.live : { fen, depth: 0, lines: [] };
      live.analyze(fen);
    }
    render();
  }

  // ---------------------------------------------------------------- moves on the board
  async function onBoardMove(orig, dest) {
    const pos = new Chess(curFen());
    const piece = pos.get(orig);
    let promotion;
    if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
      promotion = await askPromotion(dest, colorName(piece.color));
      if (!promotion) return sync();
    }
    playMove({ from: orig, to: dest, promotion });
  }

  /** Play a move from the current position: follow the game/variation if it matches, otherwise branch. */
  function playMove(mv, { silent = false, render: doRender = true } = {}) {
    const fen = curFen();
    const pos = new Chess(fen);
    const legalBefore = pos.moves().length;
    let m;
    try {
      m = pos.move(mv);
    } catch {
      sync();
      return false;
    }
    const u = m.from + m.to + (m.promotion || '');
    if (!silent) ctx.moveSound(m, pos);
    const inRetry = A.retry && A.ply === A.retry.ply && A.ex === 0;
    if (!inRetry && A.ex === 0 && A.main[A.ply]?.uci === u) {
      A.ply++;
    } else if (A.explore && A.explore.from === A.ply && A.explore.moves[A.ex]?.uci === u) {
      A.ex++;
    } else {
      const entry = { uci: u, san: m.san, color: colorName(m.color), from: m.from, to: m.to, fen: pos.fen(), legalBefore, moveNo: moveNo(fen) };
      if (A.ex === 0) A.explore = { from: A.ply, moves: [entry] };
      else A.explore.moves = [...A.explore.moves.slice(0, A.ex), entry];
      A.ex++;
    }
    if (doRender) afterPositionChange();
    return true;
  }

  /** Play the first n+1 moves of an engine line from the current position. */
  function playLine(pv, n) {
    for (let i = 0; i <= n && i < pv.length; i++) {
      if (!playMove(parseUci(pv[i]), { silent: i < n, render: false })) break;
    }
    afterPositionChange();
  }

  function discardExplore() {
    const from = A.explore?.from ?? A.ply;
    A.explore = null;
    goto(from, 0);
  }

  // ---------------------------------------------------------------- learning tools
  function startRetry() {
    const i = A.ex === 0 ? A.ply - 1 : -1;
    if (i < 0) return;
    A.retry = { ply: i, bad: A.main[i].uci, badSan: A.main[i].san, color: A.main[i].color };
    A.explore = null;
    A.ply = i;
    A.ex = 0;
    afterPositionChange();
  }

  function showBest() {
    const i = A.retry ? A.retry.ply : A.ply - 1;
    const best = A.evals[i]?.best;
    if (!best) return;
    A.retry = null;
    A.ply = i;
    A.ex = 0;
    A.explore = null;
    playLine([best], 0);
  }

  function mistakes() {
    const who = A.input.userColor;
    const list = [];
    for (let i = 0; i < A.main.length; i++) {
      const c = mainClass(i);
      if (c && (c.cls === 'mistake' || c.cls === 'blunder') && (!who || A.main[i].color === who)) list.push(i);
    }
    if (list.length) return list;
    for (let i = 0; i < A.main.length; i++) {
      const c = mainClass(i);
      if (c?.cls === 'inaccuracy' && (!who || A.main[i].color === who)) list.push(i);
    }
    return list;
  }

  function nextMistake() {
    const list = mistakes();
    if (!list.length) return toast('No mistakes found. Nice game!');
    const after = list.find((i) => i + 1 > A.ply) ?? list[0];
    A.retry = null;
    A.explore = null;
    goto(after + 1, 0);
  }

  // ---------------------------------------------------------------- engine updates
  function onLive(u) {
    if (!A || u.fen !== curFen()) return;
    A.live = u;
    if (u.lines[0] && u.depth >= 8) remember(u.fen, { score: u.lines[0].score, best: u.lines[0].pv[0], pv: u.lines[0].pv, depth: u.depth });
    queueRender();
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      if (A) {
        render();
        cg.setAutoShapes(shapes());
      }
    }, 120);
  }

  // ---------------------------------------------------------------- board
  function sync() {
    const fen = curFen();
    const pos = new Chess(fen);
    const mv = curMove();
    const turn = colorName(pos.turn());
    cg.set({
      fen,
      orientation: getOrientation(),
      turnColor: turn,
      lastMove: mv ? [mv.from, mv.to] : undefined,
      check: pos.inCheck(),
      viewOnly: false,
      movable: { free: false, color: pos.isGameOver() ? undefined : turn, dests: legalDests(pos), showDests: true },
      premovable: { enabled: false },
    });
    cg.setAutoShapes(shapes());
  }

  function badgeSvg(cls) {
    const g = CLASSES[cls].glyph;
    const fs = g.length > 1 ? 15 : 19;
    // chessground places custom SVGs at the square's top-left corner (100 units = 1 square)
    return `<g transform="translate(84 16)"><circle r="15" fill="${CLASS_COLOR[cls]}" stroke="#fff" stroke-width="2.5"/><text text-anchor="middle" dominant-baseline="central" font-size="${fs}" font-weight="800" font-family="system-ui,sans-serif" fill="#fff">${g}</text></g>`;
  }

  function shapes() {
    const out = [];
    const mv = curMove();
    const c = currentClass();
    if (mv && c) out.push({ orig: mv.to, customSvg: { html: badgeSvg(c.cls) } });
    if (!showEngine()) return out;
    // what should have been played, after a bad mainline move
    if (A.ex === 0 && c && BAD.has(c.cls)) {
      const best = A.evals[A.ply - 1]?.best;
      if (best && best !== mv.uci) out.push({ orig: best.slice(0, 2), dest: best.slice(2, 4), brush: 'green' });
    }
    const lines = A.live?.fen === curFen() ? A.live.lines : [];
    lines.slice(0, 3).forEach((l, i) => {
      const u = l.pv[0];
      if (u) out.push({ orig: u.slice(0, 2), dest: u.slice(2, 4), brush: i === 0 ? 'blue' : 'paleBlue', modifiers: i === 0 ? undefined : { lineWidth: 7 } });
    });
    return out;
  }

  // ---------------------------------------------------------------- rendering
  function currentScore() {
    const fen = curFen();
    const l = A.live?.fen === fen && A.live.lines[0];
    const known = cache.get(fen);
    if (l && (!known || A.live.depth >= (known.depth || 0))) return l.score;
    return known?.score || null;
  }

  function render() {
    if (!A) return;
    const fen = curFen();
    paintBar($('#bar-bottom'), { color: getOrientation(), fen, name: nameOf(getOrientation()) });
    paintBar($('#bar-top'), { color: getOrientation() === 'white' ? 'black' : 'white', fen, name: nameOf(getOrientation() === 'white' ? 'black' : 'white') });
    renderEvalBar();
    renderProgress();
    renderSummary();
    renderGraph();
    renderInfo();
    renderLines();
    renderMoves();
  }

  const nameOf = (color) => (color === 'white' ? A.input.white : A.input.black) || cap(color);

  function renderEvalBar() {
    const bar = $('#evalbar');
    bar.hidden = !showEngine();
    if (bar.hidden) return;
    const score = currentScore();
    const w = winPct(score);
    bar.classList.toggle('flipped', getOrientation() === 'black');
    $('.evalbar-white', bar).style.height = `${w}%`;
    const label = $('.evalbar-score', bar);
    label.textContent = score ? formatScore(score).replace('+', '') : '';
    label.classList.toggle('on-white', w >= 50);
    bar.title = score ? `Evaluation ${formatScore(score)} (white's view)` : 'Evaluating…';
  }

  function renderProgress() {
    const el = $('#an-progress');
    const total = A.fens.length;
    const done = Math.min(A.passDone, total);
    el.hidden = done >= total;
    if (el.hidden) return;
    $('.an-progress-text', el).textContent = `Analyzing the game with Stockfish… ${Math.round((100 * done) / total)}%`;
    $('.an-progress-bar span', el).style.width = `${(100 * done) / total}%`;
  }

  function stats() {
    const s = { white: { acc: [], counts: {} }, black: { acc: [], counts: {} } };
    for (let i = 0; i < A.main.length; i++) {
      const c = mainClass(i);
      if (!c) continue;
      const side = s[A.main[i].color];
      side.acc.push(c.accuracy);
      side.counts[c.cls] = (side.counts[c.cls] || 0) + 1;
    }
    for (const side of Object.values(s)) side.accuracy = side.acc.length ? side.acc.reduce((a, b) => a + b, 0) / side.acc.length : null;
    return s;
  }

  let summaryKey = '';
  function renderSummary() {
    const el = $('#an-summary');
    const complete = A.main.length > 0 && passComplete();
    el.hidden = !complete;
    if (!complete || summaryKey === A.key) return;
    summaryKey = A.key;
    const s = stats();
    const row = (cls) =>
      `<tr><td><span class="nag-dot" style="background:${CLASS_COLOR[cls]}">${CLASSES[cls].glyph}</span>${CLASSES[cls].label}</td><td>${s.white.counts[cls] || 0}</td><td>${s.black.counts[cls] || 0}</td></tr>`;
    const acc = (c) => (s[c].accuracy != null ? s[c].accuracy.toFixed(1) : '–');
    el.innerHTML = `
      <details class="an-sum">
      <summary><span class="muted">Accuracy</span> <b>${esc(nameOf('white'))} ${acc('white')}</b> <span class="muted">·</span> <b>${esc(nameOf('black'))} ${acc('black')}</b></summary>
      <table class="an-table">
        <thead><tr><th></th><th>${esc(nameOf('white'))}</th><th>${esc(nameOf('black'))}</th></tr></thead>
        <tbody>
          <tr class="acc"><td>Accuracy</td><td>${s.white.accuracy?.toFixed(1) ?? '–'}</td><td>${s.black.accuracy?.toFixed(1) ?? '–'}</td></tr>
          ${['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'].map(row).join('')}
        </tbody>
      </table>
      </details>`;
  }

  function renderGraph() {
    const svg = $('#an-graph');
    const n = A.fens.length;
    if (n < 2) {
      svg.innerHTML = '';
      return;
    }
    const W = 300;
    const H = 60;
    const x = (i) => (i / (n - 1)) * W;
    const y = (i) => H - (winPct(A.evals[i]?.score) / 100) * H;
    let d = `M0 ${H}`;
    for (let i = 0; i < n; i++) d += ` L${x(i).toFixed(1)} ${(A.evals[i] ? y(i) : H / 2).toFixed(1)}`;
    d += ` L${W} ${H} Z`;
    const dots = [];
    for (let i = 0; i < A.main.length; i++) {
      const c = mainClass(i);
      if (c && BAD.has(c.cls) && c.cls !== 'inaccuracy') dots.push(`<circle cx="${x(i + 1)}" cy="${y(i + 1)}" r="2.6" fill="${CLASS_COLOR[c.cls]}"/>`);
    }
    const cur = `<line x1="${x(A.ply)}" x2="${x(A.ply)}" y1="0" y2="${H}" class="g-cur"/>`;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = `<rect width="${W}" height="${H}" class="g-bg"/><path d="${d}" class="g-area"/><line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="g-mid"/>${cur}${dots.join('')}`;
  }

  let infoKey = '';
  function renderInfo() {
    const el = $('#an-info');
    const c0 = currentClass();
    const key = [A.ply, A.ex, A.explore?.moves.length, c0?.cls, A.retry ? `${A.retry.ply}:${A.retry.solved}` : '', showEngine(), passComplete(), A.ex > 0 ? !!cache.get(curFen()) : !!A.evals[A.ply]].join('|');
    if (key === infoKey) return;
    infoKey = key;
    el.innerHTML = '';
    if (A.retry && A.ply === A.retry.ply) return el.append(retryCard());
    if (A.ex === 0 && A.ply === 0) {
      el.append(h('p', { class: 'muted' }, A.main.length ? 'Step through the game with → (or click any move). Moves get graded as the analysis finishes.' : 'Make moves on the board to explore. The engine shows the best continuations below.'));
      return;
    }
    const mv = curMove();
    const c = currentClass();
    const head = h('div', { class: 'an-info-head' }, h('b', {}, `${mv.moveNo || moveNo(prevFen())} ${mv.san}`));
    if (c) head.append(h('span', { class: 'cls-pill', style: `background:${CLASS_COLOR[c.cls]}` }, `${CLASSES[c.cls].glyph} ${CLASSES[c.cls].label}`));
    else head.append(h('span', { class: 'muted small' }, 'grading…'));
    if (A.ex > 0) head.append(h('span', { class: 'explore-tag' }, 'your variation'));
    el.append(head);

    const beforeEval = A.ex > 0 ? cache.get(prevFen()) : A.evals[A.ply - 1];
    const afterEval = A.ex > 0 ? cache.get(curFen()) : A.evals[A.ply];
    if (beforeEval?.score && afterEval?.score && showEngine()) {
      el.append(h('p', { class: 'small muted' }, `Evaluation ${formatScore(beforeEval.score)} → ${formatScore(afterEval.score)}`));
    }
    if (c && BAD.has(c.cls) && beforeEval?.best && beforeEval.best !== mv.uci) {
      const bestSan = sanOf(prevFen(), beforeEval.best);
      const p = h('p', { class: 'small' }, 'Better was ', h('b', {}, bestSan), '.');
      el.append(p);
      const row = h('div', { class: 'an-btns' });
      if (A.ex === 0) {
        row.append(
          h('button', { class: 'btn small-btn primary', onclick: startRetry }, 'Retry this move'),
          h('button', { class: 'btn small-btn', onclick: showBest }, 'Show best move'),
        );
      }
      el.append(row);
    } else if (c?.cls === 'best') el.append(h('p', { class: 'small muted' }, 'This was the engine’s top choice.'));
    else if (c?.cls === 'forced') el.append(h('p', { class: 'small muted' }, 'This was the only legal move.'));

    const list = mistakes();
    if (A.ex === 0 && list.length && passComplete()) {
      const idx = list.indexOf(A.ply - 1);
      const nav = h('div', { class: 'an-btns' });
      if (idx >= 0) nav.append(h('span', { class: 'small muted' }, `Mistake ${idx + 1} of ${list.length}`));
      nav.append(h('button', { class: 'btn small-btn', onclick: nextMistake }, idx >= 0 ? 'Next mistake ›' : 'Go to my mistakes ›'));
      el.append(nav);
    }
    if (A.ex > 0) el.append(h('div', { class: 'an-btns' }, h('button', { class: 'btn small-btn', onclick: () => goto(A.explore.from, 0) }, '‹ Back to the game')));
    if (A.ex === 0 && A.ply === A.main.length && A.input.result) el.append(h('p', { class: 'small muted' }, `Game over: ${A.input.result}`));
  }

  function retryCard() {
    const r = A.retry;
    const box = h('div', { class: 'retry-card' });
    if (A.ex === 0) {
      box.append(
        h('b', {}, `Find a better move for ${cap(r.color)}`),
        h('p', { class: 'small muted' }, `In the game, ${r.badSan} was played here. The engine is hidden until you move.`),
        h('div', { class: 'an-btns' }, h('button', { class: 'btn small-btn', onclick: showBest }, 'Give up — show me'), h('button', { class: 'btn small-btn', onclick: () => goto(r.ply + 1, 0) }, 'Cancel')),
      );
      return box;
    }
    const m = A.explore.moves[A.ex - 1];
    const c = exploreClass(A.ex - 1);
    const tryAgain = () => {
      A.explore = null;
      goto(r.ply, 0);
    };
    if (A.ex === 1 && m.uci === r.bad) {
      box.append(h('b', {}, 'That’s the move from the game.'), h('p', { class: 'small muted' }, 'Try something different.'));
    } else if (!c) {
      box.append(h('b', {}, `${m.moveNo} ${m.san}`), h('p', { class: 'small muted' }, 'Checking your move…'));
    } else if (!BAD.has(c.cls)) {
      box.append(h('b', { class: 'ok-text' }, `✓ ${m.san} — ${CLASSES[c.cls].label}!`), h('p', { class: 'small muted' }, `Much better than ${r.badSan}. Explore the position or continue the review.`));
      if (!r.solved) {
        r.solved = true;
        sound.notify();
      }
    } else {
      box.append(h('b', { class: 'bad-text' }, `✗ ${m.san} — ${CLASSES[c.cls].label.toLowerCase()}`), h('p', { class: 'small muted' }, 'Not quite. Have another go.'));
    }
    box.append(
      h(
        'div',
        { class: 'an-btns' },
        h('button', { class: 'btn small-btn primary', onclick: tryAgain }, 'Try again'),
        h('button', { class: 'btn small-btn', onclick: showBest }, 'Show best move'),
        h('button', { class: 'btn small-btn', onclick: () => ((A.retry = null), goto(r.ply + 1, 0)) }, 'Done'),
      ),
    );
    return box;
  }

  function renderLines() {
    const el = $('#an-lines');
    el.innerHTML = '';
    if (!showEngine()) {
      el.append(h('p', { class: 'small muted an-lines-off' }, retryHidden() ? 'Engine hidden — your turn to find the move.' : 'Engine lines are hidden.'));
      return;
    }
    const fen = curFen();
    const pos = new Chess(fen);
    if (pos.isGameOver()) {
      el.append(h('p', { class: 'small muted' }, pos.isCheckmate() ? 'Checkmate.' : 'Game over — draw.'));
      return;
    }
    const L = A.live?.fen === fen ? A.live : null;
    el.append(h('div', { class: 'an-lines-head small muted' }, L?.depth ? `Stockfish 19 · depth ${L.depth}` : 'Stockfish 19 · thinking…'));
    for (const line of (L?.lines || []).slice(0, 3)) {
      const row = h('div', { class: 'an-line' });
      const w = winPct(line.score);
      row.append(h('span', { class: `an-score ${w >= 50 ? 'w' : 'b'}` }, formatScore(line.score)));
      const pv = h('span', { class: 'an-pv' });
      const c = new Chess(fen);
      const pvStr = line.pv.slice(0, 10).join(' ');
      line.pv.slice(0, 10).forEach((u, j) => {
        const before = c.fen();
        let m;
        try {
          m = c.move(parseUci(u));
        } catch {
          return;
        }
        const label = j === 0 || m.color === 'w' ? `${moveNo(before)} ${m.san}` : m.san;
        // pointerdown (not click): the list is redrawn as the engine deepens, which could eat a click
        pv.append(h('button', { class: 'pv-move', title: 'Play up to here', 'data-pv': pvStr, 'data-j': j, 'data-fen': fen }, label));
      });
      row.append(pv);
      el.append(row);
    }
  }

  function renderMoves() {
    const list = $('#an-moves');
    const classes = A.main.map((_, i) => mainClass(i)?.cls || '').join(',');
    const ex = A.explore ? `${A.explore.from}:${A.explore.moves.map((m) => m.uci).join(' ')}:${A.explore.moves.map((_, k) => exploreClass(k)?.cls || '').join(',')}` : '';
    const key = `${A.ply}|${A.ex}|${classes}|${ex}`;
    if (key === movesKey) return;
    movesKey = key;
    list.innerHTML = '';
    const badge = (c) => (c ? h('span', { class: 'nag', style: `color:${CLASS_COLOR[c.cls]}` }, CLASSES[c.cls].glyph) : null);
    const variation = () => {
      if (!A.explore) return null;
      const v = h('div', { class: 'variation' });
      A.explore.moves.forEach((m, k) => {
        const show = k === 0 || m.color === 'white';
        v.append(h('button', { class: `mv vmv${A.ply === A.explore.from && A.ex === k + 1 ? ' active' : ''}`, onclick: () => goto(A.explore.from, k + 1) }, show ? `${m.moveNo} ${m.san}` : m.san, badge(exploreClass(k))));
      });
      v.append(h('button', { class: 'var-close', title: 'Discard this variation', 'aria-label': 'Discard variation', onclick: discardExplore }, '×'));
      return v;
    };
    if (A.explore && A.explore.from === 0) list.append(variation());
    if (!A.main.length && !A.explore) list.append(h('div', { class: 'moves-empty' }, 'No moves yet.'));
    const startNo = Number(A.fens[0].split(' ')[5]);
    const blackFirst = A.fens[0].split(' ')[1] === 'b';
    const n = A.main.length;
    const rows = [];
    let i = 0;
    if (blackFirst && n) {
      rows.push({ no: startNo, cells: [null, 0] });
      i = 1;
    }
    for (; i < n; i += 2) rows.push({ no: startNo + Math.floor((i + (blackFirst ? 1 : 0)) / 2), cells: [i, i + 1 < n ? i + 1 : null] });
    for (const r of rows) {
      const row = h('div', { class: 'move-row' }, h('span', { class: 'move-no' }, `${r.no}.`));
      r.cells.forEach((j, k) => {
        if (j == null) {
          if (k === 0) row.append(h('span', { class: 'mv-empty' }, '…'));
          return;
        }
        row.append(h('button', { class: `mv${A.ex === 0 && A.ply === j + 1 ? ' active' : ''}`, onclick: () => goto(j + 1, 0) }, A.main[j].san, badge(mainClass(j))));
      });
      list.append(row);
      if (A.explore && A.explore.from > 0 && r.cells.includes(A.explore.from - 1)) list.append(variation());
    }
    const active = list.querySelector('.mv.active');
    active?.scrollIntoView({ block: 'nearest' });
  }

  function renderActions() {
    const box = $('#an-actions');
    box.innerHTML = '';
    box.append(
      h('button', { class: 'btn', onclick: () => (store.set('cp.engineOn', !engineOn()), renderActions(), afterPositionChange()) }, engineOn() ? 'Hide engine' : 'Show engine'),
      h('button', { class: 'btn', onclick: () => copyText(annotatedPgn(), 'Annotated PGN copied') }, 'Copy PGN'),
      h('button', { class: 'btn', onclick: () => close(true) }, 'Close'),
    );
  }

  // ---------------------------------------------------------------- export
  function annotatedPgn() {
    const nag = { inaccuracy: '?!', mistake: '?', blunder: '??' };
    const tags = [
      ['Event', A.input.event || 'Chess Playground analysis'],
      ['Site', location.host || 'Chess Playground'],
      ['White', A.input.white || 'White'],
      ['Black', A.input.black || 'Black'],
      ['Result', A.input.pgnResult || '*'],
    ];
    if (A.fens[0] !== START_FEN) tags.push(['SetUp', '1'], ['FEN', A.fens[0]]);
    const out = tags.map(([k, v]) => `[${k} "${String(v).replace(/"/g, "'")}"]`);
    const parts = [];
    A.main.forEach((m, i) => {
      const fen = A.fens[i];
      if (m.color === 'white' || i === 0) parts.push(moveNo(fen).replace('…', '...'));
      const c = mainClass(i);
      parts.push(m.san + (c && nag[c.cls] ? nag[c.cls] : ''));
      const e = A.evals[i + 1]?.score;
      const notes = [];
      if (e && e.mate !== 0) notes.push(`[%eval ${e.mate != null ? '#' + e.mate : (e.cp / 100).toFixed(2)}]`);
      if (c && BAD.has(c.cls) && A.evals[i]?.best) notes.push(`${CLASSES[c.cls].label}. Best was ${sanOf(fen, A.evals[i].best)}.`);
      if (notes.length) parts.push(`{ ${notes.join(' ')} }`);
    });
    parts.push(A.input.pgnResult || '*');
    return `${out.join('\n')}\n\n${parts.join(' ')}\n`;
  }

  // ---------------------------------------------------------------- keyboard / tools
  function onKey(e) {
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowUp') goto(0, 0);
    else if (e.key === 'ArrowDown') goto(A.main.length, 0);
    else if (e.key === 'f') flip();
    else return false;
    return true;
  }

  function flip() {
    setOrientation(getOrientation() === 'white' ? 'black' : 'white');
    sync();
    render();
  }

  return {
    open,
    close,
    isOpen,
    onBoardMove,
    onKey,
    flip,
    sync: () => A && sync(),
    copyPgn: () => A && copyText(annotatedPgn(), 'Annotated PGN copied'),
    nav: { first: () => goto(0, 0), prev: () => step(-1), next: () => step(1), last: () => goto(A.main.length, 0) },
  };
}
