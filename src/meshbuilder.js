import * as THREE from 'three';

// Scratch buffers the caller fills before each quad:
// QL = baked light rgb for 4 vertices, QD = (flicker amount, flicker phase, sky exposure, caustics) x 4
export const QL = new Float32Array(12);
export const QD = new Float32Array(16);
// QT = albedo tint rgb for 4 vertices; goes back to white after every quad
export const QT = new Float32Array(12).fill(1);
// QA = opacity for 4 vertices (only overlay layers use it); goes back to 1 after every quad
export const QA = new Float32Array(4).fill(1);

export function setFlat(r, g, b, d0 = 0, d1 = 0, d2 = 0, d3 = 0) {
  for (let v = 0; v < 4; v++) {
    QL[v * 3] = r; QL[v * 3 + 1] = g; QL[v * 3 + 2] = b;
    QD[v * 4] = d0; QD[v * 4 + 1] = d1; QD[v * 4 + 2] = d2; QD[v * 4 + 3] = d3;
  }
}

export class MB {
  constructor() {
    this.p = []; this.n = []; this.u = []; this.l = []; this.d = []; this.t = []; this.a = []; this.ix = []; this.c = 0;
  }

  // Vertices a,b,c,d go around the quad; winding is fixed up to match the normal.
  quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, ua, va, ub, vb, uc, vc, ud, vd) {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = dx - ax, e2y = dy - ay, e2z = dz - az;
    const flip = (e1y * e2z - e1z * e2y) * nx + (e1z * e2x - e1x * e2z) * ny + (e1x * e2y - e1y * e2x) * nz < 0;
    const p = this.p, u = this.u, l = this.l, d = this.d, t = this.t;
    if (flip) {
      t.push(QT[0], QT[1], QT[2], QT[9], QT[10], QT[11], QT[6], QT[7], QT[8], QT[3], QT[4], QT[5]);
      this.a.push(QA[0], QA[3], QA[2], QA[1]);
      p.push(ax, ay, az, dx, dy, dz, cx, cy, cz, bx, by, bz);
      u.push(ua, va, ud, vd, uc, vc, ub, vb);
      l.push(QL[0], QL[1], QL[2], QL[9], QL[10], QL[11], QL[6], QL[7], QL[8], QL[3], QL[4], QL[5]);
      d.push(QD[0], QD[1], QD[2], QD[3], QD[12], QD[13], QD[14], QD[15], QD[8], QD[9], QD[10], QD[11], QD[4], QD[5], QD[6], QD[7]);
    } else {
      p.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
      u.push(ua, va, ub, vb, uc, vc, ud, vd);
      for (let q = 0; q < 12; q++) { l.push(QL[q]); t.push(QT[q]); }
      this.a.push(QA[0], QA[1], QA[2], QA[3]);
      for (let q = 0; q < 16; q++) d.push(QD[q]);
    }
    QT.fill(1); QA.fill(1);
    this.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    const c = this.c;
    this.ix.push(c, c + 1, c + 2, c, c + 2, c + 3);
    this.c += 4;
  }

  // Axis-aligned box with world-space UVs; uses whatever is in QL/QD.
  box(x0, y0, z0, x1, y1, z1, S) {
    const a = x0 / S, b = x1 / S, c = y0 / S, d = y1 / S, e = z0 / S, f = z1 / S;
    this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, e, c, f, c, f, d, e, d);
    this.quad(x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0, 1, 0, 0, e, c, f, c, f, d, e, d);
    this.quad(x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, 0, 0, -1, a, c, b, c, b, d, a, d);
    this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, a, c, b, c, b, d, a, d);
    this.quad(x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1, 0, 1, 0, a, e, b, e, b, f, a, f);
    this.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0, a, e, b, e, b, f, a, f);
  }

  // Flat-coloured box (palette uv), lit by one colour with simple per-face shading.
  cbox(x0, y0, z0, x1, y1, z1, u, v, r, g, b, sky, caust, fl = 0, ph = 0) {
    const sh = [0.8, 0.8, 0.88, 0.88, 1, 0.6];
    for (let f = 0; f < 6; f++) {
      const s = sh[f];
      setFlat(r * s, g * s, b * s, fl, ph, sky, caust);
      if (f === 0) this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, u, v, u, v, u, v, u, v);
      else if (f === 1) this.quad(x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0, 1, 0, 0, u, v, u, v, u, v, u, v);
      else if (f === 2) this.quad(x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, 0, 0, -1, u, v, u, v, u, v, u, v);
      else if (f === 3) this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, u, v, u, v, u, v, u, v);
      else if (f === 4) this.quad(x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1, 0, 1, 0, u, v, u, v, u, v, u, v);
      else this.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0, u, v, u, v, u, v, u, v);
    }
  }

  build() {
    if (!this.c) return null;
    const g = new THREE.BufferGeometry();
    // one interleaved vertex buffer (position 3, normal 3, uv 2, light 3, data 4) instead of five GPU buffers per mesh
    const nv = this.c, S = 19, a = new Float32Array(nv * S), al = this.a;
    const p = this.p, n = this.n, u = this.u, l = this.l, d = this.d, tn = this.t;
    for (let v = 0; v < nv; v++) {
      const o = v * S, v3 = v * 3, v2 = v * 2, v4 = v * 4;
      a[o] = p[v3]; a[o + 1] = p[v3 + 1]; a[o + 2] = p[v3 + 2];
      a[o + 3] = n[v3]; a[o + 4] = n[v3 + 1]; a[o + 5] = n[v3 + 2];
      a[o + 6] = u[v2]; a[o + 7] = u[v2 + 1];
      a[o + 8] = l[v3]; a[o + 9] = l[v3 + 1]; a[o + 10] = l[v3 + 2];
      a[o + 11] = d[v4]; a[o + 12] = d[v4 + 1]; a[o + 13] = d[v4 + 2]; a[o + 14] = d[v4 + 3];
      a[o + 15] = tn[v3]; a[o + 16] = tn[v3 + 1]; a[o + 17] = tn[v3 + 2]; a[o + 18] = al[v];
    }
    const ib = new THREE.InterleavedBuffer(a, S);
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(ib, 3, 3));
    g.setAttribute('uv', new THREE.InterleavedBufferAttribute(ib, 2, 6));
    g.setAttribute('aLight', new THREE.InterleavedBufferAttribute(ib, 3, 8));
    g.setAttribute('aData', new THREE.InterleavedBufferAttribute(ib, 4, 11));
    g.setAttribute('aTint', new THREE.InterleavedBufferAttribute(ib, 4, 15));
    g.setIndex(new THREE.BufferAttribute(this.c > 65535 ? new Uint32Array(this.ix) : new Uint16Array(this.ix), 1));
    return g;
  }
}
