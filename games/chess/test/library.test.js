// Unit tests for game history, puzzle spaced repetition, and move explanations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibrary, PUZZLE_INTERVALS } from '../src/library.js';
import { explainMove, lineOutcome } from '../src/explain.js';

function memStore() {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? JSON.parse(m.get(k)) : d), set: (k, v) => m.set(k, JSON.stringify(v)) };
}

test('history: add, dedupe by key, update, remove', () => {
  const lib = createLibrary(memStore());
  const id = lib.addGame({ key: 'room:1', moves: ['e2e4'] });
  assert.equal(lib.addGame({ key: 'room:1', moves: ['e2e4'] }), id);
  lib.addGame({ moves: ['d2d4'] });
  assert.equal(lib.games().length, 2);
  lib.updateGame(id, { analysis: { accuracy: { white: 90 } } });
  assert.equal(lib.getGame(id).analysis.accuracy.white, 90);
  lib.removeGame(id);
  assert.equal(lib.games().length, 1);
});

test('puzzles: dedupe, due order, Leitner boxes', () => {
  let t = 1_000_000;
  const lib = createLibrary(memStore(), () => t);
  assert.equal(lib.addPuzzles([{ fen: 'A', bad: 'x' }, { fen: 'A', bad: 'x' }, { fen: 'B', bad: 'y' }]), 2);
  assert.equal(lib.due().length, 2);
  const [p] = lib.due();
  lib.grade(p.id, true);
  assert.equal(lib.puzzles().find((x) => x.id === p.id).due, t + PUZZLE_INTERVALS[1]);
  assert.equal(lib.due().length, 1);
  const q = lib.due()[0];
  lib.grade(q.id, false);
  assert.equal(lib.due().length, 0);
  t += PUZZLE_INTERVALS[0];
  assert.equal(lib.due().length, 1); // a missed puzzle comes back soon
});

test('lineOutcome measures material after the opponent replies', () => {
  // White queen takes a defended pawn on e5... and gets taken.
  const fen = 'rnb1kbnr/pppp1ppp/8/4p3/4P1q1/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1';
  const o = lineOutcome(fen, ['f3g5', 'g4d1'], 'w', 2);
  assert.equal(o.lost, 'q');
  assert.ok(o.worst <= -8);
});

test('explainMove: allows mate', () => {
  // 1. f3 e5 2. g4?? allows Qh4#
  const fenBefore = 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2';
  const text = explainMove({
    fenBefore,
    played: 'g2g4',
    mover: 'white',
    before: { score: { cp: -50 }, best: 'e2e4', pv: ['e2e4'] },
    after: { score: { mate: -1 }, best: 'd8h4', pv: ['d8h4'] },
  });
  assert.match(text, /mate in 1, starting with Qh4#/);
});

test('explainMove: hanging the moved piece', () => {
  // White plays Nd5?? into a pawn: ...exd5 is not possible; use Ng5?? attacked by a queen on d8 line: simpler — Bb5?? attacked by c6 pawn
  const fenBefore = 'r1bqkbnr/pp1ppppp/2n5/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3';
  const text = explainMove({
    fenBefore,
    played: 'f1a6',
    mover: 'white',
    before: { score: { cp: 30 }, best: 'f1b5', pv: ['f1b5'] },
    after: { score: { cp: -300 }, best: 'b7a6', pv: ['b7a6', 'd2d4'] },
  });
  assert.match(text, /bishop on a6 can simply be taken \(bxa6\)/);
});

test('explainMove: fork', () => {
  // Black plays ...Ke8?? and Nc7+ forks the king and the a8 rook.
  const text = explainMove({
    fenBefore: 'r4k2/8/8/1N6/8/8/8/4K3 b - - 0 1',
    played: 'f8e8',
    mover: 'black',
    before: { score: { cp: 0 }, best: 'a8a5', pv: ['a8a5'] },
    after: { score: { cp: 600 }, best: 'b5c7', pv: ['b5c7', 'e8d7', 'c7a8'] },
  });
  assert.equal(text, 'This allows a fork: Nc7+ attacks your king and rook.');
});

test('explainMove: missed material', () => {
  // White can win the undefended black queen on d5 with Nc3xd5 but plays Kf1 instead.
  const fenBefore = '4k3/8/8/3q4/8/2N5/8/4K3 w - - 0 1';
  const text = explainMove({
    fenBefore,
    played: 'e1f1',
    mover: 'white',
    before: { score: { cp: 900 }, best: 'c3d5', pv: ['c3d5', 'e8d7'] },
    after: { score: { cp: -300 }, best: 'd5d4', pv: ['d5d4', 'f1e2'] },
  });
  assert.equal(text, 'You could have won a queen with Nxd5.');
});
