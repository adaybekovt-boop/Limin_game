// World generator. Everything about a place is a pure function of the seed,
// the dimension and its coordinates, so each world is endless and consistent.
//
// There are three separate dimensions, joined only by hatches and doors:
//   0  the lit floors      endless rooms and corridors
//   1  the drowned floors  the same kind of building, under water
//   2  the outside         no building at all; things arranged around points
//
// Networks (all in nn.js, all evaluated while you play):
//   realmField  - neural field: depth of the water
//   detailField - neural field: local density / ceiling modulation
//   architect   - latent code of a district -> its architecture and palette
//   breeder     - latent code -> a creature species (see creatures.js)
import { hash32, rand01, mulberry32, gauss, Net, FourierField } from './nn.js';
import { PROPS } from './propdefs.js';
import { propAABBs, propBounds } from './pose.js';

export const CS = 3;            // cell size, metres
export const CN = 16;           // cells per chunk side
export const CHUNK = CS * CN;
export const WL = -0.4;         // water level
export const HALL = 0, WET = 1, VOID = 2;
export const RS = 22;           // district size in cells
export const SG = 12;           // site grid: each square holds at most one special room
// openings in walls, by wall type: 2 doorway, 3 crawl gap (crouch to pass)
export const OPEN_HW = [0, 0, 0.8, 0.6], OPEN_H = [0, 0, 2.5, 1.0];
export const FAR = 9999;
export const TOP = 16, BOT = -20;
export const NEED = 3;          // how many keys / pearls / splinters a threshold asks for

const mod = (n, m) => ((n % m) + m) % m;
const fdiv = (n, m) => Math.floor(n / m);
const key = (a, b) => (a + 32768) * 65536 + (b + 32768);
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function hsv(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

export function pillarSize(R, realm) {
  return realm === WET ? 0.5 : R.mode === 3 ? 0.45 : 0.28;
}

// special rooms: [width, depth] in cells; the "front" is the v = 0 wall
const SIZE = {
  hatch: [3, 3], stardoor: [3, 3], door: [3, 3], exit: [3, 3],
  cinema: [5, 7], playground: [6, 6], classroom: [4, 5], ring: [3, 3], storage: [3, 4], ward: [3, 5], office: [3, 3],
  party: [3, 4], laundry: [3, 3], waiting: [3, 4], nursery: [3, 3], chapel: [3, 5], camp: [3, 3],
};
const PIECE_H = { cinema: 5.4, playground: 7, classroom: 3.4, hatch: 4, stardoor: 5.2, door: 4, exit: 5, party: 3.4, laundry: 3.2, waiting: 3.6, nursery: 3.0, chapel: 6.5, camp: 3.4 };
const PORTAL = { hatch: 1, stardoor: 1, door: 1, exit: 1 };
// a few fixed rooms around the start, so the first minutes show what the place holds
const FORCED = { '1,0': 'ring', '0,1': 'cinema', '0,-1': 'classroom', '1,1': 'playground', '-1,-1': 'storage', '1,-1': 'ward', '2,0': 'camp', '0,2': 'party', '2,-1': 'office' };
const FORCED_LINK = { '-1,0': [0, 1], '-1,1': [0, 2] };
const LAW_PICK = [0, 0, 0, 1, 1, 2, 3, 3, 4, 4];
const ODD_PICK = [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 9];
const KIND_POOL = ['chair', 'table', 'cabinet', 'lamp', 'tv', 'shelf', 'bed', 'boxes', 'plant', 'door'];
// what a district of the outside is made of: three things that belong together
const THEMES = [['arch', 'obelisk', 'monolith'], ['door', 'lamp', 'chairs'], ['lattice', 'helix', 'zig'], ['room', 'corridor', 'tv'], ['coral', 'lamp', 'obelisk'], ['arch', 'lamp', 'monolith']];
const SPACE_POOL = ['door', 'lamp', 'chairs', 'tv', 'zig', 'arch', 'lattice', 'coral', 'obelisk', 'helix', 'room', 'monolith', 'corridor'];
const GLOWS = [[0.4, 1.2, 1.5], [0.8, 0.4, 1.5], [1.4, 1.0, 0.4], [0.4, 1.4, 0.7], [1.2, 1.2, 1.4]];
const CACHE = ['medkit', 'battery', 'flare', 'tonic', 'shells', 'medkit'];

// 0 none, 1 wall, 2 doorway
function wallRule(R, i, j, dir, r, r2, dm, seed) {
  switch (R.mode) {
    case 1: { // long corridors
      if (dir === R.axis) {
        const lane = dir === 0 ? i + 1 : j + 1;
        if (mod(lane, R.a) === 0) return r < 0.1 ? 0 : r < 0.1 + 0.3 * R.doorRate ? 2 : 1;
        return 0;
      }
      return r < 0.05 ? (r < 0.025 ? 2 : 1) : 0;
    }
    case 2: { // grid of rooms, every side has one door
      if (dir === 0) {
        if (mod(i + 1, R.a) !== 0) return 0;
        const door = hash32(seed, i + 1, fdiv(j, R.b), 5) % R.b;
        if (mod(j, R.b) === door) return 2;
        return r < 0.06 ? 0 : 1;
      }
      if (mod(j + 1, R.b) !== 0) return 0;
      const door = hash32(seed, fdiv(i, R.a), j + 1, 6) % R.a;
      if (mod(i, R.a) === door) return 2;
      return r < 0.06 ? 0 : 1;
    }
    case 3: // pillar hall
      return r < 0.03 ? 1 : 0;
    case 4: // labyrinth
      if (r < 0.3) return r2 < 0.3 ? 2 : 1;
      return 0;
    default: // loose partitions
      if (r < R.density * dm) return r2 < R.doorRate ? 2 : 1;
      return 0;
  }
}

function doorAt(P, u, v, side) {
  const ns = side === 'N' || side === 'S';
  switch (P.kind) {
    case 'hatch': case 'stardoor': case 'door': return (ns ? u === 1 : v === 1) ? 2 : 1;
    case 'exit': return side === 'N' ? 1 : (ns ? u === 1 : v === 1) ? 2 : 1;
    case 'cinema': return side === 'N' ? 1 : side === 'S' ? (u === 2 ? 2 : 1) : v === P.d - 1 ? 2 : 1;
    case 'playground': return (ns ? u === 2 || u === 3 : v === 2 || v === 3) ? 0 : 1;
    case 'classroom': return !ns && v === P.d - 1 ? 0 : 1;
    case 'storage': return side === 'S' && u === 1 ? 2 : 1;
    case 'ward': return ns && u === 1 ? 2 : 1;
    case 'office': case 'camp': return (side === 'S' && u === 1) || (side === 'W' && v === 1) ? 2 : 1;
    case 'party': return (side === 'S' && u === 1) || (side === 'E' && v === 1) ? 2 : 1;
    case 'laundry': case 'waiting': case 'nursery': case 'chapel': return side === 'S' && u === 1 ? 2 : 1;
    default: return 1;
  }
}

// light (bits 0-1: 1 on, 2 flicker, 3 dead) and glow source (bits 2-3: 1 steady, 2 flicker) for a cell of a special room
function pieceLight(P, u, v) {
  switch (P.kind) {
    case 'hatch': case 'stardoor': case 'door': return u === 1 && v === 1 ? 4 : 0;
    case 'exit': return u === 1 && v === 0 ? 4 : 0;
    case 'cinema': return v === 1 ? 8 : 0;
    case 'playground': return u === 2 && v === 2 ? 2 : 0;
    case 'classroom': return (u === 1 || u === 2) && (v === 1 || v === 3) ? (u === 2 && v === 3 ? 2 : 1) : 0;
    case 'ring': return u === 1 && v === 1 ? 1 : 0;
    case 'storage': return u === 1 && v === 1 ? 2 : u === 1 && v === 2 ? 1 : 0;
    case 'ward': return u === 1 && v % 2 === 0 ? (v === 2 ? 2 : 1) : 0;
    case 'office': return u === 1 && v === 1 ? 1 : 0;
    case 'party': return u === 1 && v === 2 ? 2 : 0;                       // one flickering tube over the cake
    case 'laundry': return u === 1 && v === 1 ? 1 : u === 2 && v === 2 ? 3 : 0;
    case 'waiting': return u === 1 && v === 0 ? 1 : u === 1 && v === 2 ? 2 : u === 0 && v === 3 ? 3 : 0;
    case 'chapel': return u === 1 && v === 1 ? 2 : u === 1 && v === 3 ? 3 : 0;
    case 'camp': return u === 1 && v === 1 ? 3 : 0;                         // the tube died; the lantern is all there is
    default: return 0;                                                      // the nursery has only its night light
  }
}

// The thing you go through. add(u0, v0, u1, v1, y0, y1, colour, glow, flicker, solid), in metres within a 9 x 9 room.
function portalModel(kind, add) {
  const c = 4.5;
  if (kind === 'hatch') return poolHatch(add);
  if (kind === 'door') return homeDoor(add);
  if (kind === 'stardoor') return starDoor(add);
  if (kind === 'exit') return whiteDoor(add);
  const col = kind === 'stardoor' ? 8 : kind === 'exit' ? 7 : 0;
  const glow = kind === 'stardoor' ? [0.45, 0.25, 1.3] : kind === 'exit' ? [1.7, 1.7, 1.6] : [1.2, 0.85, 0.45];
  const hw = kind === 'exit' ? 1.3 : 0.75, hh = kind === 'exit' ? 3.2 : 2.6, v0 = kind === 'exit' ? 0.5 : c;
  add(c - hw - 0.16, v0 - 0.12, c - hw, v0 + 0.12, 0, hh + 0.16, col, null, false, true);
  add(c + hw, v0 - 0.12, c + hw + 0.16, v0 + 0.12, 0, hh + 0.16, col, null, false, true);
  add(c - hw, v0 - 0.12, c + hw, v0 + 0.12, hh, hh + 0.16, col);
  add(c - hw, v0 - 0.03, c + hw, v0 + 0.03, 0, hh, 14, glow, kind === 'stardoor', true);
  add(c - hw - 0.3, v0 - 0.5, c + hw + 0.3, v0 + 0.5, 0, 0.03, col === 0 ? 9 : col);
}

// The way down to the drowned floors: a round ship's hatch set in the floor, with a red valve wheel, rivets,
// a ring of hazard stripes, water seeping out round the rim, and a rusted pipe with a gauge that reads too high.
function poolHatch(add) {
  const c = 4.5, ST = 3, MT = 2, RED = 24, Y = 18, BK = 8, SEEP = [0.12, 0.75, 0.85];
  // hazard stripes round it, painted on the floor
  for (let q = 0; q < 16; q++) {
    const s = -1.6 + q * 0.2, col = q % 2 ? Y : BK;
    add(c + s, c - 1.6, c + s + 0.2, c - 1.42, 0, 0.01, col); add(c + s, c + 1.42, c + s + 0.2, c + 1.6, 0, 0.01, col);
    add(c - 1.6, c + s, c - 1.42, c + s + 0.2, 0, 0.01, col); add(c + 1.42, c + s, c + 1.6, c + s + 0.2, 0, 0.01, col);
  }
  // wet floor, and the water coming up round the rim
  for (const [a, b, w, d] of [[-1.25, 0.3, 0.6, 0.9], [0.7, -1.2, 0.8, 0.5], [0.9, 0.8, 0.45, 0.6], [-0.9, -1.0, 0.5, 0.4]]) add(c + a, c + b, c + a + w, c + b + d, 0, 0.006, 32);
  for (const [w, d] of [[1.0, 0.62], [0.62, 1.0], [0.88, 0.88]]) add(c - w - 0.03, c - d - 0.03, c + w + 0.03, c + d + 0.03, 0, 0.02, 14, SEEP, true);
  // the coaming: a raised round rim, then the lid, then a second, smaller step
  for (const [w, d] of [[1.0, 0.6], [0.6, 1.0], [0.86, 0.86]]) add(c - w, c - d, c + w, c + d, 0.02, 0.26, ST, null, false, true);
  for (const [w, d] of [[0.86, 0.52], [0.52, 0.86], [0.74, 0.74]]) add(c - w, c - d, c + w, c + d, 0.26, 0.32, MT);
  for (const [w, d] of [[0.42, 0.25], [0.25, 0.42], [0.36, 0.36]]) add(c - w, c - d, c + w, c + d, 0.32, 0.36, ST);
  // rivets round the rim
  for (let q = 0; q < 16; q++) { const a = (q / 16) * 6.2832, x = c + Math.cos(a) * 0.9, z = c + Math.sin(a) * 0.9 * (Math.abs(Math.cos(a)) > 0.7 ? 0.62 / 0.9 * 1.3 : 1); add(x - 0.025, z - 0.025, x + 0.025, z + 0.025, 0.26, 0.29, 31); }
  // the valve wheel: hub, spokes, and a rim with its corners cut
  add(c - 0.07, c - 0.07, c + 0.07, c + 0.07, 0.36, 0.62, MT);
  add(c - 0.42, c - 0.025, c + 0.42, c + 0.025, 0.58, 0.62, RED); add(c - 0.025, c - 0.42, c + 0.025, c + 0.42, 0.58, 0.62, RED);
  for (const s of [-1, 1]) {
    add(c - 0.24, c + s * 0.44 - 0.03, c + 0.24, c + s * 0.44 + 0.03, 0.57, 0.63, RED);
    add(c + s * 0.44 - 0.03, c - 0.24, c + s * 0.44 + 0.03, c + 0.24, 0.57, 0.63, RED);
    for (const r of [-1, 1]) add(c + s * 0.34 - 0.06, c + r * 0.34 - 0.06, c + s * 0.34 + 0.06, c + r * 0.34 + 0.06, 0.57, 0.63, RED);
  }
  // a pipe coming up out of the floor beside it, with a gauge, and drops under the joint
  const px = c + 2.1, pz = c - 1.6;
  add(px - 0.09, pz - 0.09, px + 0.09, pz + 0.09, 0, 2.5, 17, null, false, true);
  add(px - 0.13, pz - 0.13, px + 0.13, pz + 0.13, 0.9, 1.0, 17); add(px - 0.13, pz - 0.13, px + 0.13, pz + 0.13, 0, 0.08, 17);
  add(px - 0.09, pz - 0.09, px + 1.4, pz + 0.09, 2.4, 2.58, 17);
  add(px - 0.13, pz - 0.2, px + 0.13, pz - 0.09, 1.3, 1.56, 2); add(px - 0.1, pz - 0.21, px + 0.1, pz - 0.2, 1.33, 1.53, 14, [0.85, 0.85, 0.75]);
  add(px + 0.02, pz - 0.215, px + 0.08, pz - 0.21, 1.43, 1.45, RED);
  for (const h of [0.55, 0.3, 0.12]) add(px - 0.16, pz - 0.02, px - 0.13, pz + 0.01, h, h + 0.04, 14, SEEP);
  add(px - 0.4, pz - 0.3, px + 0.1, pz + 0.15, 0, 0.006, 32);
  // a yellow sign on a post: whatever it said has run
  add(c - 2.0 - 0.025, c + 1.9 - 0.025, c - 2.0 + 0.025, c + 1.9 + 0.025, 0, 1.3, MT, null, false, true);
  add(c - 2.25, c + 1.87, c - 1.75, c + 1.93, 1.1, 1.5, Y); add(c - 2.2, c + 1.86, c - 1.8, c + 1.87, 1.25, 1.32, BK);
}

// The way back up from the water: an ordinary flat door in a scrap of papered wall, standing on its own,
// open a little, warm light behind it; a doormat, a house number, a coat on a hook, and a lifebuoy nobody used.
function homeDoor(add) {
  const c = 4.5, hw = 0.55, hh = 2.15, ww = 1.75, wh = 3.0, WALL = 33, WOOD = 0, DW = 1, WARM = [1.6, 1.2, 0.7];
  // the wall, either side and over the top
  add(c - ww, c - 0.1, c - hw - 0.08, c + 0.1, 0, wh, WALL, null, false, true);
  add(c + hw + 0.08, c - 0.1, c + ww, c + 0.1, 0, wh, WALL, null, false, true);
  add(c - hw - 0.08, c - 0.1, c + hw + 0.08, c + 0.1, hh + 0.08, wh, WALL);
  add(c - ww, c - 0.13, c + ww, c + 0.13, 0, 0.14, DW); // skirting
  add(c - ww - 0.02, c - 0.12, c + ww + 0.02, c + 0.12, wh - 0.06, wh, DW);
  // the frame
  add(c - hw - 0.08, c - 0.12, c - hw, c + 0.12, 0, hh + 0.08, WOOD); add(c + hw, c - 0.12, c + hw + 0.08, c + 0.12, 0, hh + 0.08, WOOD);
  add(c - hw - 0.08, c - 0.12, c + hw + 0.08, c + 0.12, hh, hh + 0.08, WOOD);
  // the light behind, and the door leaf standing open into it
  add(c - hw, c - 0.02, c + hw, c + 0.02, 0, hh, 14, WARM, false, true);
  add(c + hw - 0.05, c + 0.1, c + hw, c + 1.1, 0.01, hh - 0.01, WOOD, null, false, true);
  for (const [y0, y1] of [[0.2, 0.95], [1.15, 1.95]]) add(c + hw - 0.065, c + 0.22, c + hw - 0.05, c + 0.98, y0, y1, DW);
  add(c + hw - 0.11, c + 0.95, c + hw - 0.05, c + 1.02, 0.98, 1.04, 31);
  // light thrown out over the floor in front, wider as it goes
  add(c - hw, c - 0.6, c + hw, c - 0.1, 0, 0.006, 14, [0.75, 0.55, 0.3]);
  add(c - hw - 0.15, c - 1.3, c + hw + 0.15, c - 0.6, 0, 0.005, 14, [0.45, 0.33, 0.18]);
  add(c - 0.42, c - 0.78, c + 0.42, c - 0.22, 0, 0.025, 10); // doormat
  add(c - 0.38, c - 0.74, c + 0.38, c - 0.7, 0.025, 0.03, 1);
  // a brass number, a light switch, a lamp over the door
  add(c - 0.08, c - 0.115, c + 0.08, c - 0.1, hh + 0.3, hh + 0.5, 31);
  add(c - hw - 0.32, c - 0.115, c - hw - 0.2, c - 0.1, 1.2, 1.36, 30);
  add(c - 0.16, c - 0.2, c + 0.16, c - 0.1, hh + 0.62, hh + 0.66, 31); add(c - 0.12, c - 0.24, c + 0.12, c - 0.12, hh + 0.66, hh + 0.84, 14, WARM);
  // a coat on a hook
  add(c - 1.22, c - 0.13, c - 1.18, c - 0.1, 1.82, 1.9, 31);
  add(c - 1.42, c - 0.24, c - 0.98, c - 0.1, 0.85, 1.85, 6); add(c - 1.3, c - 0.25, c - 1.1, c - 0.23, 1.55, 1.85, 34);
  // a lifebuoy hung on the wall, red and white in quarters
  const bx = c + 1.2, by = 1.55, r = 0.3, t = 0.09;
  for (const [x0, y0, x1, y1, col] of [[-r, r - t, r, r, 24], [-r, -r, r, -r + t, 24], [-r, -r + t, -r + t, r - t, 30], [r - t, -r + t, r, r - t, 30]]) add(bx + x0, c - 0.2, bx + x1, c - 0.1, by + y0, by + y1, col);
  add(bx - 0.02, c - 0.21, bx + 0.02, c - 0.2, by + r, by + r + 0.25, 7);
}

// A desk with a valve radio on it, left out here by somebody: walnut case, cloth grille, a lit dial, a wire aerial.
export const RADIO = [6.7, 3.0]; // where it stands in the platform's own metres
function radioDesk(add) {
  const [x, z] = RADIO;
  for (const [a, b] of [[-0.55, -0.3], [0.55, -0.3], [-0.55, 0.3], [0.55, 0.3]]) add(x + a - 0.03, z + b - 0.03, x + a + 0.03, z + b + 0.03, 0, 0.74, 1, null, false, true);
  add(x - 0.62, z - 0.36, x + 0.62, z + 0.36, 0.74, 0.79, 0, null, false, true);
  add(x - 0.3, z - 0.16, x + 0.3, z + 0.16, 0.79, 1.15, 1, null, false, true);
  add(x - 0.27, z - 0.165, x - 0.03, z - 0.16, 0.83, 1.11, 10);
  for (let q = 0; q < 4; q++) add(x - 0.27, z - 0.17, x - 0.03, z - 0.165, 0.86 + q * 0.07, 0.875 + q * 0.07, 1);
  add(x + 0.02, z - 0.17, x + 0.27, z - 0.16, 1.0, 1.1, 14, [1.5, 1.1, 0.45]);
  add(x + 0.06, z - 0.18, x + 0.11, z - 0.16, 0.86, 0.92, 30); add(x + 0.17, z - 0.18, x + 0.22, z - 0.16, 0.86, 0.92, 30);
  add(x + 0.2, z + 0.05, x + 0.215, z + 0.065, 1.15, 1.75, 2);
  add(x - 0.1, z - 0.2, x + 0.05, z - 0.15, 0.79, 0.8, 7);
}

// a fixed scatter, the same every time (no random source inside a model)
const sc = (q, k) => { const s = Math.sin(q * 127.1 + k * 311.7) * 43758.5453; return s - Math.floor(s); };

// The way to the outside: a black door standing open in a stepped black frame, the night showing through it
// and leaking out across the floor; a few pieces of the frame have come loose and hang in the air above.
function starDoor(add) {
  const c = 4.5, hw = 0.8, hh = 2.9, BL = 8, ST = 23, V = [0.3, 0.12, 0.9];
  // inlaid floor: a dark square ringed with a thin violet line
  add(c - 2.2, c - 2.2, c + 2.2, c + 2.2, 0, 0.012, ST);
  for (const [a, b, d, e] of [[-2.05, -2.05, 2.05, -2], [-2.05, 2, 2.05, 2.05], [-2.05, -2, -2, 2], [2, -2, 2.05, 2]]) add(c + a, c + b, c + d, c + e, 0.012, 0.02, 14, [0.35, 0.15, 1.0], true);
  // the frame: two stepped jambs, a lintel, a pointed pediment of stacked bars
  for (const s of [-1, 1]) {
    const x0 = s < 0 ? c - hw - 0.22 : c + hw, x1 = s < 0 ? c - hw : c + hw + 0.22;
    add(x0, c - 0.16, x1, c + 0.16, 0, hh + 0.2, BL, null, false, true);
    const y0 = s < 0 ? c - hw - 0.44 : c + hw + 0.22, y1 = s < 0 ? c - hw - 0.22 : c + hw + 0.44;
    add(y0, c - 0.26, y1, c + 0.26, 0, hh + 0.45, ST, null, false, true);
    add(y0 - 0.04, c - 0.3, y1 + 0.04, c + 0.3, 0, 0.3, BL, null, false, true);
    // a strip of violet light down the inside of each jamb
    add(s < 0 ? c - hw - 0.005 : c + hw, c - 0.04, s < 0 ? c - hw : c + hw + 0.005, c + 0.04, 0.05, hh, 14, V, true);
  }
  add(c - hw - 0.44, c - 0.26, c + hw + 0.44, c + 0.26, hh + 0.2, hh + 0.5, BL);
  for (let q = 0; q < 4; q++) { const w = hw + 0.3 - q * 0.3; add(c - w, c - 0.2, c + w, c + 0.2, hh + 0.5 + q * 0.18, hh + 0.68 + q * 0.18, q % 2 ? ST : BL); }
  add(c - 0.06, c - 0.21, c + 0.06, c + 0.21, hh + 0.62, hh + 0.74, 14, [1.4, 1.2, 1.8]);
  // the door leaf, swung all the way open behind the frame
  add(c + hw - 0.06, c + 0.16, c + hw, c + 1.75, 0.02, hh, BL, null, false, true);
  add(c + hw - 0.1, c + 1.45, c + hw - 0.06, c + 1.55, 1.2, 1.3, 31);
  // the opening: deep violet, with a band of nebula and stars on both faces
  add(c - hw, c - 0.02, c + hw, c + 0.02, 0, hh, 14, [0.07, 0.03, 0.2], false, true);
  for (const f of [-1, 1]) {
    const v0 = f < 0 ? c - 0.03 : c + 0.02, v1 = v0 + 0.01;
    for (let q = 0; q < 5; q++) { const y = 0.5 + q * 0.42 + sc(q, 1) * 0.3, x = (sc(q, 2) - 0.5) * 0.9; add(c + x - 0.28, v0, c + x + 0.28, v1, y, y + 0.22, 14, q % 2 ? [0.32, 0.08, 0.38] : [0.12, 0.1, 0.42]); }
    for (let q = 0; q < 26; q++) {
      const x = (sc(q, 3 + f) - 0.5) * (hw * 2 - 0.08), y = 0.05 + sc(q, 5 + f) * (hh - 0.1), s = 0.012 + sc(q, 7) * 0.025;
      const b = 1 + sc(q, 9) * 1.6;
      add(c + x - s, f < 0 ? v0 - 0.006 : v1, c + x + s, f < 0 ? v0 : v1 + 0.006, y - s, y + s, 14, [b, b * 0.95, b * 1.15], q % 7 === 0);
    }
  }
  // the night spilling out over the floor in front, thinning as it goes
  for (let q = 0; q < 34; q++) {
    const f = q % 2 ? 1 : -1, d = 0.15 + Math.pow(sc(q, 11), 1.6) * 2.1, x = (sc(q, 13) - 0.5) * (1.4 + d), s = 0.015 + sc(q, 15) * 0.02;
    add(c + x - s, c + f * d - s, c + x + s, c + f * d + s, 0.02, 0.02 + s * 1.5, 14, [0.8, 0.7, 1.5], q % 5 === 0);
  }
  // loose pieces of the frame, hanging still in the air
  for (let q = 0; q < 7; q++) {
    const x = (sc(q, 17) - 0.5) * 2.6, y = hh + 1.05 + sc(q, 19) * 1.0, z = (sc(q, 21) - 0.5) * 0.9, s = 0.06 + sc(q, 23) * 0.12;
    add(c + x - s, c + z - s, c + x + s, c + z + s, y - s, y + s, q % 3 ? BL : ST);
  }
  // the box that powers it: grey, on a post, with an empty socket for a fuse and a yellow warning label
  const fx = c - 2.7, fz = c + 0.5;
  add(fx - 0.04, fz - 0.04, fx + 0.04, fz + 0.04, 0, 1.15, 3, null, false, true);
  add(fx - 0.24, fz - 0.09, fx + 0.24, fz + 0.09, 1.15, 1.75, 2, null, false, true);
  add(fx - 0.2, fz - 0.1, fx + 0.2, fz - 0.09, 1.2, 1.7, 3);
  add(fx - 0.06, fz - 0.105, fx + 0.06, fz - 0.1, 1.38, 1.56, 8);
  add(fx - 0.12, fz - 0.105, fx + 0.12, fz - 0.1, 1.24, 1.32, 18);
  add(fx + 0.14, fz - 0.105, fx + 0.18, fz - 0.1, 1.62, 1.66, 14, [1.4, 0.15, 0.1], true);
  add(fx - 0.03, fz + 0.09, fx + 0.03, fz + 1.2, 0.0, 0.04, 3); // the cable to the door
  // two black stands with violet flames, either side
  for (const s of [-1, 1]) {
    const x = c + s * 1.75, z = c - 0.9;
    add(x - 0.035, z - 0.035, x + 0.035, z + 0.035, 0, 1.25, BL, null, false, true);
    add(x - 0.14, z - 0.14, x + 0.14, z + 0.14, 0, 0.05, BL);
    add(x - 0.1, z - 0.1, x + 0.1, z + 0.1, 1.25, 1.3, BL);
    add(x - 0.05, z - 0.05, x + 0.05, z + 0.05, 1.3, 1.46, 14, [0.55, 0.3, 1.6], true);
  }
}

// The way out: a tall white double door with panelled leaves, a cornice, brass pulls, three empty hollows
// where a handle should be, light pressing through every crack, and a red runner laid up to it.
function whiteDoor(add) {
  const c = 4.5, v0 = 0.5, hw = 1.25, hh = 3.4, W = 30, CR = 7, L = [1.9, 1.85, 1.65];
  // the light behind it, showing round the edges and down the middle
  add(c - hw, v0 - 0.02, c + hw, v0 + 0.02, 0, hh, 14, L, false, true);
  // leaves, slightly proud of the light, with a seam left between them
  for (const s of [-1, 1]) {
    const x0 = s < 0 ? c - hw + 0.03 : c + 0.025, x1 = s < 0 ? c - 0.025 : c + hw - 0.03;
    add(x0, v0 + 0.02, x1, v0 + 0.09, 0.025, hh - 0.03, W);
    for (const [y0, y1] of [[0.25, 1.35], [1.6, 3.05]]) { // raised panels
      add(x0 + 0.14, v0 + 0.09, x1 - 0.14, v0 + 0.115, y0, y1, CR);
      add(x0 + 0.2, v0 + 0.115, x1 - 0.2, v0 + 0.125, y0 + 0.06, y1 - 0.06, W);
    }
    add(s < 0 ? c - 0.11 : c + 0.07, v0 + 0.09, s < 0 ? c - 0.07 : c + 0.11, v0 + 0.16, 1.15, 1.75, 31); // brass pulls
  }
  // three hollows across the seam, waiting for what you carry; a faint cold light at the bottom of each
  for (const y of [2.05, 2.3, 2.55]) {
    add(c - 0.09, v0 + 0.09, c + 0.09, v0 + 0.13, y - 0.09, y + 0.09, 3);
    add(c - 0.05, v0 + 0.13, c + 0.05, v0 + 0.135, y - 0.05, y + 0.05, 14, [0.25, 0.6, 1.1], true);
  }
  // frame and cornice
  for (const s of [-1, 1]) {
    const x0 = s < 0 ? c - hw - 0.24 : c + hw, x1 = s < 0 ? c - hw : c + hw + 0.24;
    add(x0, v0 - 0.12, x1, v0 + 0.2, 0, hh + 0.24, CR, null, false, true);
    add(x0 - 0.06, v0 - 0.12, x1 + 0.06, v0 + 0.26, 0, 0.32, CR, null, false, true);
    add(x0 + 0.06, v0 + 0.2, x1 - 0.06, v0 + 0.23, 0.45, hh, W);
  }
  add(c - hw - 0.24, v0 - 0.12, c + hw + 0.24, v0 + 0.2, hh, hh + 0.24, CR);
  add(c - hw - 0.4, v0 - 0.12, c + hw + 0.4, v0 + 0.32, hh + 0.24, hh + 0.36, CR);
  add(c - hw - 0.3, v0 - 0.12, c + hw + 0.3, v0 + 0.26, hh + 0.36, hh + 0.48, W);
  add(c - 0.16, v0 + 0.2, c + 0.16, v0 + 0.3, hh + 0.02, hh + 0.36, CR); // keystone
  // light spilling under it, and the step it stands on
  add(c - hw, v0 + 0.09, c + hw, v0 + 0.8, 0, 0.012, 14, [0.9, 0.88, 0.8]);
  add(c - hw - 0.5, v0 - 0.1, c + hw + 0.5, v0 + 0.95, 0, 0.1, CR);
  // a red runner up to the step, with brass rods
  add(c - 0.75, v0 + 0.95, c + 0.75, 8.6, 0, 0.018, 15);
  add(c - 0.75, v0 + 0.95, c + 0.75, 8.6, 0.018, 0.02, 16);
  add(c - 0.68, v0 + 1.0, c + 0.68, 8.55, 0.02, 0.024, 15);
  for (let q = 0; q < 6; q++) { const v = v0 + 1.3 + q * 1.25; add(c - 0.82, v - 0.02, c + 0.82, v + 0.02, 0.018, 0.04, 31); }
  // a lamp on either side, in white shades
  for (const s of [-1, 1]) {
    const x = c + s * 2.4, z = v0 + 0.6;
    add(x - 0.04, z - 0.04, x + 0.04, z + 0.04, 0, 1.5, 31, null, false, true);
    add(x - 0.16, z - 0.16, x + 0.16, z + 0.16, 0, 0.04, 31);
    add(x - 0.2, z - 0.2, x + 0.2, z + 0.2, 1.5, 1.85, 14, [1.6, 1.45, 1.1]);
  }
}

export class Generator {
  constructor(seed) {
    this.seed = seed >>> 0;
    const rng = mulberry32(this.seed);
    this.realmField = new FourierField(rng, { features: 10, wavelength: 250, hidden: [14, 8], outputs: 3, gain: 1.25 });
    this.detailField = new FourierField(rng, { features: 12, wavelength: 44, hidden: [14, 8], outputs: 6, gain: 1.7 });
    this.architect = new Net([8, 18, 18, 28], rng, { gain: 2.0 });
    this.stance = new Net([8, 14, 14], rng, { gain: 2.0 });
    this.breeder = new Net([11, 22, 22, 36], rng, { gain: 2.0 });
    this.dim = 0;
    this.blocks = new Map(); this.regions = new Map(); this.sites = new Map();
    this._lat = new Float32Array(8);
    this._lk = -1; this._lb = null;
    this.si = SG >> 1; this.sj = SG >> 1;               // the start: middle of site square (0, 0), which is kept plain
    this.spawnX = (this.si + 0.5) * CS; this.spawnZ = (this.sj + 0.5) * CS;
    this.stats = { regions: 0 };
  }

  setDim(d) {
    this.dim = d;
    this.blocks.clear(); this.regions.clear(); this.sites.clear();
    this._lk = -1; this._lb = null;
  }

  nearSpawn(i, j, r) {
    return this.dim === 0 && Math.abs(i - this.si) <= r && Math.abs(j - this.sj) <= r;
  }

  // ---- districts -----------------------------------------------------------
  region(ri, rj) {
    const k = key(ri, rj);
    let R = this.regions.get(k);
    if (R) return R;
    const dim = this.dim, id = hash32(this.seed, ri, rj, 101 + dim * 7);
    const rng = mulberry32(id);
    const sx = (ri + 0.15 + 0.7 * rng()) * RS, sz = (rj + 0.15 + 0.7 * rng()) * RS;
    const lat = this._lat;
    for (let q = 0; q < 8; q++) lat[q] = gauss(rng);
    const o = Float32Array.from(this.architect.forward(lat));
    const u = q => 0.5 + 0.5 * o[q];
    const bias = [-0.1, 0.25, 0.3, 0.05, -0.35];
    let mode = 0, best = -9;
    for (let q = 0; q < 5; q++) { const v = o[q] + bias[q]; if (v > best) { best = v; mode = q; } }
    const great = mode === 3;
    const lt = u(16);
    const lc = lt < 0.5
      ? mix3([1.0, 0.86, 0.6], [0.86, 1.0, 0.8], lt * 2)
      : mix3([0.86, 1.0, 0.8], [0.74, 0.86, 1.0], (lt - 0.5) * 2);
    const hue = u(19) + 0.3 * o[4];
    const sat = 0.1 + 0.3 * u(20), val = 0.5 + 0.24 * u(21);
    const wallA = hsv(hue, sat, val);
    const wallB = hsv(hue + 0.05 * o[22], Math.min(0.6, sat * 1.3 + 0.04), val * (0.66 + 0.2 * u(23)));
    // some districts have no light at all
    const nearStart = dim === 0 && Math.hypot(sx - this.si, sz - this.sj) < 30;
    const dark = dim !== 2 && !nearStart && id % 100 < 36;
    const k1 = KIND_POOL[(id >>> 6) % KIND_POOL.length], k2 = KIND_POOL[(id >>> 10) % KIND_POOL.length];
    const sp = (id >>> 5) % SPACE_POOL.length;
    R = {
      id, ri, rj, sx, sz, mode, dark,
      a: 3 + Math.floor(u(5) * 4.99), b: 3 + Math.floor(u(6) * 4.99),
      density: 0.05 + 0.1 * u(7), doorRate: 0.2 + 0.5 * u(8),
      ceilBase: great ? 6 + Math.round(u(9) * 8) / 2 : 3.4 + Math.round(u(9) * 10) / 10,
      ceilVar: u(10) > 0.8 ? 0.5 + (1.5 * (u(10) - 0.8)) / 0.2 : 0,
      floorVar: u(11) > 0.93 ? 1 : 0,
      lsx: 2 + Math.floor(u(12) * 2.99), lsz: 2 + Math.floor(u(13) * 2.99),
      lpx: id & 3, lpz: (id >>> 2) & 3,
      fail: dark ? 1 : Math.pow(u(14), 2.4) * 0.7, flick: 0.03 + 0.2 * u(15) * u(15),
      lc, amb: dark ? [0, 0, 0] : [lc[0] * 0.02, lc[1] * 0.02, lc[2] * 0.022],
      fog: dark ? [0.001, 0.001, 0.002] : [wallA[0] * lc[0] * 0.12 + 0.006, wallA[1] * lc[1] * 0.12 + 0.006, wallA[2] * lc[2] * 0.12 + 0.007],
      pp: 2 + Math.floor(u(22) * 2.99), axis: o[23] > 0 ? 0 : 1,
      solidP: 0.005, wetPillars: o[24] > 0.1,
      texSeed: hash32(id, 7),
      wallStyle: Math.floor(u(25) * 2.99), floorStyle: Math.floor(u(24) * 2.99),
      bands: 2 + Math.floor(u(26) * 3.99), stripes: u(27) > 0.5,
      // fittings: a district uses two kinds, at a regular interval
      rail: o[12] > 0.15, crown: o[13] > -0.25, skirt: o[7] > -0.3, pipes: o[14] > 0.6, beams: great || o[8] > 0.8,
      trimCol: o[15] > 0 ? 7 : o[15] > -0.5 ? 1 : 3, pipeCol: o[6] > 0 ? 2 : 13,
      fits: [(id >>> 20) % 9, (id >>> 24) % 9], fitP: 4 + ((id >>> 27) % 4),
      // the rule its furniture obeys, the two kinds of thing it keeps, and the one way they are all wrong
      law: LAW_PICK[(id >>> 4) % 10], kinds: [k1, k2], odd: ODD_PICK[(id >>> 12) % 14],
      oddH: 0.9 + ((id >>> 16) % 8) * 0.15, oddDir: ((id >>> 18) % 8) * 0.785,
      // the outside: the rule things are arranged by, the height of the point they attend to, what they are
      slaw: (id >>> 4) % 2, fy: (((id >>> 8) % 5) - 2) * 2.5,
      skinds: THEMES[(id >>> 5) % THEMES.length], sp,
      glowCol: GLOWS[(id >>> 14) % 5], slots: null,
      wallA, wallB, wallAvg: mix3(wallA, wallB, 0.4),
      floorC: hsv(hue + 0.25 * o[24], 0.12 + 0.3 * u(25), 0.2 + 0.2 * u(26)),
      ceilC: hsv(hue, 0.05, 0.6),
      tileA: hsv(0.47 + 0.07 * o[26], 0.1 + 0.25 * u(27), 0.7),
      tileB: hsv(0.52 + 0.1 * o[20], 0.5, 0.36),
    };
    R.tileAvg = mix3(R.tileA, R.tileB, 0.4);
    this.regions.set(k, R);
    this.stats.regions++;
    return R;
  }

  regionAt(i, j) {
    const gi = Math.floor(i / RS), gj = Math.floor(j / RS);
    let best = null, bd = 1e18;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const R = this.region(gi + a, gj + b);
      const dx = R.sx - i - 0.5, dz = R.sz - j - 0.5, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = R; }
    }
    return best;
  }

  // Colours at a cell corner, shading from one district into the next over about twenty metres.
  // Writes 15 numbers at out[o]: wall, floor, ceiling, tile and light colour.
  blendAt(ci, cj, out, o, regs, ws, o9) {
    const gi = Math.floor(ci / RS), gj = Math.floor(cj / RS), Rs = this._br || (this._br = new Array(9)), D = this._bd || (this._bd = new Float32Array(9)), Wt = this._bw || (this._bw = new Float32Array(9));
    let dmin = 1e9, q = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++, q++) {
      const R = this.region(gi + a, gj + b), d = Math.hypot(R.sx - ci, R.sz - cj);
      Rs[q] = R; D[q] = d;
      if (d < dmin) dmin = d;
    }
    for (let k = 0; k < 15; k++) out[o + k] = 0;
    let sum = 0;
    for (q = 0; q < 9; q++) {
      let w = 1 - (D[q] - dmin) / 12;
      w = w > 0 ? w * w : 0;
      Wt[q] = w; sum += w;
      if (!w) continue;
      const R = Rs[q], A = R.wallAvg, F = R.floorC, C = R.ceilC, T = R.tileAvg, L = R.lc;
      for (let k = 0; k < 3; k++) { out[o + k] += w * A[k]; out[o + 3 + k] += w * F[k]; out[o + 6 + k] += w * C[k]; out[o + 9 + k] += w * T[k]; out[o + 12 + k] += w * L[k]; }
    }
    for (let k = 0; k < 15; k++) out[o + k] /= sum;
    if (regs) for (q = 0; q < 9; q++) { regs[o9 + q] = Rs[q]; ws[o9 + q] = Wt[q] / sum; } // how much of each district is here
  }

  // ---- sites: special rooms and the ways between dimensions -----------------
  site(si, sj) {
    const k = key(si, sj);
    let S = this.sites.get(k);
    if (S) return S;
    const dim = this.dim, h = hash32(this.seed, si, sj, 211), kk = h % 100, name = si + ',' + sj;
    let kind = 'none', to = -1;
    // links pair up: the same site is a way through in both of the dimensions it joins
    const pair = FORCED_LINK[name] || (FORCED[name] || name === '0,0' ? null : kk < 13 ? [0, 1] : kk < 22 ? [1, 2] : kk < 30 ? [0, 2] : null);
    if (pair) { if (pair[0] === dim) to = pair[1]; else if (pair[1] === dim) to = pair[0]; }
    if (to >= 0) kind = to === 1 ? 'hatch' : to === 2 ? 'stardoor' : 'door';
    else if (!pair && name !== '0,0') {
      const h2 = hash32(this.seed, si, sj, 223 + dim) % 100;
      if (dim === 0) {
        kind = FORCED[name] || (kk < 36 ? 'exit' : h2 < 10 ? 'cinema' : h2 < 18 ? 'playground' : h2 < 26 ? 'classroom' : h2 < 40 ? 'ring' : h2 < 48 ? 'storage' : h2 < 55 ? 'ward' : h2 < 61 ? 'office'
          : h2 < 67 ? 'party' : h2 < 72 ? 'laundry' : h2 < 78 ? 'waiting' : h2 < 83 ? 'nursery' : h2 < 87 ? 'chapel' : h2 < 91 ? 'camp' : 'none');
      } else if (dim === 1) kind = h2 < 14 ? 'classroom' : h2 < 22 ? 'playground' : h2 < 29 ? 'cinema' : h2 < 40 ? 'ring' : h2 < 49 ? 'waiting' : h2 < 56 ? 'party' : h2 < 64 ? 'laundry' : h2 < 71 ? 'chapel' : 'none';
    }
    S = { kind, to, si, sj, h, content: null };
    if (kind !== 'none') {
      const [w, d] = SIZE[kind], orient = (h >>> 8) & 1, I = orient ? d : w, J = orient ? w : d;
      S.w = w; S.d = d; S.orient = orient; S.I = I; S.J = J;
      S.i0 = si * SG + 1 + ((h >>> 10) % (SG - 1 - I)); S.j0 = sj * SG + 1 + ((h >>> 16) % (SG - 1 - J));
      S.cx = (S.i0 + I / 2) * CS; S.cz = (S.j0 + J / 2) * CS;
      // where you stand to use it
      const pv = kind === 'exit' ? 1.1 : 4.5;
      S.px = orient ? S.i0 * CS + pv : S.i0 * CS + 4.5; S.pz = orient ? S.j0 * CS + 4.5 : S.j0 * CS + pv;
    }
    this.sites.set(k, S);
    return S;
  }

  pieceAt(i, j) {
    if (this.dim === 2) return null;
    const S = this.site(fdiv(i, SG), fdiv(j, SG));
    if (S.kind === 'none') return null;
    const a = i - S.i0, b = j - S.j0;
    return a >= 0 && b >= 0 && a < S.I && b < S.J ? S : null;
  }

  // the special room this cell belongs to or borders
  nearPiece(i, j) {
    if (this.dim === 2) return null;
    const S = this.site(fdiv(i, SG), fdiv(j, SG));
    if (S.kind === 'none') return null;
    const a = i - S.i0, b = j - S.j0;
    return a >= -1 && b >= -1 && a <= S.I && b <= S.J ? S : null;
  }

  local(S, i, j) {
    const a = i - S.i0, b = j - S.j0;
    return S.orient ? [b, a] : [a, b];
  }

  // nearest site passing a test, searching outward square by square
  nearestSite(x, z, test, rings = 7) {
    const ci = fdiv(Math.floor(x / CS), SG), cj = fdiv(Math.floor(z / CS), SG);
    let best = null, bd = 1e18;
    for (let r = 0; r <= rings; r++) {
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
        if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
        const S = this.site(ci + a, cj + b);
        if (S.kind === 'none' || !test(S)) continue;
        const d = (S.cx - x) ** 2 + (S.cz - z) ** 2;
        if (d < bd) { bd = d; best = S; }
      }
      if (best && r >= 1 && bd < ((r - 0.5) * SG * CS) ** 2) break;
    }
    return best;
  }

  // the outside: nearest point that things attend to
  nearestFocus(x, z, test) {
    const gi = Math.floor(x / CS / RS), gj = Math.floor(z / CS / RS);
    let best = null, bd = 1e18;
    for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) {
      const R = this.region(gi + a, gj + b);
      if (!test(R)) continue;
      const d = (R.sx * CS - x) ** 2 + (R.sz * CS - z) ** 2;
      if (d < bd) { bd = d; best = R; }
    }
    return best;
  }

  focusItemId(R) { return '2:f:' + R.ri + ':' + R.rj; }

  // ---- blocks (16 x 16 cells) ----------------------------------------------
  base(cx, cz) {
    const k = key(cx, cz);
    if (k === this._lk) return this._lb;
    let b = this.blocks.get(k);
    if (!b) { b = this._makeBase(cx, cz); this.blocks.set(k, b); }
    this._lk = k; this._lb = b;
    return b;
  }

  _makeBase(cx, cz) {
    const b = {
      cx, cz, phase: 1,
      realm: new Uint8Array(256), floor: new Float32Array(256), ceil: new Float32Array(256),
      solid: new Uint8Array(256), reg: new Array(256), dens: new Float32Array(256),
      wallE: null, wallS: null, light: null, glow: null, pillar: null,
      props: null, boxes: null, decor: null, items: null, lightS: null, frags: undefined,
    };
    const i0 = cx * CN, j0 = cz * CN, dim = this.dim, seed = this.seed;
    const cand = [];
    for (let gi = Math.floor(i0 / RS) - 1; gi <= Math.floor((i0 + 15) / RS) + 1; gi++) {
      for (let gj = Math.floor(j0 / RS) - 1; gj <= Math.floor((j0 + 15) / RS) + 1; gj++) cand.push(this.region(gi, gj));
    }
    for (let lj = 0; lj < CN; lj++) for (let li = 0; li < CN; li++) {
      const k = li | (lj << 4), i = i0 + li, j = j0 + lj;
      const x = (i + 0.5) * CS, z = (j + 0.5) * CS;
      let R = cand[0], bd = 1e18;
      for (let q = 0; q < cand.length; q++) {
        const c = cand[q], dx = c.sx - i - 0.5, dz = c.sz - j - 0.5, d = dx * dx + dz * dz;
        if (d < bd) { bd = d; R = c; }
      }
      b.reg[k] = R;
      let realm = dim, floor = 0, ceil = 3.4, solid = 0;
      if (dim === 2) { floor = -FAR; ceil = FAR; }
      else {
        const d = this.detailField.eval(x, z), d0 = d[0], d1 = d[1], d2 = d[2];
        b.dens[k] = 0.35 + 0.65 * (d0 + 1);
        const P = this.pieceAt(i, j), NP = P || this.nearPiece(i, j);
        if (dim === 1) {
          // shallows you can stand in, then a few broad levels going down
          const o = this.realmField.eval(x, z), t = 0.5 + 0.5 * o[0];
          floor = t < 0.2 ? -1.4 : t < 0.42 ? -3 : t < 0.6 ? -6 : t < 0.76 ? -9 : t < 0.9 ? -12 : -15;
          if (floor <= -6 && o[2] > -0.25) ceil = Math.min(floor + 4 + Math.round(d1 + 1), -1.2);
          else ceil = Math.max(3.6, R.ceilBase) + (d1 > 0.35 ? 3 : 0);
          solid = d2 > 0.92 && floor <= -3 ? 1 : 0;
          if (NP) {
            solid = 0;
            floor = NP.kind === 'classroom' ? -1.4 : -6;
            ceil = !P ? Math.max(3.6, R.ceilBase) : P.kind === 'classroom' ? 3.4 : floor + (PIECE_H[P.kind] || 4);
          }
        } else {
          if (R.floorVar && d0 > 0.45) floor = 0.5;
          ceil = R.ceilBase + (R.ceilVar ? Math.round(R.ceilVar * Math.max(0, d1) * 4) / 4 : 0);
          if (ceil < floor + 3.2) ceil = floor + 3.2;
          solid = d2 > 0.93 || rand01(seed, i, j, 7) < R.solidP ? 1 : 0;
          if (NP) { solid = 0; floor = 0; }
          if (P) {
            ceil = PIECE_H[P.kind] || 3.6;
            if (P.kind === 'classroom') { // sunk and flooded to the desk tops; the two doorways are steps down
              const uv = this.local(P, i, j);
              realm = WET; floor = uv[1] === P.d - 1 && (uv[0] === 0 || uv[0] === P.w - 1) ? -0.8 : -1.4;
            }
          }
          if (this.nearSpawn(i, j, 2)) { solid = 0; floor = 0; }
        }
      }
      b.realm[k] = realm; b.floor[k] = floor; b.ceil[k] = ceil; b.solid[k] = solid;
    }
    return b;
  }

  block(cx, cz) {
    const b = this.base(cx, cz);
    if (b.phase >= 2) return b;
    const bE = this.base(cx + 1, cz), bS = this.base(cx, cz + 1);
    this._lk = key(cx, cz); this._lb = b;
    b.wallE = new Uint8Array(256); b.wallS = new Uint8Array(256);
    b.light = new Uint8Array(256); b.glow = new Uint8Array(256); b.pillar = new Uint8Array(256);
    b.phase = 2;
    if (this.dim === 2) return b;
    const i0 = cx * CN, j0 = cz * CN, seed = this.seed;
    for (let lj = 0; lj < CN; lj++) for (let li = 0; li < CN; li++) {
      const k = li | (lj << 4), i = i0 + li, j = j0 + lj;
      b.wallE[k] = li < 15 ? this._edge(b, k, b, k + 1, i, j, 0) : this._edge(b, k, bE, lj << 4, i, j, 0);
      b.wallS[k] = lj < 15 ? this._edge(b, k, b, k + 16, i, j, 1) : this._edge(b, k, bS, li, i, j, 1);
      if (b.solid[k]) continue;
      const R = b.reg[k], P = this.pieceAt(i, j);
      if (P) {
        const uv = this.local(P, i, j), L = pieceLight(P, uv[0], uv[1]);
        b.light[k] = L & 3; b.glow[k] = L >> 2;
        continue;
      }
      if (mod(i + R.lpx, R.lsx) === 0 && mod(j + R.lpz, R.lsz) === 0) {
        const r = rand01(seed, i, j, 13);
        b.light[k] = r < R.fail ? 3 : r < R.fail + R.flick ? 2 : 1;
      }
      if (i === this.si && j === this.sj && this.dim === 0) b.light[k] = 1;
      if (!this.nearSpawn(i, j, 2) && !this.nearPiece(i, j)) {
        const lattice = mod(i, R.pp) === 0 && mod(j, R.pp) === 0;
        if ((R.mode === 3 && lattice) || (b.realm[k] === WET && R.wetPillars && lattice && b.floor[k] < -2) || rand01(seed, i, j, 19) < 0.004) b.pillar[k] = 1;
      }
    }
    return b;
  }

  _edge(A, ka, B, kb, i, j, dir) {
    if (A.solid[ka] || B.solid[kb]) return 0;
    const ni = dir === 0 ? i + 1 : i, nj = dir === 0 ? j : j + 1;
    if (this.nearSpawn(i, j, 1) && this.nearSpawn(ni, nj, 1)) return 0;
    const s = this.seed;
    let w;
    const PA = this.pieceAt(i, j), PB = this.pieceAt(ni, nj);
    if (PA || PB) {
      if (PA === PB) return 0;
      const P = PA || PB;
      if (P.kind === 'ring') return 0;
      const uv = PA ? this.local(P, i, j) : this.local(P, ni, nj);
      // which wall of the room this edge is
      const side = dir === 0 ? (PA ? (P.orient ? 'S' : 'E') : (P.orient ? 'N' : 'W')) : (PA ? (P.orient ? 'E' : 'S') : (P.orient ? 'W' : 'N'));
      w = doorAt(P, uv[0], uv[1], side);
    } else {
      // the cells around a special room are kept open, so its doors always lead somewhere
      const NA = this.nearPiece(i, j);
      if (NA && NA === this.nearPiece(ni, nj)) return 0;
      const r = rand01(s, i, j, 17 + dir), r2 = rand01(s, i, j, 29 + dir), r3 = rand01(s, i, j, 41 + dir);
      w = wallRule(A.reg[ka], i, j, dir, r, r2, A.dens[ka], s);
      if (A.realm[ka] === WET && w && r3 < 0.4) w = 0;
      else if (A.realm[ka] === HALL && w === 1 && rand01(s, i, j, 47 + dir) < 0.04) w = 3; // now and then only a low gap
    }
    if (w >= 2) {
      const fa = A.floor[ka];
      if (fa !== B.floor[kb] || Math.min(A.ceil[ka], B.ceil[kb]) - fa < OPEN_H[w] + 0.3) w = w === 3 ? 1 : 0;
    }
    return w;
  }

  // ---- objects -------------------------------------------------------------
  isCache(b, k, i, j) {
    const R = b.reg[k];
    return R.law !== 4 && i === Math.floor(R.sx) && j === Math.floor(R.sz) && !b.solid[k] && !b.pillar[k] && !this.nearPiece(i, j) && !this.nearSpawn(i, j, 3);
  }

  cellProps(b, k, i, j) {
    if (b.props === null) b.props = new Array(256);
    let p = b.props[k];
    if (p !== undefined) return p;
    p = null;
    if (b.realm[k] !== VOID && !b.solid[k]) {
      const P = this.pieceAt(i, j);
      if (P) p = this._piece(P).props.get(key(i, j)) || null;
      else if (!b.pillar[k] && !this.nearPiece(i, j) && !this.nearSpawn(i, j, 2) && !this.isCache(b, k, i, j)) p = this._lawProps(b, k, i, j);
    }
    b.props[k] = p;
    return p;
  }

  // Furniture outside the special rooms. Each district keeps two kinds of thing, places them by one
  // rule, and gets them wrong in one consistent way.
  _lawProps(b, k, i, j) {
    const R = b.reg[k];
    if (R.law === 4) return null;
    const f = b.floor[k], c = b.ceil[k], cx = (i + 0.5) * CS, cz = (j + 0.5) * CS;
    const h = hash32(this.seed, i, j, 59), pct = h % 100;
    let yaw, pair = false;
    switch (R.law) {
      case 0: // on a wide lattice, every one of them facing the middle of the district
        if (mod(i, 4) !== 1 || mod(j, 4) !== 1 || pct >= 65) return null;
        yaw = Math.atan2(R.sx * CS - cx, R.sz * CS - cz);
        break;
      case 1: // only directly beneath a light that works, all facing the same way
        if (b.light[k] !== 1 || pct >= 45) return null;
        yaw = R.axis ? 0 : 1.5708;
        break;
      case 2: // in pairs, facing each other
        if (mod(i, 5) !== 2 || mod(j, 3) !== 1 || pct >= 70) return null;
        yaw = R.axis ? 0 : 1.5708; pair = true;
        break;
      default: { // in single file along every sixth row, as if waiting for something
        const row = R.axis ? i : j, al = R.axis ? j : i;
        if (mod(row, 6) !== 3 || mod(al, 2) !== 0) return null;
        yaw = R.axis ? 0 : 1.5708;
      }
    }
    let type = R.kinds[(h >>> 8) % 2];
    const def = PROPS[type], out = [], odd = R.odd;
    const mk = (x, z, yw, over) => {
      const s = Object.assign({
        type, x, y: f, z, yaw: yw, tilt: 0, tiltDir: 0, flip: 0, s: 1, mode: 'ground', sink: 0, dyn: 0,
        variant: ((h >>> 12) % 100) / 100, fy: f, cy: c, seed: h, col: null,
      }, over);
      if (odd === 1) { s.mode = 'ceil'; s.flip = 1; }
      else if (odd === 2) { s.mode = 'free'; s.y = f + R.oddH; }                      // all hanging at the same height
      else if (odd === 3) s.sink = 0.45;                                              // all sunk to the same depth
      else if (odd === 4) { s.tilt = 0.55; s.tiltDir = R.oddDir; }                    // all leaning the same way
      else if (odd === 5 && b.realm[k] === HALL && (type === 'chair' || type === 'door' || type === 'cabinet' || type === 'boxes')) { s.mode = 'free'; s.dyn = 2; }
      else if (odd === 6 && c - f > def.h * 2.1) s.s = 2;                             // all twice the size
      if (!s.dyn) s.col = propAABBs(s);
      out.push(s);
      return s;
    };
    if (pair) {
      const ax = R.axis ? 0 : 1, az = R.axis ? 1 : 0;
      mk(cx - ax * 0.9, cz - az * 0.9, yaw); mk(cx + ax * 0.9, cz + az * 0.9, yaw + Math.PI);
    } else if (odd === 7 && (type === 'chair' || type === 'table' || type === 'boxes' || type === 'tv' || type === 'cabinet')) {
      // stacks, one taller for every few steps away from the middle of the district
      const n = Math.max(1, Math.min(1 + Math.floor(Math.hypot(R.sx - i, R.sz - j) / 4), Math.floor((Math.min(c, f + 12) - f) / def.h)));
      for (let q = 0; q < n; q++) mk(cx, cz, yaw + q * 0.4, q ? { mode: 'free', y: f + q * def.h * 0.98 } : {});
    } else if (odd === 8 || odd === 9) {
      // the same thing several times in a row: each one larger than the last, or large and small by turns
      const wide = def.hx > 0.4 || def.hz > 0.4;
      const sizes = odd === 8 ? (wide ? [0.4, 0.65, 0.95] : [0.45, 0.7, 1.0, 1.4]) : (wide ? [0.9, 0.45, 0.9] : [1.2, 0.5, 1.2, 0.5, 1.2]);
      const w = 2 * Math.max(def.hx, def.hz), ax = R.axis ? 1 : 0, az = R.axis ? 0 : 1;
      let tot = -0.12;
      for (const sc of sizes) tot += w * sc + 0.12;
      let p = -tot / 2;
      for (const sc of sizes) { p += (w * sc) / 2; mk(cx + ax * p, cz + az * p, yaw, { s: sc }); p += (w * sc) / 2 + 0.12; }
    } else mk(cx, cz, yaw);
    return out;
  }

  // Contents of a special room, built once: props, fittings and items keyed by cell.
  _piece(S) {
    if (S.content) return S.content;
    const props = new Map(), decor = new Map(), items = new Map();
    const o = S.orient, ox = S.i0 * CS, oz = S.j0 * CS, dim = this.dim, rng = mulberry32(S.h ^ 0x77aa);
    S.content = { props, decor, items };
    const W = (lu, lv) => (o ? [ox + lv, oz + lu] : [ox + lu, oz + lv]);
    // facing: 0 the front (v = 0), 1 +u, 2 the back, 3 -u
    const YAW = o ? [-1.5708, 0, 1.5708, Math.PI] : [Math.PI, 1.5708, 0, -1.5708];
    const fc = (x, z) => {
      const i = Math.floor(x / CS), j = Math.floor(z / CS), b = this.base(i >> 4, j >> 4), k = (i & 15) | ((j & 15) << 4);
      return [b.floor[k], b.ceil[k], i, j];
    };
    const prop = (type, lu, lv, d, over) => {
      const xz = W(lu, lv), q = fc(xz[0], xz[1]);
      const s = Object.assign({
        type, x: xz[0], y: q[0], z: xz[1], yaw: YAW[d], tilt: 0, tiltDir: 0, flip: 0, s: 1, mode: 'ground', sink: 0, dyn: 0,
        variant: rng(), fy: q[0], cy: q[1], seed: (rng() * 4294967296) >>> 0, col: null,
      }, over);
      s.col = propAABBs(s);
      const kk = key(q[2], q[3]);
      if (!props.has(kk)) props.set(kk, []);
      props.get(kk).push(s);
      return s;
    };
    // a box in the room's own metres; heights are above the floor under its middle
    const box = (lu0, lv0, lu1, lv1, y0, y1, col, glow = null, flick = false, solid = false) => {
      const a = W(lu0, lv0), c = W(lu1, lv1);
      const x0 = Math.min(a[0], c[0]), x1 = Math.max(a[0], c[0]), z0 = Math.min(a[1], c[1]), z1 = Math.max(a[1], c[1]);
      const q = fc((x0 + x1) / 2, (z0 + z1) / 2), kk = key(q[2], q[3]);
      let d = decor.get(kk);
      if (!d) { d = { boxes: [], cols: [] }; decor.set(kk, d); }
      d.boxes.push(x0, q[0] + y0, z0, x1, q[0] + y1, z1, col, glow ? glow[0] : 0, glow ? glow[1] : 0, glow ? glow[2] : 0, flick ? 10 : 0);
      if (solid) d.cols.push(x0, q[0] + y0, z0, x1, q[0] + y1, z1);
    };
    const item = (type, lu, lv, h) => {
      const xz = W(lu, lv), q = fc(xz[0], xz[1]);
      const it = { type, x: xz[0], y: q[0] + h, z: xz[1], id: dim + ':' + q[2] + ':' + q[3] };
      items.set(key(q[2], q[3]), it);
      if (ITEM_TOKEN[type]) S.token = it;
      return it;
    };
    const token = dim === 1 ? 'pearl' : 'key';
    switch (S.kind) {
      case 'cinema': { // rows of red seats facing a screen that is showing nothing
        box(1.5, 0.1, 13.5, 0.2, 1.3, 4.9, 14, [0.7, 0.75, 0.85], true);
        box(0.25, 0.1, 1.4, 0.55, 0, 5.3, 16); box(13.6, 0.1, 14.75, 0.55, 0, 5.3, 16);
        const br = 2 + Math.floor(rng() * 6), bs = Math.floor(rng() * 10);
        for (let r = 0; r < 8; r++) for (let q = 0; q < 10; q++) {
          // every seat faces the screen. one of them faces you.
          prop('armchair', q < 5 ? 1.0 + q * 1.1 : 9.6 + (q - 5) * 1.1, 6 + r * 1.75, r === br && q === bs ? 2 : 0);
        }
        for (let r = 0; r < 9; r++) {
          const lv = 5.2 + r * 1.75;
          box(6.25, lv, 6.35, lv + 0.3, 0, 0.04, 14, [0.5, 0.04, 0.03]); box(8.65, lv, 8.75, lv + 0.3, 0, 0.04, 14, [0.5, 0.04, 0.03]);
        }
        box(7.2, 19.6, 7.8, 20.3, 0, 1.3, 3, null, false, true); box(7.15, 19.5, 7.85, 20.4, 1.3, 1.85, 9, null, false, true);
        box(7.4, 19.42, 7.6, 19.5, 1.5, 1.7, 14, [0.9, 0.9, 1.0]);
        item(dim === 1 ? 'pearl' : 'cassette', 7.5, 3.5, 0.9); if (dim === 1) item('fuse', 7.5, 18.4, 0.7);
        break;
      }
      case 'playground': { // swings, a slide, a frame to climb, nobody
        const Y = 18, B = 19, RU = 17, RED = 4;
        for (const lu of [3, 7]) for (const lv of [4.4, 5.6]) box(lu - 0.04, lv - 0.04, lu + 0.04, lv + 0.04, 0, 2.7, Y, null, false, true);
        box(3, 4.95, 7, 5.05, 2.62, 2.7, Y); box(2.96, 4.4, 3.04, 5.6, 2.62, 2.7, Y); box(6.96, 4.4, 7.04, 5.6, 2.62, 2.7, Y);
        box(4.05, 4.99, 4.07, 5.01, 0.5, 2.62, 3); box(4.53, 4.99, 4.55, 5.01, 0.5, 2.62, 3);
        box(4.02, 4.9, 4.58, 5.1, 0.46, 0.5, RED, null, false, true);
        box(5.42, 5.75, 5.98, 5.95, 1.25, 1.29, RED, null, false, true); // the other seat stopped at the top of its swing; nothing holds it there
        box(11.6, 4.7, 11.66, 4.76, 0, 1.9, RU, null, false, true); box(11.6, 5.24, 11.66, 5.3, 0, 1.9, RU, null, false, true);
        for (let q = 0; q < 5; q++) box(11.6, 4.76, 11.66, 5.24, 0.3 + q * 0.36, 0.33 + q * 0.36, RU);
        box(11.66, 4.6, 12.6, 5.4, 1.8, 1.88, B, null, false, true);
        for (let q = 0; q < 6; q++) box(12.6 + q * 0.6, 4.65, 13.2 + q * 0.6, 5.35, 1.5 - q * 0.27, 1.58 - q * 0.27, B, null, false, true);
        box(12, 12, 14, 14, 0.3, 0.42, RED, null, false, true); box(12.94, 12.94, 13.06, 13.06, 0, 0.95, 3, null, false, true);
        box(12.1, 12.98, 13.9, 13.02, 0.9, 0.94, Y); box(12.98, 12.1, 13.02, 13.9, 0.9, 0.94, Y);
        for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) box(8 + a - 0.03, 8 + c - 0.03, 8 + a + 0.03, 8 + c + 0.03, 0, 2.2, RU, null, false, true);
        for (const hh of [1.1, 2.2]) for (let a = 0; a < 3; a++) {
          box(8 + a - 0.03, 8, 8 + a + 0.03, 10, hh - 0.03, hh + 0.03, RU); box(8, 8 + a - 0.03, 10, 8 + a + 0.03, hh - 0.03, hh + 0.03, RU);
        }
        box(7.8, 2, 10.2, 2.15, 0, 0.2, 0, null, false, true); box(7.8, 4.25, 10.2, 4.4, 0, 0.2, 0, null, false, true);
        box(7.8, 2.15, 7.95, 4.25, 0, 0.2, 0, null, false, true); box(10.05, 2.15, 10.2, 4.25, 0, 0.2, 0, null, false, true);
        box(7.95, 2.15, 10.05, 4.25, 0, 0.08, 20);
        for (let q = 0; q < 6; q++) { const a = 15.2 + (q % 3 === 1 ? 0.3 : q % 3 === 2 ? -0.3 : 0); box(a, 7.5 + q * 0.62, a + 0.55, 8.05 + q * 0.62, 0, 0.004, 22); }
        prop('seesaw', 4.5, 13, 1, { tilt: 0.22, tiltDir: o ? 0 : 1.5708 });
        prop('bench', 1.0, 9, 1); prop('bench', 17.0, 9, 3);
        item(token, 9, 3.2, 0.7);
        break;
      }
      case 'classroom': { // flooded to the desk tops
        box(2, 0.09, 10, 0.15, 2.3, 3.6, 21); box(2, 0.15, 10, 0.24, 2.22, 2.3, 1);
        for (let q = 0; q < 5; q++) { const a = 2.6 + q * 1.5 + rng() * 0.4, y = 2.6 + rng() * 0.7; box(a, 0.15, a + 0.5 + rng() * 0.5, 0.158, y, y + 0.03, 22); }
        box(5.8, 0.09, 6.2, 0.13, 3.85, 4.25, 7); box(5.99, 0.13, 6.01, 0.135, 4.05, 4.2, 8);
        prop('table', 6, 1.5, 2); prop('chair', 6, 0.8, 2);
        for (let r = 0; r < 5; r++) for (let q = 0; q < 4; q++) {
          if (r === 4 && (q === 0 || q === 3)) continue; // the way in
          const lu = 1.8 + q * 2.8, lv = 4.2 + r * 2.1;
          prop('desk', lu, lv, 0);
          // most chairs are where they were left; some have floated up and stay there
          if (rng() < 0.25) prop('chair', lu + rng() - 0.5, lv + 0.8, 0, { mode: 'free', y: WL - 0.55, tilt: 1.5708, tiltDir: rng() < 0.5 ? 0 : 1.5708 });
          else prop('chair', lu, lv + 0.62, 0);
        }
        // windows letting in a daylight that has no source
        for (const lv of [3, 7.5, 12]) {
          box(0.09, lv - 0.8, 0.14, lv + 0.8, 2.3, 3.7, 7); box(0.14, lv - 0.72, 0.16, lv + 0.72, 2.38, 3.62, 14, [0.85, 0.75, 0.45]);
          box(0.16, lv - 0.02, 0.18, lv + 0.02, 2.38, 3.62, 7);
        }
        item(dim === 1 ? 'pearl' : 'cassette', 6, 1.5, 1.15);
        break;
      }
      case 'ring': { // chairs in a circle; what they are for is in the middle
        const c = W(4.5, 4.5);
        for (let q = 0; q < 8; q++) {
          const a = (q / 8) * 6.2832, p = W(4.5 + Math.sin(a) * 1.3, 4.5 + Math.cos(a) * 1.3);
          prop('chair', 4.5 + Math.sin(a) * 1.3, 4.5 + Math.cos(a) * 1.3, 0, { yaw: Math.atan2(c[0] - p[0], c[1] - p[1]) });
        }
        item(token, 4.5, 4.5, 0.9);
        break;
      }
      case 'storage': {
        for (let q = 0; q < 6; q++) { prop('shelf', 0.3, 1.2 + q * 1.8, 1); prop('shelf', 8.7, 1.2 + q * 1.8, 3); }
        prop('boxes', 4.5, 3.6, 0); prop('boxes', 4.2, 7.4, 1); prop('boxes', 4.9, 8.3, 2);
        item('battery', 2.4, 2.2, 0.9); item('shells', 6.6, 5.5, 0.9); item('grease', 2.4, 9.5, 0.9); item('medkit', 6.6, 9.5, 0.9);
        break;
      }
      case 'ward': { // beds, made, in two rows
        for (let q = 0; q < 5; q++) {
          const lv = 1.5 + q * 3;
          prop('bed', 1.15, lv, 1); prop('bed', 7.85, lv, 3);
          if (q % 2 === 0) prop('pole', 0.45, lv + 0.85, 1); else prop('pole', 8.55, lv - 0.85, 3);
        }
        item('medkit', 1.2, 4.5, 0.85); item('medkit', 7.8, 10.5, 0.85); item('tonic', 4.5, 13.5, 0.9); item('memo', 4.5, 7.5, 0.9);
        break;
      }
      case 'office': {
        prop('table', 4.5, 4.2, 2); prop('chair', 4.5, 3.4, 2);
        prop('cabinet', 1.2, 0.45, 2); prop('cabinet', 2.0, 0.45, 2); prop('plant', 8.2, 0.8, 0); prop('shelf', 8.7, 5.5, 3);
        // the pump computer: a beige monitor, its screen green, a keyboard, a mug gone cold
        box(4.25, 4.15, 4.75, 4.5, 0.77, 0.81, 9); box(4.15, 4.2, 4.85, 4.56, 0.81, 1.3, 33, null, false, true);
        box(4.22, 4.18, 4.78, 4.2, 0.87, 1.24, 14, [0.25, 1.1, 0.45], true);
        box(4.2, 3.86, 4.8, 4.06, 0.77, 0.79, 33); box(4.23, 3.89, 4.77, 4.03, 0.79, 0.795, 9);
        box(5.0, 3.95, 5.1, 4.05, 0.77, 0.87, 30);
        item('cassette', 1.4, 7.6, 0.6); item('gaskets', 1.6, 0.6, 1.45);
        break;
      }
      case 'party': { // a birthday: a long table, paper hats, a cake nobody cut, balloons against the ceiling
        const HAT = [28, 32, 29, 15, 19];
        for (const lv of [3.6, 5.0, 6.4, 7.8]) prop('table', 4.5, lv, 1);
        let n = 0;
        for (let q = 0; q < 5; q++) for (const [lu, d, pu] of [[3.75, 1, 4.3], [5.25, 3, 4.7]]) {
          const lv = 3.3 + q * 1.2;
          if (n === 7) prop('chair', lu + (d === 1 ? -0.55 : 0.55), lv + 0.3, d, { mode: 'free', y: 0.24, tilt: 1.5708, tiltDir: o ? 1.5708 : 0 }); // knocked over
          else prop('chair', lu, lv, d);
          box(pu - 0.12, lv - 0.12, pu + 0.12, lv + 0.12, 0.77, 0.785, 30);
          const hc = HAT[n % 5];
          box(pu - 0.06, lv - 0.06, pu + 0.06, lv + 0.06, 0.785, 0.87, hc); box(pu - 0.035, lv - 0.035, pu + 0.035, lv + 0.035, 0.87, 0.94, hc); box(pu - 0.012, lv - 0.012, pu + 0.012, lv + 0.012, 0.94, 0.99, 29);
          n++;
        }
        box(4.22, 7.82, 4.78, 8.38, 0.77, 0.8, 28); box(4.25, 7.85, 4.75, 8.35, 0.8, 0.95, 30); box(4.27, 7.87, 4.73, 8.33, 0.95, 0.97, 28);
        box(4.48, 8.08, 4.52, 8.12, 0.97, 1.09, 29); box(4.47, 8.07, 4.53, 8.13, 1.09, 1.15, 14, [1.9, 1.1, 0.4], true);
        for (let q = 0; q < 11; q++) { // balloons, and their strings
          const lu = 1 + rng() * 7, lv = 1 + rng() * 10, c = HAT[q % 5], low = q === 10;
          const y0 = low ? 1.05 : 2.88, s = 0.17;
          box(lu - s, lv - s, lu + s, lv + s, y0, y0 + 0.42, c); box(lu - 0.03, lv - 0.03, lu + 0.03, lv + 0.03, y0 - 0.05, y0, c);
          box(lu - 0.006, lv - 0.006, lu + 0.006, lv + 0.006, low ? 0 : 1.5 + rng() * 0.8, y0 - 0.05, 7);
        }
        box(0.4, 0.08, 8.6, 0.1, 3.0, 3.02, 7); // bunting
        for (let q = 0; q < 14; q++) { const a = 0.6 + q * 0.58; box(a, 0.08, a + 0.3, 0.12, 2.76, 3.0, HAT[q % 5]); box(a + 0.08, 0.08, a + 0.22, 0.12, 2.66, 2.76, HAT[q % 5]); }
        box(7.6, 1.0, 8.2, 1.6, 0, 0.5, 19, null, false, true); box(7.85, 0.98, 7.95, 1.62, 0, 0.52, 29); box(7.58, 1.25, 8.22, 1.35, 0, 0.52, 29);
        prop('lamp', 0.5, 0.5, 0); prop('cabinet', 0.4, 10.6, 1);
        item('tonic', 7.9, 10.5, 0.6); item('cassette', 1.4, 7.0, 0.9); if (dim === 1) item('wax', 4.5, 7.6, 1.2);
        break;
      }
      case 'laundry': { // a laundrette; machine four is running
        for (let q = 0; q < 6; q++) {
          const lu = 0.9 + q * 1.45, run = q === 3;
          box(lu - 0.33, 0.1, lu + 0.33, 0.75, 0, 0.9, 30, null, false, true);
          box(lu - 0.33, 0.1, lu + 0.33, 0.75, 0.9, 0.93, 9);
          box(lu - 0.3, 0.75, lu + 0.3, 0.77, 0.74, 0.86, 9); box(lu + 0.16, 0.77, lu + 0.24, 0.8, 0.77, 0.83, 2);
          box(lu - 0.23, 0.75, lu + 0.23, 0.78, 0.18, 0.64, 3);
          box(lu - 0.16, 0.78, lu + 0.16, 0.79, 0.25, 0.57, run ? 14 : 8, run ? [0.3, 0.5, 0.65] : null, run);
          if (run) box(lu - 0.24, 0.77, lu - 0.2, 0.78, 0.78, 0.82, 14, [0.3, 1.6, 0.4]);
        }
        for (let q = 0; q < 3; q++) { // dryers, stacked, along the side
          const lv = 2.6 + q * 1.5;
          for (const y of [0, 0.88]) {
            box(0.1, lv - 0.36, 0.76, lv + 0.36, y, y + 0.86, 30, null, false, true);
            box(0.76, lv - 0.22, 0.78, lv + 0.22, y + 0.2, y + 0.64, 3); box(0.78, lv - 0.16, 0.79, lv + 0.16, y + 0.26, y + 0.58, 8);
          }
        }
        prop('table', 5, 5, 0);
        box(4.5, 4.8, 4.9, 5.15, 0.77, 0.85, 32); box(4.52, 4.82, 4.88, 5.13, 0.85, 0.92, 28); box(5.2, 4.8, 5.6, 5.15, 0.77, 0.84, 6); box(5.22, 4.82, 5.58, 5.13, 0.84, 0.9, 7);
        box(6.2, 6.4, 6.8, 6.9, 0, 0.36, 10, null, false, true); box(6.25, 6.45, 6.75, 6.85, 0.34, 0.37, 32);
        for (let q = 0; q < 4; q++) prop('chair', 8.5, 3 + q * 1.1, 3);
        box(3.0, 7.2, 3.25, 7.28, 0, 0.03, 7); box(3.18, 7.2, 3.26, 7.36, 0, 0.03, 7); // one sock
        prop('plant', 8.4, 8.4, 0);
        item('battery', 5.0, 5.0, 0.98); item(dim === 1 ? 'oilskin' : 'gaskets', 6.5, 6.65, 0.55);
        break;
      }
      case 'waiting': { // a waiting room: rows of chairs, a counter with nobody behind it, NOW SERVING 0
        box(2, 0.6, 7, 1.3, 0, 1.05, 1, null, false, true); box(1.95, 0.55, 7.05, 1.35, 1.05, 1.1, 7);
        box(5.6, 0.85, 5.72, 0.97, 1.1, 1.16, 31);
        const RD = [1.6, 0.12, 0.08];
        box(3.5, 0.08, 5.5, 0.14, 2.25, 3.0, 8);
        box(4.3, 0.14, 4.7, 0.16, 2.8, 2.85, 14, RD); box(4.3, 0.14, 4.7, 0.16, 2.4, 2.45, 14, RD);
        box(4.3, 0.14, 4.35, 0.16, 2.4, 2.85, 14, RD); box(4.65, 0.14, 4.7, 0.16, 2.4, 2.85, 14, RD);
        box(3.7, 0.14, 4.1, 0.16, 2.6, 2.65, 14, [0.5, 0.05, 0.03]); box(4.9, 0.14, 5.3, 0.16, 2.6, 2.65, 14, [0.5, 0.05, 0.03]);
        const coat = { r: 1, q: 4 };
        for (let r = 0; r < 4; r++) for (let q = 0; q < 6; q++) {
          const lu = q < 3 ? 1.3 + q * 0.85 : 5.4 + (q - 3) * 0.85, lv = 4.4 + r * 1.75;
          prop('chair', lu, lv, 0);
          if (r === coat.r && q === coat.q) { box(lu - 0.25, lv + 0.12, lu + 0.25, lv + 0.3, 0.4, 1.02, 6); box(lu - 0.2, lv - 0.05, lu + 0.2, lv + 0.18, 0.47, 0.52, 6); item('cassette', lu, lv, 0.75); }
        }
        box(7.47, 11.17, 7.53, 11.23, 0, 1.1, 2, null, false, true); box(7.35, 11.05, 7.65, 11.35, 1.1, 1.45, 24); box(7.42, 11.04, 7.58, 11.05, 1.2, 1.24, 14, [1.2, 1.2, 1.1]);
        for (let q = 0; q < 14; q++) { const lu = 1 + rng() * 7, lv = 3 + rng() * 8.5; box(lu, lv, lu + 0.06, lv + 0.11, 0, 0.004, 7); }
        prop('plant', 0.6, 0.6, 0); prop('plant', 8.4, 0.6, 0); prop('plant', 0.6, 11.4, 0); prop('tv', 8.4, 6.2, 3);
        item('flare', 2.5, 1.0, 1.25); if (dim === 1) { item('oilskin', 8.3, 10.4, 0.5); item('fuse', 6.5, 1.0, 1.25); }
        break;
      }
      case 'nursery': { // a child's room, kept as it was; only the night light is on
        prop('bed', 0.75, 2.2, 2, { s: 0.78 });
        box(0.08, 3.35, 0.12, 3.55, 0.28, 0.46, 14, [1.6, 1.05, 0.45]); box(0.1, 3.3, 0.16, 3.6, 0.24, 0.28, 30);
        box(3.4, 0.1, 5.6, 0.72, 0, 2.3, 1, null, false, true); box(3.35, 0.08, 5.65, 0.76, 2.3, 2.38, 0);
        box(3.45, 0.72, 4.48, 0.75, 0.05, 2.25, 0); box(4.6, 0.72, 5.55, 0.75, 0.05, 2.25, 0);
        box(4.48, 0.7, 4.6, 0.74, 0.05, 2.25, 8); // open the width of a hand
        box(4.51, 0.73, 4.53, 0.745, 1.52, 1.535, 14, [0.35, 0.3, 0.22]); box(4.56, 0.73, 4.58, 0.745, 1.52, 1.535, 14, [0.35, 0.3, 0.22]);
        box(4.3, 0.74, 4.36, 0.78, 1.0, 1.12, 31); box(4.64, 0.74, 4.7, 0.78, 1.0, 1.12, 31);
        // the bear, sitting on the rug, facing the wardrobe
        const B = 35;
        box(4.3, 2.5, 4.7, 2.8, 0, 0.36, B); box(4.36, 2.52, 4.64, 2.78, 0.36, 0.62, B);
        box(4.36, 2.6, 4.44, 2.68, 0.62, 0.69, B); box(4.56, 2.6, 4.64, 2.68, 0.62, 0.69, B);
        box(4.22, 2.55, 4.3, 2.75, 0.12, 0.3, B); box(4.7, 2.55, 4.78, 2.75, 0.12, 0.3, B);
        box(4.3, 2.3, 4.45, 2.52, 0, 0.12, B); box(4.55, 2.3, 4.7, 2.52, 0, 0.12, B);
        box(4.42, 2.5, 4.46, 2.52, 0.48, 0.52, 8); box(4.54, 2.5, 4.58, 2.52, 0.48, 0.52, 8); box(4.46, 2.49, 4.54, 2.52, 0.4, 0.45, 1);
        box(2.6, 2.0, 6.4, 5.4, 0, 0.015, 28);
        const BL = [24, 32, 29, 25];
        for (let q = 0; q < 4; q++) { const a = 1.6 + (q % 2) * 0.03; box(a, 4.4, a + 0.2, 4.6, q * 0.2, q * 0.2 + 0.2, BL[q]); }
        box(2.1, 4.9, 2.3, 5.1, 0, 0.2, 19); box(2.35, 4.75, 2.55, 4.95, 0, 0.2, 28);
        box(1.15, 2.15, 1.17, 2.17, 2.2, 3.0, 7); box(0.8, 2.15, 1.52, 2.17, 2.2, 2.22, 7); // the mobile
        for (const [a, h] of [[0.82, 2.0], [1.0, 1.9], [1.32, 2.05], [1.5, 1.95]]) { box(a - 0.005, 2.155, a + 0.005, 2.165, h + 0.1, 2.2, 7); box(a - 0.05, 2.11, a + 0.05, 2.21, h, h + 0.1, 29); }
        prop('desk', 7.5, 2, 3); prop('chair', 6.95, 2, 1, { s: 0.75 });
        box(7.35, 1.85, 7.65, 2.15, 0.74, 0.745, 7); box(7.4, 1.95, 7.6, 1.98, 0.745, 0.75, 24); box(7.45, 2.02, 7.48, 2.1, 0.745, 0.75, 8);
        item('cassette', 7.6, 2.4, 0.95);
        break;
      }
      case 'chapel': { // pews facing a door that does not open
        for (let r = 0; r < 6; r++) { const lv = 5 + r * 1.6; prop('bench', 2.5, lv, 0); prop('bench', 6.5, lv, 0); }
        box(3.2, 1.6, 5.8, 2.5, 0, 1.0, 23, null, false, true); box(3.1, 1.55, 5.9, 2.55, 1.0, 1.04, 7); box(3.1, 1.53, 5.9, 1.56, 0.55, 1.04, 7);
        for (let q = 0; q < 5; q++) { const a = 3.5 + q * 0.5, h = 1.16 + rng() * 0.14; box(a - 0.03, 2.02, a + 0.03, 2.08, 1.04, h, 7); box(a - 0.02, 2.03, a + 0.02, 2.07, h, h + 0.06, 14, [1.8, 1.1, 0.4], true); }
        box(3.7, 0.08, 3.85, 0.3, 0, 2.6, 1, null, false, true); box(5.15, 0.08, 5.3, 0.3, 0, 2.6, 1, null, false, true); box(3.7, 0.08, 5.3, 0.3, 2.45, 2.6, 1);
        box(3.85, 0.1, 5.15, 0.18, 0, 2.45, 0); box(4.95, 0.18, 5.02, 0.22, 1.1, 1.18, 31);
        box(3.85, 0.18, 5.15, 0.6, 0, 0.008, 14, [1.2, 0.9, 0.5]);                    // light under the door
        for (let q = 0; q < 4; q++) box(3.55 + q * 0.5, 2.75, 3.95 + q * 0.5, 3.1, 0, 0.08, 15);
        for (const u of [0.35, 8.65]) for (let k = 0; k < 3; k++) { // racks of candles along the walls
          const lv = 5.5 + k * 3;
          box(u - 0.2, lv - 0.4, u + 0.2, lv + 0.4, 0.85, 0.9, 31); box(u - 0.03, lv - 0.03, u + 0.03, lv + 0.03, 0, 0.85, 3, null, false, true);
          for (let q = 0; q < 6; q++) { const z = lv - 0.3 + q * 0.12; if (rng() < 0.3) continue; box(u - 0.02, z - 0.02, u + 0.02, z + 0.02, 0.9, 0.98, 7); box(u - 0.015, z - 0.015, u + 0.015, z + 0.015, 0.98, 1.02, 14, [1.7, 1.0, 0.35], true); }
        }
        for (const lv of [4, 8, 12]) { box(0.08, lv - 0.25, 0.12, lv + 0.25, 2.2, 5.4, 14, [0.25, 0.3, 0.5]); box(8.88, lv - 0.25, 8.92, lv + 0.25, 2.2, 5.4, 14, [0.25, 0.3, 0.5]); }
        item('flare', 0.8, 13.6, 0.5); item('medkit', 7.9, 13.2, 0.5); if (dim === 1) item('wax', 4.5, 2.0, 1.2);
        break;
      }
      case 'camp': { // where the surveyor slept, and counted, and stopped
        box(1.0, 6.2, 3.0, 7.0, 0, 0.14, 34); box(1.05, 6.3, 1.45, 6.9, 0.14, 0.24, 7); box(2.0, 6.2, 3.0, 7.0, 0.14, 0.17, 6);
        box(3.3, 6.5, 3.5, 6.7, 0, 0.06, 3); box(3.32, 6.52, 3.48, 6.68, 0.06, 0.28, 14, [1.7, 1.15, 0.5], true); box(3.3, 6.5, 3.5, 6.7, 0.28, 0.32, 3);
        for (const [a, b] of [[-0.28, 0], [0.16, 0.24], [0.16, -0.24]]) box(5.5 + a - 0.02, 4 + b - 0.02, 5.5 + a + 0.02, 4 + b + 0.02, 0, 1.3, 1);
        box(5.4, 3.9, 5.6, 4.1, 1.3, 1.38, 3); box(5.38, 3.92, 5.62, 4.08, 1.38, 1.6, 18); box(5.58, 3.95, 5.9, 4.05, 1.45, 1.53, 3);
        box(5.9, 3.97, 5.92, 4.03, 1.47, 1.51, 14, [0.5, 0.8, 1.2]);
        box(2.5, 2, 4, 3.1, 0, 0.012, 7); box(3.2, 2.4, 4.6, 3.4, 0.012, 0.022, 20);
        box(2.7, 2.5, 3.9, 2.53, 0.012, 0.016, 24); box(3.5, 2.6, 3.53, 3.3, 0.022, 0.026, 24); box(3.9, 2.9, 4.4, 2.93, 0.022, 0.026, 24);
        // tally marks, a week at a time, row after row; the last week stops on a Wednesday
        let left = 31 * 5 + 3;
        for (let row = 0; row < 6 && left > 0; row++) for (let g = 0; g < 6 && left > 0; g++) {
          const y = 2.3 - row * 0.3, v = 1.0 + g * 1.15;
          const n = Math.min(5, left); left -= n;
          for (let m = 0; m < Math.min(4, n); m++) box(0.08, v + m * 0.1, 0.1, v + m * 0.1 + 0.02, y, y + 0.22, 8);
          if (n === 5) box(0.08, v - 0.04, 0.1, v + 0.36, y + 0.1, y + 0.12, 8);
        }
        for (let q = 0; q < 7; q++) { const a = 6.6 + (q % 3) * 0.13, b = 6.2 + Math.floor(q / 3) * 0.13; box(a, b, a + 0.08, b + 0.08, q === 6 ? 0.12 : 0, q === 6 ? 0.24 : 0.12, 2); }
        box(7.5, 7.4, 8.1, 7.8, 0, 0.65, 6, null, false, true); box(7.5, 7.35, 8.1, 7.85, 0.55, 0.7, 34);
        box(4.8, 7.6, 5.0, 7.8, 0, 0.08, 18); box(5.0, 7.68, 8.5, 7.72, 0, 0.005, 29);
        item('cassette', 1.6, 5.6, 0.5); item('shells', 7.8, 1.5, 0.5); item('gaskets', 4.6, 7.0, 0.4); item('memo', 7.6, 4.2, 0.6);
        break;
      }
      default: // a way through
        portalModel(S.kind, box);
    }
    return S.content;
  }

  // ---- fittings: the small things that make a room a room -------------------
  // Returns { boxes: stride 11 [x0,y0,z0,x1,y1,z1,colour,glowR,glowG,glowB,tag], cols } or null.
  // tag: light cell (0 this cell, 1 east, 2 south) + 10 if the glow flickers.
  cellDecor(b, k, i, j) {
    if (b.decor === null) b.decor = new Array(256);
    let d = b.decor[k];
    if (d !== undefined) return d;
    d = b.realm[k] !== VOID && !b.solid[k] ? this._makeDecor(b, k, i, j) : null;
    b.decor[k] = d;
    return d;
  }

  _makeDecor(b, k, i, j) {
    const R = b.reg[k], realm = b.realm[k], f = b.floor[k], c = b.ceil[k];
    const P = this.pieceAt(i, j), plain = !P && !this.nearPiece(i, j), hall = this.dim === 0;
    const x0 = i * CS, z0 = j * CS, xc = x0 + 1.5, zc = z0 + 1.5;
    const out = [], cols = [];
    const push = (ax, ay, az, bx, by, bz, col, tag = 0, g = null) => out.push(
      Math.min(ax, bx), ay, Math.min(az, bz), Math.max(ax, bx), by, Math.max(az, bz), col, g ? g[0] : 0, g ? g[1] : 0, g ? g[2] : 0, tag);

    if (b.pillar[k]) { // plinth and capital
      const ps = pillarSize(R, realm) + 0.07;
      push(xc - ps, f, zc - ps, xc + ps, f + 0.18, zc + ps, hall ? R.trimCol : 2);
      push(xc - ps, c - 0.22, zc - ps, xc + ps, c, zc + ps, hall ? R.trimCol : 2);
    }
    if (hall && plain) {
      if (R.beams && mod(R.axis ? j : i, 2) === 0) {
        if (R.axis) push(x0, c - 0.3, zc - 0.14, x0 + CS, c, zc + 0.14, 9);
        else push(xc - 0.14, c - 0.3, z0, xc + 0.14, c, z0 + CS, 9);
      }
      if (R.pipes && mod(R.axis ? i : j, 4) === 1) {
        if (R.axis) push(xc - 0.03, c - 0.2, z0, xc + 0.03, c - 0.14, z0 + CS, 4);
        else push(x0, c - 0.2, zc - 0.03, x0 + CS, c - 0.14, zc + 0.03, 4);
      }
      if (!b.light[k] && mod(i, 6) === 2 && mod(j, 6) === 2) push(xc - 0.3, c - 0.025, zc - 0.3, xc + 0.3, c, zc + 0.3, 3); // air vents, evenly
    }
    if (plain && this.isCache(b, k, i, j)) { // the middle of the district: a plinth, and something left on it
      push(xc - 0.3, f, zc - 0.3, xc + 0.3, f + 0.8, zc + 0.3, 3);
      push(xc - 0.34, f + 0.8, zc - 0.34, xc + 0.34, f + 0.84, zc + 0.34, 14, 0, R.dark ? [0.5, 0.45, 0.3] : [0.9, 0.8, 0.5]);
      cols.push(xc - 0.3, f, zc - 0.3, xc + 0.3, f + 0.84, zc + 0.3);
    }
    if (realm === WET && this.dim === 1 && plain && f <= -3 && c > WL && !R.dark && mod(i, 5) === 1 && mod(j, 5) === 3) {
      push(xc - 0.2, f, zc - 0.2, xc + 0.2, f + 0.1, zc + 0.2, 14, 0, [0.45, 1.25, 1.15]); // lamps on the bottom, in a grid
    }

    for (let dir = 0; dir < 2; dir++) {
      const w = dir === 0 ? b.wallE[k] : b.wallS[k];
      if (!w) continue;
      const ni = dir === 0 ? i + 1 : i, nj = dir === 0 ? j : j + 1;
      const nb = this.base(ni >> 4, nj >> 4), nk = (ni & 15) | ((nj & 15) << 4);
      const fb = nb.floor[nk], cb = nb.ceil[nk];
      const p = dir === 0 ? x0 + CS : z0 + CS, a0 = dir === 0 ? z0 : x0, ac = a0 + 1.5;
      // a box on this edge: a runs along the wall, q across it (negative = this cell's side)
      const wb = (a1, a2, y1, y2, q1, q2, col, tag, g) => (dir === 0 ? push(p + q1, y1, a1, p + q2, y2, a2, col, tag, g) : push(a1, y1, p + q1, a2, y2, p + q2, col, tag, g));
      const sides = [];
      if (hall) { sides.push([-1, f, c, 0]); if (!nb.solid[nk]) sides.push([1, fb, cb, dir + 1]); }
      if (w >= 2) {
        const hw = OPEN_HW[w], hh = OPEN_H[w], base = Math.max(f, fb);
        const col = w === 3 ? 3 : hall ? R.trimCol : 2;
        wb(ac - hw - 0.09, ac - hw, base, base + hh + 0.09, -0.12, 0.12, col, 0);
        wb(ac + hw, ac + hw + 0.09, base, base + hh + 0.09, -0.12, 0.12, col, 0);
        wb(ac - hw, ac + hw, base + hh, base + hh + 0.09, -0.12, 0.12, col, 0);
        if (w === 2 && hall && plain && hash32(this.seed, i, j, 89 + dir) % 100 < 12) { // a door, left standing open
          const hs = hash32(this.seed, i, j, 91 + dir), sd = hs & 1 ? -1 : 1, hg = hs & 2 ? -1 : 1;
          const a1 = ac + hg * hw, a2 = a1 - hg * 0.05, q1 = sd * 0.12, q2 = sd * (0.04 + hw * 2);
          const tag = sd < 0 ? 0 : dir + 1, y1 = base + 0.02, y2 = base + hh - 0.03;
          wb(Math.min(a1, a2), Math.max(a1, a2), y1, y2, q1, q2, R.trimCol === 7 ? 0 : 7, tag);
          const lo = Math.min(a1, a2), hi = Math.max(a1, a2), qa = Math.min(q1, q2), qb = Math.max(q1, q2);
          if (dir === 0) cols.push(p + qa, y1, lo, p + qb, y2, hi); else cols.push(lo, y1, p + qa, hi, y2, p + qb);
        }
      }
      // a district hangs two kinds of fitting, each at its own regular interval along the walls
      const n = (dir === 0 ? j + i * 3 : i + j * 3), fit = w === 1 && plain ? (mod(n, R.fitP) === 0 ? R.fits[0] : mod(n, R.fitP + 1) === 2 ? R.fits[1] : -1) : -1;
      for (let si = 0; si < sides.length; si++) {
        const sg = sides[si][0], sf = sides[si][1], sc = sides[si][2], tag = sides[si][3];
        const q1 = sg * 0.08, d = depth => sg * (0.08 + depth);
        const span = (y1, y2, qa, qb, col) => {
          if (w >= 2 && y1 < sf + OPEN_H[w]) {
            const hw = OPEN_HW[w] + 0.09;
            wb(a0, ac - hw, y1, y2, qa, qb, col, tag); wb(ac + hw, a0 + CS, y1, y2, qa, qb, col, tag);
          } else wb(a0, a0 + CS, y1, y2, qa, qb, col, tag);
        };
        if (R.skirt) span(sf, sf + 0.13, q1, d(0.025), R.trimCol);
        if (R.rail) span(sf + 0.92, sf + 0.99, q1, d(0.03), R.trimCol);
        if (R.crown) span(sc - 0.11, sc, q1, d(0.07), R.trimCol);
        if (R.pipes && dir === R.axis) span(sc - 0.48, sc - 0.4, d(0.04), d(0.12), R.pipeCol);
        if (fit < 0 || si > 0) continue;
        switch (fit) {
          case 0: // a framed picture of nothing in particular, always at the same height
            wb(ac - 0.45, ac + 0.45, sf + 1.3, sf + 1.95, q1, d(0.035), 1, tag);
            wb(ac - 0.4, ac + 0.4, sf + 1.35, sf + 1.9, q1, d(0.042), [4, 5, 6, 11, 12, 9, 8][(R.id >>> 3) % 7], tag);
            break;
          case 1: // vent
            wb(ac - 0.3, ac + 0.3, sc - 0.8, sc - 0.5, q1, d(0.02), 3, tag);
            for (let s = 0; s < 3; s++) wb(ac - 0.27, ac + 0.27, sc - 0.76 + s * 0.09, sc - 0.73 + s * 0.09, q1, d(0.03), 2, tag);
            break;
          case 2: // socket and switch
            wb(ac + 0.9, ac + 0.98, sf + 0.3, sf + 0.42, q1, d(0.015), 7, tag);
            wb(ac - 1.0, ac - 0.92, sf + 1.2, sf + 1.32, q1, d(0.012), 7, tag);
            break;
          case 3: // radiator
            wb(ac - 0.5, ac + 0.5, sf + 0.14, sf + 0.7, d(0.02), d(0.1), 7, tag);
            for (let s = 0; s < 7; s++) wb(ac - 0.46 + s * 0.15, ac - 0.43 + s * 0.15, sf + 0.16, sf + 0.68, d(0.1), d(0.113), 2, tag);
            break;
          case 4: // wall light (dead where the district is dark)
            wb(ac - 0.07, ac + 0.07, sf + 1.95, sf + 2.0, q1, d(0.1), 3, tag);
            wb(ac - 0.06, ac + 0.06, sf + 2.0, sf + 2.2, d(0.02), d(0.09), R.dark ? 9 : 14, tag, R.dark ? null : [1.3, 1.0, 0.55]);
            break;
          case 5: { // a window, onto nothing
            const lit = !R.dark && (R.id & 1) === 1;
            wb(ac - 0.6, ac + 0.6, sf + 0.95, sf + 2.25, q1, d(0.04), 7, tag);
            wb(ac - 0.53, ac + 0.53, sf + 1.02, sf + 2.18, q1, d(0.045), lit ? 14 : 8, tag, lit ? [0.9, 0.75, 0.4] : null);
            wb(ac - 0.02, ac + 0.02, sf + 1.02, sf + 2.18, q1, d(0.05), 7, tag);
            wb(ac - 0.53, ac + 0.53, sf + 1.58, sf + 1.62, q1, d(0.05), 7, tag);
            break;
          }
          case 6: // a clock
            wb(ac - 0.17, ac + 0.17, sf + 2.0, sf + 2.34, q1, d(0.03), 7, tag);
            wb(ac - 0.01, ac + 0.01, sf + 2.17, sf + 2.3, q1, d(0.036), 8, tag);
            wb(ac, ac + 0.1, sf + 2.16, sf + 2.18, q1, d(0.036), 8, tag);
            break;
          case 7: // notice board
            wb(ac - 0.5, ac + 0.5, sf + 1.2, sf + 1.9, q1, d(0.02), 10, tag);
            for (let s = 0; s < 3; s++) wb(ac - 0.36 + s * 0.3, ac - 0.16 + s * 0.3, sf + 1.35, sf + 1.63, q1, d(0.026), 7, tag);
            break;
          default: // fire point
            wb(ac - 0.16, ac + 0.16, sf + 1.0, sf + 1.55, q1, d(0.13), 4, tag);
            wb(ac - 0.12, ac + 0.12, sf + 1.3, sf + 1.36, d(0.13), d(0.135), 7, tag);
        }
      }
    }
    if (P) {
      const pd = this._piece(P).decor.get(key(i, j));
      if (pd) { for (let q = 0; q < pd.boxes.length; q++) out.push(pd.boxes[q]); for (let q = 0; q < pd.cols.length; q++) cols.push(pd.cols[q]); }
    }
    return out.length ? { boxes: new Float32Array(out), cols: cols.length ? new Float32Array(cols) : null } : null;
  }

  // Writing on a wall of this cell: [dir (0 east wall, 1 south wall), side (-1 this cell, 1 the next), line, height] or null.
  cellWriting(b, k, i, j) {
    if (this.dim === 2 || b.solid[k] || b.realm[k] !== HALL || this.nearPiece(i, j)) return null;
    for (let dir = 0; dir < 2; dir++) {
      if ((dir === 0 ? b.wallE[k] : b.wallS[k]) !== 1) continue;
      const h = hash32(this.seed, i, j, 131 + dir);
      if (h % 100 >= 7) continue;
      const R = b.reg[k], n = dir === 0 ? j + i * 3 : i + j * 3;
      if (mod(n, R.fitP) === 0 || mod(n, R.fitP + 1) === 2) continue; // something already hangs there
      let side = h & 256 ? 1 : -1;
      if (side > 0) { const ni = dir === 0 ? i + 1 : i, nj = dir === 0 ? j : j + 1, nb = this.base(ni >> 4, nj >> 4), nk = (ni & 15) | ((nj & 15) << 4); if (nb.solid[nk] || nb.realm[nk] !== HALL) side = -1; }
      return [dir, side, (h >>> 10) % 32, 0.9 + ((h >>> 16) % 100) / 100 * 0.9];
    }
    return null;
  }

  // ---- things to pick up: never scattered; always where the place's own logic puts them -----
  cellItem(b, k, i, j) {
    if (b.items === null) b.items = new Array(256);
    let it = b.items[k];
    if (it !== undefined) return it;
    it = null;
    if (b.realm[k] !== VOID && !b.solid[k]) {
      const P = this.pieceAt(i, j), dim = this.dim, f = b.floor[k];
      if (P) it = this._piece(P).items.get(key(i, j)) || null;
      else if (dim === 0 && i === this.si + 1 && j === this.sj - 1) it = { type: 'shotgun', x: (i + 0.5) * CS, y: f + 0.9, z: (j + 0.5) * CS, id: '0:' + i + ':' + j };
      else if (dim === 0 && i === this.si - 1 && j === this.sj - 1) it = { type: 'cassette', x: (i + 0.5) * CS, y: f + 0.9, z: (j + 0.5) * CS, id: '0:' + i + ':' + j };
      else if (this.isCache(b, k, i, j)) it = { type: CACHE[(b.reg[k].id >>> 3) % CACHE.length], x: (i + 0.5) * CS, y: f + 1.2, z: (j + 0.5) * CS, id: dim + ':' + i + ':' + j };
    }
    b.items[k] = it;
    return it;
  }

  // ---- colliders -----------------------------------------------------------
  cellBoxes(b, k, i, j) {
    if (!b.boxes) b.boxes = new Array(256);
    let bx = b.boxes[k];
    if (bx !== undefined) return bx;
    const out = [];
    const x0 = i * CS, z0 = j * CS, x1 = x0 + CS, z1 = z0 + CS;
    const realm = b.realm[k], fa = b.floor[k], ca = b.ceil[k];
    if (realm !== VOID) {
      for (let dir = 0; dir < 2; dir++) {
        const w = dir === 0 ? b.wallE[k] : b.wallS[k];
        if (!w) continue;
        const ni = dir === 0 ? i + 1 : i, nj = dir === 0 ? j : j + 1;
        const nb = this.base(ni >> 4, nj >> 4), nk = (ni & 15) | ((nj & 15) << 4);
        const fb = nb.floor[nk], cb = nb.ceil[nk];
        const lo = Math.min(fa, fb), hi = Math.max(ca, cb), basey = Math.max(fa, fb);
        const hw = OPEN_HW[w], top = basey + OPEN_H[w];
        if (dir === 0) {
          if (w === 1) out.push(x1 - 0.1, lo, z0, x1 + 0.1, hi, z1);
          else {
            const zc = z0 + CS / 2;
            out.push(x1 - 0.1, lo, z0, x1 + 0.1, hi, zc - hw, x1 - 0.1, lo, zc + hw, x1 + 0.1, hi, z1, x1 - 0.1, top, zc - hw, x1 + 0.1, hi, zc + hw);
          }
        } else if (w === 1) out.push(x0, lo, z1 - 0.1, x1, hi, z1 + 0.1);
        else {
          const xc = x0 + CS / 2;
          out.push(x0, lo, z1 - 0.1, xc - hw, hi, z1 + 0.1, xc + hw, lo, z1 - 0.1, x1, hi, z1 + 0.1, xc - hw, top, z1 - 0.1, xc + hw, hi, z1 + 0.1);
        }
      }
      if (b.pillar[k]) {
        const ps = pillarSize(b.reg[k], realm), xc = x0 + CS / 2, zc = z0 + CS / 2;
        out.push(xc - ps, fa, zc - ps, xc + ps, ca, zc + ps);
      }
      const ps = this.cellProps(b, k, i, j);
      if (ps) for (const s of ps) if (s.col) for (let q = 0; q < s.col.length; q++) out.push(s.col[q]);
      const dc = this.cellDecor(b, k, i, j);
      if (dc && dc.cols) for (let q = 0; q < dc.cols.length; q++) out.push(dc.cols[q]);
    }
    bx = out.length ? new Float32Array(out) : null;
    b.boxes[k] = bx;
    return bx;
  }

  // ---- the outside ----------------------------------------------------------
  // Nothing out here is scattered. Each district has a point; everything in it is placed by one rule
  // around that point: in rings, along a spiral, along spokes, or on a lattice with every other place empty.
  // Where things stand in a district of the outside. Two orders only, both centred on the point and level with it:
  // rings (each ring one kind of thing, evenly spaced, lined up spoke by spoke, a lantern between each pair), or four
  // avenues (pairs of things flanking a straight way in, lanterns down the middle). Everything faces the point.
  _slots(R) {
    if (R.slots) return R.slots;
    const fx = R.sx * CS, fz = R.sz * CS, fy = R.fy, K = R.skinds, out = [];
    out.push({ x: fx, y: fy, z: fz, kind: 'shrine', s: 1, n: 0 });
    // a circle of lanterns round the point itself, in every district
    for (let q = 0; q < 8; q++) { const a = (q / 8) * 6.2832; out.push({ x: fx + Math.cos(a) * 9, y: fy, z: fz + Math.sin(a) * 9, kind: 'lantern', s: 1, n: q }); }
    if ((R.id >>> 21) % 3 === 0) { R.slots = out; return out; }
    if (R.slaw === 0) {
      for (let r = 1; r <= 3; r++) {
        const n = 4 * r, rad = 16 * r + 8, s = 0.9 + 0.15 * r;
        for (let q = 0; q < n; q++) {
          const a = (q / n) * 6.2832, b = ((q + 0.5) / n) * 6.2832;
          out.push({ x: fx + Math.cos(a) * rad, y: fy - (r - 1) * 1.2, z: fz + Math.sin(a) * rad, kind: K[r - 1], s, n: q });
          out.push({ x: fx + Math.cos(b) * rad, y: fy - (r - 1) * 1.2, z: fz + Math.sin(b) * rad, kind: 'lantern', s: 1, n: q });
        }
      }
    } else {
      for (let arm = 0; arm < 4; arm++) {
        const dx = [1, 0, -1, 0][arm], dz = [0, 1, 0, -1][arm];
        for (let st = 1; st <= 4; st++) {
          const d = 10 + st * 12, k = K[(st - 1) % 2 ? 1 : 0];
          for (const side of [-1, 1]) out.push({ x: fx + dx * d - dz * side * 7, y: fy, z: fz + dz * d + dx * side * 7, kind: k, s: 1.1, n: st });
          out.push({ x: fx + dx * (d - 6), y: fy, z: fz + dz * (d - 6), kind: 'lantern', s: 1, n: st });
        }
        out.push({ x: fx + dx * 66, y: fy, z: fz + dz * 66, kind: K[2], s: 1.4, n: 9 }); // and something larger where each avenue begins
      }
    }
    R.slots = out;
    return out;
  }

  fragments(cx, cz) {
    const b = this.base(cx, cz);
    if (b.frags !== undefined) return b.frags;
    let res = null;
    if (this.dim === 2) {
      const list = [], boxes = [], x0 = cx * CHUNK, z0 = cz * CHUNK, i0 = cx * CN, j0 = cz * CN;
      const keep = F => {
        for (const s of F.props) { s.col = propAABBs(s); for (let q = 0; q < s.col.length; q++) boxes.push(s.col[q]); }
        for (const p of F.parts) boxes.push(p.box[0], p.box[1], p.box[2], p.box[3], p.box[4], p.box[5]);
        for (let q = 0; q < F.extra.length; q++) boxes.push(F.extra[q]);
        list.push(F);
      };
      // ways through, each on its own slab
      for (let si = fdiv(i0, SG); si <= fdiv(i0 + 15, SG); si++) for (let sj = fdiv(j0, SG); sj <= fdiv(j0 + 15, SG); sj++) {
        const S = this.site(si, sj);
        if (S.kind === 'none' || S.cx < x0 || S.cx >= x0 + CHUNK || S.cz < z0 || S.cz >= z0 + CHUNK) continue;
        keep(this._platform(S));
      }
      const g0 = Math.floor((i0 - 32) / RS), g1 = Math.floor((i0 + 47) / RS), h0 = Math.floor((j0 - 32) / RS), h1 = Math.floor((j0 + 47) / RS);
      for (let ri = g0; ri <= g1; ri++) for (let rj = h0; rj <= h1; rj++) {
        const R = this.region(ri, rj), sl = this._slots(R);
        for (let q = 0; q < sl.length; q++) {
          const s = sl[q];
          if (s.x < x0 || s.x >= x0 + CHUNK || s.z < z0 || s.z >= z0 + CHUNK) continue;
          keep(this._spaceObject(s, R, hash32(R.id, q, 31)));
        }
      }
      if (list.length) res = { list, boxes: new Float32Array(boxes) };
    }
    b.frags = res;
    return res;
  }

  _platform(S) {
    const F = { x: S.cx, y: 0, z: S.cz, R: this.regionAt(Math.floor(S.cx / CS), Math.floor(S.cz / CS)), light: 0.4, parts: [], glows: [], props: [], cb: [], extra: [], items: [] };
    const ox = S.i0 * CS, oz = S.j0 * CS, o = S.orient;
    F.parts.push({ kind: 'floor', box: [ox, -0.3, oz, ox + 9, 0, oz + 9] });
    const addB = (u0, v0, u1, v1, y0, y1, col, glow, flick, solid) => {
      const xa = o ? ox + v0 : ox + u0, za = o ? oz + u0 : oz + v0, xb = o ? ox + v1 : ox + u1, zb = o ? oz + u1 : oz + v1;
      const bx = [Math.min(xa, xb), y0, Math.min(za, zb), Math.max(xa, xb), y1, Math.max(za, zb)];
      if (glow) F.glows.push({ box: bx, col: glow, fl: !!flick, ph: 0.3 });
      else F.cb.push(bx[0], bx[1], bx[2], bx[3], bx[4], bx[5], col);
      if (solid) F.extra.push(bx[0], bx[1], bx[2], bx[3], bx[4], bx[5]);
    };
    portalModel(S.kind, addB);
    if (S.kind === 'door') radioDesk(addB);
    for (const a of [0.3, 8.7]) for (const c of [0.3, 8.7]) { // four lamps at the corners
      F.cb.push(ox + a - 0.04, 0, oz + c - 0.04, ox + a + 0.04, 1.6, oz + c + 0.04, 3);
      F.glows.push({ box: [ox + a - 0.1, 1.6, oz + c - 0.1, ox + a + 0.1, 1.85, oz + c + 0.1], col: [1.2, 0.95, 0.5], fl: false, ph: 0 });
    }
    return F;
  }

  // One object of the outside. Built things from indoors, and things that were never built by anyone.
  _spaceObject(sl, R, seed) {
    const rng = mulberry32(seed), x = sl.x, y = sl.y, z = sl.z, s = sl.s, G = R.glowCol;
    const F = { x, y, z, R, light: 0.06, parts: [], glows: [], props: [], cb: [], extra: [], items: [] };
    const stone = (x0, y0, z0, x1, y1, z1) => F.parts.push({ kind: 'stone', box: [x0, y0, z0, x1, y1, z1] });
    const glow = (x0, y0, z0, x1, y1, z1, fl = false, col = G) => F.glows.push({ box: [x0, y0, z0, x1, y1, z1], col, fl, ph: rng() });
    const prop = (type, px, py, pz, over) => F.props.push(Object.assign({
      type, x: px, y: py, z: pz, yaw: 0, tilt: 0, tiltDir: 0, flip: 0, s: 1, mode: 'free', sink: 0, dyn: 0,
      variant: rng(), fy: py, cy: py + 3, seed: (rng() * 4294967296) >>> 0, col: null,
    }, over));
    // everything that can face the point does, to the nearest quarter turn
    const face = Math.round(Math.atan2(R.sx * CS - x, R.sz * CS - z) / 1.5708) * 1.5708;
    const alongX = Math.abs(Math.sin(face)) > 0.5; // true when it faces along x
    switch (sl.kind) {
      case 'shrine': { // the point itself
        stone(x - 3, y - 0.4, z - 3, x + 3, y, z + 3);
        stone(x - 1, y, z - 1, x + 1, y + 0.5, z + 1);
        for (let q = 0; q < 6; q++) {
          const a = (q / 6) * 6.2832, px = x + Math.cos(a) * 5.5, pz = z + Math.sin(a) * 5.5;
          stone(px - 0.3, y - 2, pz - 0.3, px + 0.3, y + 3, pz + 0.3);
          glow(px - 0.2, y + 3, pz - 0.2, px + 0.2, y + 3.4, pz + 0.2);
        }
        glow(x - 0.25, y + 0.5, z - 0.25, x + 0.25, y + 0.56, z + 0.25);
        F.items.push({ type: 'shard', x, y: y + 1.5, z, id: this.focusItemId(R) });
        F.light = 0.3;
        break;
      }
      case 'lantern': { // a small floating stone with a light set on it: the outside's street lamps
        stone(x - 0.35, y - 0.25, z - 0.35, x + 0.35, y, z + 0.35);
        stone(x - 0.08, y, z - 0.08, x + 0.08, y + 0.7, z + 0.08);
        glow(x - 0.16, y + 0.7, z - 0.16, x + 0.16, y + 1.0, z + 0.16, false, [1.35, 1.15, 0.8]); // the same warm light in every district
        break;
      }
      case 'door': prop('door', x, y, z, { s: 1.6 + s, yaw: face }); break;
      case 'lamp': prop('lamp', x, y, z, { s: 1.4 + 0.4 * s }); break;
      case 'tv': prop('tv', x, y, z, { s: 1.5 + 0.6 * s, yaw: face }); break;
      case 'chairs':
        for (let q = -1; q <= 1; q++) prop('chair', x + (alongX ? 0 : q * 1.6 * s), y, z + (alongX ? q * 1.6 * s : 0), { s: 1.3 + 0.5 * s, yaw: face });
        break;
      case 'zig': { // a stepped mound with a light held over it
        const t = 4 + (seed % 3), st = 1.1 * s;
        for (let q = 0; q < t; q++) { const hf = (t - q) * 1.5 * s; stone(x - hf, y + q * st, z - hf, x + hf, y + (q + 1) * st, z + hf); }
        glow(x - 0.5 * s, y + t * st + 1.2, z - 0.5 * s, x + 0.5 * s, y + t * st + 1.2 + s, z + 0.5 * s);
        break;
      }
      case 'arch': { // a gate, standing across the way to the point
        const hw = 2.6 * s, th = 0.7 * s, hh = 7 * s;
        if (alongX) { stone(x - th, y, z - hw - th, x + th, y + hh, z - hw + th); stone(x - th, y, z + hw - th, x + th, y + hh, z + hw + th); stone(x - th, y + hh, z - hw - th, x + th, y + hh + 1.2 * s, z + hw + th); glow(x - 0.08, y + hh - 0.15, z - hw + th, x + 0.08, y + hh, z + hw - th); }
        else { stone(x - hw - th, y, z - th, x - hw + th, y + hh, z + th); stone(x + hw - th, y, z - th, x + hw + th, y + hh, z + th); stone(x - hw - th, y + hh, z - th, x + hw + th, y + hh + 1.2 * s, z + th); glow(x - hw + th, y + hh - 0.15, z - 0.08, x + hw - th, y + hh, z + 0.08); }
        break;
      }
      case 'lattice': { // cubes on a grid, some missing, some lit
        const cs = 0.6 * s, sp = 2.6 * s;
        for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) for (let e = -1; e <= 1; e++) {
          const r = rng();
          if (r < 0.4) continue;
          const px = x + a * sp, py = y + c * sp, pz = z + e * sp;
          if (r > 0.86) glow(px - cs, py - cs, pz - cs, px + cs, py + cs, pz + cs, r > 0.95);
          else stone(px - cs, py - cs, pz - cs, px + cs, py + cs, pz + cs);
        }
        break;
      }
      case 'coral': { // something that grew, at right angles
        const grow = (px, py, pz, len, depth) => {
          const w = 0.14 * s * (depth + 1);
          stone(px - w, py, pz - w, px + w, py + len, pz + w);
          if (!depth) { glow(px - w * 1.6, py + len, pz - w * 1.6, px + w * 1.6, py + len + w * 3, pz + w * 1.6); return; }
          const n = 2 + Math.floor(rng() * 2);
          for (let q = 0; q < n; q++) {
            const d = Math.floor(rng() * 4), bl = (1.2 + rng() * 1.8) * s, dx = d === 0 ? 1 : d === 1 ? -1 : 0, dz = d === 2 ? 1 : d === 3 ? -1 : 0, ty = py + len - w;
            stone(Math.min(px, px + dx * bl) - (dx ? 0 : w), ty - w, Math.min(pz, pz + dz * bl) - (dz ? 0 : w), Math.max(px, px + dx * bl) + (dx ? 0 : w), ty + w, Math.max(pz, pz + dz * bl) + (dz ? 0 : w));
            grow(px + dx * bl, ty, pz + dz * bl, (1.2 + rng() * 2) * s, depth - 1);
          }
        };
        grow(x, y - 2 * s, z, 3.5 * s, 2);
        break;
      }
      case 'obelisk': {
        const w = 0.7 * s, h = 13 * s;
        stone(x - w, y - h * 0.4, z - w, x + w, y + h * 0.6, z + w);
        for (let q = 0; q < 3; q++) { const by = y - h * 0.2 + q * h * 0.3; glow(x - w - 0.04, by, z - w - 0.04, x + w + 0.04, by + 0.18, z + w + 0.04); }
        break;
      }
      case 'helix': { // steps wound round nothing
        for (let q = 0; q < 14; q++) {
          const a = q * 0.52, px = x + Math.cos(a) * 3 * s, pz = z + Math.sin(a) * 3 * s, py = y - 4 + q * 0.7;
          stone(px - 1.0, py, pz - 1.0, px + 1.0, py + 0.25, pz + 1.0);
        }
        glow(x - 0.3, y + 6.5, z - 0.3, x + 0.3, y + 7.1, z + 0.3);
        break;
      }
      case 'room': { // a hollow block with a way in on two sides and a light left on inside
        const hf = 4 * s, t = 0.35, d = 1.3;
        stone(x - hf, y - hf, z - hf, x + hf, y - hf + t, z + hf); stone(x - hf, y + hf - t, z - hf, x + hf, y + hf, z + hf);
        stone(x - hf, y - hf + t, z - hf, x - hf + t, y + hf - t, z + hf); stone(x + hf - t, y - hf + t, z - hf, x + hf, y + hf - t, z + hf);
        for (const sg of [-1, 1]) {
          const za = sg < 0 ? z - hf : z + hf - t, zb = za + t;
          stone(x - hf + t, y - hf + t, za, x - d, y + hf - t, zb); stone(x + d, y - hf + t, za, x + hf - t, y + hf - t, zb);
          stone(x - d, y + d, za, x + d, y + hf - t, zb); stone(x - d, y - hf + t, za, x + d, y - d, zb);
        }
        glow(x - 0.6, y + hf - t - 0.05, z - 0.6, x + 0.6, y + hf - t, z + 0.6, rng() < 0.3, [1.5, 1.3, 0.9]);
        F.light = 0.35;
        break;
      }
      case 'monolith': {
        const w = 1.2 * s, h = 9 * s, t = 0.3 * s;
        if (alongX) { stone(x - t, y - h / 2, z - w, x + t, y + h / 2, z + w); glow(x + t, y - h * 0.3, z - 0.06, x + t + 0.03, y + h * 0.3, z + 0.06); }
        else { stone(x - w, y - h / 2, z - t, x + w, y + h / 2, z + t); glow(x - 0.06, y - h * 0.3, z + t, x + 0.06, y + h * 0.3, z + t + 0.03); }
        break;
      }
      default: { // a length of corridor from the lit floors, pointing at the point
        const n = 3 + (seed % 3), len = n * CS, hx = alongX ? len / 2 : 1.5, hz = alongX ? 1.5 : len / 2, H = 3.4;
        F.light = 0.45;
        F.parts.push({ kind: 'floor', box: [x - hx, y - 0.2, z - hz, x + hx, y, z + hz] });
        F.parts.push({ kind: 'ceil', box: [x - hx, y + H, z - hz, x + hx, y + H + 0.2, z + hz] });
        if (alongX) { F.parts.push({ kind: 'wall', box: [x - hx, y, z - hz - 0.16, x + hx, y + H, z - hz] }); F.parts.push({ kind: 'wall', box: [x - hx, y, z + hz, x + hx, y + H, z + hz + 0.16] }); }
        else { F.parts.push({ kind: 'wall', box: [x - hx - 0.16, y, z - hz, x - hx, y + H, z + hz] }); F.parts.push({ kind: 'wall', box: [x + hx, y, z - hz, x + hx + 0.16, y + H, z + hz] }); }
        const lc = R.lc;
        glow(x - (alongX ? 0.6 : 0.3), y + H - 0.04, z - (alongX ? 0.3 : 0.6), x + (alongX ? 0.6 : 0.3), y + H - 0.005, z + (alongX ? 0.3 : 0.6), rng() < 0.4, [lc[0] * 1.7, lc[1] * 1.7, lc[2] * 1.7]);
      }
    }
    return F;
  }

  // somewhere plain to be put down, near a point
  findOpen(x, z) {
    if (this.dim === 2) return [x, z];
    const ci = Math.floor(x / CS), cj = Math.floor(z / CS);
    for (let r = 0; r < 60; r++) {
      for (let a = -r; a <= r; a++) for (let c = -r; c <= r; c++) {
        if (Math.max(Math.abs(a), Math.abs(c)) !== r) continue;
        const i = ci + a, j = cj + c;
        const b = this.block(i >> 4, j >> 4), k = (i & 15) | ((j & 15) << 4);
        if (b.solid[k] || b.pillar[k] || this.nearPiece(i, j)) continue;
        if (this.dim === 0 ? b.floor[k] !== 0 : b.floor[k] > -3) continue;
        if (this.cellProps(b, k, i, j) || this.isCache(b, k, i, j)) continue;
        if (b.wallE[k] !== 1 || b.wallS[k] !== 1) return [(i + 0.5) * CS, (j + 0.5) * CS];
      }
    }
    return [x, z];
  }

  prune(pcx, pcz, dist) {
    this._lk = -1; this._lb = null;
    for (const [k, b] of this.blocks) {
      if (Math.abs(b.cx - pcx) > dist || Math.abs(b.cz - pcz) > dist) this.blocks.delete(k);
    }
    if (this.regions.size > 700) this.regions.clear();
    if (this.sites.size > 3000) this.sites.clear();
  }
}

const ITEM_TOKEN = { key: 1, pearl: 1 };
