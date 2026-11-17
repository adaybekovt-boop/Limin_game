// Surface textures painted by small CPPNs (see nn.js). Each district gets its
// own wallpaper, floor, ceiling and tile mosaic, generated the first time a
// chunk that needs it is built.
import * as THREE from 'three';
import { Net, mulberry32, hash32 } from './nn.js';
import { PALETTE } from './propdefs.js';

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

function tex(data, w, h, { repeat = true, mip = true, nearest = false } = {}) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  t.minFilter = nearest ? THREE.NearestFilter : mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mip && !nearest;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// Tileable CPPN field: inputs are periodic in u and v.
function cppn(seed, n, outs) {
  const rng = mulberry32(seed);
  const net = new Net([8, 10, 10, outs], rng, { gain: 2.0, cppn: true });
  const inp = new Float32Array(8), out = new Float32Array(n * n * outs);
  for (let y = 0; y < n; y++) {
    const v = (y / n) * 6.2831853;
    for (let x = 0; x < n; x++) {
      const u = (x / n) * 6.2831853;
      inp[0] = Math.sin(u); inp[1] = Math.cos(u); inp[2] = Math.sin(v); inp[3] = Math.cos(v);
      inp[4] = Math.sin(2 * u); inp[5] = Math.cos(2 * v); inp[6] = Math.sin(u + v); inp[7] = Math.cos(u - v);
      const o = net.forward(inp);
      for (let c = 0; c < outs; c++) out[(y * n + x) * outs + c] = o[c];
    }
  }
  return out;
}

// bilinear, wrapping
function samp(f, n, outs, ch, fx, fy) {
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const xa = ((x0 % n) + n) % n, xb = (xa + 1) % n, ya = ((y0 % n) + n) % n, yb = (ya + 1) % n;
  const a = f[(ya * n + xa) * outs + ch], b = f[(ya * n + xb) * outs + ch];
  const c = f[(yb * n + xa) * outs + ch], d = f[(yb * n + xb) * outs + ch];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

function put(d, o, r, g, b) {
  d[o] = clamp01(r) * 255; d[o + 1] = clamp01(g) * 255; d[o + 2] = clamp01(b) * 255; d[o + 3] = 255;
}

export function makeWall(R) {
  const N = 256, F = 64, fld = cppn(R.texSeed, F, 3);
  const d = new Uint8Array(N * N * 4), rng = mulberry32(R.texSeed ^ 0xabc1);
  const A = R.wallA, B = R.wallB, bands = R.bands, sw = [8, 16, 32][R.texSeed % 3];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const fx = (x / N) * F, fy = (y / N) * F;
    const f = samp(fld, F, 3, 0, fx, fy), g = samp(fld, F, 3, 1, fx, fy), s = samp(fld, F, 3, 2, fx, fy);
    let m;
    if (R.wallStyle === 0) m = clamp01(Math.floor((f * 0.5 + 0.5) * bands) / (bands - 1));
    else if (R.wallStyle === 1) m = Math.abs((((f * 0.5 + 0.5) * bands * 1.5) % 1) - 0.5) < 0.09 ? 1 : 0;
    else m = (f > 0.15) !== (g > 0.1) ? 0.85 : 0.1;
    const k = m * 0.8;
    let sh = 0.97 + 0.06 * rng();
    if (R.stripes && ((x / sw) | 0) % 2) sh *= 0.95;
    if (s > 0.25) sh *= 1 - (s - 0.25) * 0.45;
    const v = y / N;
    if (v < 0.035) sh *= 0.32; else if (v < 0.09) sh *= 0.78 + (v - 0.035) * 4;
    put(d, (y * N + x) * 4, (A[0] + (B[0] - A[0]) * k) * sh, (A[1] + (B[1] - A[1]) * k) * sh, (A[2] + (B[2] - A[2]) * k) * sh);
  }
  return tex(d, N, N);
}

export function makeFloor(R) {
  const N = 128, F = 32, fld = cppn(R.texSeed ^ 0x77, F, 2);
  const d = new Uint8Array(N * N * 4), rng = mulberry32(R.texSeed ^ 0x1f00), C = R.floorC;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const f = samp(fld, F, 2, 0, (x / N) * F, (y / N) * F), s = samp(fld, F, 2, 1, (x / N) * F, (y / N) * F);
    let sh;
    if (R.floorStyle === 0) sh = (0.78 + 0.44 * rng()) * (1 + 0.14 * f); // carpet
    else if (R.floorStyle === 1) { // worn linoleum squares
      sh = (((x >> 6) + (y >> 6)) & 1 ? 1.25 : 0.7) * (0.96 + 0.08 * rng());
      if ((x & 63) < 1 || (y & 63) < 1) sh *= 0.5;
    } else sh = 0.85 + 0.2 * f + 0.1 * rng(); // poured, mottled
    if (s > 0.35) sh *= 1 - (s - 0.35) * 0.6;
    put(d, (y * N + x) * 4, C[0] * sh, C[1] * sh, C[2] * sh);
  }
  return tex(d, N, N);
}

export function makeCeil(R) {
  const N = 128, F = 32, fld = cppn(R.texSeed ^ 0x3131, F, 1);
  const d = new Uint8Array(N * N * 4), rng = mulberry32(R.texSeed ^ 0x2e00), C = R.ceilC;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const s = samp(fld, F, 1, 0, (x / N) * F, (y / N) * F);
    let sh = 0.95 + 0.07 * rng();
    if (rng() < 0.035) sh *= 0.55;
    if ((x & 63) < 2 || (y & 63) < 2) sh *= 0.62;
    let r = C[0] * sh, g = C[1] * sh, b = C[2] * sh;
    if (s > 0.5) { const k = (s - 0.5) * 1.6; r *= 1 - 0.25 * k; g *= 1 - 0.4 * k; b *= 1 - 0.65 * k; } // water stains
    put(d, (y * N + x) * 4, r, g, b);
  }
  return tex(d, N, N);
}

export function makeTile(R) {
  const N = 128, T = 8, F = 8, fld = cppn(R.texSeed ^ 0x9d9d, F, 2);
  const d = new Uint8Array(N * N * 4), rng = mulberry32(R.texSeed ^ 0x4400), A = R.tileA, B = R.tileB;
  const glaze = new Float32Array(T * T);
  for (let q = 0; q < T * T; q++) glaze[q] = 0.93 + 0.12 * rng();
  const thr = ((R.texSeed >>> 5) % 100) / 100 * 0.6 - 0.1;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const tx = x >> 4, ty = y >> 4, px = x & 15, py = y & 15;
    const f = fld[(ty * F + tx) * 2];
    const k = f > thr ? 1 : 0;
    let sh = glaze[ty * T + tx] * (0.96 + 0.05 * rng());
    if (px === 0 || py === 0) sh *= 0.42;
    else sh *= 1 + 0.05 * (1 - (px + py) / 30);
    put(d, (y * N + x) * 4, (A[0] + (B[0] - A[0]) * k) * sh, (A[1] + (B[1] - A[1]) * k) * sh, (A[2] + (B[2] - A[2]) * k) * sh);
  }
  return tex(d, N, N);
}

// The outside face of everything: raw cast concrete.
export function makeShell(seed) {
  const N = 256, F = 64, fld = cppn(seed ^ 0x5e11, F, 2);
  const d = new Uint8Array(N * N * 4), rng = mulberry32(seed ^ 0x8800);
  const streak = new Float32Array(N);
  for (let x = 0; x < N; x++) streak[x] = rng() < 0.08 ? 0.75 + 0.2 * rng() : 1;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const f = samp(fld, F, 2, 0, (x / N) * F, (y / N) * F);
    let sh = 0.3 + 0.05 * f + 0.03 * rng();
    sh *= 0.9 + 0.1 * streak[x];
    if ((x & 127) < 2 || (y & 127) < 2) sh *= 0.5;
    const hx = (x & 63) - 32, hy = (y & 63) - 32;
    if (hx * hx + hy * hy < 5) sh *= 0.45;
    put(d, (y * N + x) * 4, sh, sh * 1.01, sh * 1.04);
  }
  return tex(d, N, N);
}

export function makePalette() {
  const d = new Uint8Array(8 * 8 * 4);
  for (let q = 0; q < 64; q++) {
    const c = PALETTE[q] || [1, 0, 1];
    put(d, q * 4, c[0], c[1], c[2]);
  }
  return tex(d, 8, 8, { repeat: false, nearest: true });
}

export function makeWhite() {
  return tex(new Uint8Array([255, 255, 255, 255]), 1, 1, { nearest: true });
}

export function makeSkin(seed, base) {
  const N = 64, fld = cppn(seed, N, 2), d = new Uint8Array(N * N * 4), rng = mulberry32(seed ^ 0x99);
  for (let q = 0; q < N * N; q++) {
    const f = fld[q * 2], g = fld[q * 2 + 1];
    let sh = 0.75 + 0.3 * f + 0.1 * rng();
    if (Math.abs(g) < 0.06) sh *= 0.35; // veins
    put(d, q * 4, base[0] * sh, base[1] * sh, base[2] * sh);
  }
  return tex(d, N, N);
}

// Equirectangular sky: faint clouds of colour on black, from a CPPN over directions.
export function makeNebula(seed) {
  const W = 256, H = 128, rng = mulberry32(seed ^ 0x7eb);
  const net = new Net([9, 12, 12, 3], rng, { gain: 1.9, cppn: true });
  const inp = new Float32Array(9), d = new Uint8Array(W * H * 4);
  const ca = [0.18, 0.05, 0.3], cb = [0.03, 0.2, 0.26];
  for (let y = 0; y < H; y++) {
    const th = ((y + 0.5) / H) * Math.PI, sy = Math.cos(th), sr = Math.sin(th);
    for (let x = 0; x < W; x++) {
      const ph = (x / W) * 6.2831853, sx = Math.cos(ph) * sr, sz = Math.sin(ph) * sr;
      inp[0] = sx; inp[1] = sy; inp[2] = sz;
      inp[3] = Math.sin(3 * sx); inp[4] = Math.sin(3 * sy); inp[5] = Math.sin(3 * sz);
      inp[6] = sx * sy * 2; inp[7] = sy * sz * 2; inp[8] = sz * sx * 2;
      const o = net.forward(inp);
      let dn = clamp01((o[0] * 0.5 + 0.5 - 0.35) / 0.65); dn = dn * dn * (0.7 + 0.3 * rng());
      const k = o[1] * 0.5 + 0.5, br = 1.15 * dn * (0.6 + 0.4 * (o[2] * 0.5 + 0.5));
      put(d, (y * W + x) * 4, (ca[0] + (cb[0] - ca[0]) * k) * br, (ca[1] + (cb[1] - ca[1]) * k) * br, (ca[2] + (cb[2] - ca[2]) * k) * br);
    }
  }
  const t = tex(d, W, H, { repeat: false, mip: false });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

export function makePlanet(seed) {
  const W = 128, H = 64, rng = mulberry32(seed ^ 0x91a);
  const net = new Net([4, 10, 10, 2], rng, { gain: 2.2, cppn: true });
  const inp = new Float32Array(4), d = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const lat = (y / H) * 2 - 1, lon = (x / W) * 6.2831853;
    inp[0] = lat * 3; inp[1] = Math.sin(lat * 9); inp[2] = Math.sin(lon) * 0.35; inp[3] = Math.cos(lon) * 0.35;
    const o = net.forward(inp);
    const k = o[0] * 0.5 + 0.5, sh = 0.55 + 0.45 * (o[1] * 0.5 + 0.5);
    put(d, (y * W + x) * 4, (0.5 + 0.3 * k) * sh, (0.42 + 0.1 * k) * sh, (0.36 - 0.12 * k) * sh);
  }
  const t = tex(d, W, H, { repeat: false, mip: false });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

// Things people wrote. 32 lines in a 2 x 16 sheet; alpha is the mark, colour is pencil or something redder.
export const WRITING = [
  'you fell through. so did we.', 'E.M. — surveyor — third circuit', 'it only moves when you do not look', 'the chairs know where the keys are',
  'DAY 41', 'DAY 41', 'DAY 41 ?', 'the hum stops before they come',
  'count the doors. count them again.', 'they are residents. we are visitors.', 'do not sit in the cinema', 'two barrels. it gets up again',
  'pearls are teeth', 'i heard my kitchen', 'floor 0 of 0', 'KEEP LEFT   (there is no left)',
  'mind the gap between rooms', 'turn the torch off and listen', '8 tapes. i left 8.', 'the black sun does not set',
  'class dismissed', 'if found, return to ——————', 'not the white door. not yet.', 'it knows your face now',
  '|||| |||| |||| |||| ||', 'someone moved the furniture', 'the water is breathing for you', 'follow the ones facing the middle',
  'M.  was here.   M. is here.', 'this corridor is longer on the way back', 'do not answer the telephone', 'there is only further',
];
export function makeWriting(seed) {
  const cv = document.createElement('canvas'); cv.width = 2048; cv.height = 2048;
  const g = cv.getContext('2d'), rng = mulberry32(seed ^ 0x1e77e2);
  g.textBaseline = 'middle';
  for (let q = 0; q < 32; q++) {
    const x0 = (q & 1) * 1024, y0 = (q >> 1) * 128, text = WRITING[q], red = rng() < 0.3;
    const size = Math.min(74, 1500 / text.length + 18) * (0.85 + 0.25 * rng());
    g.font = (rng() < 0.5 ? 'italic ' : '') + size.toFixed(0) + 'px "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';
    g.fillStyle = red ? 'rgb(96,10,8)' : 'rgb(22,20,22)';
    let x = x0 + 30 + rng() * 40;
    g.save(); g.beginPath(); g.rect(x0 + 4, y0 + 4, 1016, 120); g.clip();
    for (const ch of text) { // each letter a little off, as if written standing up, in a hurry
      g.save();
      g.translate(x, y0 + 64 + (rng() - 0.5) * 12); g.rotate((rng() - 0.5) * 0.14);
      g.globalAlpha = 0.55 + 0.4 * rng();
      g.fillText(ch, 0, 0);
      g.restore();
      x += g.measureText(ch).width * (0.96 + 0.1 * rng());
    }
    g.restore();
  }
  const t = new THREE.CanvasTexture(cv);
  t.anisotropy = 4;
  return t;
}

export { hash32 };
