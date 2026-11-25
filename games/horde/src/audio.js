// Synthesized sound effects (WebAudio, no audio files). Rate-limited so a 500-soldier squad
// doesn't turn into noise.
let ctx = null;
let master = null;
let enabled = true;
let noiseBuf = null;
const last = {};

function ensure() {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function throttle(name, ms) {
  const now = performance.now();
  if (now - (last[name] || 0) < ms) return false;
  last[name] = now;
  return true;
}

function tone({ freq, to = freq, dur = 0.12, type = 'square', vol = 0.2, delay = 0 }) {
  const c = ensure();
  if (!c) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise({ dur = 0.15, vol = 0.3, freq = 1200, q = 1, type = 'lowpass', delay = 0 }) {
  const c = ensure();
  if (!c) return;
  const t = c.currentTime + delay;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.3);
  src.stop(t + dur + 0.02);
}

export const sound = {
  get enabled() {
    return enabled;
  },
  set enabled(v) {
    enabled = !!v;
    if (master) master.gain.value = enabled ? 0.5 : 0;
  },
  unlock() {
    ensure();
  },
  shot() {
    if (throttle('shot', 70)) noise({ dur: 0.04, vol: 0.05, freq: 3000, type: 'highpass' });
  },
  kill() {
    if (throttle('kill', 45)) tone({ freq: 300 + Math.random() * 120, to: 90, dur: 0.07, type: 'triangle', vol: 0.12 });
  },
  clash() {
    if (throttle('clash', 90)) noise({ dur: 0.1, vol: 0.25, freq: 600 });
  },
  gate(good) {
    if (good) {
      tone({ freq: 520, to: 1040, dur: 0.14, type: 'square', vol: 0.12 });
      tone({ freq: 780, to: 1560, dur: 0.16, type: 'triangle', vol: 0.1, delay: 0.05 });
    } else tone({ freq: 400, to: 110, dur: 0.3, type: 'sawtooth', vol: 0.14 });
  },
  tick() {
    if (throttle('tick', 60)) tone({ freq: 1300, dur: 0.03, type: 'square', vol: 0.06 });
  },
  metal() {
    if (throttle('metal', 80)) tone({ freq: 900 + Math.random() * 300, to: 700, dur: 0.05, type: 'triangle', vol: 0.07 });
  },
  open() {
    noise({ dur: 0.5, vol: 0.35, freq: 900 });
    [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.18, type: 'square', vol: 0.1, delay: i * 0.07 }));
  },
  crate() {
    noise({ dur: 0.25, vol: 0.3, freq: 1500 });
    tone({ freq: 660, to: 1320, dur: 0.25, type: 'triangle', vol: 0.15, delay: 0.05 });
  },
  boom() {
    noise({ dur: 0.7, vol: 0.6, freq: 400 });
    tone({ freq: 120, to: 35, dur: 0.6, type: 'sine', vol: 0.5 });
  },
  boss() {
    tone({ freq: 90, to: 60, dur: 0.9, type: 'sawtooth', vol: 0.25 });
    tone({ freq: 95, to: 62, dur: 0.9, type: 'sawtooth', vol: 0.2, delay: 0.02 });
  },
  win() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone({ freq: f, dur: 0.22, type: 'square', vol: 0.11, delay: i * 0.1 }));
  },
  lose() {
    [392, 330, 262, 196].forEach((f, i) => tone({ freq: f, to: f * 0.97, dur: 0.3, type: 'triangle', vol: 0.18, delay: i * 0.16 }));
  },
  coin() {
    if (throttle('coin', 50)) tone({ freq: 1568, to: 2093, dur: 0.08, type: 'square', vol: 0.06 });
  },
  click() {
    tone({ freq: 700, dur: 0.04, type: 'square', vol: 0.06 });
  },
};
