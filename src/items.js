// Things that can be picked up, modelled from small blocks. They are self-lit so they read in the dark.
// Box: [cx, cy, cz, sx, sy, sz, r, g, b]
import * as THREE from 'three';
import { MB, QL, QD } from './meshbuilder.js';

const BRASS = [1.05, 0.78, 0.26], BRASS2 = [0.75, 0.52, 0.16], PAPER = [0.9, 0.88, 0.8], DARK = [0.1, 0.1, 0.11];
const CASE = [0.92, 0.9, 0.86], CASE2 = [0.7, 0.68, 0.64], CROSS = [0.95, 0.08, 0.08];
const STEEL = [0.2, 0.24, 0.32], STEEL2 = [0.34, 0.37, 0.42], WOOD = [0.5, 0.27, 0.13], WOOD2 = [0.36, 0.18, 0.08];
const SHELL = [0.85, 0.09, 0.1], SHELL2 = [0.6, 0.05, 0.06];

// a round thing out of three boxes: wide, deep, and the corners between
const oct = (cy, h, r, c) => [[0, cy, 0, 2 * r, h, 1.2 * r, ...c], [0, cy, 0, 1.2 * r, h, 2 * r, ...c], [0, cy, 0, 1.7 * r, h, 1.7 * r, ...c]];
// a square ring of rubber on a card
const ring = (cy, r, t) => [[0, cy + r, 0.016, 2 * r, t, 0.018, ...DARK], [0, cy - r, 0.016, 2 * r, t, 0.018, ...DARK], [-r, cy, 0.016, t, 2 * r, 0.018, ...DARK], [r, cy, 0.016, t, 2 * r, 0.018, ...DARK]];

// The shotgun, part by part: two blued barrels with a rib and a bead, a case-hardened action with engraved
// side plates, two hammers, two triggers in a guard, a checkered walnut fore-end and stock, a rubber butt pad.
// 'wet': the wood soaked dark, the steel gone dull and green at the joints, rust coming, water running off it.
// 'sealed': the same gun with oilskin bound round the action and the fore-end, rubber at the breech, wax gleaming.
function shotgunBoxes(v) {
  const wet = v === 'wet', sealed = v === 'sealed';
  const W = (c, k = 1) => (wet ? [c[0] * 0.55 * k, c[1] * 0.5 * k, c[2] * 0.48 * k] : [c[0] * k, c[1] * k, c[2] * k]);
  const S = c => (wet ? [c[0] * 0.75, c[1] * 0.85, c[2] * 0.8] : c);
  const wood = W(WOOD), wood2 = W(WOOD2), chk = W(WOOD2, 0.7), blue = S(STEEL), bore = [0.02, 0.02, 0.03], silver = S([0.58, 0.6, 0.62]), mot = S([0.42, 0.38, 0.5]), dark = S([0.15, 0.16, 0.18]);
  const B = [];
  const add = (x, y, z, sx, sy, sz, c) => B.push([x, y, z, sx, sy, sz, c[0], c[1], c[2]]);
  for (const s of [-1, 1]) {
    add(s * 0.016, 0.03, 0.17, 0.03, 0.03, 0.46, blue);                 // barrels
    add(s * 0.016, 0.03, 0.395, 0.034, 0.034, 0.012, silver);            // muzzle rings
    add(s * 0.016, 0.03, 0.402, 0.02, 0.02, 0.006, bore);
    add(s * 0.016, 0.03, -0.055, 0.032, 0.032, 0.012, silver);           // chambers
    add(s * 0.036, 0.022, -0.1, 0.004, 0.05, 0.09, silver);              // side plates
    for (let q = 0; q < 4; q++) add(s * 0.039, 0.01 + (q % 2) * 0.022, -0.13 + q * 0.018, 0.003, 0.008, 0.01, sealed || wet ? silver : BRASS); // engraving
    add(s * 0.022, 0.066, -0.145, 0.012, 0.032, 0.016, dark);            // hammers
    add(s * 0.022, 0.084, -0.157, 0.012, 0.008, 0.024, dark);
    add(s * 0.026, -0.005, -0.18, 0.002, 0.036, 0.05, chk);              // checkering on the wrist
    add(s * 0.031, 0.003, 0.1, 0.002, 0.02, 0.15, chk);                  // and on the fore-end
  }
  add(0, 0.049, 0.17, 0.012, 0.008, 0.44, silver);                        // rib
  add(0, 0.055, 0.398, 0.008, 0.008, 0.008, BRASS); add(0, 0.055, 0.22, 0.006, 0.006, 0.006, silver); // beads
  add(0, 0.012, 0.17, 0.012, 0.008, 0.44, blue);                          // under rib
  add(0, 0.0, -0.04, 0.05, 0.02, 0.06, blue);                              // lug
  add(0, 0.02, -0.1, 0.07, 0.066, 0.11, mot);                              // action, case-hardened
  add(0.02, 0.03, -0.085, 0.03, 0.02, 0.03, S([0.5, 0.42, 0.32])); add(-0.015, 0.008, -0.12, 0.03, 0.02, 0.04, S([0.35, 0.36, 0.5]));
  add(0, 0.0, -0.045, 0.076, 0.016, 0.016, silver);                        // hinge pin
  add(0.012, 0.058, -0.13, 0.024, 0.01, 0.05, silver); add(0, 0.059, -0.16, 0.012, 0.008, 0.016, silver); // top lever, safety
  add(0, -0.045, -0.11, 0.012, 0.008, 0.07, blue); add(0, -0.03, -0.075, 0.012, 0.03, 0.008, blue); add(0, -0.03, -0.145, 0.012, 0.03, 0.008, blue); // trigger guard
  add(0, -0.018, -0.1, 0.008, 0.026, 0.006, silver); add(0, -0.018, -0.118, 0.008, 0.024, 0.006, silver); // two triggers
  add(0, 0.003, 0.1, 0.06, 0.03, 0.2, wood); add(0, -0.013, 0.1, 0.046, 0.012, 0.18, wood2); add(0, 0.003, 0.205, 0.062, 0.032, 0.012, blue); // fore-end, tip
  add(0, -0.003, -0.18, 0.05, 0.055, 0.07, wood);                          // wrist
  add(0, -0.022, -0.24, 0.048, 0.07, 0.06, wood2);
  add(0, -0.03, -0.31, 0.046, 0.088, 0.12, wood); add(0, 0.016, -0.33, 0.04, 0.014, 0.12, wood2); // stock and comb
  add(0, -0.04, -0.39, 0.046, 0.102, 0.06, wood);
  add(0, -0.04, -0.428, 0.052, 0.108, 0.02, [0.05, 0.05, 0.05]);          // butt pad
  add(0.027, -0.01, -0.428, 0.004, 0.008, 0.008, BRASS2); add(0.027, -0.07, -0.428, 0.004, 0.008, 0.008, BRASS2);
  add(0.024, -0.04, -0.36, 0.004, 0.022, 0.03, sealed ? silver : BRASS);  // a small oval inlay
  add(0, -0.093, -0.36, 0.008, 0.012, 0.02, silver); add(0, 0.0, 0.26, 0.008, 0.012, 0.02, silver); // sling swivels
  if (wet) {
    const RU = [0.6, 0.27, 0.08], AL = [0.18, 0.32, 0.12], DROP = [0.55, 0.85, 1.2];
    for (const [x, y, z, s] of [[0.033, 0.035, 0.31, 0.014], [-0.033, 0.028, 0.12, 0.012], [0.031, 0.04, 0.02, 0.01], [-0.04, 0.025, -0.07, 0.012]]) add(x, y, z, 0.004, s, s * 1.6, RU);
    add(0, -0.01, 0.0, 0.066, 0.012, 0.03, AL); add(0.02, -0.03, -0.0, 0.01, 0.03, 0.01, AL); add(-0.015, -0.04, 0.01, 0.008, 0.04, 0.008, AL); // weed caught in the hinge
    for (const [x, y, z] of [[0.016, 0.01, 0.38], [-0.016, 0.012, 0.3], [0, -0.03, 0.16], [0.02, -0.06, -0.1], [0, -0.1, -0.38], [-0.01, -0.03, 0.06], [0.01, -0.07, -0.3]]) { add(x, y, z, 0.01, 0.016, 0.01, DROP); add(x, y - 0.016, z, 0.006, 0.01, 0.006, DROP); }
    add(0, 0.052, 0.17, 0.02, 0.003, 0.4, [0.3, 0.42, 0.5]);              // a film of water along the rib
  }
  if (sealed) {
    const OIL = [1.0, 0.76, 0.12], OIL2 = [0.82, 0.6, 0.08], RUB = [0.06, 0.06, 0.07], WAX = [0.95, 0.92, 0.78];
    add(0, 0.022, -0.1, 0.082, 0.078, 0.06, OIL); add(0, 0.022, -0.1, 0.084, 0.012, 0.062, OIL2); // oilskin over the action, tied
    add(0, 0.003, 0.12, 0.072, 0.042, 0.1, OIL); add(0, 0.003, 0.09, 0.074, 0.044, 0.01, OIL2); add(0, 0.003, 0.15, 0.074, 0.044, 0.01, OIL2);
    add(0, 0.03, -0.052, 0.074, 0.04, 0.008, RUB);                        // rubber round the breech
    for (const s of [-1, 1]) add(s * 0.016, 0.03, 0.385, 0.033, 0.033, 0.01, WAX); // wax at the muzzles
    add(0, 0.052, 0.3, 0.014, 0.004, 0.16, [0.75, 0.8, 0.85]);           // a shine of wax along the rib
  }
  return B;
}

// one shotgun shell standing at x, z
const shell = (x, z, s = 1) => [
  [x, -0.035 * s, z, 0.052 * s, 0.05 * s, 0.052 * s, ...BRASS], [x, -0.062 * s, z, 0.06 * s, 0.012 * s, 0.06 * s, ...BRASS2],
  [x, 0.045 * s, z, 0.046 * s, 0.11 * s, 0.046 * s, ...SHELL], [x, 0.104 * s, z, 0.036 * s, 0.01 * s, 0.036 * s, ...SHELL2],
];

// kind: token = needed to get further; story = a tape; use = kept and used with a key; now = takes effect at once
export const ITEMS = {
  key: { // bow, shank, two wards
    label: 'a brass key', kind: 'token',
    boxes: [
      [0, 0.13, 0, 0.15, 0.03, 0.03, ...BRASS], [0, 0.23, 0, 0.15, 0.03, 0.03, ...BRASS], [-0.06, 0.18, 0, 0.03, 0.13, 0.03, ...BRASS], [0.06, 0.18, 0, 0.03, 0.13, 0.03, ...BRASS],
      [0, 0.1, 0, 0.05, 0.03, 0.04, ...BRASS2], [0, -0.03, 0, 0.035, 0.26, 0.03, ...BRASS],
      [0.04, -0.13, 0, 0.06, 0.03, 0.03, ...BRASS], [0.03, -0.08, 0, 0.04, 0.03, 0.03, ...BRASS], [0, -0.165, 0, 0.045, 0.02, 0.035, ...BRASS2],
    ],
  },
  pearl: { // lying in half a shell
    label: 'a pearl', kind: 'token',
    boxes: [
      [0, -0.06, 0, 0.26, 0.03, 0.2, 0.75, 0.55, 0.55], [0, -0.035, -0.07, 0.24, 0.05, 0.05, 0.85, 0.65, 0.62], [-0.11, -0.035, 0, 0.04, 0.05, 0.16, 0.85, 0.65, 0.62], [0.11, -0.035, 0, 0.04, 0.05, 0.16, 0.85, 0.65, 0.62],
      [0, 0.02, 0, 0.1, 0.1, 0.1, 1.35, 1.25, 1.3], [0, 0.02, 0, 0.13, 0.06, 0.06, 1.2, 1.1, 1.2], [0, 0.02, 0, 0.06, 0.06, 0.13, 1.2, 1.1, 1.2], [0, 0.02, 0, 0.06, 0.13, 0.06, 1.2, 1.1, 1.2],
    ],
  },
  shard: { // a cluster of crystals
    label: 'a splinter of starlight', kind: 'token',
    boxes: [
      [0, 0.02, 0, 0.07, 0.4, 0.07, 0.7, 1.3, 1.6], [0, 0.24, 0, 0.04, 0.06, 0.04, 1.0, 1.5, 1.7], [0.06, -0.06, 0.02, 0.05, 0.22, 0.05, 0.5, 1.0, 1.5], [-0.05, -0.02, -0.03, 0.045, 0.28, 0.045, 0.6, 1.15, 1.6],
      [-0.02, -0.1, 0.06, 0.04, 0.14, 0.04, 0.45, 0.9, 1.4], [0.03, -0.09, -0.06, 0.04, 0.16, 0.04, 0.5, 1.0, 1.5], [0, -0.19, 0, 0.18, 0.04, 0.18, 0.12, 0.12, 0.2],
    ],
  },
  cassette: {
    label: 'a cassette', kind: 'story',
    boxes: [
      [0, 0, 0, 0.3, 0.19, 0.035, 0.2, 0.19, 0.19], [0, 0.03, 0.02, 0.24, 0.1, 0.008, ...PAPER], [0, 0.03, 0.026, 0.13, 0.045, 0.006, 0.08, 0.08, 0.09],
      [-0.06, 0.03, 0.03, 0.035, 0.035, 0.006, 0.8, 0.8, 0.78], [0.06, 0.03, 0.03, 0.035, 0.035, 0.006, 0.8, 0.8, 0.78], [0, 0.065, 0.026, 0.22, 0.012, 0.006, 1.0, 0.7, 0.25],
      [0, -0.07, 0.02, 0.18, 0.035, 0.012, 0.13, 0.12, 0.12], [-0.13, 0.08, 0.02, 0.012, 0.012, 0.008, 0.6, 0.6, 0.6], [0.13, 0.08, 0.02, 0.012, 0.012, 0.008, 0.6, 0.6, 0.6],
    ],
  },
  medkit: { // a white case with a handle, two catches and a red cross
    label: 'a first-aid kit', kind: 'use',
    boxes: [
      [0, -0.03, 0, 0.3, 0.16, 0.17, ...CASE], [0, 0.065, 0, 0.31, 0.035, 0.18, ...CASE], [0, 0.045, 0, 0.315, 0.008, 0.185, ...CASE2], [0, 0.088, 0, 0.27, 0.012, 0.15, ...CASE],
      [-0.06, 0.115, 0, 0.022, 0.045, 0.03, ...CASE2], [0.06, 0.115, 0, 0.022, 0.045, 0.03, ...CASE2], [0, 0.14, 0, 0.142, 0.022, 0.03, ...CASE2],
      [-0.08, 0.045, 0.092, 0.035, 0.03, 0.01, ...CASE2], [0.08, 0.045, 0.092, 0.035, 0.03, 0.01, ...CASE2],
      [0, -0.03, 0.087, 0.1, 0.03, 0.006, ...CROSS], [0, -0.03, 0.087, 0.03, 0.1, 0.006, ...CROSS],
      [0, 0.03, 0.087, 0.14, 0.008, 0.004, ...CROSS], [0, -0.09, 0.087, 0.14, 0.008, 0.004, ...CROSS], [-0.07, -0.03, 0.087, 0.008, 0.128, 0.004, ...CROSS], [0.07, -0.03, 0.087, 0.008, 0.128, 0.004, ...CROSS],
    ],
  },
  flare: {
    label: 'a flare', kind: 'use',
    boxes: [
      [0, 0, 0, 0.05, 0.26, 0.05, 1.1, 0.14, 0.1], [0, 0.03, 0, 0.054, 0.05, 0.054, ...PAPER], [0, 0.145, 0, 0.058, 0.035, 0.058, 0.3, 0.3, 0.32], [0, 0.17, 0, 0.03, 0.02, 0.03, 1.5, 1.2, 0.4],
      [0, -0.14, 0, 0.058, 0.025, 0.058, 0.3, 0.3, 0.32], [0.035, -0.06, 0, 0.012, 0.1, 0.02, 0.5, 0.5, 0.5],
    ],
  },
  shotgun: { label: 'a shotgun', kind: 'now', boxes: shotgunBoxes('dry') },
  shotgun_wet: { label: 'a shotgun', kind: 'now', boxes: shotgunBoxes('wet') },
  shotgun_sealed: { label: 'a shotgun', kind: 'now', boxes: shotgunBoxes('sealed') },
  fuse: { // an old ceramic fuse with brass caps and a red tell-tale
    label: 'a fuse', kind: 'task',
    boxes: [...oct(0, 0.2, 0.045, [0.88, 0.86, 0.8]).map(b => [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8]]),
      ...oct(0.115, 0.04, 0.05, BRASS), ...oct(-0.115, 0.04, 0.05, BRASS), ...oct(0.15, 0.03, 0.022, BRASS2), ...oct(-0.15, 0.03, 0.022, BRASS2),
      [0, 0.02, 0.046, 0.03, 0.05, 0.006, 1.2, 0.15, 0.1], [0, -0.04, 0.046, 0.06, 0.012, 0.004, 0.2, 0.2, 0.22]],
  },
  memo: { // a page torn from a notebook, a strip of tape, four digits in red pencil
    label: 'a note', kind: 'task',
    boxes: [[0, 0, 0, 0.24, 0.3, 0.008, ...PAPER], [0.1, 0.13, 0.002, 0.04, 0.04, 0.008, 0.78, 0.76, 0.68], [0, 0.155, 0.006, 0.09, 0.03, 0.006, 0.85, 0.8, 0.55],
      ...[0.09, 0.05, 0.01, -0.03, -0.07, -0.11].map((y, q) => [-0.01 + (q % 2) * 0.01, y, 0.006, 0.17 - (q % 3) * 0.03, 0.008, 0.003, 0.25, 0.25, 0.32]),
      ...[-0.06, -0.02, 0.02, 0.06].map(x => [x, -0.035, 0.007, 0.022, 0.035, 0.003, 0.9, 0.12, 0.1])],
  },
  shells: { // red twelve-bore cartridges with brass heads
    label: 'a box of shells', kind: 'now',
    boxes: [...shell(-0.09, 0), ...shell(-0.03, 0.02), ...shell(0.03, -0.01), ...shell(0.09, 0.015), [0, -0.075, 0, 0.3, 0.014, 0.13, 0.4, 0.3, 0.16]],
  },
  grease: { // a tin of gun grease, the lid smeared
    label: 'a tin of gun grease', kind: 'part',
    boxes: [...oct(-0.04, 0.12, 0.11, [0.42, 0.44, 0.47]), ...oct(-0.045, 0.06, 0.114, [1.05, 0.72, 0.12]), ...oct(0.03, 0.03, 0.116, [0.3, 0.31, 0.34]),
      [0, -0.045, 0.116, 0.1, 0.025, 0.004, 0.12, 0.1, 0.08], [0.02, 0.05, 0.02, 0.07, 0.014, 0.05, 0.8, 0.6, 0.18]],
  },
  gaskets: { // rubber seals, two sizes, still on the shop card
    label: 'a card of rubber seals', kind: 'part',
    boxes: [[0, 0, 0, 0.26, 0.34, 0.02, 0.86, 0.8, 0.66], [0, 0.14, 0.012, 0.26, 0.045, 0.005, 0.85, 0.15, 0.1], [0, 0.155, 0.012, 0.04, 0.02, 0.006, 0.1, 0.1, 0.1],
      ...ring(0.03, 0.08, 0.026), ...ring(-0.105, 0.045, 0.02)],
  },
  wax: { // a block of paraffin in a paper band
    label: 'a block of wax', kind: 'part',
    boxes: [[0, 0, 0, 0.26, 0.12, 0.16, 0.95, 0.92, 0.78], [0, 0, 0, 0.11, 0.125, 0.166, 0.72, 0.56, 0.36], [0, 0, 0.084, 0.06, 0.04, 0.003, 0.7, 0.12, 0.1],
      [0.08, 0.065, 0.02, 0.02, 0.012, 0.02, 0.25, 0.2, 0.15], [-0.09, 0.065, -0.04, 0.05, 0.014, 0.04, 0.98, 0.95, 0.82]],
  },
  oilskin: { // a folded oilskin, tied
    label: 'an oilskin', kind: 'part',
    boxes: [[0, -0.05, 0, 0.3, 0.04, 0.22, 1.05, 0.8, 0.12], [0.01, -0.01, 0.006, 0.29, 0.04, 0.21, 0.9, 0.66, 0.09], [0, 0.03, -0.005, 0.28, 0.04, 0.2, 1.05, 0.8, 0.12],
      [0, -0.01, 0, 0.31, 0.105, 0.025, 0.35, 0.24, 0.14], [0, -0.01, 0, 0.025, 0.105, 0.23, 0.35, 0.24, 0.14]],
  },
  battery: {
    label: 'a torch cell', kind: 'now',
    boxes: [
      [0, -0.01, 0, 0.09, 0.19, 0.09, 0.16, 0.17, 0.19], [0, 0.03, 0, 0.094, 0.07, 0.094, 1.25, 1.0, 0.15], [0, 0.03, 0.048, 0.03, 0.04, 0.004, 0.1, 0.1, 0.1],
      [0, 0.095, 0, 0.092, 0.02, 0.092, 0.7, 0.7, 0.72], [0, 0.115, 0, 0.035, 0.022, 0.035, 0.85, 0.85, 0.85], [0, -0.11, 0, 0.092, 0.012, 0.092, 0.6, 0.6, 0.62],
    ],
  },
  tonic: {
    label: 'a can, still cold', kind: 'now',
    boxes: [
      [0, 0, 0, 0.1, 0.2, 0.1, 1.0, 0.16, 0.12], [0, 0.02, 0, 0.104, 0.06, 0.104, ...PAPER], [0, 0.02, 0.053, 0.05, 0.03, 0.003, 1.0, 0.16, 0.12],
      [0, 0.105, 0, 0.09, 0.012, 0.09, 0.72, 0.72, 0.75], [0, 0.113, 0.01, 0.03, 0.006, 0.045, 0.5, 0.5, 0.52], [0, -0.105, 0, 0.09, 0.012, 0.09, 0.72, 0.72, 0.75],
    ],
  },
};

const cache = {};
const SXc = [-1, 1, -1, 1, -1, 1, -1, 1], SYc = [-1, -1, 1, 1, -1, -1, 1, 1], SZc = [-1, -1, -1, -1, 1, 1, 1, 1];
const FACES = [[0, 4, 6, 2, -1, 0, 0], [1, 3, 7, 5, 1, 0, 0], [0, 1, 5, 4, 0, -1, 0], [2, 6, 7, 3, 0, 1, 0], [0, 2, 3, 1, 0, 0, -1], [4, 5, 7, 6, 0, 0, 1]];

// dim: how brightly it shows (1 for something lying in the dark waiting to be found, less for one held in the hand)
export function itemGeometry(type, S = 1.5, dim = 1) {
  const ck = type + ':' + S + ':' + dim;
  if (cache[ck]) return cache[ck];
  const mb = new MB(), c = new Float32Array(24);
  for (const b of ITEMS[type].boxes) {
    for (let q = 0; q < 8; q++) { c[q * 3] = (b[0] + SXc[q] * b[3] * 0.5) * S; c[q * 3 + 1] = (b[1] + SYc[q] * b[4] * 0.5) * S; c[q * 3 + 2] = (b[2] + SZc[q] * b[5] * 0.5) * S; }
    for (const f of FACES) {
      const sh = (0.72 + 0.28 * f[5] + 0.1 * f[6] - 0.06 * f[4]) * dim;
      for (let v = 0; v < 4; v++) { QL[v * 3] = b[6] * sh; QL[v * 3 + 1] = b[7] * sh; QL[v * 3 + 2] = b[8] * sh; QD[v * 4] = 0; QD[v * 4 + 1] = 0; QD[v * 4 + 2] = 0; QD[v * 4 + 3] = 0; }
      const p = f[0] * 3, q = f[1] * 3, r = f[2] * 3, s = f[3] * 3;
      mb.quad(c[p], c[p + 1], c[p + 2], c[q], c[q + 1], c[q + 2], c[r], c[r + 1], c[r + 2], c[s], c[s + 1], c[s + 2], f[4], f[5], f[6], 0, 0, 0, 0, 0, 0, 0, 0);
    }
  }
  return (cache[ck] = mb.build());
}

export function makeItemMesh(it, mat) {
  const m = new THREE.Mesh(itemGeometry(it.type), mat);
  m.position.set(it.x, it.y, it.z);
  m.userData.item = it;
  m.userData.shared = true;
  return m;
}
