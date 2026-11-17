// Small pictures of the things you carry, drawn from the same block models as the 3D items:
// every box is turned to a three-quarter view, its visible faces sorted back to front and painted
// onto a 2D canvas. No GPU work, made once per item and kept as an image URL.
import { ITEMS } from './items.js';

const SX = [-1, 1, -1, 1, -1, 1, -1, 1], SY = [-1, -1, 1, 1, -1, -1, 1, 1], SZ = [-1, -1, -1, -1, 1, 1, 1, 1];
const FACES = [[0, 4, 6, 2, -1, 0, 0], [1, 3, 7, 5, 1, 0, 0], [0, 1, 5, 4, 0, -1, 0], [2, 6, 7, 3, 0, 1, 0], [0, 2, 3, 1, 0, 0, -1], [4, 5, 7, 6, 0, 0, 1]];
// how each one is best seen: turn about the vertical, tilt toward you, and the shape of the picture
const VIEW = {
  shotgun: { yaw: 1.5, pitch: 0.3, roll: 0.16, w: 2.8 },
  shells: { yaw: 0.35, pitch: 0.55 },
  medkit: { yaw: 0.45, pitch: 0.38 },
  key: { yaw: 0.25, pitch: 0.15, roll: -0.6 },
  flare: { yaw: 0.4, pitch: 0.3, roll: 0.7 },
  cassette: { yaw: 0.3, pitch: 0.25 },
};
const LX = 0.35, LY = 0.85, LZ = 0.4;
// the radar also points at doors, hatches and machines; these are their little models
const oct = (cy, h, r, c) => [[0, cy, 0, 2 * r, h, 1.2 * r, ...c], [0, cy, 0, 1.2 * r, h, 2 * r, ...c], [0, cy, 0, 1.7 * r, h, 1.7 * r, ...c]];
const RED = [1.0, 0.15, 0.12], YEL = [1.0, 0.8, 0.15], BLK = [0.08, 0.08, 0.09], GRY = [0.42, 0.44, 0.47];
const EXTRA = {
  hatch: { boxes: [[0, -0.02, 0, 0.44, 0.02, 0.44, ...YEL], [-0.16, -0.008, -0.16, 0.08, 0.01, 0.08, ...BLK], [0.16, -0.008, 0.16, 0.08, 0.01, 0.08, ...BLK], [0.16, -0.008, -0.16, 0.08, 0.01, 0.08, ...BLK], [-0.16, -0.008, 0.16, 0.08, 0.01, 0.08, ...BLK],
    ...oct(0.02, 0.06, 0.16, [0.3, 0.31, 0.34]), ...oct(0.055, 0.02, 0.12, [0.55, 0.56, 0.6]), [0, 0.09, 0, 0.22, 0.015, 0.02, ...RED], [0, 0.09, 0, 0.02, 0.015, 0.22, ...RED],
    [0, 0.09, 0.11, 0.15, 0.02, 0.02, ...RED], [0, 0.09, -0.11, 0.15, 0.02, 0.02, ...RED], [0.11, 0.09, 0, 0.02, 0.02, 0.15, ...RED], [-0.11, 0.09, 0, 0.02, 0.02, 0.15, ...RED], [0, 0.085, 0, 0.04, 0.03, 0.04, ...GRY]] },
  stardoor: { boxes: [[-0.11, 0, 0, 0.05, 0.4, 0.06, ...BLK], [0.11, 0, 0, 0.05, 0.4, 0.06, ...BLK], [0, 0.2, 0, 0.27, 0.05, 0.06, ...BLK], [0, 0.24, 0, 0.14, 0.04, 0.05, ...BLK],
    [0, 0, 0, 0.17, 0.38, 0.02, 0.32, 0.12, 0.95], [0, 0.05, 0.012, 0.1, 0.05, 0.004, 0.6, 0.2, 0.7], [0.03, -0.08, 0.012, 0.08, 0.04, 0.004, 0.2, 0.25, 0.9],
    ...[[-0.04, 0.12], [0.05, 0.08], [-0.02, -0.03], [0.04, -0.12], [-0.05, -0.1], [0.01, 0.15]].map(([x, y]) => [x, y, 0.014, 0.014, 0.014, 0.004, 1.6, 1.6, 1.8])] },
  door: { boxes: [[0, 0, -0.01, 0.4, 0.42, 0.04, 0.74, 0.69, 0.57], [0, -0.03, 0.012, 0.15, 0.32, 0.01, 1.6, 1.2, 0.7], [-0.085, -0.03, 0.015, 0.02, 0.34, 0.012, 0.42, 0.3, 0.18], [0.085, -0.03, 0.015, 0.02, 0.34, 0.012, 0.42, 0.3, 0.18],
    [0, 0.14, 0.015, 0.19, 0.02, 0.012, 0.42, 0.3, 0.18], [0.11, -0.03, 0.08, 0.012, 0.32, 0.13, 0.42, 0.3, 0.18], [0, 0.185, 0.015, 0.03, 0.03, 0.006, 1.05, 0.78, 0.26], [0, -0.2, 0.06, 0.16, 0.012, 0.08, 0.55, 0.42, 0.26]] },
  exit: { boxes: [[0, 0, 0, 0.3, 0.42, 0.04, 1.6, 1.55, 1.4], [-0.075, 0, 0.022, 0.13, 0.4, 0.01, 0.9, 0.9, 0.86], [0.075, 0, 0.022, 0.13, 0.4, 0.01, 0.9, 0.9, 0.86], [-0.17, 0.02, 0.01, 0.04, 0.46, 0.06, 0.8, 0.78, 0.72], [0.17, 0.02, 0.01, 0.04, 0.46, 0.06, 0.8, 0.78, 0.72],
    [0, 0.24, 0.01, 0.4, 0.05, 0.07, 0.8, 0.78, 0.72], [-0.018, -0.02, 0.03, 0.01, 0.07, 0.01, ...YEL], [0.018, -0.02, 0.03, 0.01, 0.07, 0.01, ...YEL],
    ...[0.06, 0.1, 0.14].map(y => [0, y, 0.028, 0.025, 0.025, 0.006, 0.3, 0.6, 1.1])] },
  terminal: { boxes: [[0, 0.06, 0, 0.3, 0.24, 0.24, 0.72, 0.68, 0.58], [0, 0.07, 0.122, 0.22, 0.16, 0.006, 0.15, 0.9, 0.4], [0, 0.11, 0.126, 0.14, 0.012, 0.003, 0.5, 1.4, 0.7], [-0.02, 0.08, 0.126, 0.16, 0.012, 0.003, 0.5, 1.4, 0.7], [0.01, 0.05, 0.126, 0.1, 0.012, 0.003, 0.5, 1.4, 0.7],
    [0, -0.07, 0.02, 0.12, 0.03, 0.12, 0.6, 0.57, 0.5], [0, -0.1, 0.2, 0.34, 0.025, 0.12, 0.66, 0.63, 0.55], [0, -0.085, 0.2, 0.3, 0.008, 0.09, 0.3, 0.3, 0.3]] },
  fusebox: { boxes: [[0, 0, 0, 0.28, 0.36, 0.1, ...GRY], [0, 0, 0.052, 0.22, 0.3, 0.006, 0.2, 0.21, 0.23], [-0.05, 0.04, 0.058, 0.04, 0.12, 0.012, 0.85, 0.84, 0.78], [0.05, 0.04, 0.058, 0.04, 0.12, 0.012, 0.1, 0.1, 0.1],
    [0, -0.1, 0.058, 0.1, 0.05, 0.006, ...YEL], [0, -0.1, 0.062, 0.03, 0.04, 0.004, ...BLK], [0.17, 0, 0.1, 0.012, 0.32, 0.1, ...GRY]] },
  radio: { boxes: [[0, 0, 0, 0.34, 0.2, 0.14, 0.45, 0.25, 0.12], [-0.07, 0, 0.072, 0.14, 0.15, 0.006, 0.2, 0.15, 0.1], [0.09, 0.03, 0.072, 0.1, 0.05, 0.006, 1.5, 1.1, 0.5], [0.09, -0.05, 0.075, 0.04, 0.04, 0.01, 0.75, 0.7, 0.6],
    ...[-0.04, 0, 0.04].map(y => [-0.07, y, 0.076, 0.12, 0.008, 0.004, 0.08, 0.06, 0.05]), [0.12, 0.2, -0.03, 0.008, 0.22, 0.008, 0.7, 0.7, 0.72], [0.12, 0.31, -0.03, 0.016, 0.016, 0.016, 0.8, 0.8, 0.8]] },
};
const VIEW2 = { hatch: { yaw: 0.6, pitch: 0.75 }, stardoor: { yaw: 0.35, pitch: 0.12 }, door: { yaw: 0.4, pitch: 0.12 }, exit: { yaw: 0.3, pitch: 0.12 }, terminal: { yaw: 0.45, pitch: 0.3 }, fusebox: { yaw: 0.4, pitch: 0.15 }, radio: { yaw: 0.45, pitch: 0.25 },
  shotgun_wet: { yaw: 1.5, pitch: 0.3, roll: 0.16, w: 2.8 }, shotgun_sealed: { yaw: 1.5, pitch: 0.3, roll: 0.16, w: 2.8 } };
const cache = {};

export function itemIcon(type, h = 64) {
  const ck = type + ':' + h;
  if (cache[ck]) return cache[ck];
  const def = ITEMS[type] || EXTRA[type], V = VIEW[type] || VIEW2[type] || { yaw: 0.6, pitch: 0.4 };
  const w = Math.round(h * (V.w || 1));
  const cy = Math.cos(V.yaw), sy = Math.sin(V.yaw), cp = Math.cos(V.pitch), sp = Math.sin(V.pitch), cr = Math.cos(V.roll || 0), sr = Math.sin(V.roll || 0);
  // world -> view: yaw about y, pitch about x, then roll in the picture plane; z comes toward you
  const tf = (x, y, z, o) => {
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    o[0] = x1 * cr - y2 * sr; o[1] = x1 * sr + y2 * cr; o[2] = z2;
    return o;
  };
  const polys = [], P = [0, 0, 0], N = [0, 0, 0];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const b of def.boxes) {
    const pts = [];
    for (let q = 0; q < 8; q++) pts.push(tf(b[0] + SX[q] * b[3] / 2, b[1] + SY[q] * b[4] / 2, b[2] + SZ[q] * b[5] / 2, [0, 0, 0]));
    for (const f of FACES) {
      tf(f[4], f[5], f[6], N);
      if (N[2] <= 0.001) continue; // facing away
      const light = 0.55 + 0.5 * Math.max(0, f[4] * LX + f[5] * LY + f[6] * LZ);
      const c = [b[6], b[7], b[8]].map(v => Math.round(255 * Math.min(1, v * light)));
      const poly = [pts[f[0]], pts[f[1]], pts[f[2]], pts[f[3]]];
      let z = 0;
      for (const p of poly) { z += p[2]; x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      // sort by the middle of the face, nudged by the middle of its box so thin overlays sit on top
      polys.push({ poly, z: z / 4 + tf(b[0], b[1], b[2], P)[2] * 0.25, col: `rgb(${c[0]},${c[1]},${c[2]})` });
    }
  }
  polys.sort((a, b) => a.z - b.z);
  const pad = Math.max(3, h * 0.08), k = Math.min((w - pad * 2) / (x1 - x0), (h - pad * 2) / (y1 - y0));
  const ox = (w - (x1 - x0) * k) / 2 - x0 * k, oy = (h - (y1 - y0) * k) / 2 + y1 * k;
  const art = document.createElement('canvas'); art.width = w; art.height = h;
  const g = art.getContext('2d');
  g.lineJoin = 'round'; g.lineWidth = 0.7;
  for (const p of polys) {
    g.beginPath();
    p.poly.forEach((v, i) => (i ? g.lineTo : g.moveTo).call(g, ox + v[0] * k, oy - v[1] * k));
    g.closePath(); g.fillStyle = p.col; g.strokeStyle = p.col; g.fill(); g.stroke();
  }
  // a dark rim so it reads against any background
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const o = out.getContext('2d');
  o.shadowColor = 'rgba(0,0,0,0.9)'; o.shadowBlur = Math.max(2, h * 0.06);
  o.drawImage(art, 0, 0);
  return (cache[ck] = out.toDataURL());
}

// an <img> tag for the HUD
export function iconTag(type, h, cls = '') {
  return `<img class="ico ${cls}" src="${itemIcon(type, h * 2)}" style="height:${h}px" alt="">`;
}
