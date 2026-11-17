// Streams chunks around the player: asks the generator what is there, bakes
// light by flood-filling it through open edges, and builds the meshes.
// Also answers collision, line-of-sight and path queries.
import * as THREE from 'three';
import { CS, CN, CHUNK, WL, HALL, WET, VOID, OPEN_HW, OPEN_H, FAR, TOP, BOT, pillarSize } from './gen.js';
import { rand01 } from './nn.js';
import { MB, QL, QD, QT, QA, setFlat } from './meshbuilder.js';
import { emitProp, makeDynProp, updateDynProp } from './props.js';
import { makeItemMesh } from './items.js';

const M = 7, G = CN + 2 * M, GG = G * G, T = 0.08;
const gRealm = new Uint8Array(GG), gSolid = new Uint8Array(GG), gWE = new Uint8Array(GG), gWS = new Uint8Array(GG);
const gLight = new Uint8Array(GG), gPillar = new Uint8Array(GG);
const gFloor = new Float32Array(GG), gCeil = new Float32Array(GG);
const gLs = new Float32Array(GG), gLf = new Float32Array(GG), gPf = new Float32Array(GG);
const gReg = new Array(GG);
const cS = new Float32Array(GG * 4), cF = new Float32Array(GG * 4);
const G1 = G + 1, cT = new Float32Array(G1 * G1 * 15); // blended district colours at cell corners
const cReg = new Array(G1 * G1 * 9), cW = new Float32Array(G1 * G1 * 9);   // which districts meet at each corner, and how much of each
const ovR = new Array(GG), ovA = new Float32Array(GG * 4);                 // per cell: the neighbouring district laid over it, and its opacity at each corner
let TR = null;                                                             // set while an overlay layer is being lit
let TK = 0;                                            // which surface is being lit: 0 wall, 1 floor, 2 ceiling, 3 tile
const tr = v => (v < 0.4 ? 0.4 : v > 2.5 ? 2.5 : v);
const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
const PR = 18, PW = PR * 2 + 1;
const pVis = new Int8Array(PW * PW), pQ = new Int16Array(PW * PW);
const L3 = [0, 0, 0];

const blocked = c => gSolid[c] || gRealm[c] === VOID;

// neighbour reachable from cell c through an edge with no wall, or -1
function openTo(c, dx, dz) {
  const n = c + dx + dz * G;
  if (blocked(n)) return -1;
  const w = dx === 1 ? gWE[c] : dx === -1 ? gWE[n] : dz === 1 ? gWS[c] : gWS[n];
  return w === 0 ? n : -1;
}

function ambientAt(c, y, out) {
  const R = gReg[c];
  if (gRealm[c] === WET) {
    const open = gCeil[c] > WL;
    if (y < WL) {
      const wa = R.dark ? 0.002 : open ? 0.3 * Math.exp((y - WL) * 0.16) + 0.012 : 0.035;
      out[0] = 0.22 * wa; out[1] = 0.78 * wa; out[2] = 0.74 * wa;
      return open && !R.dark ? 1 : 0;
    }
    if (R.dark) { out[0] = out[1] = out[2] = 0; return 0; }
    out[0] = 0.02; out[1] = 0.045; out[2] = 0.045;
    return 0;
  }
  out[0] = R.amb[0]; out[1] = R.amb[1]; out[2] = R.amb[2];
  return 0;
}

// light for vertex vi: cell c, corner q (0:-x-z 1:+x-z 2:-x+z 3:+x+z), height y
function LV(vi, c, q, y, mul) {
  const R = gReg[c], dy = gCeil[c] - y, att = mul / (1 + 0.02 * dy * dy);
  const s = cS[c * 4 + q] * att, f = cF[c * 4 + q] * att;
  const caust = ambientAt(c, y, L3);
  const o = vi * 3, p = vi * 4;
  // light colour and surface tint come from the corner, where neighbouring districts are mixed
  const t = ((c % G) + (q & 1) + (((c / G) | 0) + (q >> 1)) * G1) * 15, k = t + TK * 3;
  const Ro = TR || R, own = TK === 0 ? Ro.wallAvg : TK === 1 ? Ro.floorC : TK === 2 ? Ro.ceilC : Ro.tileAvg;
  QA[vi] = TR ? ovA[c * 4 + q] : 1;
  QL[o] = cT[t + 12] * s + L3[0]; QL[o + 1] = cT[t + 13] * s + L3[1]; QL[o + 2] = cT[t + 14] * s + L3[2];
  QT[o] = tr(cT[k] / own[0]); QT[o + 1] = tr(cT[k + 1] / own[1]); QT[o + 2] = tr(cT[k + 2] / own[2]);
  QD[p] = f; QD[p + 1] = gPf[c]; QD[p + 2] = 0; QD[p + 3] = caust;
}

export class World {
  constructor(scene, gen, mats) {
    this.scene = scene; this.gen = gen; this.mats = mats;
    this.chunks = new Map();
    this.queue = [];
    this.pcx = 1e9; this.pcz = 1e9; this.radius = 0;
    this.pruneT = 0;
    this.creaks = 0;
    this.dyn = [];            // hitboxes of things that move: creatures, restless furniture
    this.taken = new Set();   // ids of items already picked up
    this.onCollect = null;
    this.prepare = null;      // (object) => Promise: compile its GPU pipelines before it is shown
    this.tmpInfo = { realm: 0, floor: 0, ceil: 0, solid: 0, R: null };
  }

  key(cx, cz) { return (cx + 32768) * 65536 + (cz + 32768); }

  // ---- streaming -----------------------------------------------------------
  update(px, pz, radius, budgetMs) {
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);
    if (pcx !== this.pcx || pcz !== this.pcz || radius !== this.radius) {
      this.pcx = pcx; this.pcz = pcz; this.radius = radius;
      this.queue.length = 0;
      for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
        if (!this.chunks.has(this.key(pcx + dx, pcz + dz))) this.queue.push([pcx + dx, pcz + dz, dx * dx + dz * dz]);
      }
      this.queue.sort((a, b) => b[2] - a[2]);
      for (const [k, ch] of this.chunks) {
        if (Math.abs(ch.cx - pcx) > radius + 1 || Math.abs(ch.cz - pcz) > radius + 1) { this.disposeChunk(ch); this.chunks.delete(k); }
      }
      if (++this.pruneT > 6) {
        this.pruneT = 0;
        this.gen.prune(pcx, pcz, radius + 5);
        const live = new Set();
        for (const ch of this.chunks.values()) for (const id of ch.regions) live.add(id);
        this.mats.prune(live);
      }
    }
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budgetMs) {
      const [cx, cz] = this.queue.pop();
      if (!this.chunks.has(this.key(cx, cz))) this.buildChunk(cx, cz, false);
    }
  }

  ensure(px, pz, r) {
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (!this.chunks.has(this.key(pcx + dx, pcz + dz))) this.buildChunk(pcx + dx, pcz + dz);
    }
  }

  // throw everything away: used when stepping through to another dimension
  reset() {
    for (const ch of this.chunks.values()) this.disposeChunk(ch);
    this.chunks.clear();
    this.queue.length = 0; this.dyn.length = 0;
    this.pcx = 1e9; this.pcz = 1e9;
    this.mats.prune(new Set(), true); // nothing of the old dimension is needed any more
  }

  // how far a straight line gets before it meets something built
  rayStatic(ox, oy, oz, dx, dy, dz, max) {
    for (let t = 0.3; t < max; t += 0.25) {
      if (this.collides(ox + dx * t, oy + dy * t - 0.05, oz + dz * t, 0.05, 0.1)) return t;
    }
    return max;
  }

  disposeChunk(ch) {
    ch.dead = true;
    this.scene.remove(ch.group);
    for (const m of ch.group.children) if (!m.userData.shared) m.geometry.dispose();
  }

  updateDynamics(dt, t, cam, camDir) {
    this.creaks = 0;
    this.dyn.length = 0;
    for (const ch of this.chunks.values()) {
      if (!ch.dyn.length) continue;
      if (Math.abs(ch.cx - this.pcx) > 2 || Math.abs(ch.cz - this.pcz) > 2) continue;
      for (const m of ch.dyn) {
        if (updateDynProp(m, dt, t, cam, camDir, this)) this.creaks++;
        this.dyn.push(m.userData.box);
      }
    }
  }

  // Items turn slowly so they catch the eye; anything within reach is collected.
  updateItems(t, px, py, pz) {
    for (const ch of this.chunks.values()) {
      if (!ch.items.length || Math.abs(ch.cx - this.pcx) > 2 || Math.abs(ch.cz - this.pcz) > 2) continue;
      for (let q = ch.items.length - 1; q >= 0; q--) {
        const m = ch.items[q], p = m.position;
        m.rotation.y = t * 0.9 + p.x;
        const dx = p.x - px, dy = p.y - py, dz = p.z - pz;
        if (dx * dx + dy * dy + dz * dz < 1.7) {
          ch.group.remove(m);
          ch.items.splice(q, 1);
          this.taken.add(m.userData.item.id);
          if (this.onCollect) this.onCollect(m.userData.item);
        }
      }
    }
  }

  // Living things and restless furniture are solid: ease a body out of any it overlaps.
  pushOut(body, use3d, maxStep) {
    let pushed = false;
    for (let n = 0; n < this.dyn.length; n++) {
      const b = this.dyn[n];
      if (b.owner === body) continue;
      const xa = body.x - body.r, xb = body.x + body.r, za = body.z - body.r, zb = body.z + body.r, ya = body.y, yb = body.y + body.h;
      if (xa >= b.x1 || xb <= b.x0 || za >= b.z1 || zb <= b.z0 || ya >= b.y1 || yb <= b.y0) continue;
      const sx = body.x < (b.x0 + b.x1) / 2 ? b.x0 - xb : b.x1 - xa;
      const sz = body.z < (b.z0 + b.z1) / 2 ? b.z0 - zb : b.z1 - za;
      const sy = ya + body.h / 2 < (b.y0 + b.y1) / 2 ? b.y0 - yb : b.y1 - ya;
      const opts = [[Math.abs(sx), sx, 0, 0], [Math.abs(sz), 0, 0, sz]];
      if (use3d) opts.push([Math.abs(sy), 0, sy, 0]);
      opts.sort((p, q) => p[0] - q[0]);
      for (const o of opts) {
        const k = Math.min(1.001, maxStep / (o[0] + 1e-6));
        const nx = body.x + o[1] * k, ny = body.y + o[2] * k, nz = body.z + o[3] * k;
        if (!this.collides(nx, ny, nz, body.r, body.h)) { body.x = nx; body.y = ny; body.z = nz; pushed = true; break; }
      }
    }
    return pushed;
  }

  // ---- meshing -------------------------------------------------------------
  // now: add it to the scene at once (spawn, arrival); otherwise its pipelines compile first, off the frame
  buildChunk(cx, cz, now = true) {
    const gen = this.gen, mats = this.mats;
    const i0 = cx * CN, j0 = cz * CN, gi0 = i0 - M, gj0 = j0 - M;
    for (let gj = 0; gj < G; gj++) for (let gi = 0; gi < G; gi++) {
      const i = gi0 + gi, j = gj0 + gj, c = gi + gj * G;
      const b = gen.block(i >> 4, j >> 4), k = (i & 15) | ((j & 15) << 4);
      gRealm[c] = b.realm[k]; gSolid[c] = b.solid[k]; gWE[c] = b.wallE[k]; gWS[c] = b.wallS[k];
      gLight[c] = b.light[k]; gPillar[c] = b.pillar[k]; gFloor[c] = b.floor[k]; gCeil[c] = b.ceil[k]; gReg[c] = b.reg[k];
      let s = 0, f = 0, ph = 0;
      if (gLight[c] === 1) s = 1; else if (gLight[c] === 2) { f = 1; ph = rand01(i, j, 3); }
      const ps = gen.cellProps(b, k, i, j);
      if (ps) for (const p of ps) {
        if (p.type === 'lamp') s = Math.max(s, 0.5);
        else if (p.type === 'tv' && f < 0.4) { f = 0.4; ph = rand01(i, j, 4); }
      }
      const gl = b.glow[k]; // screens, portals: light with no fitting
      if (gl === 1) s = Math.max(s, 0.75); else if (gl === 2 && f < 0.85) { f = 0.85; ph = rand01(i, j, 5); }
      gLs[c] = s; gLf[c] = f; gPf[c] = ph;
    }

    // flood light through open edges; walls stop it, doorways choke it
    for (let pass = 0; pass < 6; pass++) {
      for (let q = 0; q < GG; q++) {
        const c = pass & 1 ? GG - 1 - q : q;
        if (blocked(c)) continue;
        const gi = c % G, gj = (c / G) | 0;
        let s = gLs[c], f = gLf[c], ph = gPf[c];
        for (let d = 0; d < 4; d++) {
          const ni = gi + DX[d], nj = gj + DZ[d];
          if (ni < 0 || nj < 0 || ni >= G || nj >= G) continue;
          const n = ni + nj * G;
          if (blocked(n)) continue;
          const w = d === 0 ? gWE[c] : d === 1 ? gWE[n] : d === 2 ? gWS[c] : gWS[n];
          if (w === 1) continue;
          const a = w === 2 ? 0.45 : w === 3 ? 0.2 : 0.72;
          if (gLs[n] * a > s) s = gLs[n] * a;
          if (gLf[n] * a > f) { f = gLf[n] * a; ph = gPf[n]; }
        }
        gLs[c] = s; gLf[c] = f; gPf[c] = ph;
      }
    }
    const blk = gen.block(cx, cz);
    blk.lightS = new Float32Array(256);
    for (let lj = 0; lj < CN; lj++) for (let li = 0; li < CN; li++) {
      const c = li + M + (lj + M) * G;
      blk.lightS[li | (lj << 4)] = gLs[c] + gLf[c] * 0.5;
    }

    // smooth per-corner light for the chunk and a one-cell ring
    for (let gj = M - 1; gj <= M + CN; gj++) for (let gi = M - 1; gi <= M + CN; gi++) {
      const c = gi + gj * G;
      if (blocked(c)) continue;
      for (let q = 0; q < 4; q++) {
        const sx = q & 1 ? 1 : -1, sz = q & 2 ? 1 : -1;
        let s = gLs[c], f = gLf[c], n = 1;
        const a = openTo(c, sx, 0), b = openTo(c, 0, sz);
        if (a >= 0) { s += gLs[a]; f += gLf[a]; n++; }
        if (b >= 0) { s += gLs[b]; f += gLf[b]; n++; }
        let d = a >= 0 ? openTo(a, 0, sz) : -1;
        if (d < 0 && b >= 0) d = openTo(b, sx, 0);
        if (d >= 0) { s += gLs[d]; f += gLf[d]; n++; }
        cS[c * 4 + q] = s / n; cF[c * 4 + q] = f / n;
      }
    }

    if (gen.dim !== 2) {
      for (let gj = M - 1; gj <= M + CN + 1; gj++) for (let gi = M - 1; gi <= M + CN + 1; gi++) gen.blendAt(gi0 + gi, gj0 + gj, cT, (gi + gj * G1) * 15, cReg, cW, (gi + gj * G1) * 9);
      // Near a border every surface is drawn twice: its own district, and the neighbour's on top, fading out.
      for (let gj = M - 1; gj <= M + CN; gj++) for (let gi = M - 1; gi <= M + CN; gi++) {
        const c = gi + gj * G;
        ovR[c] = null;
        if (blocked(c)) continue;
        const own = gReg[c];
        let best = null, bw = 0.05;
        for (let q = 0; q < 4; q++) {
          const t9 = (gi + (q & 1) + (gj + (q >> 1)) * G1) * 9;
          for (let k = 0; k < 9; k++) if (cReg[t9 + k] !== own && cW[t9 + k] > bw) { bw = cW[t9 + k]; best = cReg[t9 + k]; }
        }
        if (!best) continue;
        ovR[c] = best;
        for (let q = 0; q < 4; q++) {
          const t9 = (gi + (q & 1) + (gj + (q >> 1)) * G1) * 9;
          let wo = 0, wn = 0;
          for (let k = 0; k < 9; k++) { if (cReg[t9 + k] === own) wo = cW[t9 + k]; else if (cReg[t9 + k] === best) wn = cW[t9 + k]; }
          ovA[c * 4 + q] = wn / (wn + wo + 1e-6);
        }
      }
    }

    const builders = new Map();
    const mbFor = (kind, R) => {
      const key = R ? kind + R.id : kind;
      let e = builders.get(key);
      if (!e) { e = { mb: new MB(), kind, R }; builders.set(key, e); }
      return e.mb;
    };
    const tiled = gen.dim === 1; // only the drowned floors are tiled; a flooded room upstairs keeps its wallpaper
    const wallMB = c => mbFor(tiled ? 't' : 'w', gReg[c]);
    const wallS = c => (tiled ? 1.5 : 3);
    const mbShell = mbFor('shell'), mbGlow = mbFor('glow'), mbProp = mbFor('prop'), mbWater = mbFor('water');

    const vface = (mb, xa, za, xb, zb, y0, y1, nx, nz, c, qa, qb, S) => {
      if (y1 - y0 < 1e-4) return;
      TK = tiled ? 3 : 0;
      LV(0, c, qa, y0, 0.85); LV(1, c, qb, y0, 0.85); LV(2, c, qb, y1, 1); LV(3, c, qa, y1, 1);
      const ua = (xa + za) / S, ub = (xb + zb) / S;
      mb.quad(xa, y0, za, xb, y0, zb, xb, y1, zb, xa, y1, za, nx, 0, nz, ua, y0 / S, ub, y0 / S, ub, y1 / S, ua, y1 / S);
      if (ovR[c]) {
        TR = ovR[c];
        LV(0, c, qa, y0, 0.85); LV(1, c, qb, y0, 0.85); LV(2, c, qb, y1, 1); LV(3, c, qa, y1, 1);
        const ex = nx * 0.003, ez = nz * 0.003;
        mbFor(tiled ? 'to' : 'wo', TR).quad(xa + ex, y0, za + ez, xb + ex, y0, zb + ez, xb + ex, y1, zb + ez, xa + ex, y1, za + ez, nx, 0, nz, ua, y0 / S, ub, y0 / S, ub, y1 / S, ua, y1 / S);
        TR = null;
      }
    };
    const shell = (xa, za, xb, zb, y0, y1, nx, nz) => {
      if (y1 - y0 < 1e-4) return;
      setFlat(0.012, 0.012, 0.014, 0, 0, 1, 0);
      const ua = (xa + za) / 18, ub = (xb + zb) / 18;
      mbShell.quad(xa, y0, za, xb, y0, zb, xb, y1, zb, xa, y1, za, nx, 0, nz, ua, y0 / 18, ub, y0 / 18, ub, y1 / 18, ua, y1 / 18);
    };
    const waterV = (xa, za, xb, zb, y0, y1, nx, nz, c) => {
      if (y1 - y0 < 1e-4) return;
      const R = gReg[c], s = gLs[c];
      setFlat(R.lc[0] * s, R.lc[1] * s, R.lc[2] * s);
      mbWater.quad(xa, y0, za, xb, y0, zb, xb, y1, zb, xa, y1, za, nx, 0, nz, 0, 0, 1, 0, 1, 1, 0, 1);
    };
    // one side of a wall with a doorway cut in it
    const doorSide = (mb, x0, z0, x1, z1, ox, oz, y0, y1, yt, nx, nz, c, q0, q1, S, hw) => {
      const ex = (x1 - x0) / CS, ez = (z1 - z0) / CS, xc = (x0 + x1) / 2 + ox, zc = (z0 + z1) / 2 + oz;
      const ax = xc - ex * hw, az = zc - ez * hw, bx = xc + ex * hw, bz = zc + ez * hw;
      vface(mb, x0 + ox, z0 + oz, ax, az, y0, y1, nx, nz, c, q0, q0, S);
      vface(mb, bx, bz, x1 + ox, z1 + oz, y0, y1, nx, nz, c, q1, q1, S);
      vface(mb, ax, az, bx, bz, yt, y1, nx, nz, c, q0, q1, S);
    };
    // the inside faces of a doorway (thickness t0..t1 along the edge normal)
    const jambs = (mb, x0, z0, x1, z1, nx, nz, t0, t1, yb, yt, c, q0, q1, S, hw) => {
      const ex = (x1 - x0) / CS, ez = (z1 - z0) / CS, xc = (x0 + x1) / 2, zc = (z0 + z1) / 2;
      const ax = xc - ex * hw, az = zc - ez * hw, bx = xc + ex * hw, bz = zc + ez * hw;
      vface(mb, ax + nx * t0, az + nz * t0, ax + nx * t1, az + nz * t1, yb, yt, ex, ez, c, q0, q0, S);
      vface(mb, bx + nx * t0, bz + nz * t0, bx + nx * t1, bz + nz * t1, yb, yt, -ex, -ez, c, q1, q1, S);
      TK = tiled ? 3 : 0;
      LV(0, c, q0, yt, 0.8); LV(1, c, q0, yt, 0.8); LV(2, c, q1, yt, 0.8); LV(3, c, q1, yt, 0.8);
      mb.quad(ax + nx * t0, yt, az + nz * t0, ax + nx * t1, yt, az + nz * t1, bx + nx * t1, yt, bz + nz * t1, bx + nx * t0, yt, bz + nz * t0,
        0, -1, 0, 0, 0, 0.1, 0, 0.1, 0.4, 0, 0.4);
    };

    // Edge between cell A and cell B; (nx,nz) points from A to B.
    const edge = (A, B, x0, z0, x1, z1, nx, nz, qa0, qa1, qb0, qb1, w, capS, capE) => {
      const sA = gSolid[A], sB = gSolid[B], vA = !sA && gRealm[A] === VOID, vB = !sB && gRealm[B] === VOID;
      if ((sA && sB) || (vA && vB)) return;
      const ex = (x1 - x0) / CS, ez = (z1 - z0) / CS;
      if (!sA && !sB && !vA && !vB) {
        const fA = gFloor[A], fB = gFloor[B], hA = gCeil[A], hB = gCeil[B];
        if (w) {
          const mA = wallMB(A), mB = wallMB(B), ox = nx * T, oz = nz * T;
          if (w === 1) {
            vface(mA, x0 - ox, z0 - oz, x1 - ox, z1 - oz, fA, hA, -nx, -nz, A, qa0, qa1, wallS(A));
            vface(mB, x0 + ox, z0 + oz, x1 + ox, z1 + oz, fB, hB, nx, nz, B, qb0, qb1, wallS(B));
          } else {
            const yt = fA + OPEN_H[w], hw = OPEN_HW[w];
            doorSide(mA, x0, z0, x1, z1, -ox, -oz, fA, hA, yt, -nx, -nz, A, qa0, qa1, wallS(A), hw);
            doorSide(mB, x0, z0, x1, z1, ox, oz, fB, hB, yt, nx, nz, B, qb0, qb1, wallS(B), hw);
            jambs(mA, x0, z0, x1, z1, nx, nz, -T, T, fA, yt, A, qa0, qa1, wallS(A), hw);
          }
          const lo = Math.min(fA, fB), hi = Math.max(hA, hB);
          if (capS) vface(mA, x0 - ox, z0 - oz, x0 + ox, z0 + oz, lo, hi, -ex, -ez, A, qa0, qa0, wallS(A));
          if (capE) vface(mA, x1 - ox, z1 - oz, x1 + ox, z1 + oz, lo, hi, ex, ez, A, qa1, qa1, wallS(A));
        } else {
          if (fA !== fB) {
            const lowA = fA < fB, low = lowA ? A : B;
            vface(wallMB(low), x0, z0, x1, z1, Math.min(fA, fB), Math.min(Math.max(fA, fB), gCeil[low]),
              lowA ? -nx : nx, lowA ? -nz : nz, low, lowA ? qa0 : qb0, lowA ? qa1 : qb1, wallS(low));
          }
          if (hA !== hB) {
            const hiA = hA > hB, hi = hiA ? A : B;
            vface(wallMB(hi), x0, z0, x1, z1, Math.max(Math.min(hA, hB), gFloor[hi]), Math.max(hA, hB),
              hiA ? -nx : nx, hiA ? -nz : nz, hi, hiA ? qa0 : qb0, hiA ? qa1 : qb1, wallS(hi));
          }
        }
        return;
      }
      if (!vA && !vB) { // room against solid mass
        if (sB) vface(wallMB(A), x0, z0, x1, z1, gFloor[A], gCeil[A], -nx, -nz, A, qa0, qa1, wallS(A));
        else vface(wallMB(B), x0, z0, x1, z1, gFloor[B], gCeil[B], nx, nz, B, qb0, qb1, wallS(B));
        return;
      }
      // one side is the outside: this is the shell of the structure
      const room = vB ? A : B, onx = vB ? nx : -nx, onz = vB ? nz : -nz;
      if (gSolid[room]) { shell(x0, z0, x1, z1, BOT, TOP, onx, onz); return; }
      const f = gFloor[room], h = gCeil[room], q0 = vB ? qa0 : qb0, q1 = vB ? qa1 : qb1;
      const mR = wallMB(room), ox = -onx * T, oz = -onz * T;
      shell(x0, z0, x1, z1, BOT, f, onx, onz);
      shell(x0, z0, x1, z1, h, TOP, onx, onz);
      if (w === 1) {
        shell(x0, z0, x1, z1, f, h, onx, onz);
        vface(mR, x0 + ox, z0 + oz, x1 + ox, z1 + oz, f, h, -onx, -onz, room, q0, q1, wallS(room));
      } else if (w === 2) {
        const hw = OPEN_HW[2], yt = f + OPEN_H[2], xc = (x0 + x1) / 2, zc = (z0 + z1) / 2;
        const ax = xc - ex * hw, az = zc - ez * hw, bx = xc + ex * hw, bz = zc + ez * hw;
        shell(x0, z0, ax, az, f, h, onx, onz); shell(bx, bz, x1, z1, f, h, onx, onz); shell(ax, az, bx, bz, yt, h, onx, onz);
        doorSide(mR, x0, z0, x1, z1, ox, oz, f, h, yt, -onx, -onz, room, q0, q1, wallS(room), hw);
        jambs(mR, x0, z0, x1, z1, -onx, -onz, 0, T, f, yt, room, q0, q1, wallS(room), hw);
      }
      if (w) {
        vface(mR, x0, z0, x0 + ox, z0 + oz, f, h, -ex, -ez, room, q0, q0, wallS(room));
        vface(mR, x1, z1, x1 + ox, z1 + oz, f, h, ex, ez, room, q1, q1, wallS(room));
      }
      if (gRealm[room] === WET && w !== 1 && f < WL) {
        // the water does not spill. it stands there.
        if (w === 2) {
          const xc = (x0 + x1) / 2, zc = (z0 + z1) / 2;
          waterV(xc - ex * OPEN_HW[2], zc - ez * OPEN_HW[2], xc + ex * OPEN_HW[2], zc + ez * OPEN_HW[2], f, Math.min(WL, f + OPEN_H[2]), onx, onz, room);
        } else waterV(x0, z0, x1, z1, f, Math.min(WL, h), onx, onz, room);
      }
    };

    const chunk = { cx, cz, group: new THREE.Group(), dyn: [], items: [], regions: new Set(), solid: [], hidden: false };
    for (let lj = 0; lj < CN; lj++) for (let li = 0; li < CN; li++) {
      const gi = li + M, gj = lj + M, c = gi + gj * G, i = i0 + li, j = j0 + lj;
      const x0 = i * CS, z0 = j * CS, x1 = x0 + CS, z1 = z0 + CS;
      const room = !blocked(c);
      if (room) {
        const R = gReg[c], wet = gRealm[c] === WET, f = gFloor[c], h = gCeil[c], tl = tiled;
        const xc = x0 + CS / 2, zc = z0 + CS / 2;
        // floor
        let mb = mbFor(tl ? 't' : 'f', R), S = tl ? 1.5 : 2;
        TK = tl ? 3 : 1;
        LV(0, c, 0, f, 1); LV(1, c, 2, f, 1); LV(2, c, 3, f, 1); LV(3, c, 1, f, 1);
        mb.quad(x0, f, z0, x0, f, z1, x1, f, z1, x1, f, z0, 0, 1, 0, x0 / S, z0 / S, x0 / S, z1 / S, x1 / S, z1 / S, x1 / S, z0 / S);
        if (ovR[c]) {
          TR = ovR[c];
          LV(0, c, 0, f, 1); LV(1, c, 2, f, 1); LV(2, c, 3, f, 1); LV(3, c, 1, f, 1);
          const fy = f + 0.003;
          mbFor(tl ? 'to' : 'fo', TR).quad(x0, fy, z0, x0, fy, z1, x1, fy, z1, x1, fy, z0, 0, 1, 0, x0 / S, z0 / S, x0 / S, z1 / S, x1 / S, z1 / S, x1 / S, z0 / S);
          TR = null;
        }
        // ceiling
        mb = mbFor(tl ? 't' : 'c', R); S = tl ? 1.5 : 1.2;
        TK = tl ? 3 : 2;
        LV(0, c, 0, h, 0.9); LV(1, c, 1, h, 0.9); LV(2, c, 3, h, 0.9); LV(3, c, 2, h, 0.9);
        mb.quad(x0, h, z0, x1, h, z0, x1, h, z1, x0, h, z1, 0, -1, 0, x0 / S, z0 / S, x1 / S, z0 / S, x1 / S, z1 / S, x0 / S, z1 / S);
        if (ovR[c]) {
          TR = ovR[c];
          LV(0, c, 0, h, 0.9); LV(1, c, 1, h, 0.9); LV(2, c, 3, h, 0.9); LV(3, c, 2, h, 0.9);
          const hy = h - 0.003;
          mbFor(tl ? 'to' : 'co', TR).quad(x0, hy, z0, x1, hy, z0, x1, hy, z1, x0, hy, z1, 0, -1, 0, x0 / S, z0 / S, x1 / S, z0 / S, x1 / S, z1 / S, x0 / S, z1 / S);
          TR = null;
        }
        // water surface
        if (wet && h > WL && f < WL) {
          LV(0, c, 0, WL, 1); LV(1, c, 2, WL, 1); LV(2, c, 3, WL, 1); LV(3, c, 1, WL, 1);
          mbWater.quad(x0, WL, z0, x0, WL, z1, x1, WL, z1, x1, WL, z0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0);
        }
        // light panel
        const L = gLight[c];
        if (L) {
          const y = h - 0.012, hx = R.axis ? 0.6 : 0.3, hz = R.axis ? 0.3 : 0.6, lc = R.lc;
          if (L === 1) setFlat(lc[0] * 1.7, lc[1] * 1.7, lc[2] * 1.7);
          else if (L === 2) setFlat(lc[0] * 0.1, lc[1] * 0.1, lc[2] * 0.1, 1.6, gPf[c]);
          else setFlat(0.05, 0.05, 0.055);
          mbGlow.quad(xc - hx, y, zc - hz, xc + hx, y, zc - hz, xc + hx, y, zc + hz, xc - hx, y, zc + hz, 0, -1, 0, 0, 0, 1, 0, 1, 1, 0, 1);
        }
        if (gPillar[c]) {
          const ps = pillarSize(R, gRealm[c]), m = wallMB(c), Sw = wallS(c);
          vface(m, xc - ps, zc - ps, xc - ps, zc + ps, f, h, -1, 0, c, 0, 2, Sw);
          vface(m, xc + ps, zc - ps, xc + ps, zc + ps, f, h, 1, 0, c, 1, 3, Sw);
          vface(m, xc - ps, zc - ps, xc + ps, zc - ps, f, h, 0, -1, c, 0, 1, Sw);
          vface(m, xc - ps, zc + ps, xc + ps, zc + ps, f, h, 0, 1, c, 2, 3, Sw);
        }
        const ps = gen.cellProps(blk, li | (lj << 4), i, j);
        if (ps) for (const s of ps) {
          const py = s.mode === 'ceil' ? h - 0.5 : s.y + 0.5;
          const dy = h - py, att = 1 / (1 + 0.02 * dy * dy), caust = ambientAt(c, py, L3);
          const light = [R.lc[0] * gLs[c] * att + L3[0] + 0.004, R.lc[1] * gLs[c] * att + L3[1] + 0.004, R.lc[2] * gLs[c] * att + L3[2] + 0.004];
          if (s.dyn) { if (chunk.dyn.length < 14) chunk.dyn.push(makeDynProp(s, light, 0, caust, mats)); }
          else emitProp(mbProp, mbGlow, s, light, 0, caust);
        }
      }
      // fittings and clutter
      const dc = gen.cellDecor(blk, li | (lj << 4), i, j);
      if (dc) {
        const bx = dc.boxes;
        for (let q = 0; q < bx.length; q += 11) {
          const tg = bx[q + 10], fl = tg >= 10, tag = tg % 10, lc = tag === 1 ? c + 1 : tag === 2 ? c + G : c;
          if (blocked(lc)) continue;
          const Rl = gReg[lc], ym = (bx[q + 1] + bx[q + 4]) / 2, dy = gCeil[lc] - ym;
          const caust = ambientAt(lc, ym, L3), sl = gLs[lc] / (1 + 0.02 * dy * dy);
          if (bx[q + 7] + bx[q + 8] + bx[q + 9] > 0) {
            const k = fl ? 0.1 : 1;
            mbGlow.cbox(bx[q], bx[q + 1], bx[q + 2], bx[q + 3], bx[q + 4], bx[q + 5], 0, 0, bx[q + 7] * k, bx[q + 8] * k, bx[q + 9] * k, 0, 0, fl ? 1.3 : 0, 0.37);
          }
          else {
            const col = bx[q + 6];
            mbProp.cbox(bx[q], bx[q + 1], bx[q + 2], bx[q + 3], bx[q + 4], bx[q + 5], ((col % 8) + 0.5) / 8, (Math.floor(col / 8) + 0.5) / 8,
              Rl.lc[0] * sl + L3[0] + 0.004, Rl.lc[1] * sl + L3[1] + 0.004, Rl.lc[2] * sl + L3[2] + 0.004, 0, caust);
          }
        }
      }
      const wr = gen.cellWriting(blk, li | (lj << 4), i, j);
      if (wr) { // a line someone wrote, lying just proud of the wall
        const sg = wr[1], q = sg * 0.092, slot = wr[2], u0 = (slot & 1) * 0.5, v1 = 1 - (slot >> 1) / 16, v0 = v1 - 1 / 16, y0 = gFloor[c] + wr[3], y1 = y0 + 0.3;
        const mw = mbFor('writing');
        setFlat(0, 0, 0);
        if (wr[0] === 0) { const a = sg < 0 ? z0 + 0.3 : z1 - 0.3, e = sg < 0 ? z1 - 0.3 : z0 + 0.3; mw.quad(x1 + q, y0, a, x1 + q, y0, e, x1 + q, y1, e, x1 + q, y1, a, sg, 0, 0, u0, v0, u0 + 0.5, v0, u0 + 0.5, v1, u0, v1); }
        else { const a = sg < 0 ? x1 - 0.3 : x0 + 0.3, e = sg < 0 ? x0 + 0.3 : x1 - 0.3; mw.quad(a, y0, z1 + q, e, y0, z1 + q, e, y1, z1 + q, a, y1, z1 + q, 0, 0, sg, u0, v0, u0 + 0.5, v0, u0 + 0.5, v1, u0, v1); }
      }
      const it = gen.cellItem(blk, li | (lj << 4), i, j);
      if (it && !this.taken.has(it.id)) chunk.items.push(makeItemMesh(it, mats.glow));
      // east and south edges belong to this cell
      edge(c, c + 1, x1, z0, x1, z1, 1, 0, 1, 3, 0, 2, gWE[c], true, true);
      edge(c, c + G, x0, z1, x1, z1, 0, 1, 2, 3, 0, 1, gWS[c], true, true);
    }

    // the roof and the underside of the structure, merged into strips
    for (let lj = 0; lj < CN; lj++) {
      let run = -1;
      for (let li = 0; li <= CN; li++) {
        const c = li + M + (lj + M) * G;
        const on = false && li < CN && (gSolid[c] || gRealm[c] !== VOID);
        if (on && run < 0) run = li;
        else if (!on && run >= 0) {
          const xa = (i0 + run) * CS, xb = (i0 + li) * CS, za = (j0 + lj) * CS, zb = za + CS;
          setFlat(0.012, 0.012, 0.014, 0, 0, 1, 0);
          mbShell.quad(xa, TOP, za, xa, TOP, zb, xb, TOP, zb, xb, TOP, za, 0, 1, 0, xa / 18, za / 18, xa / 18, zb / 18, xb / 18, zb / 18, xb / 18, za / 18);
          mbShell.quad(xa, BOT, za, xa, BOT, zb, xb, BOT, zb, xb, BOT, za, 0, -1, 0, xa / 18, za / 18, xa / 18, zb / 18, xb / 18, zb / 18, xb / 18, za / 18);
          run = -1;
        }
      }
    }

    // things adrift in the outside
    const fr = gen.fragments(cx, cz);
    if (fr) for (const F of fr.list) {
      const R = F.R, l = F.light, lr = R.lc[0] * l + 0.004, lg = R.lc[1] * l + 0.004, lb = R.lc[2] * l + 0.005;
      for (const p of F.parts) {
        setFlat(lr, lg, lb, 0, 0, 1, 0);
        const b = p.box;
        if (p.kind === 'shell') mbShell.box(b[0], b[1], b[2], b[3], b[4], b[5], 18);
        else if (p.kind === 'stone') mbFor('stone').box(b[0], b[1], b[2], b[3], b[4], b[5], 9);
        else if (p.kind === 'floor') mbFor('f', R).box(b[0], b[1], b[2], b[3], b[4], b[5], 2);
        else if (p.kind === 'ceil') mbFor('c', R).box(b[0], b[1], b[2], b[3], b[4], b[5], 1.2);
        else mbFor('w', R).box(b[0], b[1], b[2], b[3], b[4], b[5], 3);
      }
      for (const g of F.glows) {
        if (g.fl) setFlat(g.col[0] * 0.08, g.col[1] * 0.08, g.col[2] * 0.08, 1.5, g.ph, 1, 0);
        else setFlat(g.col[0], g.col[1], g.col[2], 0, 0, 1, 0);
        const b = g.box;
        mbGlow.box(b[0], b[1], b[2], b[3], b[4], b[5], 1);
      }
      const light = [lr + 0.01, lg + 0.01, lb + 0.012];
      for (const s of F.props) emitProp(mbProp, mbGlow, s, light, 1, 0);
      for (let q = 0; q < F.cb.length; q += 7) {
        const col = F.cb[q + 6];
        mbProp.cbox(F.cb[q], F.cb[q + 1], F.cb[q + 2], F.cb[q + 3], F.cb[q + 4], F.cb[q + 5], ((col % 8) + 0.5) / 8, (Math.floor(col / 8) + 0.5) / 8, light[0], light[1], light[2], 1, 0);
      }
      for (const it of F.items) if (!this.taken.has(it.id)) chunk.items.push(makeItemMesh(it, mats.glow));
    }

    for (const e of builders.values()) {
      const geo = e.mb.build();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, e.R ? mats.get(e.kind, e.R) : mats[e.kind]);
      mesh.matrixAutoUpdate = false;
      if (e.kind === 'water') mesh.renderOrder = 5;
      else if (e.kind === 'writing') mesh.renderOrder = 2;
      else if (e.R && e.kind.length > 1) mesh.renderOrder = 1; // overlay layers, after everything solid
      else if (e.kind !== 'glow') chunk.solid.push(mesh);
      chunk.group.add(mesh);
      if (e.R) chunk.regions.add(e.R.id);
    }
    for (const m of chunk.dyn) chunk.group.add(m);
    for (const m of chunk.items) chunk.group.add(m);
    chunk.group.matrixAutoUpdate = false;
    if (now || !this.prepare) this.scene.add(chunk.group);
    else this.prepare(chunk.group).catch(() => {}).then(() => { if (!chunk.dead) this.scene.add(chunk.group); });
    this.chunks.set(this.key(cx, cz), chunk);
    return chunk;
  }

  // Hide the opaque surfaces of chunks that lie wholly inside the fog (beyond maxDist on the ground plane).
  cull(px, pz, maxDist) {
    const h = CHUNK / 2;
    for (const ch of this.chunks.values()) {
      const dx = Math.max(0, Math.abs(px - (ch.cx * CHUNK + h)) - h), dz = Math.max(0, Math.abs(pz - (ch.cz * CHUNK + h)) - h);
      const hide = dx * dx + dz * dz > maxDist * maxDist;
      if (hide === ch.hidden) continue;
      ch.hidden = hide;
      for (const m of ch.solid) m.visible = !hide;
    }
  }

  // ---- queries -------------------------------------------------------------
  cellInfo(x, z, out = this.tmpInfo) {
    const i = Math.floor(x / CS), j = Math.floor(z / CS);
    const b = this.gen.block(i >> 4, j >> 4), k = (i & 15) | ((j & 15) << 4);
    out.realm = b.realm[k]; out.floor = b.floor[k]; out.ceil = b.ceil[k]; out.solid = b.solid[k]; out.R = b.reg[k];
    return out;
  }

  lightAt(x, z) {
    const i = Math.floor(x / CS), j = Math.floor(z / CS);
    const b = this.gen.block(i >> 4, j >> 4);
    return b.lightS ? b.lightS[(i & 15) | ((j & 15) << 4)] : 0;
  }

  collides(x, y, z, r, h) {
    const gen = this.gen;
    const i0 = Math.floor((x - r) / CS), i1 = Math.floor((x + r) / CS), j0 = Math.floor((z - r) / CS), j1 = Math.floor((z + r) / CS);
    let anyVoid = false;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const b = gen.block(i >> 4, j >> 4), k = (i & 15) | ((j & 15) << 4);
      if ((b.realm[k] === VOID && !b.solid[k]) || y >= TOP - 0.001 || y + h <= BOT + 0.001) { anyVoid = true; continue; }
      if (b.solid[k]) return true;
      if (y < b.floor[k] - 0.002 || y + h > b.ceil[k] + 0.002) return true;
    }
    const y1 = y + h, xa = x - r, xb = x + r, za = z - r, zb = z + r;
    for (let j = j0 - 1; j <= j1 + 1; j++) for (let i = i0 - 1; i <= i1 + 1; i++) {
      const b = gen.block(i >> 4, j >> 4), k = (i & 15) | ((j & 15) << 4);
      const bx = gen.cellBoxes(b, k, i, j);
      if (!bx) continue;
      for (let q = 0; q < bx.length; q += 6) {
        if (xa < bx[q + 3] && xb > bx[q] && za < bx[q + 5] && zb > bx[q + 2] && y < bx[q + 4] && y1 > bx[q + 1]) return true;
      }
    }
    if (anyVoid) {
      const ccx = Math.floor(x / CHUNK), ccz = Math.floor(z / CHUNK);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const fr = gen.fragments(ccx + dx, ccz + dz);
        if (!fr) continue;
        const bx = fr.boxes;
        for (let q = 0; q < bx.length; q += 6) {
          if (xa < bx[q + 3] && xb > bx[q] && za < bx[q + 5] && zb > bx[q + 2] && y < bx[q + 4] && y1 > bx[q + 1]) return true;
        }
      }
    }
    return false;
  }

  // highest floor under a footprint (-FAR over the outside)
  support(x, z, r) {
    const gen = this.gen;
    const i0 = Math.floor((x - r) / CS), i1 = Math.floor((x + r) / CS), j0 = Math.floor((z - r) / CS), j1 = Math.floor((z + r) / CS);
    let f = -FAR;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const b = gen.block(i >> 4, j >> 4), k = (i & 15) | ((j & 15) << 4);
      if (b.solid[k] || b.realm[k] === VOID) continue;
      if (b.floor[k] > f) f = b.floor[k];
    }
    return f;
  }

  // Moves a body {x,y,z,r,h} axis by axis. Flags: 1 hit x, 2 hit z, 4 landed, 8 hit head, 16 stepped up.
  move(body, dx, dy, dz, step) {
    const r = body.r, h = body.h;
    let flags = 0;
    if (dx !== 0) {
      const nx = body.x + dx;
      if (!this.collides(nx, body.y, body.z, r, h)) body.x = nx;
      else {
        const f = step > 0 ? this.support(nx, body.z, r) : -FAR;
        if (f > body.y && f - body.y <= step && !this.collides(nx, f, body.z, r, h)) { body.x = nx; body.y = f; flags |= 16; }
        else flags |= 1;
      }
    }
    if (dz !== 0) {
      const nz = body.z + dz;
      if (!this.collides(body.x, body.y, nz, r, h)) body.z = nz;
      else {
        const f = step > 0 ? this.support(body.x, nz, r) : -FAR;
        if (f > body.y && f - body.y <= step && !this.collides(body.x, f, nz, r, h)) { body.z = nz; body.y = f; flags |= 16; }
        else flags |= 2;
      }
    }
    if (dy !== 0) {
      const ny = body.y + dy;
      if (!this.collides(body.x, ny, body.z, r, h)) body.y = ny;
      else if (dy < 0) {
        const f = this.support(body.x, body.z, r);
        if (f <= body.y + 0.002 && f >= ny - 0.002 && !this.collides(body.x, f, body.z, r, h)) body.y = f;
        flags |= 4;
      } else flags |= 8;
    }
    return flags;
  }

  wallAt(i, j, dir) {
    const b = this.gen.block(i >> 4, j >> 4), k = (i & 15) | ((j & 15) << 4);
    return dir === 0 ? b.wallE[k] : b.wallS[k];
  }

  // 2D line of sight through the cell grid
  los(x0, z0, x1, z1) {
    const gen = this.gen;
    let i = Math.floor(x0 / CS), j = Math.floor(z0 / CS);
    const i1 = Math.floor(x1 / CS), j1 = Math.floor(z1 / CS);
    const dx = x1 - x0, dz = z1 - z0, sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const adx = Math.abs(dx), adz = Math.abs(dz);
    const tdx = adx > 1e-9 ? CS / adx : Infinity, tdz = adz > 1e-9 ? CS / adz : Infinity;
    let tx = adx > 1e-9 ? (dx > 0 ? (i + 1) * CS - x0 : x0 - i * CS) / adx : Infinity;
    let tz = adz > 1e-9 ? (dz > 0 ? (j + 1) * CS - z0 : z0 - j * CS) / adz : Infinity;
    for (let n = 0; n < 160 && (i !== i1 || j !== j1); n++) {
      if (tx < tz) {
        const w = this.wallAt(sx > 0 ? i : i - 1, j, 0);
        if (w === 1 || w === 3) return false;
        if (w === 2 && Math.abs(z0 + dz * tx - (j + 0.5) * CS) > OPEN_HW[2]) return false;
        i += sx; tx += tdx;
      } else {
        const w = this.wallAt(i, sz > 0 ? j : j - 1, 1);
        if (w === 1 || w === 3) return false;
        if (w === 2 && Math.abs(x0 + dx * tz - (i + 0.5) * CS) > OPEN_HW[2]) return false;
        j += sz; tz += tdz;
      }
      const b = gen.block(i >> 4, j >> 4);
      if (b.solid[(i & 15) | ((j & 15) << 4)]) return false;
    }
    return true;
  }

  // kind 0: walks on dry floors (can wade); kind 1: swims
  passable(i, j, d, kind) {
    const gen = this.gen, ni = i + DX[d], nj = j + DZ[d];
    const a = gen.block(i >> 4, j >> 4), ka = (i & 15) | ((j & 15) << 4);
    const b = gen.block(ni >> 4, nj >> 4), kb = (ni & 15) | ((nj & 15) << 4);
    if (a.solid[ka] || b.solid[kb]) return false;
    const w = d === 0 ? a.wallE[ka] : d === 1 ? b.wallE[kb] : d === 2 ? a.wallS[ka] : b.wallS[kb];
    if (w === 1 || w === 3) return false;
    const ra = a.realm[ka], rb = b.realm[kb], fa = a.floor[ka], fb = b.floor[kb];
    if (kind === 0) {
      if (ra === VOID || rb === VOID) return false;
      if (Math.abs(fa - fb) > 0.55 || fa < -1.3 || fb < -1.3) return false;
      return b.ceil[kb] - fb >= 1.2;
    }
    if (ra !== WET || rb !== WET || fa > WL - 1.6 || fb > WL - 1.6) return false;
    return Math.min(a.ceil[ka], b.ceil[kb], WL) - Math.max(fa, fb) > 1.2;
  }

  // First step (0:+x 1:-x 2:+z 3:-z) of a shortest path, -1 if none, -2 if the goal is too far.
  pathStep(i0, j0, i1, j1, kind) {
    if (i0 === i1 && j0 === j1) return -1;
    const oi = i0 - PR, oj = j0 - PR, ti = i1 - oi, tj = j1 - oj;
    if (ti < 0 || tj < 0 || ti >= PW || tj >= PW) return -2;
    pVis.fill(-1);
    const start = PR + PR * PW, goal = ti + tj * PW;
    let qh = 0, qt = 0;
    pVis[goal] = 4; pQ[qt++] = goal;
    while (qh < qt) {
      const c = pQ[qh++];
      if (c === start) break;
      const ci = c % PW, cj = (c / PW) | 0;
      for (let d = 0; d < 4; d++) {
        const ni = ci + DX[d], nj = cj + DZ[d];
        if (ni < 0 || nj < 0 || ni >= PW || nj >= PW) continue;
        const n = ni + nj * PW;
        if (pVis[n] >= 0 || !this.passable(ci + oi, cj + oj, d, kind)) continue;
        pVis[n] = d ^ 1;
        pQ[qt++] = n;
      }
    }
    const s = pVis[start];
    return s >= 0 && s < 4 ? s : -1;
  }
}

export { DX, DZ };
