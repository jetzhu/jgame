// Tiny synthesized sound effects (no audio files).
let ctx = null;
const ac = () => {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
};

function knock(gain = 0.5, freq = 1800, dur = 0.06, delay = 0) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime + delay;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = 1.2;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(a.destination);
  src.start(t);
}

function tone(freq, dur = 0.15, gain = 0.08, delay = 0, type = 'sine') {
  const a = ac();
  if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

let enabled = true;
try {
  enabled = localStorage.getItem('cp.sound') !== 'off';
} catch {}

export const sound = {
  get enabled() {
    return enabled;
  },
  set enabled(v) {
    enabled = v;
    try {
      localStorage.setItem('cp.sound', v ? 'on' : 'off');
    } catch {}
  },
  unlock() {
    if (enabled) ac();
  },
  move() {
    if (enabled) knock(0.9, 1500, 0.05);
  },
  capture() {
    if (!enabled) return;
    knock(1.2, 1100, 0.07);
    knock(0.6, 2200, 0.05, 0.035);
  },
  castle() {
    if (!enabled) return;
    knock(0.8, 1500, 0.05);
    knock(0.8, 1300, 0.05, 0.09);
  },
  check() {
    if (!enabled) return;
    knock(0.9, 1500, 0.05);
    tone(988, 0.18, 0.06, 0.02, 'triangle');
  },
  start() {
    if (!enabled) return;
    tone(523, 0.12, 0.06);
    tone(784, 0.2, 0.06, 0.1);
  },
  end() {
    if (!enabled) return;
    tone(784, 0.18, 0.07);
    tone(659, 0.18, 0.07, 0.15);
    tone(523, 0.35, 0.07, 0.3);
  },
  notify() {
    if (enabled) tone(880, 0.12, 0.05);
  },
  lowTime() {
    if (enabled) tone(440, 0.1, 0.05, 0, 'square');
  },
};
