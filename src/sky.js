// The outside: stars, a CPPN nebula, a planet that is too close, a black sun.
// Also the drifting motes (dust / marine snow / star dust) around the camera.
// Stars and motes are instanced sprites (WebGPU draws points one pixel wide); motes are placed on the GPU.
import * as THREE from 'three';
import {
  Fn, uniform, texture, uv, vec3, vec4, float, sin, cos, atan, exp, pow, max, min, dot, length, normalize, floor, smoothstep, step, clamp,
  instancedBufferAttribute, vertexStage, positionWorld, normalWorld, positionLocal, cameraPosition, cameraViewMatrix,
} from 'three/tsl';
import { mulberry32 } from './nn.js';
import { makeNebula, makePlanet } from './textures.js';

const basic = (opts, frag) => { const m = new THREE.MeshBasicNodeMaterial({ fog: false, ...opts }); m.fragmentNode = frag; return m; };
const iattr = (arr, size) => instancedBufferAttribute(new THREE.InstancedBufferAttribute(arr, size));

export class Sky {
  constructor(scene, seed, sunDir) {
    this.group = new THREE.Group();
    scene.add(this.group);
    const rng = mulberry32(seed ^ 0x57a5);
    const t = this.time = uniform(0);
    this.scale = uniform(1);

    // nebula dome
    const neb = texture(makeNebula(seed));
    this.nebula = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16),
      basic({ side: THREE.BackSide, depthWrite: false }, vec4(neb.sample(uv()).rgb, 1)));
    this.nebula.renderOrder = -30;
    this.group.add(this.nebula);

    // stars: a random field, plus one patch where they sit in a perfect lattice
    const N = 2600, L = 14;
    const pos = [], size = [], col = [], ph = [];
    for (let q = 0; q < N; q++) {
      const z = rng() * 2 - 1, a = rng() * 6.2832, r = Math.sqrt(1 - z * z);
      pos.push(Math.cos(a) * r * 880, z * 880, Math.sin(a) * r * 880);
      const m = Math.pow(rng(), 5);
      size.push(1.7 + m * 6.5);
      const k = rng(), b = 0.5 + 0.9 * rng();
      col.push(b * (0.8 + 0.2 * k), b * 0.85, b * (1 - 0.25 * k));
      ph.push(rng());
    }
    const cdir = new THREE.Vector3(-0.5, 0.55, 0.67).normalize();
    const ux = new THREE.Vector3().crossVectors(cdir, new THREE.Vector3(0, 1, 0)).normalize();
    const uy = new THREE.Vector3().crossVectors(ux, cdir).normalize();
    for (let a = 0; a < L; a++) for (let b = 0; b < L; b++) {
      const v = cdir.clone().addScaledVector(ux, (a - L / 2) * 0.022).addScaledVector(uy, (b - L / 2) * 0.022).normalize().multiplyScalar(880);
      pos.push(v.x, v.y, v.z); size.push(2.2); col.push(0.75, 0.8, 0.9); ph.push(0);
    }
    const sPos = iattr(new Float32Array(pos), 3), sSize = iattr(new Float32Array(size), 1);
    const sCol = iattr(new Float32Array(col), 3), sPh = iattr(new Float32Array(ph), 1);
    const starMat = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, fog: false });
    starMat.positionNode = sPos;
    starMat.sizeNode = sSize.mul(this.scale);
    const vC = vertexStage(sCol.mul(sin(t.mul(1.3).add(sPh.mul(40))).mul(0.28).add(0.72)));
    starMat.fragmentNode = Fn(() => {
      const p = uv().sub(0.5);
      return vec4(vC.mul(smoothstep(0.25, 0, dot(p, p))), 1);
    })();
    this.stars = new THREE.Sprite(starMat);
    this.stars.count = pos.length / 3;
    this.stars.renderOrder = -29;
    this.stars.frustumCulled = false;
    this.group.add(this.stars);

    // black sun, in the direction the outside is lit from
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), basic({ transparent: true, depthWrite: false }, Fn(() => {
      const p = uv().sub(0.5);
      const r = length(p).mul(2), an = atan(p.y, p.x);
      const rays = sin(an.mul(13).add(t.mul(0.2))).mul(sin(an.mul(7).sub(t.mul(0.13)))).mul(0.4).add(0.6);
      const disc = smoothstep(0.205, 0.195, r);
      const cor = exp(r.sub(0.2).mul(-7)).mul(rays).mul(step(0.2, r));
      const ring = exp(pow(r.sub(0.205).mul(90), 2).negate());
      const c = vec3(0.85, 0.88, 1.0).mul(cor.mul(0.7).add(ring.mul(1.4)));
      const a = max(disc, clamp(cor.add(ring), 0, 1)).mul(smoothstep(1.0, 0.8, r));
      return vec4(c.mul(float(1).sub(disc)), a);
    })()));
    this.sun.scale.setScalar(520);
    this.sun.position.copy(sunDir).multiplyScalar(850);
    this.sun.lookAt(0, 0, 0);
    this.sun.renderOrder = -28;
    this.group.add(this.sun);

    // the planet
    const pdir = new THREE.Vector3(-0.7, 0.18, -0.69).normalize();
    const pmap = texture(makePlanet(seed)), sd = uniform(sunDir);
    this.planet = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), basic({}, Fn(() => {
      const N = normalize(normalWorld), V = normalize(cameraPosition.sub(positionWorld));
      const l = smoothstep(-0.05, 0.5, dot(N, sd));
      const rim = pow(float(1).sub(max(dot(N, V), 0)), 4);
      return vec4(pmap.sample(uv()).rgb.mul(l).mul(0.42).add(vec3(0.25, 0.3, 0.45).mul(rim).mul(l.add(0.15))), 1);
    })()));
    this.planet.scale.setScalar(210);
    this.planet.position.copy(pdir).multiplyScalar(760);
    this.planet.rotation.set(0.4, 0, 0.3);
    this.planet.renderOrder = -27;
    this.group.add(this.planet);

    this.ring = new THREE.Mesh(new THREE.RingGeometry(1.35, 2.4, 96, 1), basic({ transparent: true, depthWrite: false, side: THREE.DoubleSide }, Fn(() => {
      const r = length(positionLocal.xy);
      const b = sin(r.mul(60)).mul(sin(r.mul(23).add(1))).mul(0.5).add(0.5);
      const a = smoothstep(1.35, 1.45, r).mul(smoothstep(2.4, 2.2, r)).mul(b.mul(0.5).add(0.25));
      return vec4(vec3(0.5, 0.47, 0.42).mul(0.5), a.mul(0.8));
    })()));
    this.ring.scale.setScalar(210);
    this.ring.position.copy(this.planet.position);
    this.ring.rotation.set(1.25, 0.3, 0);
    this.ring.renderOrder = -26;
    this.group.add(this.ring);

    // motes around the camera: each one wraps inside a box that follows the camera
    const PN = 700, seeds = new Float32Array(PN * 3);
    for (let q = 0; q < PN * 3; q++) seeds[q] = rng();
    const U = this.moteU = {
      box: uniform(24), size: uniform(1), drift: uniform(new THREE.Vector3(0, 0.02, 0)), color: uniform(new THREE.Color(0.2, 0.2, 0.18)),
    };
    const s = iattr(seeds, 3);
    const moteMat = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, fog: false });
    const p0 = s.mul(U.box).add(U.drift.mul(t))
      .add(vec3(sin(t.mul(0.3).add(s.y.mul(30))), cos(t.mul(0.23).add(s.x.mul(30))), sin(t.mul(0.27).add(s.z.mul(30)))).mul(0.35))
      .sub(cameraPosition);
    const p = p0.sub(U.box.mul(floor(p0.div(U.box)))).sub(U.box.mul(0.5));   // GLSL-style mod, then centre
    const world = p.add(cameraPosition);
    const vz = cameraViewMatrix.mul(vec4(world, 1)).z.negate();
    moteMat.positionNode = world;
    moteMat.sizeNode = min(U.size.mul(this.scale).mul(s.x.add(0.5)).mul(14).div(max(vz, 0.3)), this.scale.mul(9).add(3));
    const vA = vertexStage(smoothstep(U.box.mul(0.5), U.box.mul(0.3), length(p)).mul(smoothstep(0.25, 1.2, vz)));
    moteMat.fragmentNode = Fn(() => {
      const q = uv().sub(0.5);
      return vec4(U.color.mul(smoothstep(0.25, 0.02, dot(q, q)).mul(vA)), 1);
    })();
    this.motes = new THREE.Sprite(moteMat);
    this.motes.count = PN;
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 10;
    scene.add(this.motes);
  }

  // mix: weights for dry / water / outside; pxScale: point scale in CSS pixels (viewport height / 900)
  update(cam, t, mix, pxScale) {
    this.group.position.copy(cam.position);
    this.stars.rotation.y = t * 0.0015;
    this.time.value = t;
    this.scale.value = pxScale;
    const u = this.moteU;
    u.box.value = 14 * mix.hall + 16 * mix.water + 60 * mix.void;
    u.size.value = 1.6 * mix.hall + 3.2 * mix.water + 5 * mix.void;
    u.drift.value.set(0.03 * mix.void, 0.015 * mix.hall + 0.09 * mix.water, 0.02 * mix.void);
    u.color.value.setRGB(
      0.1 * mix.hall + 0.1 * mix.water + 0.3 * mix.void,
      0.1 * mix.hall + 0.26 * mix.water + 0.32 * mix.void,
      0.085 * mix.hall + 0.25 * mix.water + 0.42 * mix.void,
    );
  }
}
