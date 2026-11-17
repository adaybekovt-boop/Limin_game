// Turns prop specs from the generator into geometry, and animates the few
// that refuse to stay still (the ones that creep, and the ones that tremble).
import * as THREE from 'three';
import { PROPS } from './propdefs.js';
import { MB, QL, QD } from './meshbuilder.js';
import { poseProp } from './pose.js';

const YAX = new THREE.Vector3(0, 1, 0);
const SX = [-1, 1, -1, 1, -1, 1, -1, 1], SY = [-1, -1, 1, 1, -1, -1, 1, 1], SZ = [-1, -1, -1, -1, 1, 1, 1, 1];
// faces: 4 corner indices + local normal
const FACES = [
  [0, 4, 6, 2, -1, 0, 0], [1, 3, 7, 5, 1, 0, 0],
  [0, 1, 5, 4, 0, -1, 0], [2, 6, 7, 3, 0, 1, 0],
  [0, 2, 3, 1, 0, 0, -1], [4, 5, 7, 6, 0, 0, 1],
];

// local = true: leave the geometry in the prop's own space (the mesh carries the pose)
function emit(mb, mbGlow, spec, light, sky, caust, local) {
  const boxes = PROPS[spec.type].boxes(spec.variant);
  let corners, m = null;
  if (local) {
    corners = new Float32Array(boxes.length * 24);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (let c = 0; c < 8; c++) {
        const o = bi * 24 + c * 3;
        corners[o] = b[0] + SX[c] * b[3] * 0.5; corners[o + 1] = b[1] + SY[c] * b[4] * 0.5; corners[o + 2] = b[2] + SZ[c] * b[5] * 0.5;
      }
    }
  } else {
    const P = poseProp(spec, boxes);
    corners = P.corners; m = P.R;
  }
  for (let bi = 0; bi < boxes.length; bi++) {
    const b = boxes[bi], glow = b[7], target = glow ? mbGlow : mb;
    if (!target) continue;
    const u = ((b[6] % 8) + 0.5) / 8, v = (Math.floor(b[6] / 8) + 0.5) / 8, base = bi * 24;
    for (const f of FACES) {
      let nx = f[4], ny = f[5], nz = f[6];
      if (m) {
        const x = m[0] * nx + m[1] * ny + m[2] * nz, y = m[3] * nx + m[4] * ny + m[5] * nz, z = m[6] * nx + m[7] * ny + m[8] * nz;
        nx = x; ny = y; nz = z;
      }
      const sh = glow ? 1 : 0.7 + 0.3 * ny;
      for (let q = 0; q < 4; q++) {
        if (glow) { QL[q * 3] = glow[0]; QL[q * 3 + 1] = glow[1]; QL[q * 3 + 2] = glow[2]; }
        else { QL[q * 3] = light[0] * sh; QL[q * 3 + 1] = light[1] * sh; QL[q * 3 + 2] = light[2] * sh; }
        QD[q * 4] = 0; QD[q * 4 + 1] = 0; QD[q * 4 + 2] = sky; QD[q * 4 + 3] = glow ? 0 : caust;
      }
      const a = base + f[0] * 3, c = base + f[1] * 3, d = base + f[2] * 3, e = base + f[3] * 3;
      target.quad(corners[a], corners[a + 1], corners[a + 2], corners[c], corners[c + 1], corners[c + 2],
        corners[d], corners[d + 1], corners[d + 2], corners[e], corners[e + 1], corners[e + 2],
        nx, ny, nz, u, v, u, v, u, v, u, v);
    }
  }
}

export function emitProp(mb, mbGlow, spec, light, sky, caust) {
  emit(mb, mbGlow, spec, light, sky, caust, false);
}

// dyn: 2 creeps toward you while unobserved, 3 trembles. Both stand on the floor and are solid.
export function makeDynProp(spec, light, sky, caust, mats) {
  const mb = new MB();
  emit(mb, null, spec, light, sky, caust, true);
  const mesh = new THREE.Mesh(mb.build(), mats.prop);
  mesh.position.set(spec.x, spec.y, spec.z);
  mesh.quaternion.setFromAxisAngle(YAX, spec.yaw);
  mesh.scale.setScalar(spec.s);
  const r = (spec.seed % 1000) / 1000, def = PROPS[spec.type];
  mesh.userData = {
    spec, kind: spec.dyn, x: spec.x, y: spec.y, z: spec.z, yaw: spec.yaw, ph: r * 6.2832, r, snap: 0, moved: 0,
    half: Math.max(def.hx, def.hz) * spec.s, h: def.h * spec.s,
    box: { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, owner: null },
  };
  return mesh;
}

// Returns true if the prop just crept closer (so the world can make a sound).
export function updateDynProp(mesh, dt, t, cam, camDir, world) {
  const d = mesh.userData;
  let crept = false;
  if (d.kind === 2) { // creeps toward you while unobserved; always ends up facing you
    const dx = cam.x - d.x, dz = cam.z - d.z, dist = Math.hypot(dx, dz);
    if (dist < 34 && dist > 0.01 && (-dx * camDir.x - dz * camDir.z) / dist <= 0.45) {
      d.yaw = Math.atan2(dx, dz);
      mesh.quaternion.setFromAxisAngle(YAX, d.yaw);
      if (dist > d.half + 1.6) {
        const step = 1.5 * dt, nx = d.x + (dx / dist) * step, nz = d.z + (dz / dist) * step;
        if (!world.collides(nx, d.y + 0.05, nz, 0.3, 0.9)) {
          d.x = nx; d.z = nz; mesh.position.x = nx; mesh.position.z = nz;
          d.moved += step;
          if (d.moved > 1.2) { d.moved = 0; crept = true; }
        }
      }
    }
  } else { // trembling, with sudden quarter turns
    mesh.position.set(d.x + Math.sin(t * 71 + d.ph) * 0.012, d.y, d.z + Math.cos(t * 83 + d.ph) * 0.012);
    d.snap -= dt;
    if (d.snap <= 0) {
      d.snap = 1.5 + 5 * Math.abs(Math.sin(t * 3.1 + d.ph));
      d.yaw += 1.5708;
      mesh.quaternion.setFromAxisAngle(YAX, d.yaw);
    }
  }
  const b = d.box;
  b.x0 = d.x - d.half; b.x1 = d.x + d.half; b.z0 = d.z - d.half; b.z1 = d.z + d.half; b.y0 = d.y; b.y1 = d.y + d.h;
  return crept;
}
