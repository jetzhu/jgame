// Plain-language explanations for graded moves, built from the engine's lines.
// Heuristics, phrased cautiously: mates, material lost/won within a few moves, forks.
import { Chess } from 'chess.js';

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const parseUci = (u) => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });

function material(chess, color) {
  let v = 0;
  for (const row of chess.board()) for (const sq of row) if (sq && sq.color === color) v += VALUE[sq.type];
  return v;
}

/**
 * Play up to `plies` moves of `pv` from `fen`, tracking `color`'s material edge.
 * Returns {swing, lost: biggest piece of `color` captured, won: biggest enemy piece captured, sans}.
 */
export function lineOutcome(fen, pv, color, plies = 4) {
  const c = new Chess(fen);
  const opp = color === 'w' ? 'b' : 'w';
  const start = material(c, color) - material(c, opp);
  let lost = null;
  let won = null;
  const sans = [];
  let worst = 0;
  let best = 0;
  for (const u of (pv || []).slice(0, plies)) {
    let m;
    try {
      m = c.move(parseUci(u));
    } catch {
      break;
    }
    sans.push(m.san);
    if (m.captured) {
      if (m.color === opp && (!lost || VALUE[m.captured] > VALUE[lost])) lost = m.captured;
      if (m.color === color && (!won || VALUE[m.captured] > VALUE[won])) won = m.captured;
    }
    // Only judge positions after the opponent has replied, so half-finished trades don't count.
    if (c.turn() === color) {
      const d = material(c, color) - material(c, opp) - start;
      worst = Math.min(worst, d);
      best = Math.max(best, d);
    }
  }
  const d = material(c, color) - material(c, opp) - start;
  return { swing: d, worst: Math.min(worst, d), best: Math.max(best, d), lost, won, sans };
}

/** Squares of `color`'s pieces worth >= 3 (or the king) attacked by the piece now on `sq`. */
function forkTargets(chess, sq, color) {
  const targets = [];
  for (const row of chess.board())
    for (const p of row) {
      if (!p || p.color !== color || (VALUE[p.type] < 3 && p.type !== 'k')) continue;
      if (chess.attackers(p.square, color === 'w' ? 'b' : 'w').includes(sq)) targets.push(p.type);
    }
  return targets;
}

/**
 * @param {object} o
 * @param {string} o.fenBefore  position before the move
 * @param {string} o.played     uci of the move
 * @param {{score, best, pv}} o.before  analysis before the move (best line for the mover)
 * @param {{score, best, pv}} o.after   analysis after the move (best line for the opponent)
 * @param {'white'|'black'} o.mover
 * @returns {string|null}
 */
export function explainMove({ fenBefore, played, before, after, mover }) {
  if (!before?.score || !after?.score) return null;
  const me = mover[0];
  const them = mover === 'white' ? 'Black' : 'White';
  const sign = mover === 'white' ? 1 : -1;
  const pos = new Chess(fenBefore);
  let move;
  try {
    move = pos.move(parseUci(played));
  } catch {
    return null;
  }
  const fenAfter = pos.fen();
  const sanOf = (fen, u) => {
    try {
      return new Chess(fen).move(parseUci(u)).san;
    } catch {
      return u;
    }
  };

  // 1. Mates
  const myMateBefore = before.score.mate != null && before.score.mate * sign > 0 ? Math.abs(before.score.mate) : null;
  const theirMateAfter = after.score.mate != null && after.score.mate * sign < 0 ? Math.abs(after.score.mate) : null;
  const myMateAfter = after.score.mate != null && after.score.mate * sign > 0 ? Math.abs(after.score.mate) : null;
  if (theirMateAfter) return `This allows ${them} to force mate in ${theirMateAfter}${after.best ? `, starting with ${sanOf(fenAfter, after.best)}` : ''}.`;
  if (myMateBefore && (!myMateAfter || myMateAfter > myMateBefore) && before.best && before.best !== played) {
    return `You had a forced mate in ${myMateBefore}, starting with ${sanOf(fenBefore, before.best)}.`;
  }

  // 2. What the opponent's best reply does to us
  const reply = lineOutcome(fenAfter, after.pv, me, 4);
  const replyFirst = after.pv?.[0];
  if (replyFirst) {
    const c = new Chess(fenAfter);
    let r;
    try {
      r = c.move(parseUci(replyFirst));
    } catch {}
    if (r) {
      if (r.captured && r.to === move.to && reply.worst <= -2) return `Your ${NAME[move.piece]} on ${move.to} can simply be taken (${r.san}).`;
      const targets = forkTargets(c, r.to, me);
      if (targets.length >= 2 && reply.worst <= -2) {
        const names = targets.sort((a, b) => (b === 'k') - (a === 'k') || VALUE[b] - VALUE[a]).slice(0, 2).map((t) => NAME[t]);
        return `This allows a fork: ${r.san} attacks your ${names[0]} and ${names[1]}.`;
      }
      if (reply.worst <= -2 && reply.lost) return `This lets ${them} win your ${NAME[reply.lost]}, starting with ${r.san}.`;
      if (reply.worst <= -1 && reply.lost === 'p') return `This drops a pawn: ${them} can play ${r.san}.`;
    }
  }

  // 3. What we missed
  if (before.best && before.best !== played) {
    const mine = lineOutcome(fenBefore, before.pv, me, 4);
    const gotHere = lineOutcome(fenBefore, [played, ...(after.pv || [])], me, 4);
    if (mine.best >= 2 && mine.won && mine.best - Math.max(0, gotHere.best) >= 2) {
      return `You could have won a ${NAME[mine.won]} with ${sanOf(fenBefore, before.best)}.`;
    }
  }
  return null;
}

/** One-line fallback when no tactic was detected. */
export function genericReason(cls, bestSan) {
  if (cls === 'blunder') return `This throws away a lot of your advantage. ${bestSan ? `${bestSan} was much stronger.` : ''}`.trim();
  if (cls === 'mistake') return `This makes your position noticeably worse.${bestSan ? ` ${bestSan} kept more.` : ''}`;
  if (cls === 'inaccuracy') return bestSan ? `Slightly imprecise. ${bestSan} was more accurate.` : 'Slightly imprecise.';
  return null;
}

export { cap };
