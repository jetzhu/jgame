// Horde Gate: screens, input, game loop, HUD and saving. Game rules live in sim.js,
// drawing in render.js.
import { createGame, step, DT, HALF_W, progress } from './sim.js';
import { isBossLevel } from './levels.js';
import { botInput } from './bot.js';
import { createRenderer } from './render.js';
import { sound } from './audio.js';
import * as P from './progress.js';

const $ = (id) => document.getElementById(id);
const SAVE_KEY = 'hordegate.v1';

// ------------------------------------------------------------------ save
function readSave() {
  try {
    return P.loadSave(localStorage.getItem(SAVE_KEY));
  } catch {
    return P.defaultSave();
  }
}
let save = readSave();
function writeSave() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {
    /* private mode etc.: progress just isn't kept */
  }
}
sound.enabled = save.sound;

// ------------------------------------------------------------------ state
let renderer;
try {
  renderer = createRenderer($('game'));
} catch (err) {
  document.body.innerHTML = '<p class="noscript">Horde Gate needs WebGL, which this browser has turned off or does not support.</p>';
  throw err;
}

const S = {
  screen: 'home', // home | play | pause | result | shop
  game: null,
  demo: true, // the bot plays behind the title screen
  acc: 0,
  last: performance.now(),
  endAt: 0, // when the run ended (for the finish animation)
  shownCount: 0,
  hintUntil: 0,
};

function newDemo() {
  const level = 3 + Math.floor(Math.random() * 12);
  const e = P.expectedStats(level + 2);
  S.game = createGame({ level, seed: Math.floor(Math.random() * 1e9), start: Math.round(e.start), dmg: e.dmg, rate: e.rate });
  S.demo = true;
  renderer.reset();
}

function startRun(mode) {
  const st = P.statsFor(save.upg);
  S.game = createGame({
    mode,
    level: save.level,
    seed: mode === 'endless' ? Math.floor(Math.random() * 1e9) : undefined,
    start: st.start,
    dmg: st.dmg,
    rate: st.rate,
  });
  S.demo = false;
  S.acc = 0;
  S.endAt = 0;
  S.shownCount = S.game.squad.count;
  input.tx = null;
  renderer.reset();
  sound.unlock();
  show('play');
  $('hint').textContent = matchMedia('(pointer: coarse)').matches ? 'Drag to steer' : 'Drag or use ← → to steer · hold ↑ to run faster';
  $('hint').hidden = false;
  S.hintUntil = performance.now() + 3500;
  if (mode === 'endless') banner('ENDLESS', 'gold');
  else banner(isBossLevel(save.level) ? `LEVEL ${save.level} · BOSS` : `LEVEL ${save.level}`, isBossLevel(save.level) ? 'red' : '');
}

// ------------------------------------------------------------------ screens
function show(screen) {
  S.screen = screen;
  for (const id of ['home', 'shop', 'result', 'pause']) $(id).hidden = id !== screen;
  const playing = screen === 'play' || screen === 'pause' || (screen === 'result' && !S.demo);
  $('hud').hidden = !playing;
  $('squadTag').hidden = !playing;
  if (screen !== 'play') $('hint').hidden = true;
  if (screen === 'home') refreshHome();
  if (screen === 'shop') refreshShop();
}

function refreshHome() {
  $('playLevel').textContent = `Level ${save.level}${isBossLevel(save.level) ? ' · Boss' : ''}`;
  $('bestEndless').textContent = save.bestEndless ? `Best ${save.bestEndless} m` : 'How far can you go?';
  $('homeCoins').textContent = save.coins;
  $('soundBtn').textContent = save.sound ? '🔊 Sound on' : '🔇 Sound off';
}

const ICONS = { squad: '🪖', power: '💥', rate: '⚡', coins: '💰' };
let shopReturn = 'home';
function refreshShop() {
  $('shopCoins').textContent = save.coins;
  const st = P.statsFor(save.upg);
  const now = { squad: `${st.start} soldiers`, power: `${Math.round(st.dmg * 100)}% damage`, rate: `${Math.round(st.rate * 100)}% fire rate`, coins: `${Math.round(st.coinMult * 100)}% coins` };
  $('shopList').innerHTML = '';
  for (const u of P.UPGRADES) {
    const lvl = save.upg[u.key];
    const maxed = lvl >= P.MAX_UPGRADE;
    const cost = P.upgradeCost(u.key, lvl);
    const row = document.createElement('div');
    row.className = 'upg';
    row.innerHTML = `<div class="ic">${ICONS[u.key]}</div><div class="info"><b>${u.name}</b><span class="lv">Lv ${lvl}</span><p>${u.desc} · now ${now[u.key]}</p></div>`;
    const b = document.createElement('button');
    b.className = 'coin';
    b.textContent = maxed ? 'MAX' : cost;
    b.disabled = maxed || save.coins < cost;
    b.onclick = () => {
      const next = P.buy(save, u.key);
      if (!next) return;
      save = next;
      writeSave();
      sound.coin();
      refreshShop();
    };
    row.append(b);
    $('shopList').append(row);
  }
}

function showResult() {
  const g = S.game;
  const won = g.status === 'won';
  const endless = g.mode === 'endless';
  const distance = Math.floor(g.squad.z);
  const coins = P.reward(
    { won, level: g.level, mult: g.result?.mult, progress: progress(g), kills: g.stats.kills, mode: g.mode, distance },
    save.upg,
  );
  save.coins += coins;
  save.plays++;
  let title;
  const stats = [];
  if (endless) {
    const best = distance > save.bestEndless;
    if (best) save.bestEndless = distance;
    title = best ? 'New record!' : 'Overrun!';
    stats.push(['Distance', `${distance} m`], ['Best', `${save.bestEndless} m`]);
  } else if (won) {
    title = `Level ${g.level} cleared!`;
    save.level = g.level + 1;
    stats.push(['Survivors', g.squad.count], ['Bonus', `×${g.result.mult}`]);
  } else {
    title = 'Overrun!';
    stats.push(['Progress', `${Math.round(progress(g) * 100)}%`], ['Best squad', g.stats.peak]);
  }
  stats.push(['Enemies', g.stats.kills], ['Gates', g.stats.gates]);
  writeSave();
  $('resTitle').textContent = title;
  $('resStats').innerHTML = stats.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');
  $('resNext').textContent = endless ? 'Run again' : won ? `Next: Level ${save.level}` : 'Try again';
  $('resNext').onclick = () => startRun(endless ? 'endless' : 'campaign');
  show('result');
  // count the coins up
  const el = $('resCoins');
  const t0 = performance.now();
  const tick = () => {
    const p = Math.min(1, (performance.now() - t0) / 700);
    el.textContent = Math.round(coins * p);
    if (p < 1 && S.screen === 'result') {
      sound.coin();
      requestAnimationFrame(tick);
    }
  };
  tick();
}

// ------------------------------------------------------------------ HUD & floaters
function banner(text, cls = '') {
  const b = $('banner');
  b.hidden = true;
  b.className = cls;
  b.textContent = text;
  void b.offsetWidth; // restart the animation
  b.hidden = false;
}

function floater(text, x, y, cls = '') {
  const el = document.createElement('div');
  el.className = `floater ${cls}`;
  el.textContent = text;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  $('floaters').append(el);
  setTimeout(() => el.remove(), 1100);
}
const floatAt = (text, x, y, z, cls) => {
  const p = renderer.project(x, y, z);
  if (p.on) floater(text, p.x, p.y, cls);
};

const CRATE_TEXT = { rate: '⚡ Fire rate up!', dmg: '💥 Power up!', spread: '⋔ Spread shot!', troops: '👥 Reinforcements!' };
let lastClashFloat = 0;
let lastBuzz = 0;
function handleEvents(g) {
  const live = !S.demo;
  for (const e of g.events) {
    renderer.onEvent(e);
    if (!live) continue;
    switch (e.t) {
      case 'kill':
        if (!e.quiet) sound.kill();
        break;
      case 'clash':
        sound.clash();
        if (performance.now() - lastClashFloat > 250) {
          lastClashFloat = performance.now();
          floatAt(`-${e.n}`, g.squad.x + (Math.random() - 0.5), 1.4, g.squad.z, 'bad small');
        }
        if (performance.now() - lastBuzz > 300) {
          lastBuzz = performance.now();
          navigator.vibrate?.(15);
        }
        break;
      case 'gate':
        sound.gate(e.good);
        floatAt(e.label, e.x, 2.2, e.z, e.good ? 'good' : 'bad');
        break;
      case 'vaultHit':
        sound.metal();
        break;
      case 'vaultOpen':
        sound.open();
        if (!e.pillar) floatAt('UNLOCKED!', e.x, 3, e.z, 'gold');
        navigator.vibrate?.(40);
        break;
      case 'slabHold': {
        banner('BRING IT DOWN!', 'gold');
        const v = g.vaults.find((x) => x.id === e.pillar);
        if (v) floatAt('SHOOT!', (v.x0 + v.x1) / 2, 3.4, v.z, 'gold');
        break;
      }
      case 'slabFall':
        sound.boom();
        banner(e.crushed ? `CRUSHED ×${e.crushed}` : 'GO!', 'gold');
        navigator.vibrate?.([80, 40, 80]);
        break;
      case 'pump':
        sound.tick();
        break;
      case 'crate':
        sound.crate();
        floatAt(CRATE_TEXT[e.kind], e.x, 2, e.z, 'gold');
        break;
      case 'boom':
        sound.boom();
        navigator.vibrate?.(60);
        break;
      case 'hurt':
        floatAt(`-${e.n}`, e.x, 1.6, e.z, 'bad');
        break;
      case 'bossWake':
        sound.boss();
        banner('BOSS!', 'red');
        break;
      case 'bossDown':
        sound.boom();
        banner('BOSS DOWN!', 'gold');
        navigator.vibrate?.([60, 40, 60]);
        break;
      case 'won':
        sound.win();
        break;
      case 'lost':
        sound.lose();
        navigator.vibrate?.(200);
        break;
    }
  }
}

function updateHud(g) {
  const s = g.squad;
  if (g.mode === 'endless') {
    $('hudLevel').textContent = `${Math.floor(s.z)} m`;
    $('hudProgress').style.width = `${Math.min(100, (s.z / Math.max(100, save.bestEndless)) * 100)}%`;
  } else {
    $('hudLevel').textContent = `Level ${g.level}`;
    $('hudProgress').style.width = `${progress(g) * 100}%`;
  }
  $('hudCoins').textContent = save.coins;
  const tag = $('squadTag');
  const p = renderer.project(s.x, 1.25 + s.r * 0.25, s.z);
  // position with left/top: the pop animation owns `transform`
  tag.style.left = `${p.x}px`;
  tag.style.top = `${p.y}px`;
  if (s.count !== S.shownCount) {
    tag.classList.remove('up', 'down');
    void tag.offsetWidth;
    tag.classList.add(s.count > S.shownCount ? 'up' : 'down');
    S.shownCount = s.count;
  }
  tag.textContent = s.count;
  const b = g.boss;
  $('bossBar').hidden = !(b && b.active && !b.dead && !S.demo);
  if (b && b.active) $('bossFill').style.width = `${(b.hp / b.maxHp) * 100}%`;
  if (S.hintUntil && performance.now() > S.hintUntil) {
    $('hint').hidden = true;
    S.hintUntil = 0;
  }
}

// ------------------------------------------------------------------ input
// The camera looks down +z from behind the squad, which puts world -x on the right of the screen.
const SCREEN_RIGHT = -1;
const input = { tx: null, keys: 0, dragging: false, startX: 0, startTx: 0 };
const canvas = $('game');
function pointerDown(e) {
  if (S.screen !== 'play' || S.demo) return;
  input.dragging = true;
  input.startX = e.clientX;
  input.startTx = input.tx ?? S.game.squad.tx;
  canvas.setPointerCapture?.(e.pointerId);
  sound.unlock();
}
function pointerMove(e) {
  if (!input.dragging) return;
  const w = Math.min(window.innerWidth, 700);
  input.tx = Math.max(-HALF_W, Math.min(HALF_W, input.startTx + SCREEN_RIGHT * ((e.clientX - input.startX) / w) * 2 * HALF_W * 1.3));
  if (S.hintUntil) S.hintUntil = performance.now() + 300;
}
function pointerUp() {
  input.dragging = false;
}
canvas.addEventListener('pointerdown', pointerDown);
window.addEventListener('pointermove', pointerMove);
window.addEventListener('pointerup', pointerUp);
window.addEventListener('pointercancel', pointerUp);
const KEYS = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
const BOOST_KEYS = new Set(['ArrowUp', 'KeyW']); // hold to run at double speed
const held = new Set();
const boosting = () => [...held].some((k) => BOOST_KEYS.has(k));
window.addEventListener('keydown', (e) => {
  if (e.code in KEYS || BOOST_KEYS.has(e.code)) {
    held.add(e.code);
    e.preventDefault();
  } else if ((e.code === 'Escape' || e.code === 'KeyP') && S.screen === 'play' && !S.demo) show('pause');
  else if ((e.code === 'Escape' || e.code === 'KeyP') && S.screen === 'pause') resume();
  else if ((e.code === 'Enter' || e.code === 'Space') && S.screen === 'home') startRun('campaign');
});
window.addEventListener('keyup', (e) => held.delete(e.code));
window.addEventListener('blur', () => held.clear());

function keyboardInput(dt) {
  let dir = 0;
  for (const k of held) dir += KEYS[k] || 0;
  if (!dir) return;
  input.tx = Math.max(-HALF_W, Math.min(HALF_W, (input.tx ?? S.game.squad.tx) + SCREEN_RIGHT * Math.sign(dir) * 11 * dt));
  if (S.hintUntil) S.hintUntil = performance.now() + 300;
}

function resume() {
  S.last = performance.now();
  show('play');
}

// ------------------------------------------------------------------ loop
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - S.last) / 1000);
  S.last = now;
  const g = S.game;
  const running = S.screen === 'play' || (S.demo && S.screen !== 'pause');
  if (running && g.status === 'play') {
    if (!S.demo) keyboardInput(dt);
    S.acc += dt;
    let steps = 0;
    while (S.acc >= DT && steps < 6) {
      step(g, S.demo || S.autoplay ? botInput(g, 0.8) : { tx: input.tx, boost: boosting() });
      handleEvents(g);
      S.acc -= DT;
      steps++;
    }
    if (steps === 6) S.acc = 0;
  } else if (g.status !== 'play') {
    // finish: run the survivors up the bonus ramp; then show the result
    if (!S.endAt) S.endAt = now;
    if (g.status === 'won') {
      const target = g.length + 2 + (g.result.mult - 1) * 2.4 + 1;
      if (g.squad.z < target) g.squad.z = Math.min(target, g.squad.z + 7 * dt);
    }
    const wait = g.status === 'won' ? 1800 : 1300;
    if (now - S.endAt > wait) {
      if (S.demo) newDemo();
      else if (S.screen === 'play') showResult();
    }
  }
  renderer.render(S.game);
  if (!S.demo) updateHud(S.game);
}

// ------------------------------------------------------------------ wiring
$('playBtn').onclick = () => startRun('campaign');
$('endlessBtn').onclick = () => startRun('endless');
$('shopBtn').onclick = () => {
  shopReturn = 'home';
  sound.click();
  show('shop');
};
$('shopBack').onclick = () => {
  sound.click();
  if (shopReturn === 'result') {
    newDemo();
    show('home');
  } else show('home');
};
$('shopPlay').onclick = () => startRun('campaign');
$('soundBtn').onclick = () => {
  save.sound = !save.sound;
  sound.enabled = save.sound;
  writeSave();
  refreshHome();
  sound.click();
};
$('pauseBtn').onclick = () => show('pause');
$('resumeBtn').onclick = resume;
$('restartBtn').onclick = () => startRun(S.game.mode === 'endless' ? 'endless' : 'campaign');
$('quitBtn').onclick = () => {
  newDemo();
  show('home');
};
$('resHome').onclick = () => {
  newDemo();
  show('home');
};
$('resShop').onclick = () => {
  shopReturn = 'result';
  newDemo();
  show('shop');
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden && S.screen === 'play' && !S.demo) show('pause');
});
window.addEventListener('resize', () => renderer.resize());

// Dev hook: #debug exposes state, #level=N jumps to a level (handy for testing late content).
if (location.hash.includes('debug')) {
  window.__hg = {
    S,
    get save() {
      return save;
    },
    startRun,
    // fast-forward the current game with the bot at the wheel
    ff(secs) {
      for (let i = 0; i < secs * 60 && S.game.status === 'play'; i++) step(S.game, botInput(S.game, 0.8));
    },
  };
  const m = location.hash.match(/level=(\d+)/);
  if (m) save.level = Number(m[1]);
}

newDemo();
show('home');
requestAnimationFrame(frame);
