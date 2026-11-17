// Creatures. Every district has its own resident species per realm; a species
// is decoded from a latent code by the breeder network (gen.breeder), which
// decides proportions, limb and eye counts, skin, voice and temperament.
// Every creature has hitboxes: they are solid, and they hurt by touching you.
import * as THREE from 'three';
import { CS, WL, HALL, WET, VOID, TOP, BOT } from './gen.js';
import { hash32, mulberry32, gauss } from './nn.js';
import { makeSkin } from './textures.js';
import { WALK, SWIM, FLY } from './player.js';
import { DX, DZ } from './world.js';

const GEO = {};
function geos() {
  if (GEO.cyl) return;
  GEO.cyl = new THREE.CylinderGeometry(1, 0.7, 1, 6, 1); GEO.cyl.translate(0, -0.5, 0);
  GEO.sph = new THREE.SphereGeometry(1, 10, 7);
  GEO.ico = new THREE.IcosahedronGeometry(1, 1);
}

const ADJ = ['Patient', 'Long', 'Folded', 'Quiet', 'Hollow', 'Leaning', 'Borrowed', 'Unfinished', 'Tall', 'Thin', 'Kneeling', 'Listening', 'Slow', 'Counting', 'Late', 'Other', 'Lidless', 'Narrow', 'Second', 'Polite'];
const NOUN = {
  walker: ['Tenant', 'Usher', 'Guest', 'Custodian', 'Clerk', 'Visitor', 'Neighbour'],
  eel: ['Lodger', 'Thread', 'Current', 'Swimmer'], jelly: ['Lantern', 'Bell', 'Bloom'], leviathan: ['Landlord', 'Weight', 'Foundation'],
  drifter: ['Witness', 'Chandelier', 'Congregation'], orbiter: ['Attendant', 'Satellite', 'Moth'],
  angler: ['Lamp', 'Mouth', 'Keeper'], serpent: ['Procession', 'Chain', 'Tide'],
};
const EYE_COLS = [[2.2, 2.2, 2.0], [2.6, 0.25, 0.15], [1.2, 1.9, 2.6], [2.5, 1.9, 0.6], [1.0, 2.5, 1.4]];

function wrap(a) { while (a > Math.PI) a -= 6.2832; while (a < -Math.PI) a += 6.2832; return a; }
function turn(cur, target, k) { return cur + wrap(target - cur) * k; }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function breed(gen, seed, realm, slot) {
  const rng = mulberry32(seed);
  const inp = new Float32Array(11);
  for (let q = 0; q < 8; q++) inp[q] = gauss(rng);
  inp[8 + realm] = 1;
  const o = Float32Array.from(gen.breeder.forward(inp));
  const u = q => 0.5 + 0.5 * o[q];
  const kind = realm === HALL ? 'walker' : realm === WET ? ['eel', 'jelly', 'leviathan', 'angler'][slot] : ['drifter', 'orbiter', 'serpent'][slot];
  const pale = u(23) > 0.45;
  const sp = {
    seed, realm, kind,
    name: 'the ' + ADJ[seed % ADJ.length] + ' ' + NOUN[kind][(seed >>> 8) % NOUN[kind].length],
    eyes: Math.floor(u(13) * u(13) * 9.99), eyeCol: EYE_COLS[Math.floor(u(14) * 4.99)], eyeLine: o[15] > 0.2,
    skin: pale ? [0.4 + 0.12 * u(20), 0.36 + 0.1 * u(21), 0.33 + 0.08 * u(22)] : [0.035 + 0.06 * u(20), 0.035 + 0.05 * u(21), 0.04 + 0.06 * u(22)],
    twitch: u(29), thick: 0.035 + 0.05 * u(8),
    voice: { f: 55 + 480 * u(24) * u(24), ratio: 0.5 + 3 * u(25), depth: 40 + 600 * u(26), dur: 0.5 + 1.5 * u(27), fall: 0.4 + 0.8 * u(28) },
    skinTex: null, seen: false,
  };
  if (kind === 'walker') {
    const lg = u(2);
    sp.legs = lg < 0.55 ? 2 : lg < 0.85 ? 4 : 3;
    sp.height = (2.0 + 1.3 * Math.pow(u(0), 1.5)) * (u(1) > 0.9 ? 1.5 : 1);
    sp.face = Math.floor(u(32) * 4.99);      // 0 mask, 1 one hole, 2 split, 3 jaw hanging, 4 no face at all
    sp.backArms = sp.legs !== 4 && u(34) > 0.62;
    sp.claw = 0.8 + 0.9 * u(35);
    sp.legFrac = 0.44 + 0.2 * u(4);
    sp.torso = 0.26 + 0.14 * u(5);
    sp.torsoW = 0.15 + 0.14 * u(9);
    sp.hunch = sp.legs === 4 ? 1.25 + 0.25 * u(10) : 0.1 + 0.95 * u(10);
    sp.arms = sp.legs === 4 ? Math.floor(u(3) * 2.5) : 2 + Math.floor(u(3) * u(3) * 3.99);
    sp.armLen = 0.5 + 0.5 * u(7);
    sp.asym = u(16) > 0.6 ? u(16) : 0;
    sp.neck = 0.05 + 0.3 * u(6) * u(6);
    sp.headR = 0.11 + 0.12 * u(11); sp.headStretch = 0.8 + 1.5 * u(12) * u(12);
    let b = 0, best = -9;
    for (let q = 0; q < 3; q++) if (o[17 + q] > best) { best = o[17 + q]; b = q; }
    sp.behavior = b; // 0 moves when unobserved, 1 hunts, 2 sits folded and waits
    sp.speed = 3.0 + 1.8 * u(30);
    sp.sight = 16 + 12 * u(31);
  } else if (kind === 'eel' || kind === 'leviathan' || kind === 'serpent') {
    const big = kind !== 'eel';
    sp.segs = big ? 26 : 12 + Math.floor(u(0) * 10);
    sp.len = big ? 22 + 16 * u(1) : 3 + 5 * u(1);
    sp.rad = big ? 1.0 + 0.8 * u(2) : 0.12 + 0.18 * u(2);
    sp.tendrils = Math.floor(u(3) * (big ? 9 : 5));
    sp.spines = u(4) > 0.5;
    sp.wave = 0.25 + 0.5 * u(5);
    sp.speed = big ? 1.4 : 2.9 + 0.5 * u(30);
    if (big) sp.eyes = Math.max(sp.eyes, 4);
    if (kind === 'serpent') { sp.segs = 22; sp.len = 26 + 18 * u(1); sp.rad = 0.45 + 0.5 * u(2); sp.speed = 6 + 2 * u(30); sp.spines = true; sp.tendrils = 0; }
  } else if (kind === 'angler') { // it holds out something you want
    sp.rad = 0.7 + 0.6 * u(0); sp.stalk = 1.4 + 1.4 * u(1); sp.speed = 0;
    sp.eyeCol = [1.6, 1.45, 1.5];
  } else if (kind === 'jelly') {
    sp.rad = 0.35 + 0.7 * u(0);
    sp.tendrils = 5 + Math.floor(u(3) * 5.99);
    sp.tlen = 1.5 + 3.5 * u(1);
    sp.speed = 0.35;
  } else {
    const small = kind === 'orbiter';
    sp.rad = (1.2 + 2.8 * u(0)) * (small ? 0.35 : 1);
    sp.arms = 4 + Math.floor(u(3) * 5.99);
    sp.armSeg = (1 + 2 * u(1)) * (small ? 0.35 : 1);
    sp.eyes = 6 + sp.eyes * 3;
    sp.speed = 2.8 + 1.6 * u(30);
  }
  return sp;
}

function chain(mat, n, len, r0, r1) {
  const root = new THREE.Group(), joints = [];
  let parent = root;
  for (let q = 0; q < n; q++) {
    const j = new THREE.Group();
    if (q > 0) j.position.y = -len;
    parent.add(j);
    const m = new THREE.Mesh(GEO.cyl, mat), r = r0 + ((r1 - r0) * q) / Math.max(1, n - 1);
    m.scale.set(r, len, r);
    j.add(m);
    joints.push(j);
    parent = j;
  }
  return { root, joints };
}

function eye(parent, mat, x, y, z, r) {
  const m = new THREE.Mesh(GEO.sph, mat);
  m.position.set(x, y, z); m.scale.setScalar(r);
  parent.add(m);
}

// A body that is nearly a person: too long in the limb, the ribs standing out, the spine showing,
// hands that reach the floor. And a face that is wrong in one of five ways.
function buildWalker(c) {
  const sp = c.sp, mat = c.mat, pale = c.pale, hole = c.hole, H = sp.height;
  const legLen = H * sp.legFrac, torsoLen = H * sp.torso, th = sp.thick * (0.8 + H * 0.2), tw = sp.torsoW;
  const rig = c.rig = { legs: [], arms: [], legLen };
  const ball = (parent, sx, sy, sz, x, y, z, m = mat) => { const o = new THREE.Mesh(GEO.sph, m); o.scale.set(sx, sy, sz); o.position.set(x, y, z); parent.add(o); return o; };
  const bar = (parent, r, len, x, y, z, m = mat) => { const o = new THREE.Mesh(GEO.cyl, m); o.scale.set(r, len, r); o.position.set(x, y, z); parent.add(o); return o; };

  const pelvis = rig.pelvis = new THREE.Group();
  pelvis.position.y = legLen * 0.97;
  c.root.add(pelvis);
  ball(pelvis, tw * 0.75, tw * 0.42, tw * 0.5, 0, 0, 0, pale);                      // hip bones
  const torso = rig.torso = new THREE.Group();
  torso.rotation.x = sp.hunch;
  pelvis.add(torso);
  ball(torso, tw * 0.42, torsoLen * 0.3, tw * 0.34, 0, torsoLen * 0.28, 0);          // a waist with nothing in it
  const body = rig.body = ball(torso, tw * 0.82, torsoLen * 0.3, tw * 0.6, 0, torsoLen * 0.72, 0);
  rig.bodyZ = tw * 0.6;
  for (let q = 0; q < 5; q++) for (const sd of [-1, 1]) {                             // ribs
    const r = bar(torso, th * 0.3, tw * (1.05 - q * 0.06), sd * tw * 0.08, torsoLen * (0.9 - q * 0.085), tw * 0.56, pale);
    r.rotation.z = sd * (1.25 - q * 0.05); r.rotation.x = 0.35;
  }
  for (let q = 0; q < 8; q++) ball(torso, tw * 0.17, tw * 0.17, tw * 0.3, 0, (torsoLen * (q + 0.5)) / 8, -tw * 0.55, pale); // the spine, standing out
  bar(torso, th * 0.6, tw * 2.1, -tw * 1.05, torsoLen * 0.97, 0).rotation.z = Math.PI / 2;                      // shoulders

  for (let l = 0; l < sp.legs; l++) {
    const side = sp.legs === 3 && l === 2 ? 0 : l % 2 ? 1 : -1, front = sp.legs === 4 && l >= 2;
    const ch = chain(mat, 2, legLen * 0.5, th * 1.15, th * 0.7);
    if (front) { ch.root.position.set(side * tw * 0.9, torsoLen * 0.94, 0); torso.add(ch.root); }
    else { ch.root.position.set(side * tw * 0.6, 0, side === 0 ? -tw : 0); pelvis.add(ch.root); }
    ball(ch.joints[1], th * 1.35, th * 1.35, th * 1.35, 0, 0, 0, pale);                                              // knee
    ball(ch.joints[1], th * 1.0, th * 0.5, th * 3.0, 0, -legLen * 0.5 + th * 0.4, th * 1.8);                         // a long foot
    rig.legs.push({ j: ch.joints, ph: (l % 2 ? Math.PI : 0) + (front ? Math.PI * 0.5 : 0), base: front ? -sp.hunch : 0 });
  }

  const nArm = sp.arms + (sp.backArms ? 2 : 0);
  for (let a = 0; a < nArm; a++) {
    const side = a % 2 ? 1 : -1, back = a >= sp.arms, n = back ? 3 : 2 + (a % 3 === 2 ? 1 : 0);
    const len = (H * sp.armLen * (back ? 1.25 : 1) * (1 + (side > 0 ? sp.asym : 0) * 0.8)) / n;
    const ch = chain(mat, n, len, th * 0.85, th * 0.5);
    ch.root.position.set(side * tw * (back ? 0.5 : 1.05), torsoLen * (back ? 0.8 : 0.95 - 0.13 * Math.floor(a / 2)), back ? -tw * 0.6 : 0);
    torso.add(ch.root);
    for (let q = 1; q < n; q++) ball(ch.joints[q], th * 1.1, th * 1.1, th * 1.1, 0, 0, 0, pale);                     // elbows
    const last = ch.joints[n - 1];
    ball(last, th * 1.3, th * 1.7, th * 0.5, 0, -len - th * 1.2, 0);                                                 // palm
    if (sp.face === 4) eye(last, c.eyeMat, 0, -len - th * 1.2, th * 0.5, th * 0.55);                                 // the faceless ones see with their hands
    const fingers = [], fl = len * 0.3 * sp.claw;
    for (let f = 0; f < 4; f++) {                                                                                    // four fingers, each a joint too long, ending in a nail
      const fg = new THREE.Group();
      fg.position.set((f - 1.5) * th * 0.6, -len - th * 2.4, 0); fg.rotation.z = (f - 1.5) * 0.22;
      bar(fg, th * 0.26, fl, 0, 0, 0);
      const tip = new THREE.Group(); tip.position.y = -fl; tip.rotation.x = 0.55;
      bar(tip, th * 0.2, fl * 0.9, 0, 0, 0, pale);
      fg.add(tip);
      last.add(fg);
      fingers.push(fg);
    }
    rig.arms.push({ j: ch.joints, ph: a * 1.7, side, fingers });
  }

  const neck = rig.neck = new THREE.Group();
  neck.position.y = torsoLen;
  neck.rotation.x = -sp.hunch * 0.85;
  torso.add(neck);
  const nl = rig.nl = H * sp.neck;
  const nm = rig.neckMesh = new THREE.Mesh(GEO.cyl, mat);
  nm.scale.set(th * 0.8, nl, th * 0.8); nm.position.y = nl;
  neck.add(nm);
  const head = rig.head = new THREE.Group();
  const hr = sp.headR * 1.15, hs = hr * sp.headStretch;
  rig.headOff = hs * 0.8;
  head.position.y = nl + rig.headOff;
  neck.add(head);
  // the face sits in its own frame, so it can be on upside down (the ones on all fours) or hanging off to one side
  const fg = new THREE.Group();
  head.add(fg);
  if (sp.legs === 4) fg.rotation.z = Math.PI;
  const teeth = (parent, n, w, y, z, len, up) => { for (let q = 0; q < n; q++) { const t = bar(parent, hr * 0.035, len, ((q + 0.5) / n - 0.5) * w, y, z, pale); if (up) t.rotation.x = Math.PI; } };
  switch (sp.face) {
    case 0: { // a mask: two sockets, and a mouth that is too wide and full
      ball(fg, hr, hs, hr * 0.95, 0, 0, 0, pale);
      for (const sd of [-1, 1]) { ball(fg, hr * 0.27, hs * 0.2, hr * 0.2, sd * hr * 0.4, hs * 0.18, hr * 0.78, hole); eye(fg, c.eyeMat, sd * hr * 0.4, hs * 0.18, hr * 0.9, hr * 0.045); }
      ball(fg, hr * 0.74, hs * 0.1, hr * 0.2, 0, -hs * 0.42, hr * 0.74, hole);
      teeth(fg, 9, hr * 1.2, -hs * 0.36, hr * 0.9, hs * 0.11, false); teeth(fg, 9, hr * 1.2, -hs * 0.48, hr * 0.9, hs * 0.11, true);
      break;
    }
    case 1: { // no features: one hole where the face would be, teeth all the way round it, and something lit a long way in
      ball(fg, hr, hs, hr, 0, 0, 0);
      ball(fg, hr * 0.7, hs * 0.72, hr * 0.3, 0, 0, hr * 0.8, hole);
      for (let q = 0; q < 12; q++) {
        const a = (q / 12) * 6.2832, t = bar(fg, hr * 0.04, hr * 0.3, Math.cos(a) * hr * 0.66, Math.sin(a) * hs * 0.68, hr * 0.98, pale);
        t.rotation.z = a + Math.PI / 2;
      }
      eye(fg, c.eyeMat, 0, 0, hr * 0.72, hr * 0.06);
      break;
    }
    case 2: { // split down the middle and standing open, eyes on both halves
      for (const sd of [-1, 1]) {
        ball(fg, hr * 0.56, hs, hr * 0.95, sd * hr * 0.5, 0, 0, pale).rotation.z = sd * -0.28;
        for (let q = 0; q < 6; q++) bar(fg, hr * 0.035, hr * 0.22, sd * hr * 0.12, hs * (0.6 - q * 0.24), hr * 0.5, pale).rotation.z = sd * 1.5708;
        const n = Math.max(2, Math.ceil(sp.eyes / 2));
        for (let q = 0; q < n; q++) eye(fg, c.eyeMat, sd * hr * (0.62 + 0.12 * (q % 2)), hs * (0.55 - (q / n) * 1.1), hr * 0.8, hr * 0.06);
      }
      ball(fg, hr * 0.2, hs * 0.9, hr * 0.5, 0, 0, hr * 0.2, hole);
      break;
    }
    case 3: { // the jaw has come away and hangs; the head lies over on one shoulder
      fg.rotation.z += 1.15; fg.position.x = hr * 0.5;
      ball(fg, hr, hs, hr * 0.95, 0, 0, 0, pale);
      for (const sd of [-1, 1]) { ball(fg, hr * 0.25, hs * 0.24, hr * 0.2, sd * hr * 0.4, hs * 0.2, hr * 0.78, hole); eye(fg, c.eyeMat, sd * hr * 0.4, hs * 0.16, hr * 0.9, hr * 0.04); }
      ball(fg, hr * 0.5, hs * 0.5, hr * 0.25, 0, -hs * 0.75, hr * 0.62, hole);
      teeth(fg, 7, hr * 0.85, -hs * 0.32, hr * 0.86, hs * 0.13, false);
      ball(fg, hr * 0.62, hs * 0.16, hr * 0.7, 0, -hs * 1.3, hr * 0.25, pale);
      teeth(fg, 7, hr * 0.85, -hs * 1.2, hr * 0.8, hs * 0.14, true);
      break;
    }
    default: // nothing: smooth, a single seam down the front
      ball(fg, hr * 0.9, hs * 1.15, hr * 0.9, 0, 0, 0, pale);
      ball(fg, hr * 0.03, hs * 0.95, hr * 0.1, 0, 0, hr * 0.86, hole);
  }
  for (let q = 0; q < 5; q++) { const hbar = bar(fg, hr * 0.03, hs * (1.2 + 0.5 * ((sp.seed >>> (q * 3)) & 3)), (q - 2) * hr * 0.38, hs * 0.75, -hr * 0.55, hole); hbar.rotation.x = -0.15; } // a few strands of hair, hanging

  c.eyeH = legLen + torsoLen * Math.cos(sp.hunch) + nl;
  c.topH = c.eyeH + hs * 1.8;
  c.hr = Math.max(0.3, tw + 0.14);
}

function buildEel(c) {
  const sp = c.sp, N = sp.segs, segLen = sp.len / N;
  const rig = c.rig = { segs: [], meshes: [], tend: [], segLen, trail: [], gap: segLen * 0.5 };
  for (let i = 0; i < N; i++) {
    const s = i / (N - 1);
    const rad = sp.rad * (s < 0.2 ? 0.85 + 0.15 * (s / 0.2) : 1 - 0.9 * Math.pow((s - 0.2) / 0.8, 1.3));
    const g = new THREE.Group(), m = new THREE.Mesh(GEO.sph, c.mat);
    m.scale.set(rad, rad * 0.9, segLen * 0.8);
    g.add(m);
    g.userData.rad = rad;
    c.root.add(g);
    rig.segs.push(g); rig.meshes.push(m);
    if (sp.spines && i > 1 && i % 2 === 0 && i < N - 3) {
      const sm = new THREE.Mesh(GEO.cyl, c.mat);
      sm.scale.set(rad * 0.07, rad * 1.5, rad * 0.25); sm.position.y = rad * 0.7; sm.rotation.x = Math.PI - 0.5;
      g.add(sm);
    }
  }
  const head = rig.segs[0], n = sp.eyes, er = sp.rad > 0.6 ? 0.2 : 0.045;
  for (let e = 0; e < n; e++) {
    const side = e % 2 ? 1 : -1, row = Math.floor(e / 2);
    eye(head, c.eyeMat, side * sp.rad * 0.72, sp.rad * 0.3, segLen * 0.45 - row * er * 3.2, er);
  }
  for (let t = 0; t < sp.tendrils; t++) {
    const seg = rig.segs[2 + Math.floor((t / sp.tendrils) * (N - 6))];
    const ch = chain(c.mat, 5, 0.45 + sp.rad * 0.8, 0.03 + sp.rad * 0.05, 0.012);
    ch.root.position.y = -seg.userData.rad * 0.6;
    seg.add(ch.root);
    rig.tend.push({ j: ch.joints, ph: t * 2.1 });
  }
  const need = N * 2 + 4, dx = -Math.sin(c.yaw), dz = -Math.cos(c.yaw);
  for (let q = 0; q < need; q++) rig.trail.push({ x: c.x + dx * rig.gap * q, y: c.y, z: c.z + dz * rig.gap * q });
  // jaws that open when it comes in
  const R0 = sp.rad * 0.85, mk = (sx, sy, sz, mat = c.mat) => { const m = new THREE.Mesh(GEO.sph, mat); m.scale.set(sx, sy, sz); return m; };
  for (const up of [1, -1]) {
    const j = new THREE.Group(), m = mk(R0 * 0.8, R0 * 0.16, R0 * 1.2);
    j.position.set(0, up * R0 * 0.15, segLen * 0.4); m.position.z = R0 * 1.0;
    j.add(m);
    for (let q = 0; q < 5; q++) { // teeth
      const tt = new THREE.Mesh(GEO.cyl, c.pale);
      tt.scale.set(R0 * 0.05, R0 * 0.3, R0 * 0.05); tt.position.set((q - 2) * R0 * 0.28, 0, R0 * (1.9 - Math.abs(q - 2) * 0.25));
      if (up < 0) tt.rotation.x = Math.PI;
      j.add(tt);
    }
    head.add(j);
    if (up > 0) rig.jawU = j; else rig.jawL = j;
  }
  // lights along its sides, and fins on the long ones
  rig.fins = [];
  const big = c.kind !== 'eel';
  for (let i = 2; i < N - 1; i += 2) {
    const g = rig.segs[i], rad = g.userData.rad, er2 = Math.max(0.025, rad * 0.11);
    for (const sd of [-1, 1]) eye(g, c.eyeMat, sd * rad * 0.96, rad * 0.1, 0, er2);
    if (big && i % 4 === 2 && i < N - 6) for (const sd of [-1, 1]) {
      const f = mk(rad * 1.7, rad * 0.07, rad * 0.75);
      f.position.x = sd * rad * 1.9;
      g.add(f);
      rig.fins.push({ m: f, side: sd, ph: i * 0.6 });
    }
  }
  if (c.kind === 'leviathan') for (let q = 0; q < 4; q++) { // barbels, feeling ahead of it
    const ch = chain(c.mat, 6, sp.rad * 0.7, sp.rad * 0.07, 0.02);
    ch.root.position.set((q - 1.5) * sp.rad * 0.4, -sp.rad * 0.4, segLen * 0.4);
    ch.root.rotation.x = -1.2;
    head.add(ch.root);
    rig.tend.push({ j: ch.joints, ph: q * 1.4 });
  }
  c.r = 0.35; c.h = 0.7;
}

// It sits on the bottom and holds up a light that looks very like a pearl.
function buildAngler(c) {
  const sp = c.sp, r = sp.rad, rig = c.rig = {};
  const mk = (sx, sy, sz, mat = c.mat) => { const m = new THREE.Mesh(GEO.sph, mat); m.scale.set(sx, sy, sz); return m; };
  const body = mk(r, r * 0.85, r * 1.15);
  c.root.add(body);
  const jaw = rig.jaw = new THREE.Group(), jm = mk(r * 0.92, r * 0.22, r * 0.95);
  jaw.position.set(0, -r * 0.3, r * 0.25); jm.position.z = r * 0.55;
  jaw.add(jm);
  for (let q = 0; q < 7; q++) {
    const a = (q / 6 - 0.5) * 2.2, tt = new THREE.Mesh(GEO.cyl, c.mat);
    tt.scale.set(r * 0.04, r * 0.4, r * 0.04); tt.rotation.x = Math.PI;
    tt.position.set(Math.sin(a) * r * 0.8, r * 0.05, r * 0.55 + Math.cos(a) * r * 0.8);
    jaw.add(tt);
  }
  c.root.add(jaw);
  for (const sd of [-1, 1]) { const f = mk(r * 0.7, r * 0.06, r * 0.5); f.position.set(sd * r * 1.2, 0, -r * 0.2); f.rotation.z = sd * 0.5; c.root.add(f); }
  const tail = mk(r * 0.08, r * 0.7, r * 0.6); tail.position.z = -r * 1.5; c.root.add(tail);
  const ch = chain(c.mat, 5, sp.stalk / 5, 0.05, 0.02);
  ch.root.position.set(0, r * 0.7, r * 0.5); ch.root.rotation.x = -(Math.PI - 0.55);
  c.root.add(ch.root);
  rig.stalk = ch.joints;
  const lure = rig.lure = new THREE.Mesh(GEO.sph, c.eyeMat);
  lure.position.y = -sp.stalk / 5; lure.scale.setScalar(0.13);
  ch.joints[4].add(lure);
  c.r = 0.35; c.h = 0.7; c.eyeH = 0;
}

function buildJelly(c) {
  const sp = c.sp, rig = c.rig = { tend: [] };
  const bell = rig.bell = new THREE.Mesh(GEO.sph, c.mat);
  bell.scale.set(sp.rad, sp.rad * 0.6, sp.rad);
  c.root.add(bell);
  const core = rig.core = new THREE.Mesh(GEO.sph, c.eyeMat);
  core.scale.setScalar(sp.rad * 0.22); core.position.y = -sp.rad * 0.1;
  c.root.add(core);
  for (let t = 0; t < sp.tendrils; t++) {
    const a = (t / sp.tendrils) * 6.2832;
    const ch = chain(c.mat, 6, sp.tlen / 6, 0.03, 0.008);
    ch.root.position.set(Math.cos(a) * sp.rad * 0.7, -sp.rad * 0.3, Math.sin(a) * sp.rad * 0.7);
    c.root.add(ch.root);
    rig.tend.push({ j: ch.joints, ph: t * 1.3 });
  }
  // a second bell inside the first, and thick arms under the middle
  const inner = rig.inner = new THREE.Mesh(GEO.sph, c.mat);
  inner.scale.set(sp.rad * 0.6, sp.rad * 0.75, sp.rad * 0.6); inner.position.y = -sp.rad * 0.22;
  c.root.add(inner);
  for (let t = 0; t < 3; t++) {
    const a = (t / 3) * 6.2832 + 0.5, ch = chain(c.mat, 4, sp.tlen / 7, 0.07, 0.03);
    ch.root.position.set(Math.cos(a) * sp.rad * 0.2, -sp.rad * 0.6, Math.sin(a) * sp.rad * 0.2);
    c.root.add(ch.root);
    rig.tend.push({ j: ch.joints, ph: t * 2.3 + 1 });
  }
  c.r = 0.3; c.h = 0.5;
}

function buildDrifter(c) {
  const sp = c.sp, rig = c.rig = { arms: [] };
  const core = rig.core = new THREE.Mesh(GEO.ico, c.mat);
  core.scale.setScalar(sp.rad);
  c.root.add(core);
  const rng = mulberry32(sp.seed ^ 0x3d);
  for (let e = 0; e < sp.eyes; e++) {
    const a = (e / sp.eyes) * 6.2832, band = e % 3 === 0 ? 0.35 : e % 3 === 1 ? -0.3 : 0;
    const r = Math.sqrt(1 - band * band) * sp.rad;
    eye(c.root, c.eyeMat, Math.cos(a) * r, band * sp.rad, Math.sin(a) * r, sp.rad * 0.07);
  }
  for (let a = 0; a < sp.arms; a++) {
    const ch = chain(c.mat, 7, sp.armSeg, sp.rad * 0.14, sp.rad * 0.02);
    ch.root.rotation.set(rng() * 6.28, rng() * 6.28, rng() * 6.28);
    c.root.add(ch.root);
    rig.arms.push({ j: ch.joints, ph: a * 1.9 });
  }
  // two rings of splinters turning about it, against each other
  for (const [name, rr, n] of [['halo', 1.9, 10], ['halo2', 2.5, 14]]) {
    const h = rig[name] = new THREE.Group();
    for (let q = 0; q < n; q++) {
      const a = (q / n) * 6.2832, m = new THREE.Mesh(GEO.ico, c.mat);
      m.position.set(Math.cos(a) * sp.rad * rr, 0, Math.sin(a) * sp.rad * rr);
      m.scale.set(sp.rad * 0.07, sp.rad * (0.18 + 0.2 * rng()), sp.rad * 0.07);
      m.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      h.add(m);
    }
    c.root.add(h);
  }
  rig.halo.rotation.x = 0.5; rig.halo2.rotation.z = 0.6;
  // one eye that is closed until you are near, and is always turned to you
  rig.look = new THREE.Group();
  rig.iris = new THREE.Mesh(GEO.sph, c.eyeMat);
  rig.iris.position.z = sp.rad * 0.92; rig.iris.scale.set(sp.rad * 0.42, sp.rad * 0.04, sp.rad * 0.12);
  rig.look.add(rig.iris);
  c.root.add(rig.look);
}

// A frozen attitude for the ones that only move unobserved: different every time you catch them.
function newPose(c, look) {
  const r = Math.random;
  return {
    arms: c.rig.arms.map(() => [-(0.9 + r() * 1.9), -(r() * 1.2), r() < 0.5 ? 0.95 : 0.1]),
    headY: clamp(look, -3.1, 3.1), headZ: (r() * 2 - 1) * 1.25,
    torsoX: (r() - 0.3) * 0.5, torsoZ: (r() - 0.5) * 0.5, crouch: r() < 0.3 ? 0.55 + r() * 0.2 : 1,
  };
}

class Creature {
  constructor(mgr, sp, x, y, z) {
    this.mgr = mgr; this.sp = sp; this.kind = sp.kind;
    this.x = x; this.y = y; this.z = z; this.r = 0.3; this.h = 1.0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = Math.random() * 6.2832;
    this.state = 'wander'; this.threat = 0; this.dead = false;
    this.pathT = Math.random() * 0.3; this.dirStep = -1; this.pci = 0; this.pcj = 0;
    this.wt = 0; this.wx = x; this.wy = y; this.wz = z; this.wspeed = 0;
    this.lost = 0; this.lunge = 0; this.tele = 6 + Math.random() * 10; this.cool = 0; this.sting = 0;
    this.gait = Math.random() * 6; this.fit = 1; this.voiceT = 4 + Math.random() * 10; this.eyeH = 1; this.topH = 2; this.hr = 0.3;
    this.orbR = 34; this.orbA = Math.random() * 6.28; this.orbH = (Math.random() - 0.5) * 10;
    // animation state
    this.seedF = Math.random() * 100; this.spasm = 0; this.spasmT = 1 + Math.random() * 6;
    this.reach = 0; this.neckS = 1; this.stand = sp.behavior === 2 ? 0.45 : 1; this.wasSeen = false; this.pose = null;
    this.headTilt = 0; this.headTiltTarget = 0; this.headTiltK = 1; this.headT = 0;
    this.blink = 0; this.blinkT = 1 + Math.random() * 5;
    this.hb = []; this.hbN = 0;
    this.hurt = 0; this.hurtD = 1; this.dying = 0; this.dieD = 1; this.hits = 0; this.hitF = 0; this.kx = 0; this.ky = 0; this.kz = 0; this.klx = 0; this.klz = 0; this.base = null;
    this.spawnT = 0; this.spawnD = 1; this.spawnK = 0;
    this.st = 'stalk'; this.stT = 2 + Math.random() * 2; this.snap = 0; this.home = null;
    this.despawn = sp.realm === VOID ? 230 : 80;
    if (!sp.skinTex) sp.skinTex = makeSkin(sp.seed, sp.skin);
    this.mat = mgr.mats.make({ map: sp.skinTex, rim: 0.75, stain: 0, caustic: sp.realm === WET ? 1 : 0, bare: true });
    this.eyeMat = mgr.mats.make({ map: mgr.mats.white, glow: 1, ambient: sp.eyeCol, bare: true });
    this.pale = mgr.mats.make({ map: mgr.mats.white, tint: [0.62, 0.57, 0.47], rim: 0.5, stain: 0, caustic: sp.realm === WET ? 1 : 0, bare: true }); // bone, teeth, nails
    this.hole = mgr.mats.make({ map: mgr.mats.white, tint: [0.004, 0.004, 0.005], stain: 0, caustic: 0, bare: true });                       // sockets and mouths
    this.root = new THREE.Group();
    this.root.rotation.order = 'YXZ'; // tipping over happens in its own frame, whichever way it faces
    if (this.kind === 'walker') buildWalker(this);
    else if (this.kind === 'eel' || this.kind === 'leviathan' || this.kind === 'serpent') buildEel(this);
    else if (this.kind === 'angler') buildAngler(this);
    else if (this.kind === 'jelly') buildJelly(this);
    else buildDrifter(this);
    mgr.scene.add(this.root);
  }

  // hitbox n, as a box centred on (x, y, z)
  box(n, x, y0, z, half, y1) {
    while (this.hb.length <= n) this.hb.push({ x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, owner: this });
    const b = this.hb[n];
    b.x0 = x - half; b.x1 = x + half; b.z0 = z - half; b.z1 = z + half; b.y0 = y0; b.y1 = y1;
  }

  dispose() {
    this.mgr.scene.remove(this.root);
    this.mat.dispose(); this.eyeMat.dispose(); this.pale.dispose(); this.hole.dispose();
  }
}

// how many times each kind has to be hit; the two long ones cannot be put down at all
const TOUGH = { walker: 2, eel: 2, jelly: 1, angler: 3, drifter: 3, orbiter: 2, serpent: 99, leviathan: 99 };

export class Creatures {
  constructor(scene, world, gen, mats, sound) {
    geos();
    this.scene = scene; this.world = world; this.gen = gen; this.mats = mats; this.sound = sound;
    this.list = [];
    this.species = new Map();
    this.seen = new Set();
    this.spawnT = 3; this.cool = 0; this.grace = 35;
    this.onNote = null;
    this.onAlert = null; // (creature, strength): it has noticed you, or arrived in front of you
    this.tmp = { realm: 0, floor: 0, ceil: 0, solid: 0, R: null };
    this.body = { x: 0, y: 0, z: 0, r: 0.35, h: 0.7 };
  }

  speciesFor(R, realm, slot) {
    const seed = hash32(R.id, realm, slot, 77);
    let sp = this.species.get(seed);
    if (!sp) { sp = breed(this.gen, seed, realm, slot); this.species.set(seed, sp); }
    return sp;
  }

  count(kind) { let n = 0; for (const c of this.list) if (c.kind === kind) n++; return n; }

  // arrive: play one of the ways of arriving (only the walking ones have them)
  spawn(sp, x, y, z, arrive = false) {
    const c = new Creature(this, sp, x, y, z);
    if (arrive && c.kind === 'walker') { c.spawnD = c.spawnT = 1.3 + Math.random() * 0.9; c.spawnK = Math.floor(Math.random() * 4); c.stand = 1; }
    this.list.push(c);
    return c;
  }

  clear() {
    for (const c of this.list) c.dispose();
    this.list.length = 0;
    this.cool = 12;
  }

  observed(c, cam, dir, maxDist) {
    const dx = c.x - cam.x, dy = c.y + c.eyeH * 0.6 - cam.y, dz = c.z - cam.z, d = Math.hypot(dx, dy, dz);
    if (d > maxDist) return false;
    if ((dx * dir.x + dy * dir.y + dz * dir.z) / (d || 1) < 0.5) return false;
    return c.sp.realm === VOID || this.world.los(cam.x, cam.z, c.x, c.z);
  }

  // does the player's body (grown by `m`) overlap hitboxes [from, to) of this creature?
  touch(c, P, m, from = 0, to = c.hbN) {
    const xa = P.x - P.r - m, xb = P.x + P.r + m, za = P.z - P.r - m, zb = P.z + P.r + m, ya = P.y - m, yb = P.y + P.h + m;
    for (let q = from; q < to && q < c.hbN; q++) {
      const b = c.hb[q];
      if (xa < b.x1 && xb > b.x0 && za < b.z1 && zb > b.z0 && ya < b.y1 && yb > b.y0) return true;
    }
    return false;
  }

  // Shot. It is thrown back and reels; enough hits and it goes down and does not get up (the largest only flinch).
  // Returns 'down', 'reel' or 'flinch'.
  shot(c, dx, dy, dz) {
    if (c.dying > 0) return 'reel';
    const tough = TOUGH[c.kind] || 2, big = tough > 50;
    c.hits++; c.hitF = 1;
    if (c.spawnT > 0) { c.spawnT = 0; c.root.visible = true; }
    if (!c.base) c.base = c.root.scale.clone();
    const push = c.kind === 'walker' ? 7.5 : big ? 0 : 5.5;
    c.kx = dx * push; c.ky = c.kind === 'walker' ? 2.2 : dy * push; c.kz = dz * push;
    const hl = Math.hypot(dx, dz) || 1, sy = Math.sin(c.yaw), cy = Math.cos(c.yaw);
    c.klx = (dx * cy - dz * sy) / hl; c.klz = (dx * sy + dz * cy) / hl;
    if (c.kind === 'walker') c.vy = 2.2;
    c.state = 'wander'; c.lunge = 0; c.lost = 0; c.st = 'stalk'; c.stT = 5; c.cool = big ? 14 : 9; c.sting = 3; c.reach = 0;
    if (c.kind === 'orbiter') c.orbR = Math.min(42, c.orbR + 16);
    if (c.kind === 'drifter') { c.vx = dx * 9; c.vy = dy * 9; c.vz = dz * 9; }
    const v = c.sp.voice;
    this.sound.voice({ f: v.f * 1.5, fall: 0.45, ratio: v.ratio * 1.3, depth: v.depth * 2, dur: Math.min(1.4, v.dur) }, 0.6, 0);
    if (c.hits >= tough) { c.dying = c.dieD = c.kind === 'walker' ? 2.6 : 2.2; c.hurt = 0; this.cool = Math.max(this.cool, 7); return 'down'; }
    c.hurt = c.hurtD = big ? 1.1 : c.kind === 'walker' ? 2.6 : 2.0;
    return big ? 'flinch' : 'reel';
  }

  // The animation of being hit (c.hurt) and of going down (c.dying). No thinking happens while it plays.
  reel(c, dt, t, P) {
    const world = this.world, sp = c.sp, down = c.dying > 0;
    if (down) c.dying -= dt; else c.hurt -= dt;
    const e = down ? 0 : Math.max(0, c.hurt / c.hurtD);          // 1 at the moment of the hit, 0 when it has recovered
    const u = down ? 1 - Math.max(0, c.dying) / c.dieD : 0;       // 0 -> 1 as it goes down
    const kd = Math.exp(-3.2 * dt);
    c.kx *= kd; c.kz *= kd; c.ky *= kd;
    c.threat = down ? 0 : 0.3;
    c.hbN = 0;
    if (c.kind === 'walker') {
      const rig = c.rig;
      c.vy -= 20 * dt;
      if (world.move(c, c.kx * dt, c.vy * dt, c.kz * dt, 0.6) & 4) c.vy = 0;
      if (c.y < -30) { c.dead = true; return; }
      const dx = P.x - c.x, dz = P.z - c.z, d = Math.hypot(dx, dz);
      c.spasm = 0.2; // it convulses all the way through
      this.poseWalker(c, dt, t, P, d, dx, dz, down ? 0 : 1.5 * e, false, false, true);
      const r = c.root;
      if (down) {
        // knees first, then all of it, the way it was pushed; then the floor takes it
        const fall = Math.min(1, u * 2.4), f2 = fall * fall, dir = c.klz >= 0 ? 1 : -1;
        r.rotation.x = dir * f2 * 1.5 + Math.sin(t * 46) * 0.05 * (1 - u);
        r.rotation.z += -c.klx * 0.5 * f2;
        r.scale.y *= 1 - 0.25 * fall;
        r.position.y = c.y + 0.12 * f2 - Math.max(0, u - 0.5) * 2 * (sp.height * 0.4 + 0.5);
        for (const A of rig.arms) { A.j[0].rotation.x = -2.6 + Math.sin(t * 9 + A.ph) * 0.5 * (1 - u); A.j[0].rotation.z = A.side * 0.9; A.j[1].rotation.x = -1.3 * (1 - u) + Math.sin(t * 31 + A.ph) * 0.3 * (1 - u); }
        rig.head.rotation.x = -0.8; rig.head.rotation.z = Math.sin(t * 52) * 0.5 * (1 - u);
        const dim = Math.max(0, 1 - u * 1.6), col = sp.eyeCol;
        c.eyeMat.uniforms.uAmbient.value.setRGB(col[0] * dim, col[1] * dim, col[2] * dim);
        if (c.dying <= 0) c.dead = true;
        return;
      }
      // thrown back: bent the way the shot went, arms flung up, head snapped over, in jerks rather than smoothly
      const a = Math.min(1, (1 - e) * 7) * Math.pow(e, 0.7), stp = Math.round(a * 7) / 7;
      r.rotation.x = c.klz * stp * 0.95 + Math.sin(t * 44 + c.seedF) * 0.07 * e;
      r.rotation.z += -c.klx * stp * 0.8;
      r.scale.y *= 1 - 0.18 * stp;
      for (const A of rig.arms) {
        A.j[0].rotation.x += (-2.3 + Math.sin(t * 19 + A.ph) * 0.8 - A.j[0].rotation.x) * e;
        A.j[0].rotation.z = A.side * (0.2 + 0.9 * e + 0.3 * Math.sin(t * 13 + A.ph) * e);
        A.j[1].rotation.x += (-1.0 + Math.sin(t * 27 + A.ph) * 0.7 - A.j[1].rotation.x) * e;
      }
      rig.torso.rotation.x += -c.klz * 0.5 * e;
      rig.head.rotation.x += -1.0 * e * (c.klz < 0 ? 1 : -1) * -1;
      rig.head.rotation.z += Math.sin(t * 47) * 0.7 * e;
      if (c.hurt <= 0) { r.rotation.x = 0; c.spasm = 0; }
      return;
    }
    const big = c.kind === 'leviathan' || c.kind === 'serpent';
    if (c.kind === 'eel' || big) {
      // it knots and thrashes; if that was the last of it, it goes slack and thin and sinks
      if (c.sp.realm === VOID) { c.x += c.kx * dt; c.y += c.ky * dt; c.z += c.kz * dt; }
      else {
        const body = this.body;
        body.x = c.x; body.y = c.y - 0.35; body.z = c.z;
        world.move(body, c.kx * dt, (c.ky - (down ? 0.9 : 0)) * dt, c.kz * dt, 0);
        c.x = body.x; c.y = Math.min(body.y + 0.35, WL - 0.5); c.z = body.z;
      }
      if (!down) c.yaw += Math.sin(t * 17 + c.seedF) * 9 * e * dt;
      this.trailBody(c, dt, down ? t * 0.15 : t * (big ? 3 : 4), big, !down);
      if (down) {
        const thin = Math.max(0.03, 1 - u * u);
        for (const g of c.rig.segs) g.scale.set(thin, thin, 1);
        const dim = Math.max(0, 1 - u * 2), col = sp.eyeCol;
        c.eyeMat.uniforms.uAmbient.value.setRGB(col[0] * dim, col[1] * dim, col[2] * dim);
        c.hbN = 0;
        if (c.dying <= 0) c.dead = true;
      }
      return;
    }
    // the round ones: the bell, the thing on the bottom, the things outside
    const wet = sp.realm === WET, rad = sp.rad || 0.6;
    if (wet && c.kind !== 'angler') {
      const body = this.body;
      body.x = c.x; body.y = c.y - 0.3; body.z = c.z;
      world.move(body, c.kx * dt, (c.ky - (down ? 0.8 : 0)) * dt, c.kz * dt, 0);
      c.x = body.x; c.y = Math.min(body.y + 0.3, WL - 0.6); c.z = body.z;
    } else if (!wet) { c.x += c.kx * dt; c.y += c.ky * dt; c.z += c.kz * dt; }
    const r = c.root, B = c.base, w = down ? 1 - u : e;
    r.position.set(c.x + Math.sin(t * 61) * 0.06 * w, c.y + Math.sin(t * 53) * 0.05 * w, c.z + Math.cos(t * 57) * 0.06 * w);
    if (down) {
      const s = Math.max(0.02, 1 - u * u);
      if (c.kind === 'jelly') r.scale.set(B.x * (1 + 0.5 * u), B.y * s, B.z * (1 + 0.5 * u));       // the bell goes flat
      else if (c.kind === 'angler') r.scale.set(B.x * (1 + 0.2 * u), B.y * s, B.z * (1 + 0.2 * u)); // it settles into the floor
      else { r.scale.set(B.x * s, B.y * s, B.z * s); r.rotation.y += dt * (3 + 22 * u); r.visible = Math.floor(t * 30) % 4 !== 0 || u < 0.4; } // it winds itself up to nothing
      const dim = Math.max(0, 1 - u * 1.5), col = sp.eyeCol;
      c.eyeMat.uniforms.uAmbient.value.setRGB(col[0] * dim, col[1] * dim, col[2] * dim);
      if (c.dying <= 0) c.dead = true;
      return;
    }
    const pulse = 1 + 0.22 * Math.sin(t * 36) * e;
    r.scale.set(B.x * pulse, B.y * (2 - pulse), B.z * pulse);
    if (c.kind === 'angler') { c.rig.jaw.rotation.x = 1.1 * e + 0.1; r.rotation.z = Math.sin(t * 29) * 0.3 * e; }
    else if (c.kind === 'jelly') r.rotation.z = Math.sin(t * 23) * 0.7 * e;
    else { r.rotation.y += dt * 13 * e; r.rotation.x = Math.sin(t * 41) * 0.5 * e; }
    c.box(0, c.x, c.y - rad * 0.85, c.z, rad * 0.85, c.y + rad * 0.85);
    c.hbN = r.visible ? 1 : 0;
    if (c.hurt <= 0) { r.scale.copy(B); r.rotation.z = 0; }
  }

  // nearest hitbox along a ray (each box grown by pad, for the spread of shot); returns { c, t } or null
  rayHit(ox, oy, oz, dx, dy, dz, max, pad = 0) {
    let best = null, bt = max;
    for (const c of this.list) for (let n = 0; n < c.hbN; n++) {
      const b = c.hb[n];
      let t0 = 0, t1 = bt;
      if (c.dying > 0) break;
      const lo = [b.x0 - pad, b.y0 - pad, b.z0 - pad], hi = [b.x1 + pad, b.y1 + pad, b.z1 + pad], o = [ox, oy, oz], d = [dx, dy, dz];
      let ok = true;
      for (let a = 0; a < 3 && ok; a++) {
        if (Math.abs(d[a]) < 1e-9) { if (o[a] < lo[a] || o[a] > hi[a]) ok = false; continue; }
        let ta = (lo[a] - o[a]) / d[a], tb = (hi[a] - o[a]) / d[a];
        if (ta > tb) { const q = ta; ta = tb; tb = q; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) ok = false;
      }
      if (ok && t0 < bt) { bt = t0; best = c; }
    }
    return best ? { c: best, t: bt } : null;
  }

  alert(c, k) { if (this.onAlert) this.onAlert(c, k); }

  // How a walking one arrives, e going 0 -> 1: up through the floor, down from the ceiling,
  // flickering into place, or lying face down and getting up in jerks.
  arriving(c, e, t) {
    const r = c.root, s = 1 - (1 - e) * (1 - e);
    if (c.spawnK === 0) r.position.y = c.y - c.topH * (1 - s);
    else if (c.spawnK === 1) { r.position.y = c.y + 2.6 * (1 - s); r.rotation.x = Math.PI * (1 - s); }
    else if (c.spawnK === 2) {
      r.visible = e > 0.92 || Math.floor(t * 23 + c.seedF) % 3 !== 0;
      r.scale.y *= 1 + (1 - e) * 1.3 * Math.abs(Math.sin(t * 47));
      r.position.x += Math.sin(t * 71) * 0.18 * (1 - e);
    } else r.rotation.x = 1.45 * (1 - Math.floor(e * 6) / 6);
  }

  attack(c, P, amount, vanish) {
    P.hit(amount);
    this.sound.stinger();
    this.sound.voice(c.sp.voice, 0.5, 0);
    if (vanish) { c.dead = true; this.cool = 9; }
  }

  // eyes blink, all at once, and burn brighter when it is coming for you
  eyes(c, dt, t, boost, still) {
    let e = 1;
    if (!still) {
      c.blinkT -= dt;
      if (c.blinkT <= 0) { c.blink = c.kind === 'leviathan' ? 0.7 : 0.13; c.blinkT = 1.5 + Math.random() * 6; }
      if (c.blink > 0) { c.blink -= dt; e = 0.03; }
      else if (boost) e = 1.25 + 0.35 * Math.sin(t * 31 + c.seedF);
    }
    const col = c.sp.eyeCol;
    c.eyeMat.uniforms.uAmbient.value.setRGB(col[0] * e, col[1] * e, col[2] * e);
  }

  trySpawn(P, cam, dir, t) {
    const world = this.world, tmp = this.tmp;
    const a = Math.random() * 6.2832;
    if (P.mode === FLY) {
      const nd = this.count('drifter'), no = this.count('orbiter'), ns = this.count('serpent');
      if (nd + no + ns >= 3) return;
      const slot = !ns && Math.random() < 0.35 ? 2 : nd ? (no ? 2 : 1) : no ? 0 : Math.random() < 0.6 ? 0 : 1;
      if (slot === 2 && ns) return;
      const d = 80 + Math.random() * 40, x = P.x + Math.cos(a) * d, z = P.z + Math.sin(a) * d;
      const info = world.cellInfo(x, z, tmp);
      let y = P.y + (Math.random() - 0.5) * 50;
      if (info.realm !== VOID) { if (P.y > TOP) y = Math.max(y, TOP + 14); else if (P.y < BOT) y = Math.min(y, BOT - 14); else return; }
      this.spawn(this.speciesFor(info.R, VOID, slot), x, y, z);
      return;
    }
    if (P.mode === WALK && Math.random() < 0.22 && this.count('walker') < 2) {
      // now and then one arrives where you can see it happen
      const ya = P.yaw + (Math.random() - 0.5) * 0.9, dd = 9 + Math.random() * 6, sx = P.x - Math.sin(ya) * dd, sz = P.z - Math.cos(ya) * dd;
      const inf = world.cellInfo(sx, sz, tmp);
      if (inf.realm === HALL && !inf.solid && inf.ceil - inf.floor >= 3 && world.los(P.x, P.z, sx, sz) && !world.collides(sx, inf.floor + 0.02, sz, 0.3, 1.0)) {
        const c = this.spawn(this.speciesFor(inf.R, HALL, Math.random() < 0.6 ? 0 : 1), sx, inf.floor + 0.02, sz, true);
        c.yaw = Math.atan2(P.x - sx, P.z - sz);
        this.sound.creak(0); this.alert(c, 0.8);
        return;
      }
    }
    const d = 24 + Math.random() * 26, x = P.x + Math.cos(a) * d, z = P.z + Math.sin(a) * d;
    const info = world.cellInfo(x, z, tmp);
    if (info.solid || info.realm === VOID) return;
    const ci = Math.floor(x / CS), cj = Math.floor(z / CS), cx = (ci + 0.5) * CS, cz = (cj + 0.5) * CS;
    if (info.realm === HALL) {
      if (this.count('walker') >= (P.dist > 600 ? 3 : 2) || info.ceil - info.floor < 2.2) return;
      if (t < 150 && this.gen.nearSpawn(ci, cj, 9)) return;
      const facing = ((cx - P.x) * dir.x + (cz - P.z) * dir.z) / d;
      if (facing > 0.2 && world.los(P.x, P.z, cx, cz)) return;
      if (world.collides(cx, info.floor + 0.02, cz, 0.3, 1.0)) return;
      this.spawn(this.speciesFor(info.R, HALL, Math.random() < 0.6 ? 0 : 1), cx, info.floor + 0.02, cz, true);
    } else {
      const depth = WL - info.floor, top = Math.min(info.ceil, WL);
      if (depth < 2.5 || top - info.floor < 2.5) return;
      let slot, y = info.floor + 0.8 + Math.random() * (top - info.floor - 1.8);
      const lo = info.floor + 0.8, hi = top - 1;
      if (depth > 8 && !this.count('leviathan') && Math.random() < 0.4) slot = 2;
      else if (depth > 4 && this.count('angler') < 2 && Math.random() < 0.25) slot = 3;
      else if (Math.random() < 0.55) { if (this.count('jelly') >= 6) return; slot = 1; }
      else { if (this.count('eel') >= 2) return; slot = 0; }
      const sp = this.speciesFor(info.R, WET, slot);
      if (slot === 3) y = info.floor + sp.rad + 0.25;
      if (world.collides(cx, y, cz, 0.35, 0.7)) return;
      this.spawn(sp, cx, y, cz);
      if (slot === 1) for (let q = 0; q < 2; q++) { // they come three at a time
        const ox = cx + (Math.random() - 0.5) * 4, oz = cz + (Math.random() - 0.5) * 4, oy = clamp(y + (Math.random() - 0.5) * 2, lo, Math.max(lo, hi));
        if (world.cellInfo(ox, oz, tmp).realm === WET && !world.collides(ox, oy, oz, 0.35, 0.7)) this.spawn(sp, ox, oy, oz);
      }
    }
  }

  update(dt, t, P, cam, dir) {
    this.cool -= dt;
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnT = 1.2 + Math.random() * 1.6;
      if (t > this.grace && this.cool <= 0) this.trySpawn(P, cam, dir, t);
    }
    let threat = 0;
    const dyn = this.world.dyn;
    for (let q = this.list.length - 1; q >= 0; q--) {
      const c = this.list[q];
      const d = Math.hypot(c.x - P.x, c.y - P.y, c.z - P.z);
      if (c.dead || d > c.despawn) { c.dispose(); this.list.splice(q, 1); continue; }
      c.threat = 0;
      if (c.hurt > 0 || c.dying > 0) this.reel(c, dt, t, P);
      else if ((c.hbN = 0, c.kind === 'walker')) this.walker(c, dt, t, P, cam, dir);
      else if (c.kind === 'eel' || c.kind === 'leviathan') this.eel(c, dt, t, P);
      else if (c.kind === 'serpent') this.serpent(c, dt, t, P);
      else if (c.kind === 'angler') this.angler(c, dt, t, P);
      else if (c.kind === 'jelly') this.jelly(c, dt, t, P);
      else this.drifter(c, dt, t, P, cam, dir);
      if (c.dead) continue;
      if (!(c.dying > 0)) for (let n = 0; n < c.hbN; n++) dyn.push(c.hb[n]);
      if (c.threat > threat) threat = c.threat;
      // skin picks up the light of wherever it stands, and for an instant the flash of the shot that hit it
      c.hitF = Math.max(0, c.hitF - dt * 5);
      const l = (c.sp.realm === VOID ? 0.05 : this.world.lightAt(c.x, c.z) * 0.5 + 0.015) + c.hitF * 0.55;
      c.mat.uniforms.uAmbient.value.setRGB(l, l, l * 1.05);
      c.pale.uniforms.uAmbient.value.setRGB(l * 1.2 + 0.006, l * 1.2 + 0.006, l * 1.2 + 0.006);
      if (!c.sp.seen && d < 22 && this.observed(c, cam, dir, 22)) {
        c.sp.seen = true; this.seen.add(c.sp.seed);
        if (this.onNote) this.onNote(c.sp.name);
      }
      c.voiceT -= dt;
      if (c.voiceT <= 0) {
        c.voiceT = 7 + Math.random() * 14;
        if (d < 40) this.sound.voice(c.sp.voice, 0.22 * Math.max(0.1, 1 - d / 40), clamp(((c.x - P.x) * Math.cos(P.yaw) - (c.z - P.z) * Math.sin(P.yaw)) / (d + 1), -1, 1));
      }
    }
    return threat;
  }

  // ---- things that walk the dry floors -------------------------------------
  walker(c, dt, t, P, cam, dir) {
    const world = this.world, sp = c.sp;
    const dx = P.x - c.x, dz = P.z - c.z, d = Math.hypot(dx, dz);
    if (c.still > 0) { // put there by a scare: stands, reaching, eyes burning, and does nothing else
      c.still -= dt;
      this.poseWalker(c, dt, t, P, d, dx, dz, 0, true, false, false);
      c.threat = 1;
      if (c.still <= 0) c.dead = true;
      return;
    }
    if (c.spawnT > 0) { // still arriving: it cannot be hurried and does not yet come for you
      c.spawnT -= dt;
      this.poseWalker(c, dt, t, P, d, dx, dz, 0, true, false, false);
      if (c.spawnT > 0) this.arriving(c, 1 - c.spawnT / c.spawnD, t);
      else { c.root.rotation.x = 0; c.root.visible = true; this.sound.voice(sp.voice, 0.25 * Math.max(0.2, 1 - d / 30), 0); }
      c.threat = d < 20 ? 0.5 * (1 - d / 20) : 0;
      return;
    }
    const seen = this.observed(c, cam, dir, 55);
    const reach = P.mode === WALK;
    let speed = 0, chase = false, frozen = false;
    c.threat = d < 26 ? (1 - d / 26) * (c.state === 'chase' || sp.behavior === 0 ? 1 : 0.55) : 0;

    if (sp.behavior === 0) { // only moves while unobserved
      if (seen) { frozen = true; if (d < 14) P.dread(dt * 2.2); }
      else if (reach && d < 60) { speed = sp.speed * 1.2; chase = true; }
    } else if (sp.behavior === 1) { // hunts by sight; you are harder to see when you keep low
      if (c.state === 'wander') {
        if (reach && d < sp.sight * (P.flash ? 1.4 : 1) * (P.crouched ? 0.55 : 1) && world.los(c.x, c.z, P.x, P.z)) {
          c.state = 'chase'; c.lost = 0; this.alert(c, 1);
          this.sound.voice(sp.voice, 0.6 * Math.max(0.25, 1 - d / 40), 0);
        }
      } else {
        chase = true; speed = sp.speed + 1.1;
        c.lost = world.los(c.x, c.z, P.x, P.z) ? 0 : c.lost + dt;
        if (c.lost > 7 || !reach) c.state = 'wander';
      }
    } else { // sits folded and waits; comes for you if you come too near
      if (c.lunge > 0) { c.lunge -= dt; chase = reach; speed = sp.speed * 1.45; }
      else if (reach && d < 5.5 && world.los(c.x, c.z, P.x, P.z)) { c.lunge = 4; this.sound.voice(sp.voice, 0.6, 0); this.alert(c, 1); }
      else if (!seen) {
        c.tele -= dt;
        if (c.tele <= 0) { c.tele = 9 + Math.random() * 14; this.relocate(c, P, dir); }
      } else if (d < 18) P.dread(dt * 1.3);
    }

    let tx = c.x, tz = c.z;
    const ci = Math.floor(c.x / CS), cj = Math.floor(c.z / CS);
    if (chase) {
      c.pathT -= dt;
      if (c.pathT <= 0) {
        c.pathT = 0.3;
        c.dirStep = world.pathStep(ci, cj, Math.floor(P.x / CS), Math.floor(P.z / CS), 0);
        c.pci = ci; c.pcj = cj;
      }
      if (c.dirStep >= 0) { tx = (c.pci + DX[c.dirStep] + 0.5) * CS; tz = (c.pcj + DZ[c.dirStep] + 0.5) * CS; }
      else if (d < CS * 1.5 || c.dirStep === -2) { tx = P.x; tz = P.z; }
      else speed = 0;
    } else if (!frozen && sp.behavior === 1) {
      c.wt -= dt;
      if (c.wt <= 0) {
        c.wt = 2 + Math.random() * 4;
        const dd = Math.floor(Math.random() * 4);
        if (Math.random() < 0.7 && world.passable(ci, cj, dd, 0)) { c.wx = (ci + DX[dd] + 0.5) * CS; c.wz = (cj + DZ[dd] + 0.5) * CS; c.wspeed = 1.1; }
        else c.wspeed = 0;
      }
      tx = c.wx; tz = c.wz; speed = c.wspeed;
    }

    const ddx = tx - c.x, ddz = tz - c.z, dl = Math.hypot(ddx, ddz);
    let moving = 0;
    c.vy -= 20 * dt;
    if (speed > 0 && dl > 0.08) {
      const fl = world.move(c, (ddx / dl) * speed * dt, c.vy * dt, (ddz / dl) * speed * dt, 0.6);
      if (fl & 4) c.vy = 0;
      c.yaw = turn(c.yaw, Math.atan2(ddx, ddz), 1 - Math.exp(-8 * dt));
      moving = speed;
    } else {
      if (world.move(c, 0, c.vy * dt, 0, 0) & 4) c.vy = 0;
      if (!frozen && sp.behavior !== 2) c.yaw = turn(c.yaw, Math.atan2(dx, dz), 1 - Math.exp(-1.5 * dt));
    }
    if (c.y < -30) { c.dead = true; return; }

    this.poseWalker(c, dt, t, P, d, dx, dz, moving, chase, frozen, seen);
    if (reach && !frozen && this.touch(c, P, 0.22)) this.attack(c, P, 42, true);
  }

  poseWalker(c, dt, t, P, d, dx, dz, moving, chase, frozen, seen) {
    const sp = c.sp, rig = c.rig;
    const info = this.world.cellInfo(c.x, c.z, this.tmp);
    const fit = clamp((info.ceil - info.floor - 0.06) / (sp.height * 1.02), 0.42, 1);
    c.fit += (fit - c.fit) * (1 - Math.exp(-4 * dt));
    // the ones that wait sit folded small until you are close; then they stand, slowly, all the way up
    if (sp.behavior === 2) {
      const up = c.lunge > 0 || d < 11 ? 1 : 0.45;
      c.stand += (up - c.stand) * (1 - Math.exp(-(up > c.stand ? 1.1 : 0.4) * dt));
    }
    const look = wrap(Math.atan2(dx, dz) - c.yaw);
    if (sp.behavior === 0 && seen && !c.wasSeen) { c.pose = newPose(c, look); if (d < 14) this.alert(c, 0.6); } // caught: a new attitude each time
    c.wasSeen = seen;
    const sY = c.fit * (Math.round(c.stand * 6) / 6) * (frozen && c.pose ? c.pose.crouch : 1);

    // short convulsions
    c.spasmT -= dt;
    if (c.spasmT <= 0) { c.spasmT = 1.2 + Math.random() * 8 * (1.3 - sp.twitch); c.spasm = 0.15 + Math.random() * 0.3; }
    const sz = !frozen && c.spasm > 0;
    if (sz) c.spasm -= dt;
    const j = k => (sz ? Math.sin(t * 83 + k * 12.7 + c.seedF) * 0.55 : 0);

    c.root.position.set(c.x + j(11) * 0.05, c.y, c.z + j(12) * 0.05);
    c.root.rotation.y = c.yaw;
    c.root.rotation.z = frozen ? 0 : 0.04 * Math.sin(t * 0.45 + c.seedF);
    c.root.scale.set(1, sY, 1);
    c.box(0, c.x, c.y, c.z, c.hr, c.y + c.topH * sY);
    c.hbN = 1;
    this.eyes(c, dt, t, chase, frozen);

    if (frozen) {
      const p = c.pose;
      if (p) {
        rig.torso.rotation.x = sp.hunch + p.torsoX; rig.torso.rotation.z = p.torsoZ;
        for (let a = 0; a < rig.arms.length; a++) {
          const A = rig.arms[a], pa = p.arms[a];
          A.j[0].rotation.x = -sp.hunch + pa[0]; A.j[1].rotation.x = pa[1];
          for (const f of A.fingers) f.rotation.x = pa[2];
        }
        rig.head.rotation.set(0, p.headY, p.headZ);
      }
      return;
    }

    // gait, with a hitch in it
    c.gait += (dt * (0.6 + moving * 1.5)) / (rig.legLen * 0.8 + 0.35);
    const amp = moving > 0 ? 0.3 + 0.2 * Math.min(1, moving / 4) : 0.03, limp = sp.asym > 0 ? 0.55 : 0.18;
    for (const L of rig.legs) {
      const ph = c.gait + L.ph + limp * Math.sin(c.gait + L.ph);
      L.j[0].rotation.x = L.base - Math.sin(ph) * amp + j(13 + L.ph) * 0.3;
      L.j[1].rotation.x = Math.max(0, Math.sin(ph + 0.9)) * amp * 1.8;
    }
    const breathe = Math.sin(t * 1.5 + c.seedF);
    rig.pelvis.position.y = rig.legLen * (0.97 - 0.035 * Math.abs(Math.sin(c.gait)) * (moving > 0 ? 1 : 0));
    rig.torso.rotation.x = sp.hunch + (moving > 0 ? 0.1 * Math.abs(Math.sin(c.gait)) : 0) + 0.03 * breathe + (chase ? 0.25 : 0) + j(1) * 0.4;
    rig.torso.rotation.z = Math.sin(c.gait) * 0.07 + 0.05 * Math.sin(t * 0.5 + c.seedF) + j(2) * 0.3;
    rig.body.scale.z = rig.bodyZ * (1 + 0.12 * breathe);

    // arms hang; they rise toward you while you are looking somewhere else
    const want = chase || (!seen && d < 16 && sp.behavior !== 1) ? 1 : 0;
    c.reach += (want - c.reach) * (1 - Math.exp(-(want ? 1.2 : 4) * dt));
    const aim = clamp(Math.atan2(P.y + 1.3 - (c.y + c.eyeH * sY * 0.8), d + 0.3), -0.5, 0.7);
    for (const A of rig.arms) {
      const hang = -sp.hunch + Math.sin(t * 0.7 + A.ph) * 0.1;
      const up = -sp.hunch - 1.5 - aim + Math.sin(t * 2.3 + A.ph) * 0.08;
      A.j[0].rotation.x = hang + (up - hang) * c.reach + j(3 + A.ph);
      A.j[0].rotation.z = A.side * (0.12 + 0.25 * c.reach * Math.sin(t * 0.9 + A.ph));
      A.j[1].rotation.x = -0.12 - c.reach * (0.25 + (chase ? 0.35 * Math.sin(t * 7 + A.ph) : 0.1 * Math.sin(t * 1.3 + A.ph))) + j(5 + A.ph) * 0.6;
      if (A.j[2]) A.j[2].rotation.x = -0.2 + Math.sin(t * 1.1 + A.ph) * 0.1 - c.reach * 0.2;
      for (let f = 0; f < A.fingers.length; f++) A.fingers[f].rotation.x = 0.15 + c.reach * (0.5 + 0.5 * Math.sin(t * (3 + f) + A.ph)) + j(9 + f);
    }

    // the neck of a waiting one lengthens toward you the closer you are
    const ns = sp.behavior === 2 && d < 20 && c.lunge <= 0 ? 1 + 1.8 * Math.max(0, 1 - d / 20) : 1;
    c.neckS += (ns - c.neckS) * (1 - Math.exp(-0.8 * dt));
    const nl = rig.nl * c.neckS;
    rig.neckMesh.scale.y = nl; rig.neckMesh.position.y = nl; rig.head.position.y = nl + rig.headOff;
    // the head keeps you in view, further round than a neck should go; it tilts slowly, then snaps
    const lim = sp.behavior === 1 ? 1.4 : 3.1;
    rig.head.rotation.y = clamp(look, -lim, lim);
    c.headT -= dt;
    if (c.headT <= 0) { c.headT = 1.5 + Math.random() * 5; c.headTiltTarget = (Math.random() * 2 - 1) * 1.15; c.headTiltK = Math.random() < 0.4 ? 30 : 0.7; }
    c.headTilt += (c.headTiltTarget - c.headTilt) * (1 - Math.exp(-c.headTiltK * dt));
    rig.head.rotation.z = c.headTilt + (chase ? Math.sin(t * 38) * 0.22 : 0) + j(7);
    rig.head.rotation.x = clamp(Math.atan2(c.y + c.eyeH * sY - (P.y + 1.6), d + 0.5), -0.6, 0.6) + j(8) * 0.5;
  }

  relocate(c, P, dir) {
    const world = this.world;
    for (let k = 0; k < 8; k++) {
      const a = Math.random() * 6.2832, d = 8 + Math.random() * 10;
      const x = P.x + Math.cos(a) * d, z = P.z + Math.sin(a) * d;
      const info = world.cellInfo(x, z, this.tmp);
      if (info.realm !== HALL || info.solid) continue;
      const cx = (Math.floor(x / CS) + 0.5) * CS, cz = (Math.floor(z / CS) + 0.5) * CS;
      const facing = ((cx - P.x) * dir.x + (cz - P.z) * dir.z) / d;
      if (facing > 0 && world.los(P.x, P.z, cx, cz)) continue;
      if (world.collides(cx, info.floor + 0.02, cz, 0.3, 1.0)) continue;
      c.x = cx; c.z = cz; c.y = info.floor + 0.02; c.vy = 0; c.stand = 0.45;
      return;
    }
  }

  // ---- things that swim ----------------------------------------------------
  eel(c, dt, t, P) {
    const world = this.world, sp = c.sp, big = c.kind === 'leviathan';
    const py = P.y + 0.9, dx = P.x - c.x, dy = py - c.y, dz = P.z - c.z, d = Math.hypot(dx, dy, dz);
    c.cool -= dt;
    const hunting = !big && P.mode === SWIM && d < 18 && c.cool <= 0;
    c.threat = big ? (d < 30 ? 1 - d / 30 : 0) : hunting ? Math.max(0.3, 1 - d / 18) : 0;
    let tx, ty, tz, speed;
    const ci = Math.floor(c.x / CS), cj = Math.floor(c.z / CS);
    if (hunting) { // it circles, making up its mind; then it comes straight in
      c.stT -= dt;
      if (c.stT <= 0) {
        if (c.st === 'dart') { c.st = 'stalk'; c.stT = 2.5 + Math.random() * 2; }
        else { c.st = 'dart'; c.stT = 1.7; this.sound.voice(sp.voice, 0.3, 0); this.alert(c, 0.8); }
      }
      if (c.st === 'dart') { tx = P.x; ty = py; tz = P.z; speed = sp.speed * 1.5; }
      else { const a = t * 0.6 + c.seedF; tx = P.x + Math.cos(a) * 5.5; ty = py + Math.sin(a * 0.7) * 1.5; tz = P.z + Math.sin(a) * 5.5; speed = sp.speed * 0.9; }
    }
    else {
      c.wt -= dt;
      if (c.wt <= 0 || Math.hypot(c.wx - c.x, c.wz - c.z) < 1) {
        c.wt = 5 + Math.random() * 8;
        for (let k = 0; k < 6; k++) {
          const a = Math.random() * 6.2832, r = 6 + Math.random() * 20;
          const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r, info = world.cellInfo(x, z, this.tmp);
          if (info.realm !== WET || info.solid || info.floor > WL - (big ? 5.5 : 2.5)) continue;
          const top = Math.min(info.ceil, WL) - (big ? 2 : 0.6);
          c.wx = x; c.wz = z; c.wy = info.floor + (big ? 2 : 0.6) + Math.random() * Math.max(0.1, top - info.floor - (big ? 2 : 0.6));
          break;
        }
      }
      if (big && P.flash && P.mode === SWIM && d < 38) { c.wx = P.x; c.wy = py; c.wz = P.z; c.wt = 2; } // the big one turns toward a light
      tx = c.wx; ty = c.wy; tz = c.wz; speed = big ? sp.speed : 1.1;
    }
    c.pathT -= dt;
    if (c.pathT <= 0) {
      c.pathT = 0.4;
      c.dirStep = world.pathStep(ci, cj, Math.floor(tx / CS), Math.floor(tz / CS), 1);
      c.pci = ci; c.pcj = cj;
    }
    let gx = tx, gz = tz;
    if (c.dirStep >= 0) { gx = (c.pci + DX[c.dirStep] + 0.5) * CS; gz = (c.pcj + DZ[c.dirStep] + 0.5) * CS; }
    const info = world.cellInfo(c.x, c.z, this.tmp);
    const lo = info.floor + (big ? sp.rad + 0.3 : 0.4), hi = Math.min(info.ceil, WL) - (big ? sp.rad + 0.3 : 0.5);
    const gy = clamp(ty, lo, Math.max(lo, hi));
    const wx = gx - c.x, wy = gy - c.y, wz = gz - c.z, wl = Math.hypot(wx, wy, wz) || 1;
    const k = 1 - Math.exp(-2.4 * dt);
    c.vx += ((wx / wl) * speed - c.vx) * k; c.vy += ((wy / wl) * speed - c.vy) * k; c.vz += ((wz / wl) * speed - c.vz) * k;
    const body = this.body;
    body.x = c.x; body.y = c.y - 0.35; body.z = c.z;
    world.move(body, c.vx * dt, c.vy * dt, c.vz * dt, 0);
    c.x = body.x; c.y = Math.min(body.y + 0.35, WL - 0.5); c.z = body.z;
    c.yaw = Math.atan2(c.vx, c.vz);

    this.trailBody(c, dt, t, big, hunting && c.st === 'dart');

    if (big) {
      if (d < sp.len) P.dread(dt * 3);
      c.sting -= dt;
      if (c.sting <= 0 && this.touch(c, P, 0.25)) { P.hit(18); this.sound.stinger(0.7); c.sting = 1.5; }
    } else if (hunting && this.touch(c, P, 0.2, 0, 3)) { this.attack(c, P, 34, false); c.cool = 9; c.wt = 0; }
  }

  // a long body following the path its head took: used by everything long, in water or out
  trailBody(c, dt, t, big, biting) {
    const sp = c.sp;
    // the body follows the path the head took; a slow wave of swelling runs down it
    const rig = c.rig, tr = rig.trail, h = tr[0];
    if (Math.hypot(c.x - h.x, c.y - h.y, c.z - h.z) >= rig.gap) { const p = tr.pop(); p.x = c.x; p.y = c.y; p.z = c.z; tr.unshift(p); }
    const sideX = Math.cos(c.yaw), sideZ = -Math.sin(c.yaw), n = rig.segs.length;
    let px = c.x + Math.sin(c.yaw), pY = c.y, pz = c.z + Math.cos(c.yaw);
    const whip = biting ? 1.8 : 1;
    for (let i = 0; i < n; i++) {
      const g = rig.segs[i], p = i === 0 ? c : tr[Math.min(tr.length - 1, i * 2)];
      const w = Math.sin(t * (big ? 0.9 : 3.2) - i * 0.55) * sp.wave * (i / n) * (big ? 1.6 : 0.5) * whip;
      g.position.set(p.x + sideX * w, p.y, p.z + sideZ * w);
      g.lookAt(px, pY, pz);
      g.rotateZ(Math.sin(t * (big ? 0.5 : 1.7) - i * 0.4) * (big ? 0.25 : 0.6)); // it rolls as it goes
      const sw = 1 + (big ? 0.14 : 0.08) * Math.sin(t * (big ? 0.8 : 2.2) - i * 0.5);
      rig.meshes[i].scale.x = g.userData.rad * sw; rig.meshes[i].scale.y = g.userData.rad * 0.9 * sw;
      px = g.position.x; pY = g.position.y; pz = g.position.z;
      const half = Math.max(0.14, g.userData.rad * 0.9);
      c.box(i, px, pY - half, pz, half, pY + half);
    }
    c.hbN = n;
    for (const T of rig.tend) for (let q = 0; q < T.j.length; q++) {
      T.j[q].rotation.x = 0.5 + Math.sin(t * 1.3 - q * 0.7 + T.ph) * 0.3;
      T.j[q].rotation.z = Math.cos(t * 1.1 - q * 0.6 + T.ph) * 0.25;
    }
    if (rig.jawU) { // the mouth
      const open = biting ? 0.55 + 0.25 * Math.sin(t * 14) : 0.05 + 0.04 * Math.sin(t * 1.3 + c.seedF);
      rig.jawU.rotation.x = -open; rig.jawL.rotation.x = open;
    }
    for (const f of rig.fins) f.m.rotation.z = f.side * 0.35 * Math.sin(t * (big ? 1.1 : 3) + f.ph);
    this.eyes(c, dt, t, biting, false);
  }

  // In the water: something on the bottom holding up a light.
  angler(c, dt, t, P) {
    const sp = c.sp, rig = c.rig, py = P.y + 0.9, dx = P.x - c.x, dz = P.z - c.z, dh = Math.hypot(dx, dz);
    if (dh < 14) c.yaw = turn(c.yaw, Math.atan2(dx, dz), 1 - Math.exp(-0.8 * dt)); // it turns to face you, slowly
    c.root.position.set(c.x, c.y, c.z); c.root.rotation.y = c.yaw;
    for (let q = 0; q < rig.stalk.length; q++) { rig.stalk[q].rotation.x = 0.18 + Math.sin(t * 0.8 - q * 0.6) * 0.1; rig.stalk[q].rotation.z = Math.cos(t * 0.6 - q * 0.5) * 0.1; }
    rig.lure.scale.setScalar(0.13 * (1 + 0.18 * Math.sin(t * 2.1 + c.seedF)));
    const lx = c.x + Math.sin(c.yaw) * (sp.rad * 0.5 + sp.stalk * 0.75), ly = c.y + sp.rad * 0.7 + sp.stalk * 0.55, lz = c.z + Math.cos(c.yaw) * (sp.rad * 0.5 + sp.stalk * 0.75);
    c.snap -= dt; c.sting -= dt;
    const close = Math.hypot(P.x - lx, py - ly, P.z - lz) < 1.5 || Math.hypot(dx, py - c.y, dz) < sp.rad + 1.1;
    if (close && c.sting <= 0 && P.mode === SWIM) { c.snap = 0.6; c.sting = 4; this.attack(c, P, 32, false); }
    rig.jaw.rotation.x = c.snap > 0 ? 1.1 * Math.min(1, c.snap * 4) : 0.1 + 0.05 * Math.sin(t * 0.9);
    c.box(0, c.x, c.y - sp.rad * 0.8, c.z, sp.rad * 0.8, c.y + sp.rad * 0.8);
    c.hbN = 1;
    c.threat = dh < 4 ? 0.25 : 0; // it gives almost no warning
    this.eyes(c, dt, t, false, true);
  }

  // In the outside: something very long that goes round and round the point its district attends to.
  serpent(c, dt, t, P) {
    const sp = c.sp, py = P.y + 1.2, dx = P.x - c.x, dy = py - c.y, dz = P.z - c.z, d = Math.hypot(dx, dy, dz);
    const flying = P.mode === FLY;
    c.cool -= dt;
    const hunting = flying && d < 45 && c.cool <= 0;
    let tx, ty, tz, speed;
    if (hunting) {
      c.stT -= dt;
      if (c.stT <= 0) {
        if (c.st === 'dart') { c.st = 'stalk'; c.stT = 3 + Math.random() * 3; }
        else { c.st = 'dart'; c.stT = 2.2; this.sound.voice(sp.voice, 0.35, 0); this.alert(c, 0.9); }
      }
      if (c.st === 'dart') { tx = P.x; ty = py; tz = P.z; speed = sp.speed * 1.7; }
      else { const a = t * 0.35 + c.seedF; tx = P.x + Math.cos(a) * 14; ty = py + Math.sin(a * 0.8) * 5; tz = P.z + Math.sin(a) * 14; speed = sp.speed; }
    } else {
      if (!c.home) { const R = this.gen.nearestFocus(c.x, c.z, () => true); c.home = R ? [R.sx * CS, R.fy, R.sz * CS] : [c.x, c.y, c.z]; }
      const a = t * 0.12 + c.seedF;
      tx = c.home[0] + Math.cos(a) * 26; ty = c.home[1] + 6 + Math.sin(a * 1.7) * 8; tz = c.home[2] + Math.sin(a) * 26; speed = sp.speed * 0.6;
    }
    const wx = tx - c.x, wy = ty - c.y, wz = tz - c.z, wl = Math.hypot(wx, wy, wz) || 1, k = 1 - Math.exp(-1.2 * dt);
    c.vx += ((wx / wl) * speed - c.vx) * k; c.vy += ((wy / wl) * speed - c.vy) * k; c.vz += ((wz / wl) * speed - c.vz) * k;
    c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
    c.yaw = Math.atan2(c.vx, c.vz);
    c.threat = hunting ? Math.max(0.3, 1 - d / 45) : d < 30 ? 0.2 : 0;
    this.trailBody(c, dt, t, true, hunting && c.st === 'dart');
    if (flying && c.cool <= 0 && this.touch(c, P, 0.3, 0, 3)) { this.attack(c, P, 36, false); c.cool = 8; c.st = 'stalk'; c.stT = 4; }
  }

  jelly(c, dt, t, P) {
    const world = this.world, sp = c.sp;
    const dx = P.x - c.x, dz = P.z - c.z, dh = Math.hypot(dx, dz);
    const info = world.cellInfo(c.x, c.z, this.tmp);
    if (info.realm !== WET) { c.dead = true; return; }
    const lo = info.floor + sp.tlen * 0.5 + 0.5, hi = Math.min(info.ceil, WL) - 0.7;
    const gy = lo + (0.5 + 0.5 * Math.sin(t * 0.11 + sp.seed % 7)) * Math.max(0, hi - lo);
    const lit = P.flash && dh < 26; // a light brings them
    const near = P.mode === SWIM && (dh < 15 || lit) && dh > 0.1, close = near ? Math.max(0, 1 - dh / 7) : 0;
    const pulse = Math.sin(t * (1.6 + 2.2 * close) + (sp.seed % 5)); // it beats faster when you are close
    c.vy += ((gy - c.y) * 0.3 + Math.max(0, pulse) * 0.25 - c.vy) * (1 - Math.exp(-1.5 * dt));
    const js = sp.speed * (lit ? 2.2 : 1);
    c.vx += ((near ? (dx / dh) * js : 0) - c.vx) * dt; c.vz += ((near ? (dz / dh) * js : 0) - c.vz) * dt;
    const body = this.body;
    body.x = c.x; body.y = c.y - 0.3; body.z = c.z;
    world.move(body, c.vx * dt, c.vy * dt, c.vz * dt, 0);
    c.x = body.x; c.y = Math.min(body.y + 0.3, WL - 0.6); c.z = body.z;
    c.box(0, c.x, c.y - sp.rad * 0.35, c.z, sp.rad * 0.85, c.y + sp.rad * 0.6);
    c.hbN = 1;
    c.sting -= dt;
    const py = P.y + 0.9;
    if (c.sting <= 0 && ((dh < sp.rad + 0.5 && py < c.y + 0.6 && py > c.y - sp.tlen - 0.3) || this.touch(c, P, 0.1))) { P.hit(13); this.sound.stinger(0.5); c.sting = 2.5; }
    c.threat = dh < 6 && Math.abs(py - c.y) < sp.tlen + 2 ? 0.3 : 0;
    c.root.position.set(c.x, c.y, c.z);
    const rig = c.rig, s = 1 + pulse * 0.12;
    rig.bell.scale.set(sp.rad * (2 - s), sp.rad * 0.6 * s, sp.rad * (2 - s));
    rig.core.scale.setScalar(sp.rad * (0.2 + 0.06 * pulse));
    rig.inner.scale.y = sp.rad * 0.75 * (2 - s);
    // the tendrils lean toward you, each joint a little more than the last
    const ux = near ? dx / dh : 0, uz = near ? dz / dh : 0, lean = close * 0.28;
    for (const T of rig.tend) for (let q = 0; q < T.j.length; q++) {
      T.j[q].rotation.x = Math.sin(t * 0.9 - q * 0.8 + T.ph) * 0.22 - uz * lean;
      T.j[q].rotation.z = Math.cos(t * 0.7 - q * 0.7 + T.ph) * 0.22 + ux * lean;
    }
    this.eyes(c, dt, t, close > 0.3, false);
  }

  // ---- things in the outside -----------------------------------------------
  open(x, y, z, rad) {
    return this.world.cellInfo(x, z, this.tmp).realm === VOID || y - rad > TOP || y + rad < BOT;
  }

  drifter(c, dt, t, P, cam, dir) {
    const sp = c.sp, orb = c.kind === 'orbiter';
    const py = P.y + 1.2;
    const flying = P.mode === FLY;
    let near = 0;
    if (orb) {
      // keeps its distance while you look at it. closes in when you do not.
      const seen = this.observed(c, cam, dir, 90);
      c.orbR += (seen || !flying ? 2.2 : -0.9) * dt;
      c.orbR = clamp(c.orbR, 2.6, 42);
      c.orbA += dt * 0.45 * (sp.seed & 1 ? 1 : -1) * (seen ? 0.15 : 1);
      c.x = P.x + Math.cos(c.orbA) * c.orbR; c.z = P.z + Math.sin(c.orbA) * c.orbR;
      c.y = py + c.orbH * (c.orbR / 42);
      if (flying && c.orbR <= 3) { this.attack(c, P, 30, false); c.orbR = 40; }
      c.threat = flying && c.orbR < 30 ? (1 - c.orbR / 30) * 0.9 : 0;
      near = Math.max(0, 1 - c.orbR / 20);
      c.lost = flying ? 0 : c.lost + dt;
      if (c.lost > 5) { c.dead = true; return; }
      c.root.visible = this.open(c.x, c.y, c.z, 1.5);
    } else {
      const dx = P.x - c.x, dy = py - c.y, dz = P.z - c.z, d = Math.hypot(dx, dy, dz) || 1;
      const sp2 = flying ? sp.speed : 0.4, k = 1 - Math.exp(-0.8 * dt);
      c.vx += ((dx / d) * sp2 - c.vx) * k; c.vy += ((dy / d) * sp2 - c.vy) * k; c.vz += ((dz / d) * sp2 - c.vz) * k;
      const nx = c.x + c.vx * dt, nz = c.z + c.vz * dt, ny = c.y + c.vy * dt;
      if (this.open(nx, ny, nz, sp.rad)) { c.x = nx; c.z = nz; c.y = ny; }
      else if (this.open(c.x, ny, c.z, sp.rad)) c.y = ny;
      if (d < 32) { P.dread(dt * (32 - d) * 0.22); c.threat = 1 - d / 32; }
      near = Math.max(0, 1 - d / 30);
    }
    const half = sp.rad * 0.85;
    c.box(0, c.x, c.y - half, c.z, half, c.y + half);
    c.hbN = c.root.visible ? 1 : 0;
    if (!orb && flying && this.touch(c, P, 0.5)) { this.attack(c, P, 45, true); return; }

    // it breathes; it shivers; the nearer you are the wider and faster the arms go
    c.spasmT -= dt;
    if (c.spasmT <= 0) { c.spasmT = 2 + Math.random() * 6; c.spasm = 0.3 + Math.random() * 0.4; }
    const sz = c.spasm > 0 ? (c.spasm -= dt, 1) : 0;
    c.root.position.set(c.x, c.y, c.z);
    c.root.rotation.y += dt * (0.1 + 0.5 * near);
    c.root.rotation.x = Math.sin(t * 0.07) * 0.3 + (sz ? Math.sin(t * 61) * 0.08 : 0);
    c.root.rotation.z = sz ? Math.sin(t * 73) * 0.08 : 0;
    c.rig.core.scale.setScalar(sp.rad * (1 + 0.06 * Math.sin(t * 1.1 + c.seedF) + 0.05 * near * Math.sin(t * 9)));
    const amp = 0.3 + 0.45 * near, sp3 = 0.5 + 2.5 * near;
    for (const A of c.rig.arms) for (let q = 0; q < A.j.length; q++) {
      A.j[q].rotation.x = Math.sin(t * sp3 - q * 0.6 + A.ph) * amp + (sz ? Math.sin(t * 47 + q + A.ph) * 0.25 : 0);
      A.j[q].rotation.z = Math.cos(t * sp3 * 0.8 - q * 0.5 + A.ph) * amp;
    }
    const rg = c.rig;
    rg.halo.rotation.y += dt * (0.4 + 2 * near); rg.halo2.rotation.y -= dt * (0.25 + 1.2 * near);
    rg.halo2.rotation.z = 0.6 + 0.2 * Math.sin(t * 0.3 + c.seedF);
    rg.look.lookAt(P.x, py, P.z);                                              // the eye is always turned to you
    rg.iris.scale.y = sp.rad * (0.04 + 0.34 * Math.min(1, near * 1.6));        // and opens as you come nearer
    this.eyes(c, dt, t, near > 0.4, false);
  }
}
