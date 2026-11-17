// Tiny seeded neural networks used as generative models at runtime.
// Nothing here is trained: weights are drawn from a seed and the networks are
// used CPPN-style, as smooth, structured functions that turn coordinates and
// latent codes into architecture, textures, creatures and object poses.

export function hash32(a, b = 0, c = 0, d = 0) {
  let h = 0x9e3779b9 ^ Math.imul(a | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35) ^ Math.imul(b | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 13), 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) ^ Math.imul(d | 0, 0xc2b2ae3d);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

export const rand01 = (a, b, c, d) => hash32(a, b, c, d) * 2.3283064365386963e-10;

export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rng) {
  let u = 0;
  while (u < 1e-9) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307179586 * rng());
}

// Dense feed-forward net. Hidden activations are tanh, or a CPPN mix of
// tanh / sin / gaussian. Output layer is always tanh, so outputs are in [-1, 1].
export class Net {
  constructor(sizes, rng, { gain = 1.6, bias = 0.4, cppn = false } = {}) {
    this.layers = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const nIn = sizes[l], nOut = sizes[l + 1];
      const W = new Float32Array(nIn * nOut), B = new Float32Array(nOut), A = new Uint8Array(nOut);
      const s = gain / Math.sqrt(nIn);
      for (let k = 0; k < W.length; k++) W[k] = gauss(rng) * s;
      const last = l === sizes.length - 2;
      for (let k = 0; k < nOut; k++) {
        B[k] = gauss(rng) * bias;
        A[k] = cppn && !last ? Math.floor(rng() * 3) : 0;
      }
      this.layers.push({ W, B, A, nIn, nOut, out: new Float32Array(nOut) });
    }
  }

  // Returns an internal buffer: copy it if you need to keep the values.
  forward(x) {
    let inp = x;
    for (let l = 0; l < this.layers.length; l++) {
      const L = this.layers[l];
      const W = L.W, B = L.B, A = L.A, nIn = L.nIn, nOut = L.nOut, out = L.out;
      for (let o = 0, w = 0; o < nOut; o++) {
        let s = B[o];
        for (let i = 0; i < nIn; i++, w++) s += W[w] * inp[i];
        const a = A[o];
        out[o] = a === 0 ? Math.tanh(s) : a === 1 ? Math.sin(s * 1.5) : 2 * Math.exp(-s * s) - 1;
      }
      inp = out;
    }
    return inp;
  }
}

// A neural field over the infinite plane. World coordinates are lifted through
// random Fourier features (incommensurate plane waves) so the field never
// saturates and never exactly repeats, then decoded by a small net.
export class FourierField {
  constructor(rng, { features = 10, wavelength = 200, hidden = [14, 8], outputs = 2, gain = 1.6 } = {}) {
    this.n = features;
    this.kx = new Float32Array(features);
    this.kz = new Float32Array(features);
    this.ph = new Float32Array(features);
    for (let f = 0; f < features; f++) {
      const ang = rng() * Math.PI * 2;
      const k = (Math.PI * 2) / (wavelength * (0.55 + 1.3 * rng()));
      this.kx[f] = Math.cos(ang) * k;
      this.kz[f] = Math.sin(ang) * k;
      this.ph[f] = rng() * Math.PI * 2;
    }
    this.inp = new Float32Array(features);
    this.net = new Net([features, ...hidden, outputs], rng, { gain });
  }

  eval(x, z) {
    const inp = this.inp, kx = this.kx, kz = this.kz, ph = this.ph;
    for (let f = 0; f < this.n; f++) inp[f] = Math.sin(kx[f] * x + kz[f] * z + ph[f]);
    return this.net.forward(inp);
  }
}
