// Personal puzzles: positions where you went wrong in your own games. Find the better move;
// spaced repetition (library.js) decides when each puzzle comes back.
import { Chess } from 'chess.js';
import { winPct } from './analysis.js';

const colorName = (c) => (c === 'w' ? 'white' : 'black');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const ACCEPT_DROP = 3; // a move within 3% winning chances of the engine's best also counts

function dests(chess) {
  const d = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!d.has(m.from)) d.set(m.from, []);
    d.get(m.from).push(m.to);
  }
  return d;
}

export function createPuzzles(ctx) {
  const { cg, $, h, library, sound, toast, askPromotion, setOrientation, evalPosition } = ctx;
  let P = null;

  function open() {
    const due = library.due();
    P = { queue: due.map((p) => p.id), total: due.length, done: 0, right: 0, cur: null, state: 'idle', tried: null, verdict: '', showSolution: false };
    ctx.showView('puzzles');
    next();
  }

  function close(notify = true) {
    P = null;
    if (notify) ctx.onClose();
  }

  function next() {
    const id = P.queue.shift();
    P.cur = id ? library.puzzles().find((p) => p.id === id) : null;
    P.state = P.cur ? 'solving' : 'done';
    P.tried = null;
    P.verdict = '';
    P.showSolution = false;
    if (P.cur) {
      setOrientation(P.cur.color);
      sync(P.cur.fen, true);
    }
    render();
  }

  function sync(fen, movable, lastMove) {
    const pos = new Chess(fen);
    cg.set({
      fen,
      orientation: P.cur.color,
      turnColor: colorName(pos.turn()),
      lastMove,
      check: pos.inCheck(),
      viewOnly: false,
      movable: { free: false, color: movable ? colorName(pos.turn()) : undefined, dests: movable ? dests(pos) : new Map(), showDests: true },
      premovable: { enabled: false },
    });
    cg.setAutoShapes(P.showSolution ? [{ orig: P.cur.best.slice(0, 2), dest: P.cur.best.slice(2, 4), brush: 'green' }] : []);
    ctx.onPosition?.(fen);
  }

  async function onBoardMove(orig, dest) {
    if (!P || P.state !== 'solving') return;
    const pz = P.cur;
    const pos = new Chess(pz.fen);
    const piece = pos.get(orig);
    let promotion;
    if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
      promotion = await askPromotion(dest, colorName(piece.color));
      if (!promotion) return sync(pz.fen, true);
    }
    let m;
    try {
      m = pos.move({ from: orig, to: dest, promotion });
    } catch {
      return sync(pz.fen, true);
    }
    ctx.moveSound(m, pos);
    const u = m.from + m.to + (m.promotion || '');
    P.tried = { uci: u, san: m.san, fen: pos.fen() };
    sync(pos.fen(), false, [m.from, m.to]);
    if (u === pz.best) return grade(true, 'That’s the engine’s top move.');
    if (u === pz.bad) return grade(false, 'That’s the move from your game. Try to see what it allows.');
    if (pos.isCheckmate()) return grade(true, 'Checkmate!');
    P.state = 'checking';
    render();
    let score = null;
    try {
      score = await evalPosition(pos.fen());
    } catch {}
    if (!P || P.cur !== pz) return;
    if (!score) {
      // Engine unavailable: only the stored best move counts.
      return grade(false, `The engine couldn’t check ${m.san}; the solution was ${pz.bestSan}.`);
    }
    const mover = pz.color;
    const best = mover === 'white' ? winPct(pz.score) : 100 - winPct(pz.score);
    const got = mover === 'white' ? winPct(score) : 100 - winPct(score);
    const drop = best - got;
    if (drop <= ACCEPT_DROP) grade(true, `${m.san} works too — about as good as ${pz.bestSan}.`);
    else grade(false, `${m.san} isn’t it.`);
  }

  function grade(ok, verdict) {
    const p = library.grade(P.cur.id, ok);
    P.state = ok ? 'right' : 'wrong';
    P.verdict = verdict;
    P.done++;
    if (ok) {
      P.right++;
      sound.notify();
    }
    P.nextDue = p?.due;
    render();
  }

  function retry() {
    P.state = 'solving';
    P.tried = null;
    P.verdict = '';
    sync(P.cur.fen, true);
    render();
  }

  function toggleSolution() {
    P.showSolution = !P.showSolution;
    sync(P.tried?.fen && !P.showSolution ? P.tried.fen : P.cur.fen, false);
    render();
  }

  const when = (t) => {
    const d = Math.round((t - Date.now()) / 86400000);
    if (d < 1) return 'later today';
    return d === 1 ? 'tomorrow' : `in ${d} days`;
  };

  function render() {
    if (!P) return;
    const box = $('#pz-body');
    box.innerHTML = '';
    $('#pz-progress').textContent = P.total ? `${Math.min(P.done + (P.state === 'solving' || P.state === 'checking' ? 1 : 0), P.total)} of ${P.total} · ${P.right} solved` : '';
    if (P.state === 'done') {
      const total = library.puzzles().length;
      box.append(
        h('div', { class: 'pz-card' },
          h('b', {}, P.total ? `Session done: ${P.right} of ${P.total} solved.` : total ? 'No puzzles are due right now.' : 'No puzzles yet.'),
          h('p', { class: 'small muted' }, total
            ? 'Puzzles you get right come back after longer and longer gaps (1, 3, 7, 21, then 60 days); ones you miss come back soon.'
            : 'Puzzles are made from your own mistakes and blunders. Finish a game against the computer or a friend, then press “Analyze”.'),
          total ? h('p', { class: 'small muted' }, `You have ${total} puzzle${total === 1 ? '' : 's'} in total.`) : null,
        ),
      );
      return;
    }
    const pz = P.cur;
    const card = h('div', { class: 'pz-card' });
    card.append(h('b', { class: 'pz-task' }, `Find the best move for ${cap(pz.color)}`));
    const from = [pz.gameTitle, pz.at ? new Date(pz.at).toLocaleDateString() : ''].filter(Boolean).join(' · ');
    card.append(h('p', { class: 'small muted' }, `In your game you played ${pz.badSan}${pz.cls === 'blunder' ? '??' : '?'}${from ? ` (${from})` : ''}.`));
    if (P.state === 'checking') card.append(h('p', { class: 'small' }, `Checking ${P.tried.san}…`));
    if (P.state === 'right' || P.state === 'wrong') {
      card.append(h('p', { class: P.state === 'right' ? 'ok-text pz-verdict' : 'bad-text pz-verdict' }, `${P.state === 'right' ? '✓ ' : '✗ '}${P.verdict}`));
      if (pz.reason) card.append(h('p', { class: 'small' }, `Why ${pz.badSan} was bad: ${pz.reason}`));
      if (P.state === 'right' || P.showSolution) card.append(h('p', { class: 'small' }, 'Best: ', h('b', {}, pz.bestSan)));
      if (P.nextDue) card.append(h('p', { class: 'small muted' }, `This puzzle comes back ${when(P.nextDue)}.`));
    }
    box.append(card);
    const btns = h('div', { class: 'an-btns pz-btns' });
    if (P.state === 'wrong') {
      btns.append(h('button', { class: 'btn small-btn', onclick: retry }, 'Try again'), h('button', { class: 'btn small-btn', onclick: toggleSolution }, P.showSolution ? 'Hide solution' : 'Show solution'));
    }
    if (P.state === 'right' || P.state === 'wrong') {
      btns.append(h('button', { class: 'btn small-btn primary', onclick: next }, P.queue.length ? 'Next puzzle ›' : 'Finish'));
      btns.append(h('button', { class: 'btn small-btn', onclick: () => ctx.analyzePosition(pz.fen, pz) }, 'Analyze'));
    }
    if (P.state === 'solving') btns.append(h('button', { class: 'btn small-btn', onclick: () => grade(false, `The solution was ${pz.bestSan}.`) || toggleSolution() }, 'Give up'));
    btns.append(h('button', { class: 'btn small-btn', onclick: () => {
      library.removePuzzle(pz.id);
      toast('Puzzle removed.');
      next();
    } }, 'Remove'));
    box.append(btns);
  }

  return { open, close, isOpen: () => !!P, onBoardMove };
}
