// Pose math for props, shared by the generator (colliders) and the mesher
// (geometry), so that what you bump into is exactly what you see.
import { PROPS } from './propdefs.js';

const SX = [-1, 1, -1, 1, -1, 1, -1, 1], SY = [-1, -1, 1, 1, -1, -1, 1, 1], SZ = [-1, -1, -1, -1, 1, 1, 1, 1];
const R = new Float64Array(9);

// Row-major 3x3: R = Rtilt(axis in the floor plane) * Ry(yaw) * Rflip(upside down)
export function poseRotation(spec, out = R) {
  const cy = Math.cos(spec.yaw), sy = Math.sin(spec.yaw), f = spec.flip ? -1 : 1;
  const m00 = cy * f, m02 = sy, m11 = f, m20 = -sy * f, m22 = cy;
  if (!spec.tilt) {
    out[0] = m00; out[1] = 0; out[2] = m02; out[3] = 0; out[4] = m11; out[5] = 0; out[6] = m20; out[7] = 0; out[8] = m22;
    return out;
  }
  const ax = Math.cos(spec.tiltDir), az = Math.sin(spec.tiltDir), c = Math.cos(spec.tilt), s = Math.sin(spec.tilt), k = 1 - c;
  const t00 = c + k * ax * ax, t01 = -s * az, t02 = k * ax * az;
  const t10 = s * az, t11 = c, t12 = -s * ax;
  const t20 = k * ax * az, t21 = s * ax, t22 = c + k * az * az;
  out[0] = t00 * m00 + t02 * m20; out[1] = t01 * m11; out[2] = t00 * m02 + t02 * m22;
  out[3] = t10 * m00 + t12 * m20; out[4] = t11 * m11; out[5] = t10 * m02 + t12 * m22;
  out[6] = t20 * m00 + t22 * m20; out[7] = t21 * m11; out[8] = t20 * m02 + t22 * m22;
  return out;
}

// World-space corners (8 per box) of a posed prop. `R` is a shared buffer.
export function poseProp(spec, boxes = PROPS[spec.type].boxes(spec.variant)) {
  const m = poseRotation(spec), s = spec.s, n = boxes.length;
  const out = new Float32Array(n * 24);
  let minY = 1e9, maxY = -1e9;
  for (let bi = 0; bi < n; bi++) {
    const b = boxes[bi];
    for (let c = 0; c < 8; c++) {
      const lx = (b[0] + SX[c] * b[3] * 0.5) * s, ly = (b[1] + SY[c] * b[4] * 0.5) * s, lz = (b[2] + SZ[c] * b[5] * 0.5) * s;
      const o = bi * 24 + c * 3;
      const wy = m[3] * lx + m[4] * ly + m[5] * lz + spec.y;
      out[o] = m[0] * lx + m[1] * ly + m[2] * lz + spec.x;
      out[o + 1] = wy;
      out[o + 2] = m[6] * lx + m[7] * ly + m[8] * lz + spec.z;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }
  }
  let shift = 0;
  if (spec.mode === 'ceil') shift = spec.cy - maxY;
  else if (spec.mode === 'ground') shift = spec.fy - minY - spec.sink * (maxY - minY);
  if (shift) for (let o = 1; o < out.length; o += 3) out[o] += shift;
  return { corners: out, n, boxes, R: m };
}

// One axis-aligned box per part: exact for upright and quarter-turn poses.
export function propAABBs(spec) {
  const { corners, n } = poseProp(spec), out = new Float32Array(n * 6);
  for (let bi = 0; bi < n; bi++) {
    let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
    for (let c = 0; c < 8; c++) {
      const o = bi * 24 + c * 3, x = corners[o], y = corners[o + 1], z = corners[o + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const o = bi * 6;
    out[o] = x0; out[o + 1] = y0; out[o + 2] = z0; out[o + 3] = x1; out[o + 4] = y1; out[o + 5] = z1;
  }
  return out;
}

export function propBounds(spec) {
  const a = propAABBs(spec), b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
  for (let o = 0; o < a.length; o += 6) {
    for (let q = 0; q < 3; q++) { if (a[o + q] < b[q]) b[q] = a[o + q]; if (a[o + 3 + q] > b[3 + q]) b[3 + q] = a[o + 3 + q]; }
  }
  return b;
}
