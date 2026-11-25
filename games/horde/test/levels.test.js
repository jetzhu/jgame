// Level generation and difficulty: a bot plays the real levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step } from '../src/sim.js';
import { botInput } from '../src/bot.js';
import { nice } from '../src/levels.js';
import { statsFor, expectedStats, reward, defaultSave, buy, upgradeCost } from '../src/progress.js';

function play(opts, skill = 0.6, lag = 18, maxSecs = 400) {
  const g = createGame(opts);
  let inp = null;
  for (let t = 0; g.status === 'play' && t < maxSecs * 60; t++) {
    if (t % lag === 0) inp = botInput(g, skill);
    step(g, inp);
  }
  return g;
}

test('gate numbers read well', () => {
  assert.deepEqual([3, 11.6, 23, 77, 333, 2222].map(nice), [3, 12, 25, 80, 350, 2200]);
});

test('every campaign level 1-40 builds: content, a finish, a boss every 5th level', () => {
  for (let level = 1; level <= 40; level++) {
    const g = createGame({ level });
    assert.ok(g.length > 100 && g.length < 1500, `level ${level} length ${g.length}`);
    assert.ok(g.gates.length > 0 && g.dormant.length > 0, `level ${level} has gates and enemies`);
    assert.equal(!!g.boss, level % 5 === 0, `level ${level} boss`);
    for (const gt of g.gates) assert.ok(gt.value >= 1 && Number.isInteger(gt.value));
  }
});

test('a career: playing, earning and upgrading clears levels 1-15 in a few tries each', () => {
  let save = defaultSave();
  for (let level = 1; level <= 15; level++) {
    let tries = 0;
    for (;;) {
      tries++;
      const g = play({ level, ...statsFor(save.upg) });
      const won = g.status === 'won';
      save.coins += reward({ won, level, mult: g.result?.mult, progress: g.squad.z / g.length, kills: g.stats.kills }, save.upg);
      // spend on the cheapest upgrade until broke
      for (let next; (next = buy(save, ['squad', 'power', 'rate', 'coins'].sort((a, b) => upgradeCost(a, save.upg[a]) - upgradeCost(b, save.upg[b]))[0])); )
        save = next;
      if (won) break;
      assert.ok(tries < 4, `level ${level} needed ${tries}+ tries`);
    }
  }
});

test('standing still in the middle loses most levels (choices matter)', () => {
  let lost = 0;
  for (let level = 2; level <= 12; level++) {
    const e = expectedStats(level);
    const g = createGame({ level, start: Math.round(e.start), dmg: e.dmg, rate: e.rate });
    for (let t = 0; g.status === 'play' && t < 400 * 60; t++) step(g, { tx: 0 });
    if (g.status === 'lost') lost++;
  }
  assert.ok(lost >= 8, `idle player lost only ${lost}/11`);
});

test('without upgrades the campaign eventually becomes too hard', () => {
  let lost = 0;
  for (let level = 12; level <= 20; level++) if (play({ level }).status === 'lost') lost++;
  assert.ok(lost >= 6, `lost ${lost}/9`);
});

test('endless mode ends within a few minutes for a decent player', () => {
  const g = play({ mode: 'endless', seed: 3 }, 0.6, 18, 900);
  assert.equal(g.status, 'lost');
  assert.ok(g.squad.z > 300, `distance ${g.squad.z}`);
});

test('upgrades: costs grow, buying needs coins, rewards favor wins', () => {
  assert.ok(upgradeCost('power', 5) > upgradeCost('power', 4));
  const s = { ...defaultSave(), coins: 100 };
  const s2 = buy(s, 'squad');
  assert.equal(s2.upg.squad, 1);
  assert.equal(s2.coins, 100 - upgradeCost('squad', 0));
  assert.equal(buy({ ...s, coins: 0 }, 'squad'), null);
  assert.equal(statsFor(s2.upg).start, 6);
  const win = reward({ won: true, level: 5, mult: 3 });
  const loss = reward({ won: false, level: 5, progress: 0.9 });
  assert.ok(win > loss * 2 && loss > 0);
});

test('tide levels start from one soldier (plus squad upgrades) and open with the tide', () => {
  const g = createGame({ level: 6, start: 5 });
  assert.equal(g.squad.count, 1);
  assert.equal(g.segs[0].name, 'tide');
  assert.equal(createGame({ level: 6, start: 9 }).squad.count, 5);
  assert.equal(createGame({ level: 5, start: 5 }).squad.count, 5, 'boss levels are not tide levels');
  for (let level = 1; level <= 40; level++)
    assert.ok(createGame({ level }).segs.filter((s) => s.name === 'tide').length <= 1, `level ${level}: one tide at most`);
});

test('gatehouse levels open with a gatehouse; tides and gatehouses come with a brute', () => {
  assert.equal(createGame({ level: 8 }).segs[0].name, 'gatehouse');
  assert.notEqual(createGame({ level: 12 }).segs[0].name, 'gatehouse', 'tide levels keep the tide');
  for (const level of [6, 8]) {
    const g = createGame({ level });
    assert.equal(g.dormant.filter((e) => e.kind === 'brute' && e.z < g.segs[0].z1 + 5).length, 1, `level ${level}`);
  }
});
