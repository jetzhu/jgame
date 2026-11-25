// three.js view of a game from sim.js. Owns no game state: each frame it reads the sim and
// mirrors it (instanced meshes for crowds and bullets, pooled objects for gates, vaults, etc.).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HALF_W, gateLabel, gateGood, squadRadius } from './sim.js';

const MAX_SOLDIERS = 220;
const MAX_ENEMIES = 3000;
const MAX_BULLETS = 500;
const MAX_PARTICLES = 900;
const VIEW_BEHIND = 6;
const VIEW_AHEAD = 95;
const DECK_LEN = 170;
const PILLAR_H = 2.6; // height of a slab's standing pillar (the slab's high edge rests on it)

const COLORS = {
  sky: 0x0a1730,
  deck: '#9aa3b1',
  soldier: 0x2f7dff,
  soldierBody: 0x1b3a8a,
  skin: 0xf2c49b,
  enemy: 0xe0453a,
  elite: 0x8e1336,
  stone: 0xa9a49b,
  bullet: 0xffd34d,
  good: '#1f86ff',
  gold: '#ffbf1f',
  bad: '#ff3349',
  locked: '#6d7583',
};

/** Canvas texture with big outlined text, used for gate panels, vault displays, crate labels. */
function textCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { c, ctx: c.getContext('2d'), tex };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function bigText(ctx, text, x, y, size, fill = '#fff') {
  ctx.font = `900 ${size}px "Arial Black", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size * 0.16;
  ctx.strokeStyle = 'rgba(10,20,40,.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

// The tag on a pile of sacks: its HP, on a rope-hung plank.
function drawSackTag(t, hp) {
  const { c, ctx } = t;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#7a5530';
  roundRect(ctx, 6, 6, c.width - 12, c.height - 12, 14);
  ctx.fill();
  ctx.strokeStyle = '#4a3218';
  ctx.lineWidth = 6;
  ctx.stroke();
  bigText(ctx, String(Math.ceil(hp)), c.width / 2, c.height / 2 + 2, hp >= 10000 ? 52 : 66);
  t.tex.needsUpdate = true;
}

// Steel face of a strongbox: brushed plate, rivets, hazard bands, the HP, and dents as it weakens.
function hazard(ctx, x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = '#1b1b1b';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#ffc61f';
  for (let k = x - h; k < x + w + h; k += 32) {
    ctx.beginPath();
    ctx.moveTo(k, y);
    ctx.lineTo(k + 16, y);
    ctx.lineTo(k + 16 - h, y + h);
    ctx.lineTo(k - h, y + h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
function drawSteel(t, hp, maxHp, seed) {
  const { c, ctx } = t;
  const W = c.width;
  const H = c.height;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#b9c2cc');
  g.addColorStop(0.5, '#8d97a3');
  g.addColorStop(1, '#a7b0bb');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  for (let y = 0; y < H; y += 3) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  hazard(ctx, 0, 0, W, 26);
  hazard(ctx, 0, H - 26, W, 26);
  ctx.fillStyle = '#5f6873';
  for (const x of [16, W - 16]) for (let y = 44; y < H - 30; y += 46) ctx.fillRect(x - 5, y - 5, 10, 10);
  let a = seed * 7919 + 17;
  const rnd = () => ((a = (a * 9301 + 49297) % 233280) / 233280);
  const dents = Math.floor((1 - hp / maxHp) * 9);
  for (let k = 0; k < dents; k++) {
    const x = 30 + rnd() * (W - 60);
    const y = 40 + rnd() * (H - 80);
    const r = 10 + rnd() * 16;
    const d = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
    d.addColorStop(0, 'rgba(30,34,40,.75)');
    d.addColorStop(0.7, 'rgba(60,66,74,.35)');
    d.addColorStop(1, 'rgba(255,255,255,.15)');
    ctx.fillStyle = d;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  bigText(ctx, String(Math.ceil(hp)), W / 2, H * 0.5, hp >= 10000 ? 58 : 76);
  t.tex.needsUpdate = true;
}

/** The wall of a gatehouse: dark steel plate with a hazard band along the top, tiled across. */
function gateWallTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#7b8592');
  g.addColorStop(1, '#5a636e');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.fillRect(126, 40, 4, 216);
  ctx.fillStyle = '#4a525c';
  for (let x = 12; x < 256; x += 40) for (const y of [52, 236]) ctx.fillRect(x, y, 8, 8);
  hazard(ctx, 0, 0, 256, 36);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

// Plain gates are translucent with a white frame. Pump gates (they change when shot) are solid,
// with a hazard-striped frame and a caption, so the two never look alike.
function drawGate(t, label, color, locked, pump) {
  const { c, ctx } = t;
  ctx.clearRect(0, 0, c.width, c.height);
  if (pump) return drawPumpGate(t, label, color);
  ctx.globalAlpha = locked ? 0.55 : 0.82;
  ctx.fillStyle = color;
  roundRect(ctx, 6, 6, c.width - 12, c.height - 12, 22);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(255,255,255,.75)';
  ctx.stroke();
  bigText(ctx, label, c.width / 2, c.height / 2 + 4, label.length > 4 ? 64 : 84);
  if (locked) {
    ctx.font = '48px system-ui';
    ctx.fillText('🔒', c.width - 44, 44);
  }
  t.tex.needsUpdate = true;
}

function drawPumpGate(t, label, color) {
  const { c, ctx } = t;
  const W = c.width;
  const H = c.height;
  // striped frame
  roundRect(ctx, 4, 4, W - 8, H - 8, 18);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = '#1b1b1b';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffd21f';
  for (let x = -H; x < W + H; x += 28) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 14, 0);
    ctx.lineTo(x + 14 - H, H);
    ctx.lineTo(x - H, H);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // solid face
  ctx.fillStyle = color;
  roundRect(ctx, 18, 18, W - 36, H - 36, 10);
  ctx.fill();
  bigText(ctx, label, W / 2, H / 2 - 8, label.length > 4 ? 56 : 72);
  ctx.font = '900 19px "Arial Black", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.fillText('SHOOT TO RAISE', W / 2, H - 34);
  t.tex.needsUpdate = true;
}

function targetTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ['#e8262f', '#ffffff', '#e8262f', '#ffffff', '#e8262f'].forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(64, 64, 62 - i * 12.5, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.strokeStyle = '#1b1b1b';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(64, 64, 61, 0, Math.PI * 2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Concrete face for vaults and pillars: the HP number, and cracks that spread as it weakens.
function drawConcrete(t, hp, maxHp, seed) {
  const { c, ctx } = t;
  const W = c.width;
  const H = c.height;
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#cfc9be');
  g.addColorStop(1, '#a9a297');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  let a = seed * 9301 + 49297;
  const rnd = () => ((a = (a * 9301 + 49297) % 233280) / 233280);
  ctx.fillStyle = 'rgba(0,0,0,.07)';
  for (let i = 0; i < 50; i++) ctx.fillRect(rnd() * W, rnd() * H, 5, 5);
  const frac = hp / maxHp;
  const cracks = frac < 0.33 ? 9 : frac < 0.66 ? 4 : 0;
  ctx.strokeStyle = 'rgba(45,40,35,.8)';
  ctx.lineCap = 'round';
  for (let k = 0; k < cracks; k++) {
    // start on an edge, zigzag inward, with a branch
    let x = rnd() < 0.5 ? (rnd() < 0.5 ? 0 : W) : rnd() * W;
    let y = x === 0 || x === W ? rnd() * H : rnd() < 0.5 ? 0 : H;
    ctx.lineWidth = 3 + rnd() * 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let sgm = 0; sgm < 6; sgm++) {
      x += (W / 2 - x) * 0.25 + (rnd() - 0.5) * 50;
      y += (H / 2 - y) * 0.25 + (rnd() - 0.5) * 50;
      ctx.lineTo(x, y);
      if (sgm === 3) ctx.moveTo(x, y), ctx.lineTo(x + (rnd() - 0.5) * 70, y + (rnd() - 0.5) * 70), ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  bigText(ctx, String(Math.ceil(hp)), W / 2, H * 0.32, hp >= 10000 ? 58 : 76);
  t.tex.needsUpdate = true;
}

const CRATE_ICON = { rate: '⚡', dmg: '💥', spread: '⋔', troops: '👥' };
const CRATE_NAME = { rate: 'RATE', dmg: 'POWER', spread: 'SPREAD', troops: 'TROOPS' };
function drawCrate(t, crate) {
  const { c, ctx } = t;
  ctx.fillStyle = '#b8783c';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#7a4a1f';
  ctx.lineWidth = 16;
  ctx.strokeRect(8, 8, c.width - 16, c.height - 16);
  ctx.beginPath();
  ctx.moveTo(8, 8);
  ctx.lineTo(c.width - 8, c.height - 8);
  ctx.stroke();
  ctx.font = '84px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(CRATE_ICON[crate.kind], c.width / 2, c.height * 0.36);
  bigText(ctx, crate.kind === 'troops' ? `+${crate.value}` : CRATE_NAME[crate.kind], c.width / 2, c.height * 0.72, 46);
  bigText(ctx, String(Math.ceil(crate.hp)), c.width / 2, c.height * 0.92, 30, '#ffe08a');
  t.tex.needsUpdate = true;
}

function deckTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = COLORS.deck;
  ctx.fillRect(0, 0, 256, 256);
  // subtle panel seams
  ctx.fillStyle = 'rgba(0,0,0,.06)';
  ctx.fillRect(0, 0, 256, 3);
  ctx.fillRect(0, 128, 256, 2);
  // lane dashes at 1/3 and 2/3 of the width
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  for (const x of [256 / 3, (2 * 256) / 3]) ctx.fillRect(x - 3, 30, 6, 90);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.sky);
  scene.fog = new THREE.Fog(COLORS.sky, 55, VIEW_AHEAD + 10);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 260);

  scene.add(new THREE.HemisphereLight(0xdfefff, 0x445566, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.9);
  sun.position.set(-4, 10, -6);
  scene.add(sun);
  scene.add(sun.target);

  // ---------------------------------------------------------------- bridge
  const bridge = new THREE.Group();
  scene.add(bridge);
  const deckTex = deckTexture();
  deckTex.repeat.set(1, DECK_LEN / 8);
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF_W, DECK_LEN), new THREE.MeshLambertMaterial({ map: deckTex }));
  deck.rotation.x = -Math.PI / 2;
  bridge.add(deck);
  const under = new THREE.Mesh(new THREE.BoxGeometry(2 * HALF_W + 0.8, 1.2, DECK_LEN), new THREE.MeshLambertMaterial({ color: 0x4d5868 }));
  under.position.y = -0.62;
  bridge.add(under);
  const curbMat = new THREE.MeshLambertMaterial({ color: 0x5f6b7d });
  for (const sx of [-1, 1]) {
    const curb = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.35, DECK_LEN), curbMat);
    curb.position.set(sx * (HALF_W + 0.2), 0.17, 0);
    bridge.add(curb);
  }
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ color: 0x0c2342 }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -9;
  scene.add(sea);

  // ---------------------------------------------------------------- instanced crowds
  const dummy = new THREE.Object3D();
  const soldierBody = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.16, 0.2, 0.42, 8).translate(0, 0.26, 0),
    new THREE.MeshLambertMaterial({ color: COLORS.soldierBody }),
    MAX_SOLDIERS,
  );
  const soldierHead = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.17, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.6).translate(0, 0.58, 0),
    new THREE.MeshLambertMaterial({ color: COLORS.soldier }),
    MAX_SOLDIERS,
  );
  const soldierFace = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.13, 10, 6).translate(0, 0.53, 0.02),
    new THREE.MeshLambertMaterial({ color: COLORS.skin }),
    MAX_SOLDIERS,
  );
  for (const m of [soldierBody, soldierHead, soldierFace]) {
    m.frustumCulled = false;
    m.count = 0;
    scene.add(m);
  }

  const enemyGeo = new THREE.SphereGeometry(0.3, 10, 8).scale(1, 1.15, 1).translate(0, 0.34, 0);
  const enemies = new THREE.InstancedMesh(enemyGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_ENEMIES);
  const enemyEyes = new THREE.InstancedMesh(
    mergeGeometries([
      new THREE.SphereGeometry(0.075, 8, 6).translate(-0.1, 0.47, -0.25),
      new THREE.SphereGeometry(0.075, 8, 6).translate(0.1, 0.47, -0.25),
    ]),
    new THREE.MeshBasicMaterial({ color: 0xfffbe0 }),
    MAX_ENEMIES,
  );
  for (const m of [enemies, enemyEyes]) {
    m.frustumCulled = false;
    m.count = 0;
    scene.add(m);
  }
  const cEnemy = new THREE.Color(COLORS.enemy);
  const cElite = new THREE.Color(COLORS.elite);
  const cFlash = new THREE.Color(0xffffff);
  const cStone = new THREE.Color(COLORS.stone);
  const cDust = new THREE.Color(0xd9d4ca);
  const cSand = new THREE.Color(0xd8b878);
  const cSteel = new THREE.Color(0x9aa3ae);

  // Elites wear horns (instanced separately: there are only a few).
  const MAX_ELITES = 64;
  const horns = new THREE.InstancedMesh(
    mergeGeometries([
      new THREE.ConeGeometry(0.07, 0.26, 8).rotateZ(0.5).translate(-0.17, 0.72, 0),
      new THREE.ConeGeometry(0.07, 0.26, 8).rotateZ(-0.5).translate(0.17, 0.72, 0),
    ]),
    new THREE.MeshLambertMaterial({ color: 0xf1e4c4 }),
    MAX_ELITES,
  );
  horns.frustumCulled = false;
  horns.count = 0;
  scene.add(horns);

  // Kills turn to stone for a moment, then crumble (see onEvent 'kill').
  const MAX_STONES = 700;
  const stones = [];
  const stoneMesh = new THREE.InstancedMesh(enemyGeo, new THREE.MeshLambertMaterial({ color: COLORS.stone }), MAX_STONES);
  stoneMesh.frustumCulled = false;
  stoneMesh.count = 0;
  scene.add(stoneMesh);
  const cHurt = new THREE.Color(0xffb0a0);

  const bullets = new THREE.InstancedMesh(
    new THREE.CapsuleGeometry(0.06, 0.8, 2, 6).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xfff6c8 }),
    MAX_BULLETS,
  );
  const bulletGlow = new THREE.InstancedMesh(
    new THREE.CapsuleGeometry(0.16, 1.1, 2, 6).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xff9a1f, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
    MAX_BULLETS,
  );
  for (const m of [bullets, bulletGlow]) {
    m.frustumCulled = false;
    m.count = 0;
    scene.add(m);
  }

  // ---------------------------------------------------------------- particles
  const parts = [];
  const partMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_PARTICLES);
  partMesh.frustumCulled = false;
  partMesh.count = 0;
  scene.add(partMesh);
  const tmpColor = new THREE.Color();
  function burst(x, y, z, n, color, speed = 4, size = 0.14, life = 0.6, up = 4) {
    for (let i = 0; i < n && parts.length < MAX_PARTICLES; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * 0.8);
      parts.push({
        x,
        y,
        z,
        vx: Math.cos(a) * sp,
        vy: up * (0.5 + Math.random()),
        vz: Math.sin(a) * sp,
        life,
        max: life,
        size: size * (0.6 + Math.random() * 0.8),
        color: color,
      });
    }
  }

  // ---------------------------------------------------------------- pooled scene objects
  const objs = new Map(); // key -> { obj, kind, ... }
  const panelGeoCache = new Map();
  const panelGeo = (w, h) => {
    const k = `${w.toFixed(2)}x${h}`;
    if (!panelGeoCache.has(k)) {
      panelGeoCache.set(k, new THREE.PlaneGeometry(w, h));
      shared.add(panelGeoCache.get(k));
    }
    return panelGeoCache.get(k);
  };
  const postGeo = new THREE.BoxGeometry(0.16, 2.3, 0.16).translate(0, 1.15, 0);
  const postMat = new THREE.MeshLambertMaterial({ color: 0xe8edf5 });
  const pumpPostMat = new THREE.MeshLambertMaterial({ color: 0xff8a1f });
  const targetGeo = new THREE.CircleGeometry(0.42, 28);
  const targetMat = new THREE.MeshBasicMaterial({ map: targetTexture(), side: THREE.DoubleSide });

  function makeGate(gt) {
    const w = gt.x1 - gt.x0;
    const group = new THREE.Group();
    const t = textCanvas(256, 160);
    const panel = new THREE.Mesh(
      panelGeo(w - 0.2, gt.ladder ? 1.05 : 1.45), // ladder gates: a run of small plates
      new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true }),
    );
    panel.position.y = gt.ladder ? 0.95 : 1.25;
    panel.rotation.y = Math.PI; // face the camera (which looks toward +z)
    group.add(panel);
    for (const x of [-w / 2 + 0.1, w / 2 - 0.1]) {
      const p = new THREE.Mesh(postGeo, gt.pump ? pumpPostMat : postMat);
      p.position.x = x;
      group.add(p);
    }
    let target = null;
    if (gt.pump) {
      // a bullseye on top: "shoot me"
      target = new THREE.Mesh(targetGeo, targetMat);
      target.position.set(0, 2.45, 0);
      target.rotation.y = Math.PI;
      group.add(target);
      panel.material.opacity = 1;
    }
    group.position.set((gt.x0 + gt.x1) / 2, 0, gt.z);
    scene.add(group);
    return { obj: group, kind: 'gate', t, panel, target, key: '' };
  }
  function gateLook(gt, g) {
    const lock = gt.lockedBy && g.vaults.find((v) => v.id === gt.lockedBy);
    const locked = !!(lock && lock.hp > 0) && !gt.slab; // a raised slab already says "not yet"
    const color = locked ? COLORS.locked : !gateGood(gt) ? COLORS.bad : gt.gold ? COLORS.gold : COLORS.good;
    return { label: gateLabel(gt), color, locked, pump: !!gt.pump };
  }

  const vaultBodyMat = new THREE.MeshLambertMaterial({ color: 0xbab4a9 });
  function makeVault(v) {
    if (v.pillar) return makePillar(v);
    if (v.sack) return makeSacks(v);
    if (v.steel) return makeSteel(v);
    const w = v.x1 - v.x0;
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, 2.5, v.depth), vaultBodyMat);
    body.position.y = 1.25;
    group.add(body);
    const t = textCanvas(256, 256);
    const face = new THREE.Mesh(panelGeo(w - 0.15, 2.4), new THREE.MeshLambertMaterial({ map: t.tex }));
    face.position.set(0, 1.25, -v.depth / 2 - 0.01);
    face.rotation.y = Math.PI;
    group.add(face);
    group.position.set((v.x0 + v.x1) / 2, 0, v.z);
    scene.add(group);
    return { obj: group, kind: 'vault', t, shown: -1, openAt: 0 };
  }

  // A heap of sandbags lashed with rope, plugging a lane: it bulges and shudders as it is shot,
  // then splits open in a burst of sand.
  const sackGeo = new THREE.SphereGeometry(0.5, 14, 10);
  const sackMat = new THREE.MeshLambertMaterial({ color: 0xc9a36a });
  const ropeGeo = new THREE.CylinderGeometry(0.045, 0.045, 1, 6);
  const ropeMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2a });
  function makeSacks(v) {
    const w = v.x1 - v.x0;
    const group = new THREE.Group();
    const bag = new THREE.Group();
    group.add(bag);
    const rows = [
      [3, 0.35, 0.62],
      [2, 0.95, 0.58],
      [1, 1.5, 0.55],
    ];
    let k = 0;
    for (const [n, y, h] of rows) {
      const sw = (w / 3) * 1.08;
      for (let i = 0; i < n; i++, k++) {
        const m = new THREE.Mesh(sackGeo, sackMat);
        m.scale.set(sw, h, v.depth * 0.9);
        m.position.set((i - (n - 1) / 2) * sw * 0.92, y, (k % 2) * 0.08);
        m.rotation.z = ((k * 37) % 7) * 0.03 - 0.09;
        bag.add(m);
      }
    }
    // ropes lashed across the front, corner to corner and around
    for (const [x, y, rz, len] of [
      [0, 0.95, 0.75, w * 1.2],
      [0, 0.95, -0.75, w * 1.2],
      [0, 0.6, Math.PI / 2, w * 1.05],
      [0, 1.3, Math.PI / 2, w * 0.8],
    ]) {
      const r = new THREE.Mesh(ropeGeo, ropeMat);
      r.scale.y = len;
      r.rotation.z = rz;
      r.position.set(x, y, -v.depth * 0.45);
      bag.add(r);
    }
    const t = textCanvas(256, 128);
    const tag = new THREE.Mesh(panelGeo(1.3, 0.65), new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, side: THREE.DoubleSide }));
    tag.position.set(0, 2.35, 0);
    tag.rotation.y = Math.PI;
    group.add(tag);
    group.position.set((v.x0 + v.x1) / 2, 0, v.z);
    scene.add(group);
    return { obj: group, kind: 'vault', t, shown: -1, openAt: 0, sack: true, bag };
  }

  const steelMat = new THREE.MeshLambertMaterial({ color: 0x8d97a3 });
  function makeSteel(v) {
    const w = v.x1 - v.x0;
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, 2.4, v.depth), steelMat);
    body.position.y = 1.2;
    group.add(body);
    const t = textCanvas(256, 256);
    const face = new THREE.Mesh(panelGeo(w - 0.04, 2.36), new THREE.MeshLambertMaterial({ map: t.tex }));
    face.position.set(0, 1.2, -v.depth / 2 - 0.01);
    face.rotation.y = Math.PI;
    group.add(face);
    group.position.set((v.x0 + v.x1) / 2, 0, v.z);
    scene.add(group);
    return { obj: group, kind: 'vault', t, shown: -1, openAt: 0, steel: true };
  }

  // ---------------------------------------------------------------- gatehouses
  // A steel wall across the road with two openings: the door the horde streams out of, and the
  // slot its strongbox plugs. When the gatehouse is beaten the wall sinks into the road.
  const gateWallMat = new THREE.MeshLambertMaterial({ map: gateWallTexture() });
  const gateWallH = 2.9;
  function makeGatehouse(gh) {
    const group = new THREE.Group();
    const holes = [gh.door, gh.slot].sort((a, b) => a[0] - b[0]);
    const spans = [];
    let x = -HALF_W - 0.4;
    for (const [a, b] of holes) {
      if (a - x > 0.01) spans.push([x, a]);
      x = b;
    }
    if (HALF_W + 0.4 - x > 0.01) spans.push([x, HALF_W + 0.4]);
    for (const [a, b] of spans) {
      const w = b - a;
      const geo = new THREE.BoxGeometry(w, gateWallH, 0.8);
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (w / 2));
      const m = new THREE.Mesh(geo, gateWallMat);
      m.position.set((a + b) / 2, gateWallH / 2, 0);
      group.add(m);
    }
    // lintels over both openings, and the door leaves swung open
    for (const [a, b] of holes) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(b - a, 0.5, 0.9), gateWallMat);
      l.position.set((a + b) / 2, gateWallH - 0.25, 0);
      group.add(l);
    }
    for (const sx of [0, 1]) {
      const leafW = (gh.door[1] - gh.door[0]) / 2;
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(leafW, gateWallH - 0.55, 0.12), steelMat);
      const hinge = new THREE.Group();
      hinge.position.set(gh.door[sx], 0, -0.4);
      leaf.position.set((sx ? -1 : 1) * leafW / 2, (gateWallH - 0.55) / 2, 0);
      hinge.add(leaf);
      hinge.rotation.y = (sx ? 1 : -1) * 1.9; // swung outward, toward the squad
      group.add(hinge);
    }
    group.position.set(0, 0, gh.z);
    scene.add(group);
    return { obj: group, kind: 'gatehouse', openAt: 0 };
  }

  // ---------------------------------------------------------------- brutes
  // A hulking brute: slab torso, small horned head, spiked iron pauldrons and huge fists.
  const bruteSkin = new THREE.MeshLambertMaterial({ color: 0xc8382b });
  const bruteDark = new THREE.MeshLambertMaterial({ color: 0x5c1515 });
  const ironMat = new THREE.MeshLambertMaterial({ color: 0x4b515b });
  const boneMat = new THREE.MeshLambertMaterial({ color: 0xf3e6c8 });
  function makeBrute(e) {
    const k = e.r;
    const group = new THREE.Group();
    const rig = new THREE.Group(); // leans and bobs
    group.add(rig);
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.6 * k, 1.5 * k, 1 * k), new THREE.MeshLambertMaterial({ color: 0xc8382b }));
    body.position.y = 1.85 * k;
    rig.add(body);
    const belt = new THREE.Mesh(new THREE.BoxGeometry(1.5 * k, 0.28 * k, 1.04 * k), ironMat);
    belt.position.y = 1.15 * k;
    rig.add(belt);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.42 * k, 16, 12), bruteSkin);
    head.position.set(0, 2.85 * k, -0.15 * k);
    rig.add(head);
    for (const sx of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.12 * k, 0.55 * k, 8), boneMat);
      horn.position.set(sx * 0.3 * k, 3.25 * k, -0.15 * k);
      horn.rotation.z = -sx * 0.45;
      rig.add(horn);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.08 * k, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff6a0 }));
      eye.position.set(sx * 0.16 * k, 2.92 * k, -0.52 * k);
      rig.add(eye);
      const pad = new THREE.Mesh(new THREE.SphereGeometry(0.42 * k, 12, 8), ironMat);
      pad.scale.set(1, 0.7, 1);
      pad.position.set(sx * 0.95 * k, 2.5 * k, 0);
      rig.add(pad);
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.1 * k, 0.4 * k, 6), boneMat);
      spike.position.set(sx * 1.05 * k, 2.88 * k, 0);
      rig.add(spike);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.26 * k, 0.22 * k, 1.1 * k, 10), bruteDark);
      leg.position.set(sx * 0.42 * k, 0.55 * k, 0);
      group.add(leg);
    }
    const fists = [-1, 1].map((sx) => {
      const arm = new THREE.Group();
      arm.position.set(sx * 1.05 * k, 2.4 * k, 0);
      const limb = new THREE.Mesh(new THREE.CylinderGeometry(0.22 * k, 0.2 * k, 1.2 * k, 10), bruteSkin);
      limb.position.y = -0.6 * k;
      arm.add(limb);
      const fist = new THREE.Mesh(new THREE.SphereGeometry(0.38 * k, 12, 10), ironMat);
      fist.position.y = -1.3 * k;
      arm.add(fist);
      rig.add(arm);
      return arm;
    });
    const legs = group.children.filter((c) => c.geometry?.type === 'CylinderGeometry');
    group.position.set(e.x, 0, e.z);
    scene.add(group);
    return { obj: group, kind: 'brute', rig, body, fists, legs, k };
  }

  const concreteMat = new THREE.MeshLambertMaterial({ color: 0xbab4a9 });
  function makePillar(v) {
    const w = v.x1 - v.x0;
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, PILLAR_H, v.depth), concreteMat);
    body.position.y = PILLAR_H / 2;
    group.add(body);
    const t = textCanvas(256, 340);
    const face = new THREE.Mesh(panelGeo(w - 0.05, PILLAR_H - 0.05), new THREE.MeshLambertMaterial({ map: t.tex }));
    face.position.set(0, PILLAR_H / 2, -v.depth / 2 - 0.01);
    face.rotation.y = Math.PI;
    group.add(face);
    group.position.set((v.x0 + v.x1) / 2, 0, v.z);
    scene.add(group);
    return { obj: group, kind: 'vault', t, shown: -1, openAt: 0, pillar: true };
  }

  // ---------------------------------------------------------------- slabs
  // The slab hinges on its fallen edge: a pivot group at that edge, tilted up onto the pillar.
  const SLAB_T = 0.36;
  const slabAngle = Math.atan2(PILLAR_H, 2 * HALF_W);
  const slabState = new Map(); // slab id -> { pivotX, angle } for gates riding on it
  function makeSlab(sl) {
    const D = sl.z1 - sl.z0 + 1.2;
    const pivot = new THREE.Group();
    const pivotX = sl.tiltSide * (HALF_W + 0.2);
    pivot.position.set(pivotX, 0, (sl.z0 + sl.z1) / 2);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(2 * HALF_W + 0.4, SLAB_T, D), concreteMat);
    slab.position.set(-sl.tiltSide * (HALF_W + 0.2), SLAB_T / 2, 0);
    pivot.add(slab);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF_W + 0.3, D - 0.1), new THREE.MeshLambertMaterial({ color: 0x9aa3b1 }));
    top.rotation.x = -Math.PI / 2;
    top.position.set(-sl.tiltSide * (HALF_W + 0.2), SLAB_T + 0.005, 0);
    pivot.add(top);
    scene.add(pivot);
    // the garage underneath: a dark floor
    const shade = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * HALF_W, D),
      new THREE.MeshBasicMaterial({ color: 0x05070c, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    shade.rotation.x = -Math.PI / 2;
    shade.position.set(0, 0.012, (sl.z0 + sl.z1) / 2);
    scene.add(shade);
    // rubble where the first pillar stood
    const rubble = new THREE.Group();
    for (let i = 0; i < 7; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.3 + Math.random() * 0.4, 0.2 + Math.random() * 0.3, 0.3 + Math.random() * 0.4), concreteMat);
      m.position.set(sl.tiltSide * (HALF_W - 0.9) + (Math.random() - 0.5) * 1.4, 0.12, sl.z0 - 0.6 + (Math.random() - 0.5) * 1.2);
      m.rotation.set(Math.random(), Math.random(), Math.random());
      rubble.add(m);
    }
    scene.add(rubble);
    const st = { pivotX, angle: -sl.tiltSide * slabAngle, y: 0 };
    slabState.set(sl.id, st);
    return { obj: pivot, kind: 'slab', shade, rubble, st, extra: [shade, rubble] };
  }
  /** Where a gate standing at x on a slab ends up, and how it's tilted. */
  function onSlab(st, x) {
    const dx = x - st.pivotX;
    const c = Math.cos(st.angle);
    const sn = Math.sin(st.angle);
    const up = SLAB_T + st.y;
    return { x: st.pivotX + dx * c - up * sn, y: dx * sn + up * c, rz: st.angle };
  }

  const wallMat = new THREE.MeshLambertMaterial({ color: 0x3e6db5 });
  function makeWall(w) {
    const len = w.z1 - w.z0;
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.8, len), wallMat);
    m.position.set(w.x, 0.4, (w.z0 + w.z1) / 2);
    scene.add(m);
    return { obj: m, kind: 'wall' };
  }

  const crateGeo = new THREE.BoxGeometry(1.4, 1.4, 1.4).translate(0, 0.7, 0);
  function makeCrate(c) {
    const t = textCanvas(256, 256);
    const mat = new THREE.MeshLambertMaterial({ map: t.tex });
    const m = new THREE.Mesh(crateGeo, mat);
    m.position.set(c.x, 0, c.z);
    scene.add(m);
    return { obj: m, kind: 'crate', t, shown: -1 };
  }

  const barrelGeo = new THREE.CylinderGeometry(0.42, 0.42, 1, 14).translate(0, 0.5, 0);
  const barrelMat = new THREE.MeshLambertMaterial({ color: 0xd62f25 });
  const bandGeo = new THREE.CylinderGeometry(0.44, 0.44, 0.16, 14).translate(0, 0.5, 0);
  const bandMat = new THREE.MeshLambertMaterial({ color: 0xffd21f });
  function makeBarrel(b) {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(barrelGeo, barrelMat));
    group.add(new THREE.Mesh(bandGeo, bandMat));
    group.position.set(b.x, 0, b.z);
    scene.add(group);
    return { obj: group, kind: 'barrel' };
  }

  function makeBoss(b) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(b.r, 24, 18).scale(1, 1.1, 0.9), new THREE.MeshLambertMaterial({ color: 0x9c1838 }));
    body.position.y = b.r * 1.05;
    group.add(body);
    const belly = new THREE.Mesh(new THREE.SphereGeometry(b.r * 0.7, 18, 12), new THREE.MeshLambertMaterial({ color: 0xd8566a }));
    belly.position.set(0, b.r * 0.9, -b.r * 0.4);
    group.add(belly);
    const hornMat = new THREE.MeshLambertMaterial({ color: 0xf3e6c8 });
    for (const sx of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.1, 10), hornMat);
      horn.position.set(sx * b.r * 0.6, b.r * 2, 0);
      horn.rotation.z = -sx * 0.5;
      group.add(horn);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfff6a0 }));
      eye.position.set(sx * 0.55, b.r * 1.45, -b.r * 0.78);
      group.add(eye);
    }
    group.position.set(b.x, 0, b.z);
    scene.add(group);
    // stone fists: raised during a slam wind-up, smashed down on impact
    const fistMat = new THREE.MeshLambertMaterial({ color: 0x3b3f4a });
    const fists = [-1, 1].map((sx) => {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12), fistMat);
      f.position.set(sx * b.r * 1.05, b.r * 0.85, -0.2);
      group.add(f);
      return f;
    });
    return { obj: group, kind: 'boss', body, fists, base: b.r };
  }

  // Geometries/materials shared by many objects; everything else belongs to one object.
  const shared = new Set([postGeo, postMat, pumpPostMat, targetGeo, targetMat, vaultBodyMat, concreteMat, sackGeo, sackMat, ropeGeo, ropeMat, steelMat, gateWallMat, bruteSkin, bruteDark, ironMat, boneMat, wallMat, crateGeo, barrelGeo, barrelMat, bandGeo, bandMat]);
  function disposeObj(obj) {
    scene.remove(obj);
    obj.traverse((m) => {
      if (m.geometry && !shared.has(m.geometry)) m.geometry.dispose();
      if (m.material && !shared.has(m.material)) {
        m.material.map?.dispose();
        m.material.dispose();
      }
    });
  }

  // Finish banner and the ×1..×5 bonus ramp after it.
  let finishObj = null;
  function makeFinish(z) {
    const group = new THREE.Group();
    const t = textCanvas(512, 96);
    const { c, ctx } = t;
    for (let i = 0; i < 16; i++)
      for (let j = 0; j < 3; j++) {
        ctx.fillStyle = (i + j) % 2 ? '#111' : '#fff';
        ctx.fillRect(i * 32, j * 32, 32, 32);
      }
    bigText(ctx, 'FINISH', c.width / 2, c.height / 2, 64, '#ffd33d');
    t.tex.needsUpdate = true;
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF_W, 1.1), new THREE.MeshBasicMaterial({ map: t.tex, side: THREE.DoubleSide }));
    banner.position.set(0, 3, z);
    banner.rotation.y = Math.PI;
    group.add(banner);
    for (const sx of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3.6, 0.25), postMat);
      p.position.set(sx * HALF_W, 1.8, z);
      group.add(p);
    }
    const bandColors = ['#4fa3ff', '#4fd18b', '#ffd33d', '#ff8c3a', '#ff4d6d'];
    for (let i = 0; i < 5; i++) {
      const bt = textCanvas(256, 64);
      bt.ctx.fillStyle = bandColors[i];
      bt.ctx.fillRect(0, 0, 256, 64);
      bigText(bt.ctx, `×${i + 1}`, 128, 34, 46);
      bt.tex.needsUpdate = true;
      const band = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF_W, 2.2), new THREE.MeshBasicMaterial({ map: bt.tex }));
      band.rotation.x = -Math.PI / 2;
      band.rotation.z = Math.PI;
      band.position.set(0, 0.02 + i * 0.001, z + 2 + i * 2.4);
      group.add(band);
    }
    scene.add(group);
    return group;
  }

  // ---------------------------------------------------------------- boss slam markers
  const slamRing = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xff2d40, transparent: true, depthWrite: false }),
  );
  const slamFill = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xff2d40, transparent: true, depthWrite: false }),
  );
  const wave = {
    t0: 0,
    r: 1,
    mesh: new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xfff1d0, transparent: true, depthWrite: false }),
    ),
  };
  for (const m of [slamRing, slamFill, wave.mesh]) {
    m.visible = false;
    scene.add(m);
  }

  // ---------------------------------------------------------------- squad formation
  // Soldiers settle into a sunflower pattern; each eases toward its slot so gates feel physical.
  const slots = [];
  for (let i = 0; i < MAX_SOLDIERS; i++) slots.push({ x: 0, z: 0, vx: 0, vz: 0, born: 0 });
  let shown = 0;

  // ---------------------------------------------------------------- camera
  let shake = 0;
  const cam = { x: 0, z: -9 };
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep the bridge's width in view on tall phone screens
    const hfov = 2 * Math.atan(5.4 / 13);
    camera.fov = THREE.MathUtils.clamp((2 * Math.atan(Math.tan(hfov / 2) / camera.aspect) * 180) / Math.PI, 60, 74);
    camera.updateProjectionMatrix();
  }

  const proj = new THREE.Vector3();
  function project(x, y, z) {
    proj.set(x, y, z).project(camera);
    return { x: ((proj.x + 1) / 2) * canvas.clientWidth, y: ((1 - proj.y) / 2) * canvas.clientHeight, on: proj.z < 1 };
  }

  // ---------------------------------------------------------------- events -> effects
  function onEvent(e) {
    if (e.t === 'kill') {
      const big = e.elite || e.brute;
      if (stones.length < MAX_STONES) stones.push({ x: e.x, z: e.z, sc: e.brute ? 3.6 : e.elite ? 2 : 1, t0: performance.now(), life: e.brute ? 600 : big ? 380 : 260, elite: big });
      if (e.brute) shake = Math.max(shake, 0.5);
      else burst(e.x, 0.4, e.z, 2, cStone, 3, 0.13, 0.45);
      if (e.elite) shake = Math.max(shake, 0.18);
    } else if (e.t === 'clash') {
      burst(e.x, 0.5, e.z, 4, new THREE.Color(COLORS.soldier), 3, 0.12, 0.5);
      shake = Math.max(shake, e.boss ? 0.25 : 0.12);
    } else if (e.t === 'gate') {
      const o = objs.get(`g${e.id}`);
      if (o) o.popAt = performance.now();
      burst(e.x, 1.2, e.z, 18, new THREE.Color(e.good ? 0x6cc4ff : 0xff5d6c), 5, 0.12, 0.6, 3);
    } else if (e.t === 'vaultOpen' && e.steel) {
      // the strongbox bursts: steel plates, a shower of sparks, then gold
      for (let y = 0.3; y < 2.4; y += 0.45) burst(e.x, y, e.z, 7, cSteel, 5.5, 0.34, 1.2, 4);
      burst(e.x, 1.2, e.z, 40, new THREE.Color(0xfff2a8), 9, 0.08, 0.6, 6);
      burst(e.x, 1.4, e.z, 30, new THREE.Color(0xffd34d), 6, 0.14, 0.8, 7);
      shake = Math.max(shake, 0.45);
    } else if (e.t === 'vaultOpen' && e.sack) {
      // the sacks split: sand everywhere, burlap scraps, and a flash of gold
      for (let y = 0.3; y < 1.8; y += 0.4) burst(e.x, y, e.z, 14, cSand, 6, 0.16, 1.1, 5);
      burst(e.x, 0.5, e.z, 18, cDust, 2.2, 0.55, 1.4, 1.5);
      burst(e.x, 1, e.z, 10, new THREE.Color(0xa47b45), 5, 0.3, 1, 6);
      burst(e.x, 1.4, e.z, 30, new THREE.Color(0xffd34d), 6, 0.14, 0.8, 7);
      shake = Math.max(shake, 0.35);
    } else if (e.t === 'vaultOpen') {
      // burst into rubble: big chunks from the whole height, then a dust cloud
      for (let y = 0.3; y < 2.6; y += 0.45) burst(e.x, y, e.z, 9, cStone, 4.5, 0.38, 1.3, 3);
      burst(e.x, 0.6, e.z, 16, cDust, 2, 0.6, 1.4, 1.5);
      if (!e.pillar) burst(e.x, 1.4, e.z, 30, new THREE.Color(0xffd34d), 6, 0.14, 0.8, 7);
      shake = Math.max(shake, 0.5);
    } else if (e.t === 'vaultHit') {
      if (Math.random() < 0.3) burst(e.x, 1 + Math.random(), e.z - 0.2, 1, new THREE.Color(0xffe27a), 2, 0.1, 0.25, 2);
    } else if (e.t === 'crate') {
      burst(e.x, 0.8, e.z, 40, new THREE.Color(0xd59a5b), 6, 0.18, 0.8, 6);
      burst(e.x, 0.8, e.z, 20, new THREE.Color(0xfff07a), 5, 0.12, 0.8, 6);
      shake = 0.25;
    } else if (e.t === 'boom') {
      burst(e.x, 0.6, e.z, 60, new THREE.Color(0xff8a1f), 9, 0.22, 0.7, 6);
      burst(e.x, 0.6, e.z, 30, new THREE.Color(0x3a3a3a), 5, 0.3, 1, 5);
      shake = 0.5;
    } else if (e.t === 'bossDown') {
      burst(e.x, 1.6, e.z, 120, new THREE.Color(0x9c1838), 10, 0.25, 1.1, 8);
      burst(e.x, 1.6, e.z, 60, new THREE.Color(0xffd34d), 8, 0.18, 1.1, 9);
      shake = 0.8;
    } else if (e.t === 'slam') {
      const o = objs.get('boss');
      if (o) o.slamAt = performance.now();
      Object.assign(wave, { t0: performance.now(), r: e.r });
      wave.mesh.position.set(e.x, 0.04, e.z);
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) burst(e.x + Math.cos(a) * e.r, 0.2, e.z + Math.sin(a) * e.r, 2, cDust, 3, 0.3, 0.8, 2);
      if (e.hit) burst(e.x, 0.4, e.z, 20, new THREE.Color(COLORS.soldier), 6, 0.14, 0.7, 5);
      shake = Math.max(shake, e.hit ? 0.7 : 0.4);
    } else if (e.t === 'slabFall') {
      const st = slabState.get(e.id);
      const hi = st ? -st.pivotX : 0;
      for (let z = e.z0; z <= e.z1; z += 1.5) {
        burst(hi, 0.3, z, 3, new THREE.Color(0xd7d1c6), 6, 0.3, 1.1, 3);
        burst(-hi, 0.3, z, 2, new THREE.Color(0xd7d1c6), 5, 0.25, 0.9, 2);
      }
      burst(0, 0.4, e.z0, 40, new THREE.Color(0xc8c2b6), 9, 0.3, 1.2, 4);
      shake = 1;
    } else if (e.t === 'smash') {
      const o = objs.get(`u${e.id}`);
      if (o) o.smashAt = performance.now();
      burst(e.x, 0.4, e.z, 16, new THREE.Color(COLORS.soldier), 6, 0.14, 0.7, 5);
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) burst(e.x + Math.cos(a) * 1.4, 0.2, e.z + Math.sin(a) * 1.4, 1, cDust, 3, 0.3, 0.7, 1.5);
      shake = Math.max(shake, 0.6);
    } else if (e.t === 'gateOpen') {
      const o = objs.get(`h${e.id}`);
      if (o) o.openAt = performance.now();
      for (let x = -HALF_W; x <= HALF_W; x += 0.8) burst(x, 0.5, e.z, 3, cDust, 4, 0.45, 1.2, 3);
      shake = Math.max(shake, 0.8);
    } else if (e.t === 'pump') {
      const o = objs.get(`g${e.id}`);
      if (o) o.pumpAt = performance.now();
    }
  }

  // ---------------------------------------------------------------- per-frame sync
  let lastT = performance.now();
  let stride = 0; // run-cycle phase; advances faster the faster the squad moves
  function render(g) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    const time = now / 1000;
    const s = g.squad;

    // camera follows the squad, slightly lazy sideways
    cam.x += (s.x * 0.35 - cam.x) * Math.min(1, dt * 4);
    cam.z = s.z - 7.5;
    const sh = shake > 0 ? shake : 0;
    shake = Math.max(0, shake - dt * 1.6);
    camera.position.set(cam.x + (Math.random() - 0.5) * sh, 11 + (Math.random() - 0.5) * sh, cam.z);
    camera.lookAt(cam.x * 0.8, 0, s.z + 8);
    sun.position.set(s.x - 4, 10, s.z - 6);
    sun.target.position.set(s.x, 0, s.z + 6);

    // bridge pieces travel with the camera; the deck texture scrolls
    bridge.position.z = s.z + DECK_LEN / 2 - 20;
    // The deck's v coordinate grows toward -z, so the texture must scroll back as the deck moves
    // forward with the squad; that keeps the stripes fixed to the world and passing under the squad.
    deckTex.offset.y = -bridge.position.z / 8;
    sea.position.z = s.z;

    // soldiers
    const n = Math.min(s.count, MAX_SOLDIERS);
    if (n > shown) for (let i = shown; i < n; i++) Object.assign(slots[i], { x: (Math.random() - 0.5) * 0.5, z: -0.6, born: now });
    shown = n;
    stride += dt * (4 + s.speed * 1.2);
    const R = squadRadius(s.count) * 0.95;
    // soldiers stay on the bridge and on the squad's side of any lane wall
    let lo = -HALF_W + 0.15;
    let hi = HALF_W - 0.15;
    for (const w of g.walls)
      if (s.z >= w.z0 - 1 && s.z <= w.z1) {
        if (s.x < w.x) hi = Math.min(hi, w.x - 0.18);
        else lo = Math.max(lo, w.x + 0.18);
      }
    for (let i = 0; i < n; i++) {
      const sl = slots[i];
      const rr = R * Math.sqrt((i + 0.5) / n);
      const th = i * 2.39996;
      const tx = Math.cos(th) * rr;
      const tz = Math.sin(th) * rr * 0.8;
      sl.x += (tx - sl.x) * Math.min(1, dt * 8);
      sl.z += (tz - sl.z) * Math.min(1, dt * 8);
      const hop = s.speed > 0.5 ? Math.abs(Math.sin(stride + i * 1.7)) * (s.boost ? 0.14 : 0.09) : 0;
      const grow = Math.min(1, (now - sl.born) / 180);
      dummy.position.set(THREE.MathUtils.clamp(s.x + sl.x, lo, hi), hop, s.z + sl.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(0.4 + 0.6 * grow);
      dummy.updateMatrix();
      soldierBody.setMatrixAt(i, dummy.matrix);
      soldierHead.setMatrixAt(i, dummy.matrix);
      soldierFace.setMatrixAt(i, dummy.matrix);
    }
    for (const m of [soldierBody, soldierHead, soldierFace]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }

    // enemies (marching ones, then the dormant ones that are in view)
    let k = 0;
    const zMin = s.z - VIEW_BEHIND;
    const zMax = s.z + VIEW_AHEAD;
    let nh = 0;
    const putEnemy = (e) => {
      if (k >= MAX_ENEMIES || e.z < zMin || e.z > zMax || e.hp <= 0 || e.kind === 'brute') return;
      const wob = Math.sin(time * 9 + e.id) * 0.06;
      const elite = e.kind === 'elite';
      const sc = elite ? 2 : 1;
      dummy.position.set(e.x, Math.abs(wob) * 0.6, e.z);
      dummy.rotation.set(0, 0, wob);
      dummy.scale.set(sc * (1 + wob), sc * (1 - wob), sc);
      dummy.updateMatrix();
      enemies.setMatrixAt(k, dummy.matrix);
      enemyEyes.setMatrixAt(k, dummy.matrix);
      const base = elite ? cElite : cEnemy;
      if (g.t - e.hitAt < 0.07) enemies.setColorAt(k, tmpColor.copy(base).lerp(cFlash, 0.75));
      else enemies.setColorAt(k, e.hp < e.maxHp && !elite ? tmpColor.copy(base).lerp(cHurt, 0.35) : base);
      if (elite && nh < MAX_ELITES) horns.setMatrixAt(nh++, dummy.matrix);
      k++;
    };
    for (const e of g.enemies) putEnemy(e);
    for (let i = g.dormant.length - 1; i >= 0 && k < MAX_ENEMIES; i--) {
      const e = g.dormant[i];
      if (e.z > zMax) break;
      putEnemy(e);
    }
    enemies.count = enemyEyes.count = k;
    horns.count = nh;
    horns.instanceMatrix.needsUpdate = true;

    // stone statues: hold, then crumble into chunks and dust
    let ns = 0;
    for (let i = stones.length - 1; i >= 0; i--) {
      const st = stones[i];
      const age = now - st.t0;
      if (age > st.life) {
        const big = st.elite;
        burst(st.x, 0.4 * st.sc, st.z, big ? 14 : 2, cStone, big ? 4 : 2.5, big ? 0.22 : 0.13, 0.55, 3);
        if (big || Math.random() < 0.35) burst(st.x, 0.3, st.z, big ? 8 : 1, cDust, 1.2, big ? 0.5 : 0.32, 0.7, 1);
        stones[i] = stones[stones.length - 1];
        stones.pop();
        continue;
      }
      const sq = 1 - 0.15 * (age / st.life);
      dummy.position.set(st.x, 0, st.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(st.sc, st.sc * sq, st.sc);
      dummy.updateMatrix();
      stoneMesh.setMatrixAt(ns++, dummy.matrix);
    }
    stoneMesh.count = ns;
    stoneMesh.instanceMatrix.needsUpdate = true;
    enemies.instanceMatrix.needsUpdate = enemyEyes.instanceMatrix.needsUpdate = true;
    if (enemies.instanceColor) enemies.instanceColor.needsUpdate = true;

    // bullets
    let nb = 0;
    for (const b of g.bullets) {
      if (nb >= MAX_BULLETS) break;
      dummy.position.set(b.x, 0.75, b.z);
      dummy.rotation.set(0, Math.atan2(b.vx, 45), 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      bullets.setMatrixAt(nb, dummy.matrix);
      bulletGlow.setMatrixAt(nb++, dummy.matrix);
    }
    bullets.count = bulletGlow.count = nb;
    bullets.instanceMatrix.needsUpdate = bulletGlow.instanceMatrix.needsUpdate = true;

    // pooled objects
    const seen = new Set();
    const inView = (z) => z > zMin && z < zMax;
    for (const sl of g.slabs) {
      if (sl.z1 < zMin || sl.z0 > zMax) continue;
      const key = `s${sl.id}`;
      let o = objs.get(key);
      if (!o) objs.set(key, (o = makeSlab(sl)));
      seen.add(key);
      const up = -sl.tiltSide * slabAngle;
      if (!sl.down) o.st.angle = up;
      else {
        // slam: accelerate down, small bounce, then settle flush with the road
        o.fallAt ||= now;
        const p = Math.min(1, (now - o.fallAt) / 420);
        const bounce = p < 1 ? 0 : Math.max(0, 1 - (now - o.fallAt - 420) / 250);
        o.st.angle = up * (1 - p * p) + up * 0.06 * Math.sin(bounce * Math.PI) * bounce;
        o.st.y = p < 1 ? 0 : -Math.min(SLAB_T - 0.02, ((now - o.fallAt - 420) / 300) * SLAB_T);
        o.shade.material.opacity = 0.5 * (1 - p);
      }
      o.obj.rotation.z = o.st.angle;
      o.obj.position.y = o.st.y;
    }
    for (const gt of g.gates) {
      if (!inView(gt.z)) continue;
      const key = `g${gt.id}`;
      let o = objs.get(key);
      if (!o) objs.set(key, (o = makeGate(gt)));
      seen.add(key);
      const st = gt.slab && slabState.get(gt.slab);
      if (st) {
        const p = onSlab(st, (gt.x0 + gt.x1) / 2);
        o.obj.position.set(p.x, p.y, gt.z);
        o.obj.rotation.z = p.rz;
      }
      const look = gateLook(gt, g);
      const lk = `${look.label}|${look.color}|${look.locked}|${look.pump}`;
      if (o.key !== lk) {
        drawGate(o.t, look.label, look.color, look.locked, look.pump);
        o.key = lk;
      }
      if (gt.used) {
        const p = o.popAt ? (now - o.popAt) / 300 : 1;
        if (o.popAt) {
          o.obj.scale.setScalar(1 + p * 0.4);
          o.panel.material.opacity = Math.max(0, 1 - p);
        } else {
          o.obj.scale.setScalar(Math.max(0.001, 1 - (o.fade = (o.fade || 0) + dt * 4)));
        }
        o.obj.visible = p < 1 || !o.popAt ? o.obj.scale.x > 0.01 : false;
      } else if (o.target) {
        // the bullseye jolts and the board bumps each time a hit raises the number
        const p = o.pumpAt ? Math.max(0, 1 - (now - o.pumpAt) / 150) : 0;
        o.obj.scale.setScalar(1 + p * 0.12);
        o.target.rotation.z = Math.sin(time * 3) * 0.15 + p * 0.6;
        o.target.scale.setScalar(1 + p * 0.35);
      }
    }
    for (const v of g.vaults) {
      if (!inView(v.z)) continue;
      const key = `v${v.id}`;
      let o = objs.get(key);
      if (!o) objs.set(key, (o = makeVault(v)));
      seen.add(key);
      const hp = Math.ceil(v.hp);
      if (hp !== o.shown && (now - (o.drawnAt || 0) > 60 || hp === 0)) {
        if (o.sack) drawSackTag(o.t, v.hp);
        else if (o.steel) drawSteel(o.t, v.hp, v.maxHp, v.id);
        else drawConcrete(o.t, v.hp, v.maxHp, v.id);
        o.shown = hp;
        o.drawnAt = now;
      }
      if (v.hp <= 0) {
        o.obj.visible = false; // it burst into rubble (see onEvent 'vaultOpen')
      } else if (o.sack) {
        // bulge as it is hit, swelling as it weakens
        const hit = o.drawnAt && now - o.drawnAt < 90;
        const swell = 1 + 0.12 * (1 - v.hp / v.maxHp);
        o.bag.scale.set(swell * (hit ? 1.06 : 1), swell * (hit ? 0.95 : 1), 1);
        o.bag.rotation.z = hit ? (Math.random() - 0.5) * 0.06 : 0;
      } else {
        // rattle while being hit
        const hit = o.drawnAt && now - o.drawnAt < 80;
        o.obj.position.x = (v.x0 + v.x1) / 2 + (hit ? (Math.random() - 0.5) * 0.06 : 0);
      }
    }
    const brute = (e) => {
      if (e.kind !== 'brute' || e.hp <= 0 || !inView(e.z)) return;
      const key = `u${e.id}`;
      let o = objs.get(key);
      if (!o) objs.set(key, (o = makeBrute(e)));
      seen.add(key);
      o.obj.position.set(e.x, 0, e.z);
      const moving = !e.held && !(e.stunUntil > g.t) && !(e.waitFor && e.z > s.z + 30);
      const ph = time * 5 + e.id;
      o.legs.forEach((l, i) => (l.position.z = moving ? Math.sin(ph + i * Math.PI) * 0.25 * o.k : 0));
      const stagger = e.stunUntil > g.t ? (e.stunUntil - g.t) / 0.7 : 0;
      o.rig.rotation.x = -0.35 * stagger; // knocked back: leaning away
      o.rig.position.y = moving ? Math.abs(Math.sin(ph)) * 0.12 : 0;
      // swing arms while walking; slam both fists down on a smash
      const sm = o.smashAt ? (now - o.smashAt) / 300 : 1;
      o.fists.forEach((a, i) => {
        a.rotation.x = sm < 1 ? -2.4 * (1 - sm) : moving ? Math.sin(ph + i * Math.PI) * 0.5 : 0;
      });
      o.body.material.emissive.setHex(g.t - e.hitAt < 0.07 ? 0x553333 : 0x000000);
    };
    for (const e of g.enemies) brute(e);
    for (let i = g.dormant.length - 1; i >= 0 && g.dormant[i].z < zMax; i--) brute(g.dormant[i]);
    for (const gh of g.gatehouses) {
      if (!inView(gh.z)) continue;
      const key = `h${gh.id}`;
      let o = objs.get(key);
      if (!o) objs.set(key, (o = makeGatehouse(gh)));
      seen.add(key);
      if (gh.open) {
        // the wall sinks into the road
        const p = o.openAt ? Math.min(1, (now - o.openAt) / 900) : 1;
        o.obj.position.y = -gateWallH * p * p;
        o.obj.position.x = p < 1 ? (Math.random() - 0.5) * 0.08 : 0;
        o.obj.visible = p < 1;
      }
    }
    for (const w of g.walls) {
      if (w.z1 < zMin || w.z0 > zMax) continue;
      const key = `w${w.x}:${w.z0}`;
      if (!objs.has(key)) objs.set(key, makeWall(w));
      seen.add(key);
    }
    for (const c of g.crates) {
      if (!inView(c.z)) continue;
      const key = `c${c.id}`;
      let o = objs.get(key);
      if (!o) objs.set(key, (o = makeCrate(c)));
      seen.add(key);
      const hp = Math.ceil(c.hp);
      if (hp !== o.shown) {
        drawCrate(o.t, c);
        o.shown = hp;
      }
      o.obj.rotation.y = Math.sin(time * 2) * 0.15;
    }
    for (const b of g.barrels) {
      if (!inView(b.z)) continue;
      const key = `b${b.id}`;
      if (!objs.has(key)) objs.set(key, makeBarrel(b));
      seen.add(key);
    }
    if (g.boss && !g.boss.dead && inView(g.boss.z)) {
      let o = objs.get('boss');
      if (!o) objs.set('boss', (o = makeBoss(g.boss)));
      seen.add('boss');
      o.obj.position.set(g.boss.x, 0, g.boss.z);
      const sl = g.boss.slam;
      const r = o.base;
      if (sl) {
        // wind-up: rear back, fists high
        const p = Math.min(1, sl.t / sl.dur);
        o.obj.rotation.set(-0.3 * p, 0, Math.sin(time * 30) * 0.03 * p);
        o.obj.position.y = 0.3 * p;
        o.fists.forEach((f, i) => f.position.set((i ? 1 : -1) * r * (1.05 - 0.55 * p), r * (0.85 + 1.5 * p), -0.2 + 0.4 * p));
      } else {
        const since = o.slamAt ? (now - o.slamAt) / 350 : 1;
        const stomp = g.boss.active ? Math.abs(Math.sin(time * 4)) : 0;
        o.obj.rotation.set(since < 1 ? 0.35 * (1 - since) : 0, 0, Math.sin(time * 4) * 0.06);
        o.obj.position.y = since < 1 ? 0 : stomp * 0.25;
        o.body.scale.set(1 + stomp * 0.04, 1 - stomp * 0.04, 1);
        // fists smashed into the ground in front, then back to the sides
        const k = Math.min(1, Math.max(0, since));
        o.fists.forEach((f, i) => f.position.set((i ? 1 : -1) * r * (0.5 + 0.55 * k), 0.5 + (r * 0.85 - 0.5) * k, -1.2 + 1.0 * k));
      }
    }
    // slam warning on the ground: a ring that fills up
    const slam = g.boss && !g.boss.dead && g.boss.slam;
    slamRing.visible = slamFill.visible = !!slam;
    if (slam) {
      const p = Math.min(1, slam.t / slam.dur);
      slamRing.position.set(slam.x, 0.03, slam.z);
      slamRing.scale.setScalar(slam.r);
      slamFill.position.set(slam.x, 0.025, slam.z);
      slamFill.scale.setScalar(slam.r * p);
      slamFill.material.opacity = 0.25 + 0.3 * p;
      slamRing.material.opacity = 0.6 + 0.4 * Math.abs(Math.sin(time * (8 + 14 * p)));
    }
    if (wave.t0) {
      const p = (now - wave.t0) / 450;
      wave.mesh.visible = p < 1;
      wave.mesh.scale.setScalar(wave.r * (0.6 + 1.2 * p));
      wave.mesh.material.opacity = 0.8 * (1 - p);
      if (p >= 1) wave.t0 = 0;
    }
    for (const [key, o] of objs) {
      if (seen.has(key)) continue;
      disposeObj(o.obj);
      for (const x of o.extra || []) disposeObj(x);
      if (o.kind === 'slab') for (const [id, st] of slabState) if (st === o.st) slabState.delete(id);
      objs.delete(key);
    }

    if (g.length !== Infinity && !finishObj) finishObj = makeFinish(g.length);

    // particles
    let np = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) {
        parts[i] = parts[parts.length - 1];
        parts.pop();
        continue;
      }
      p.vy -= 14 * dt;
      p.x += p.vx * dt;
      p.y = Math.max(0.05, p.y + p.vy * dt);
      p.z += p.vz * dt;
      const sc = p.size * Math.min(1, (p.life / p.max) * 2);
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(p.life * 7, p.life * 5, 0);
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      partMesh.setMatrixAt(np, dummy.matrix);
      partMesh.setColorAt(np, p.color);
      np++;
    }
    partMesh.count = np;
    partMesh.instanceMatrix.needsUpdate = true;
    if (partMesh.instanceColor) partMesh.instanceColor.needsUpdate = true;

    renderer.render(scene, camera);
  }

  /** Forget everything from the previous game. */
  function reset() {
    for (const o of objs.values()) {
      disposeObj(o.obj);
      for (const x of o.extra || []) disposeObj(x);
    }
    objs.clear();
    slabState.clear();
    if (finishObj) disposeObj(finishObj);
    finishObj = null;
    parts.length = 0;
    stones.length = 0;
    shown = 0;
    shake = 0;
  }

  resize();
  return { render, resize, project, onEvent, reset, camera };
}

