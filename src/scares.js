// Faces for the sudden scares: small, blocky, drawn pixel by pixel from a seed so no two are the same,
// then blown up to fill the screen with tape noise and torn lines laid over them every frame.
// Each floor has its own: on the lit floors a long pale face; in the water a drowned one, milk-eyed, hair
// drifting over it, rising out of the dark; outside an eye the size of the sky, or a face printed in negative.
import { mulberry32 } from './nn.js';

export const FW = 72, FH = 92;

export function makeFace(seed, look = 'dry') {
  const R = mulberry32(seed), d = new Uint8ClampedArray(FW * FH * 4), drowned = look === 'drowned';
  const cx = FW / 2 + (R() - 0.5) * 3, cy = FH * 0.5;
  const rx = (drowned ? 25 : 22) + R() * 5, ry = (drowned ? 33 : 36) + R() * 6;
  const eyeY = cy - 6 + R() * 4, eyeDX = 10 + R() * 3;
  const eyes = [[cx - eyeDX, eyeY + (R() - 0.5) * 4, 6 + R() * 3, 8 + R() * 4], [cx + eyeDX, eyeY + (R() - 0.5) * 4, 6 + R() * 4, 8 + R() * 5]];
  const mY = cy + 18 + R() * 4, mRX = drowned ? 5 + R() * 3 : 7 + R() * 6, mRY = drowned ? 6 + R() * 4 : 12 + R() * 9;
  const pupils = !drowned && R() < 0.6, tilt = (R() - 0.5) * 0.25;
  const SK = drowned ? [130, 168, 170] : [185, 178, 160];
  // hair: strands hanging from the top of the head, over the face
  const hair = [];
  if (drowned) for (let q = 0; q < 10; q++) hair.push([cx - rx + R() * rx * 2, cy - ry + R() * 12 + 30 + R() * 34, 1 + Math.floor(R() * 2)]);
  const inE = (x, y, e) => ((x - e[0]) / e[2]) ** 2 + ((y - e[1]) / e[3]) ** 2;
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const o = (y * FW + x) * 4;
    const tx = x - cx + (y - cy) * tilt, ny = (y - cy) / ry, nx = tx / (rx * (1 - 0.25 * Math.max(0, ny)));
    const f = nx * nx + ny * ny;
    let r = 0, g = 0, b = 0, a = 0;
    if (f < 1 + (R() - 0.5) * 0.06) {
      const shade = 0.55 + 0.45 * (1 - f) - 0.15 * Math.max(0, ny), blot = R() < (drowned ? 0.14 : 0.06) ? (drowned ? 0.62 : 0.75) : 1;
      r = SK[0] * shade * blot; g = SK[1] * shade * blot; b = SK[2] * shade * blot; a = 255;
      if (drowned && blot < 1) { r *= 0.8; b *= 1.25; }        // bruising where it has been in the water too long
      for (const e of eyes) {
        const k = inE(x, y, e);
        if (k < 1) { if (drowned) { const m = 0.78 + 0.22 * (1 - k); r = 205 * m; g = 214 * m; b = 208 * m; } else { r = g = b = 6; } }
        else if (k < 1.7) { const s = 0.4 + 0.35 * (k - 1); r *= s; g *= s; b *= s; }
        if (!drowned && y > e[1] && Math.abs(x - e[0] + (y - e[1]) * 0.1) < 1.2 && y < e[1] + e[3] + 14 && R() < 0.85) { r *= 0.35; g *= 0.3; b *= 0.3; }
      }
      const m = ((x - cx) / mRX) ** 2 + ((y - mY) / mRY) ** 2;
      if (m < 1) { r = 4; g = 2; b = 2; }
      else if (m < 1.35) { r *= 0.45; g *= 0.4; b *= 0.4; }
      if (Math.abs(y - (cy + 4)) < 2 && Math.abs(Math.abs(x - cx) - 2) < 1) { r *= 0.3; g *= 0.3; b *= 0.3; }
    }
    // the hair, black and wet, over everything
    for (const h of hair) {
      const top = cy - ry - 2, wave = Math.sin(y * 0.2 + h[0]) * 2;
      if (y >= top && y < h[1] && Math.abs(x - h[0] - wave) < h[2]) { r = 12; g = 16; b = 14; a = 255; }
    }
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
  }
  if (!drowned) for (let x = Math.floor(cx - mRX + 1); x < cx + mRX - 1; x += 2) { // teeth, uneven
    const w = Math.sqrt(Math.max(0, 1 - ((x - cx) / mRX) ** 2)) * mRY;
    for (const [y0, dir] of [[mY - w, 1], [mY + w, -1]]) {
      const len = 2 + Math.floor(R() * 4);
      for (let q = 0; q < len; q++) {
        const y = Math.round(y0 + dir * q), o = (y * FW + x) * 4;
        if (y < 0 || y >= FH) continue;
        d[o] = 215; d[o + 1] = 205; d[o + 2] = 170; d[o + 3] = 255;
      }
    }
  }
  if (pupils) for (const e of eyes) {
    const px = Math.round(e[0] + (R() - 0.5) * 3), py = Math.round(e[1] + (R() - 0.5) * 3);
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) { const o = ((py + b) * FW + px + a) * 4; d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = 255; }
  }
  return d;
}

const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };

// one frame: shifted lines, grain, a band of nothing now and then; the drowned one wavers and trails bubbles,
// the one outside is printed in negative over a field of stars
export function drawFace(ctx, base, t, look = 'dry') {
  const img = ctx.createImageData(FW, FH), d = img.data, drowned = look === 'drowned', neg = look === 'void';
  for (let y = 0; y < FH; y++) {
    let shift = Math.random() < 0.08 ? Math.floor((Math.random() - 0.5) * 10) : 0;
    if (drowned) shift += Math.round(Math.sin(y * 0.22 + t * 11) * 1.4);
    const dead = Math.random() < 0.03;
    for (let x = 0; x < FW; x++) {
      const sx = Math.min(FW - 1, Math.max(0, x + shift)), si = (y * FW + sx) * 4, o = (y * FW + x) * 4;
      const n = (Math.random() - 0.5) * 70;
      if (dead) { d[o] = d[o + 1] = d[o + 2] = 20 + Math.random() * 40; d[o + 3] = 255; continue; }
      let r = base[si], g = base[si + 1], b = base[si + 2], a = base[si + 3];
      if (neg) {
        if (a) { const l = 255 - (r + g + b) / 3; r = l * 0.75; g = l * 0.55; b = l; }
        else if (hash(x, y) > 0.985) { r = g = b = 200 + 55 * Math.sin(t * 20 + x); a = 255; }
      }
      if (drowned && a) { r *= 0.85; b *= 1.08; }
      d[o] = r + n; d[o + 1] = g + n; d[o + 2] = b + n * 0.9; d[o + 3] = a ? 255 : 0;
    }
  }
  if (drowned) for (let q = 0; q < 14; q++) { // bubbles going up past it
    const x = Math.floor(hash(q, 3) * FW), y = Math.floor((hash(q, 7) * FH - t * (40 + q * 4)) % FH + FH) % FH;
    for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const o = ((y + b) * FW + x + a) * 4; if (o < d.length - 3) { d[o] = 200; d[o + 1] = 235; d[o + 2] = 240; d[o + 3] = 255; } }
  }
  ctx.putImageData(img, 0, 0);
}

// The eye outside: it opens all at once, violet, the pupil full of stars, and looks straight at you.
export function drawEye(ctx, t) {
  const img = ctx.createImageData(FW, FH), d = img.data;
  const open = t < 0.07 ? t / 0.07 : t > 0.5 ? Math.max(0, 1 - (t - 0.5) * 8) : 1;
  const pr = 0.13 + 0.05 * Math.sin(t * 40) * (t < 0.25 ? 1 : 0.2); // the pupil snaps wide, then narrows on you
  const cx = FW / 2 + Math.sin(t * 60) * 0.6, cy = FH / 2;
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const o = (y * FW + x) * 4, nx = (x - cx) / 34, ny = (y - cy) / 34;
    let r = 0, g = 0, b = 0;
    if (hash(x, y) > 0.99) r = g = b = 160;
    const lid = (1 - nx * nx) * 0.62 * open;
    if (Math.abs(nx) < 1 && Math.abs(ny) < lid) {
      const rr = Math.hypot(nx, ny), ang = Math.atan2(ny, nx);
      const edge = Math.abs(ny) / Math.max(0.01, lid);
      r = 222; g = 214; b = 200;
      const vein = Math.sin(ang * 13 + rr * 30) > 0.93 && rr > 0.45;
      if (vein) { r = 170; g = 30; b = 30; }
      r *= 1 - 0.55 * edge * edge; g *= 1 - 0.6 * edge * edge; b *= 1 - 0.55 * edge * edge;
      if (rr < 0.42) { // iris, streaked
        const s = 0.6 + 0.4 * Math.sin(ang * 23 + rr * 10);
        r = (90 + 70 * (1 - rr / 0.42)) * s; g = (30 + 30 * s) * s; b = (170 + 70 * (1 - rr / 0.42)) * s;
        if (rr > 0.38) { r *= 0.3; g *= 0.3; b *= 0.4; }
      }
      if (rr < pr) { r = g = b = 0; if (hash(x + 9, y + 3) > 0.9) { r = 210; g = 200; b = 255; } }
      if (Math.hypot(nx + 0.12, ny + 0.12) < 0.05) { r = g = b = 255; } // the wet highlight
    }
    const n = (Math.random() - 0.5) * 40;
    d[o] = r + n; d[o + 1] = g + n; d[o + 2] = b + n; d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
