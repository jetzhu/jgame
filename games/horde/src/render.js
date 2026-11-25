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

const COLORS = {
  sky: 0x0a1730,
  deck: '#9aa3b1',
  soldier: 0x2f7dff,
  soldierBody: 0x1b3a8a,
  skin: 0xf2c49b,
  enemy: 0xe0453a,
  brute: 0x8e1c4a,
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

function drawVault(t, hp, maxHp) {
  const { c, ctx } = t;
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, '#aab4c3');
  g.addColorStop(1, '#6b7584');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#4b5361';
  ctx.lineWidth = 10;
  ctx.strokeRect(14, 14, c.width - 28, c.height - 28);
  // dial
  const cx = c.width / 2;
  const cy = c.height * 0.33;
  ctx.fillStyle = '#39404c';
  ctx.beginPath();
  ctx.arc(cx, cy, 46, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#cfd6df';
  ctx.beginPath();
  ctx.arc(cx, cy, 34, 0, Math.PI * 2);
  ctx.fill();
  const a = -Math.PI / 2 + (1 - hp / maxHp) * Math.PI * 2;
  ctx.strokeStyle = '#e23b3b';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * 30, cy + Math.sin(a) * 30);
  ctx.stroke();
  bigText(ctx, String(Math.ceil(hp)), cx, c.height * 0.74, hp >= 10000 ? 62 : 82);
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
  const cBrute = new THREE.Color(COLORS.brute);
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
      panelGeo(w - 0.2, 1.45),
      new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true }),
    );
    panel.position.y = 1.25;
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
    const locked = !!(lock && lock.hp > 0);
    const color = locked ? COLORS.locked : !gateGood(gt) ? COLORS.bad : gt.gold ? COLORS.gold : COLORS.good;
    return { label: gateLabel(gt), color, locked, pump: !!gt.pump };
  }

  const vaultBodyMat = new THREE.MeshLambertMaterial({ color: 0x8a95a5 });
  function makeVault(v) {
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
    return { obj: group, kind: 'boss', body };
  }

  // Geometries/materials shared by many objects; everything else belongs to one object.
  const shared = new Set([postGeo, postMat, pumpPostMat, targetGeo, targetMat, vaultBodyMat, wallMat, crateGeo, barrelGeo, barrelMat, bandGeo, bandMat]);
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
      if (Math.random() < (e.quiet ? 0.5 : 0.8)) burst(e.x, 0.4, e.z, e.brute ? 10 : 3, e.brute ? cBrute : cEnemy, 3, 0.13, 0.45);
    } else if (e.t === 'clash') {
      burst(e.x, 0.5, e.z, 4, new THREE.Color(COLORS.soldier), 3, 0.12, 0.5);
      shake = Math.max(shake, e.boss ? 0.25 : 0.12);
    } else if (e.t === 'gate') {
      const o = objs.get(`g${e.id}`);
      if (o) o.popAt = performance.now();
      burst(e.x, 1.2, e.z, 18, new THREE.Color(e.good ? 0x6cc4ff : 0xff5d6c), 5, 0.12, 0.6, 3);
    } else if (e.t === 'vaultOpen') {
      const o = objs.get(`v${e.id}`);
      if (o) o.openAt = performance.now();
      burst(e.x, 1.4, e.z, 50, new THREE.Color(0xc3ccd8), 7, 0.2, 0.9, 6);
      burst(e.x, 1.4, e.z, 30, new THREE.Color(0xffd34d), 6, 0.14, 0.8, 7);
      shake = 0.4;
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
    const putEnemy = (e) => {
      if (k >= MAX_ENEMIES || e.z < zMin || e.z > zMax || e.hp <= 0) return;
      const wob = Math.sin(time * 9 + e.id) * 0.06;
      const sc = e.kind === 'brute' ? 1.9 : 1;
      dummy.position.set(e.x, Math.abs(wob) * 0.6, e.z);
      dummy.rotation.set(0, 0, wob);
      dummy.scale.set(sc * (1 + wob), sc * (1 - wob), sc);
      dummy.updateMatrix();
      enemies.setMatrixAt(k, dummy.matrix);
      enemyEyes.setMatrixAt(k, dummy.matrix);
      enemies.setColorAt(k, e.hp < e.maxHp ? tmpColor.copy(e.kind === 'brute' ? cBrute : cEnemy).lerp(cHurt, 0.35) : e.kind === 'brute' ? cBrute : cEnemy);
      k++;
    };
    for (const e of g.enemies) putEnemy(e);
    for (let i = g.dormant.length - 1; i >= 0 && k < MAX_ENEMIES; i--) {
      const e = g.dormant[i];
      if (e.z > zMax) break;
      putEnemy(e);
    }
    enemies.count = enemyEyes.count = k;
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
    for (const gt of g.gates) {
      if (!inView(gt.z)) continue;
      const key = `g${gt.id}`;
      let o = objs.get(key);
      if (!o) objs.set(key, (o = makeGate(gt)));
      seen.add(key);
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
        drawVault(o.t, v.hp, v.maxHp);
        o.shown = hp;
        o.drawnAt = now;
      }
      if (v.hp <= 0) {
        const p = o.openAt ? Math.min(1, (now - o.openAt) / 500) : 1;
        o.obj.position.y = -2.6 * p * p;
        o.obj.visible = p < 1;
      } else {
        // rattle while being hit
        const hit = o.drawnAt && now - o.drawnAt < 80;
        o.obj.position.x = (v.x0 + v.x1) / 2 + (hit ? (Math.random() - 0.5) * 0.06 : 0);
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
      const stomp = g.boss.active ? Math.abs(Math.sin(time * 4)) : 0;
      o.obj.position.y = stomp * 0.25;
      o.obj.rotation.z = Math.sin(time * 4) * 0.06;
      o.body.scale.set(1 + stomp * 0.04, 1 - stomp * 0.04, 1);
    }
    for (const [key, o] of objs) {
      if (seen.has(key)) continue;
      disposeObj(o.obj);
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
    for (const o of objs.values()) disposeObj(o.obj);
    objs.clear();
    if (finishObj) disposeObj(finishObj);
    finishObj = null;
    parts.length = 0;
    shown = 0;
    shake = 0;
  }

  resize();
  return { render, resize, project, onEvent, reset, camera };
}

