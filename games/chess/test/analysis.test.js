// Unit tests for the analysis scoring math.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winPct, moveAccuracy, classifyMove, formatScore, parseInfo, toWhite } from '../src/analysis.js';

test('winPct is 50 at equality, symmetric, and saturates for mates', () => {
  assert.equal(winPct({ cp: 0 }), 50);
  assert.ok(Math.abs(winPct({ cp: 300 }) + winPct({ cp: -300 }) - 100) < 1e-9);
  assert.ok(winPct({ cp: 300 }) > 70 && winPct({ cp: 300 }) < 80);
  assert.equal(winPct({ mate: 3 }), 100);
  assert.equal(winPct({ mate: -1 }), 0);
});

test('moveAccuracy is ~100 for no loss and falls with the drop', () => {
  assert.ok(moveAccuracy(0) > 99.9);
  assert.ok(moveAccuracy(10) < moveAccuracy(2));
  assert.equal(moveAccuracy(200), 0);
});

test('classifyMove: best, thresholds, forced, and black perspective', () => {
  const before = { score: { cp: 30 }, best: 'g1f3' };
  assert.equal(classifyMove({ before, after: { score: { cp: 20 } }, mover: 'white', played: 'g1f3', legalCount: 20 }).cls, 'best');
  assert.equal(classifyMove({ before, after: { score: { cp: 10 } }, mover: 'white', played: 'e2e4', legalCount: 20 }).cls, 'excellent');
  assert.equal(classifyMove({ before, after: { score: { cp: -150 } }, mover: 'white', played: 'a2a4', legalCount: 20 }).cls, 'mistake');
  assert.equal(classifyMove({ before, after: { score: { cp: -900 } }, mover: 'white', played: 'd1h5', legalCount: 20 }).cls, 'blunder');
  assert.equal(classifyMove({ before, after: { score: { cp: -900 } }, mover: 'white', played: 'e1f1', legalCount: 1 }).cls, 'forced');
  // black to move: white's score going UP is bad for black
  const b = classifyMove({ before: { score: { cp: 0 }, best: 'e7e5' }, after: { score: { cp: 400 } }, mover: 'black', played: 'f7f6', legalCount: 20 });
  assert.equal(b.cls, 'blunder');
  assert.equal(classifyMove({ before: { score: null }, after: { score: { cp: 0 } }, mover: 'white', played: 'x', legalCount: 2 }), null);
});

test('formatScore', () => {
  assert.equal(formatScore({ cp: 134 }), '+1.3');
  assert.equal(formatScore({ cp: -40 }), '−0.4');
  assert.equal(formatScore({ cp: 2 }), '0.0');
  assert.equal(formatScore({ mate: 3 }), 'M3');
  assert.equal(formatScore({ mate: -2 }), '−M2');
});

test('parseInfo and toWhite', () => {
  const i = parseInfo('info depth 14 seldepth 20 multipv 2 score cp -35 nodes 1 nps 1 time 5 pv e7e5 g1f3 b8c6');
  assert.deepEqual(i, { depth: 14, multipv: 2, score: { cp: -35 }, pv: ['e7e5', 'g1f3', 'b8c6'] });
  assert.equal(parseInfo('info depth 3 score cp 10 lowerbound pv e2e4'), null);
  assert.equal(parseInfo('info string NNUE loaded'), null);
  const blackToMove = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  assert.deepEqual(toWhite({ cp: -35 }, blackToMove), { cp: 35 });
  assert.deepEqual(toWhite({ mate: 2 }, blackToMove), { mate: -2 });
});
