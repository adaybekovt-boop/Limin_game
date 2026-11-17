// First-person camera, modelled on the reference game (PNH_Demo, "ProjectNull", Unreal Engine 5,
// First Person template): Enhanced Input mouse look, a camera manager that limits pitch, and
// Unreal's LegacyCameraShake replayed every tick (Idle when standing, Walk when moving, Run when running).
//
// Read from the reference's packaged assets (ProjectNull/Content/FirstPerson/Blueprints/CameraShake/*,
// stored uncompressed in ProjectNull-Windows.ucas):
//   Idle: duration 0.3 s, blend in 0.1664 s, blend out 0.927 s,
//         rotation  pitch 2.617 @ 0.747, yaw 1.564 @ 1.913, roll 1.549 @ 1.999 (deg @ rad/s, sine)
//         location  x 0.881 @ 0.952, y 0.668 @ 0.48, z 0.2 @ 0.15 (cm @ rad/s, sine)
//   Walk: duration 0.25 s (blends: engine defaults 0.1 / 0.2), rotation pitch 0.5896 @ 10.995 sine,
//         yaw 2.454 @ 0.8517 perlin, roll 0.2 @ 21.62 sine
//   Run (CameraShake/1/Run): duration 0.3 s, pitch 4 @ 4 perlin, yaw 4 @ 3 perlin, roll 0.5 @ 40 sine
//   All three: bSingleInstance = true. IMC_MouseLook: Mouse XY 2D -> IA_MouseLook with a Negate modifier (no scalar).
// Not readable (Oodle-compressed blueprints), so Unreal engine / UE5.6 First Person template values are used:
//   mouse 0.07 sensitivity x 2.5 legacy input scale = 0.175 deg per count, pitch limited to -70..+80 deg,
//   90 deg horizontal field of view held constant across aspect ratios (Unreal's MaintainXFOV).
import * as THREE from 'three';

const DEG = Math.PI / 180;

export const CAMERA = {
  degPerCount: 0.07 * 2.5,
  pitchMin: -70, pitchMax: 80,
  hfov: 90,
  arrowYaw: 120, arrowPitch: 88,   // keyboard look, deg/s (this game's own arrow-key look)
};

// sine = 0, perlin = 1; offset 'zero' only when the asset says so (all of these use the random default)
const osc = (amp, freq, wave = 0) => ({ amp, freq, wave });
export const SHAKES = {
  idle: {
    duration: 0.3, blendIn: 0.1664, blendOut: 0.927,
    rot: [osc(2.617, 0.747), osc(1.564, 1.913), osc(1.549, 1.999)],
    loc: [osc(0.881, 0.952), osc(0.668, 0.48), osc(0.2, 0.15)],
  },
  walk: {
    duration: 0.25, blendIn: 0.1, blendOut: 0.2,
    rot: [osc(0.5896, 10.995), osc(2.454, 0.8517, 1), osc(0.2, 21.62)],
    loc: [osc(0, 1), osc(0, 1), osc(0, 1)],
  },
  run: {
    duration: 0.3, blendIn: 0.1, blendOut: 0.2,
    rot: [osc(4, 4, 1), osc(4, 3, 1), osc(0.5, 40)],
    loc: [osc(0, 1), osc(0, 1), osc(0, 1)],
  },
};

// FMath::PerlinNoise1D: Ken Perlin's permutation, 16 gradient slopes, quintic fade, scaled to [-1, 1]
const P = [151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23,
  190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166,
  77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196,
  135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42,
  223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228,
  251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254,
  138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180];
const PERM = new Uint8Array(512);
for (let i = 0; i < 512; i++) PERM[i] = P[i & 255];
const grad1 = (h, x) => { const k = h & 15; return (k < 8 ? (k - 8) / 8 : (k - 7) / 8) * x; };
export function perlin1D(v) {
  const xf = Math.floor(v), xi = xf & 255, x = v - xf;
  const s = x * x * x * (x * (x * 6 - 15) + 10);
  const a = grad1(PERM[xi], x), b = grad1(PERM[xi + 1], x - 1);
  return 2 * (a + (b - a) * s);
}

// One playing ULegacyCameraShake (oscillation part), restartable like a single-instance shake.
class LegacyShake {
  constructor(def) {
    this.def = def;
    this.remaining = 0; this.blendingIn = false; this.blendingOut = false; this.inT = 0; this.outT = 0;
    this.rotOff = [0, 0, 0]; this.locOff = [0, 0, 0];
    this.finished = true;
    this.rot = [0, 0, 0]; this.loc = [0, 0, 0];
  }

  start() {
    const d = this.def;
    if (d.duration === 0) return;
    if (!this.finished && this.remaining > 0) {
      // already playing: extend, and turn a blend-out back into a blend-in
      this.remaining = d.duration;
      if (this.blendingOut) {
        this.blendingOut = false; this.outT = 0;
        if (d.blendIn > 0) { this.blendingIn = true; this.inT = d.blendIn * (1 - this.outT / d.blendOut); }
        else { this.blendingIn = false; this.inT = 0; }
      }
    } else {
      for (let i = 0; i < 3; i++) { this.rotOff[i] = Math.random() * 2 * Math.PI; this.locOff[i] = Math.random() * 2 * Math.PI; }
      this.remaining = d.duration;
      this.blendingIn = d.blendIn > 0; this.inT = 0;
      this.blendingOut = false; this.outT = 0;
      this.finished = false;
    }
  }

  static sample(o, offs, i, dt) {
    if (o.amp === 0) return 0;
    offs[i] += dt * o.freq;
    return o.amp * (o.wave === 1 ? perlin1D(offs[i]) : Math.sin(offs[i]));
  }

  update(dt) {
    const d = this.def;
    this.rot[0] = this.rot[1] = this.rot[2] = 0; this.loc[0] = this.loc[1] = this.loc[2] = 0;
    if (this.finished) return;
    if (this.remaining > 0) this.remaining = Math.max(0, this.remaining - dt);
    if (this.blendingIn) this.inT += dt;
    if (this.blendingOut) this.outT += dt;
    let done = false;
    if (this.remaining === 0) done = true;
    else if (this.remaining > 0 && this.remaining < d.blendOut) { this.blendingOut = true; this.outT = d.blendOut - this.remaining; }
    if (this.blendingIn && this.inT > d.blendIn) this.blendingIn = false;
    if (this.blendingOut && this.outT > d.blendOut) { this.outT = d.blendOut; done = true; }
    if (done) { this.finished = true; return; }
    const wIn = this.blendingIn ? this.inT / d.blendIn : 1;
    const wOut = this.blendingOut ? 1 - this.outT / d.blendOut : 1;
    const w = Math.min(wIn, wOut);
    if (w <= 0) return;
    for (let i = 0; i < 3; i++) {
      this.loc[i] = LegacyShake.sample(d.loc[i], this.locOff, i, dt) * w;
      this.rot[i] = LegacyShake.sample(d.rot[i], this.rotOff, i, dt) * w;
    }
  }
}

const qBase = new THREE.Quaternion(), qShake = new THREE.Quaternion(), eul = new THREE.Euler(0, 0, 0, 'YXZ'), v3 = new THREE.Vector3();

export class FirstPersonCamera {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0; this.pitch = 0;     // control rotation, radians (three.js: +yaw turns left, +pitch looks up)
    this.shakes = { idle: new LegacyShake(SHAKES.idle), walk: new LegacyShake(SHAKES.walk), run: new LegacyShake(SHAKES.run) };
    this.shakeScale = 1;
    this.tremor = 0; this.tt = 0;   // fear: degrees of fast shake, set by the game each frame
  }

  // mouse counts (browser movementX / movementY, raw when pointer lock grants unadjustedMovement)
  look(dx, dy) {
    this.yaw -= dx * CAMERA.degPerCount * DEG;
    this.pitch -= dy * CAMERA.degPerCount * DEG;
    this.pitch = Math.max(CAMERA.pitchMin * DEG, Math.min(CAMERA.pitchMax * DEG, this.pitch));
  }

  // what the character blueprint asks for this tick: 'idle', 'walk' or 'run'
  play(kind) { this.shakes[kind].start(); }

  // eye position in world space, extra roll (swimming / drifting) in radians
  apply(x, y, z, roll, dt) {
    let rp = 0, ry = 0, rr = 0, lx = 0, ly = 0, lz = 0;
    for (const k in this.shakes) {
      const s = this.shakes[k];
      s.update(dt);
      rp += s.rot[0]; ry += s.rot[1]; rr += s.rot[2];
      lx += s.loc[0]; ly += s.loc[1]; lz += s.loc[2];
    }
    this.tt += dt;
    const tr = this.tremor, tt = this.tt;
    rp += tr * (Math.sin(tt * 41) + Math.sin(tt * 67.3)) * 0.5; ry += tr * Math.sin(tt * 53.1 + 1); rr += tr * Math.sin(tt * 37.7 + 2) * 0.7;
    const k = this.shakeScale;
    const cam = this.camera;
    qBase.setFromEuler(eul.set(this.pitch, this.yaw, roll, 'YXZ'));
    // Unreal pitch up / yaw right / roll right-wing-down -> three.js axes; applied in camera space
    qShake.setFromEuler(eul.set(rp * k * DEG, -ry * k * DEG, -rr * k * DEG, 'YXZ'));
    cam.quaternion.copy(qBase).multiply(qShake);
    // Unreal X forward, Y right, Z up (cm) -> camera-local metres
    v3.set(ly * 0.01 * k, lz * 0.01 * k, -lx * 0.01 * k).applyQuaternion(qBase);
    cam.position.set(x + v3.x, y + v3.y, z + v3.z);
  }

  // keep Unreal's horizontal field of view whatever the window shape
  fit(aspect) {
    const cam = this.camera;
    cam.fov = 2 * Math.atan(Math.tan((CAMERA.hfov * DEG) / 2) / aspect) / DEG;
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
  }
}
