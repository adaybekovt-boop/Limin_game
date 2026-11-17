// Surface materials as TSL node graphs (compiled to WGSL on WebGPU, GLSL on the WebGL2 fallback).
// Each material is specialised in JS for what it uses (glow, stains, rim, caustics), so the GPU only
// runs the branches a surface can take. Per-vertex flicker is evaluated in the vertex stage.
import * as THREE from 'three';
import {
  Fn, If, uniform, uniformArray, attribute, texture, uv, vec2, vec3, vec4, float, select, vertexStage,
  positionWorld, normalWorld, cameraPosition, sin, cos, fract, floor, mix, smoothstep, clamp, pow, exp, max, abs, dot, length, normalize, inverseSqrt,
} from 'three/tsl';
import { WL } from './gen.js';
import { makeWall, makeFloor, makeCeil, makeTile, makeShell, makePalette, makeWhite, makeWriting } from './textures.js';

const hash1 = n => fract(sin(n).mul(43758.5453123));

export const vnoise = Fn(([p]) => {
  const i = floor(p), f0 = fract(p);
  const f = f0.mul(f0).mul(f0.mul(-2).add(3));
  const n = i.x.add(i.y.mul(57)).add(i.z.mul(113));
  return mix(
    mix(mix(hash1(n), hash1(n.add(1)), f.x), mix(hash1(n.add(57)), hash1(n.add(58)), f.x), f.y),
    mix(mix(hash1(n.add(113)), hash1(n.add(114)), f.x), mix(hash1(n.add(170)), hash1(n.add(171)), f.x), f.y),
    f.z,
  );
}).setLayout({ name: 'vnoise', type: 'float', inputs: [{ name: 'p', type: 'vec3' }] });

export const caustic = Fn(([p, t]) => {
  const q = p.mul(0.9).toVar();
  q.addAssign(vec2(sin(q.y.mul(1.3).add(t.mul(0.7))), cos(q.x.mul(1.1).sub(t.mul(0.6)))).mul(0.45));
  const c = sin(q.x.mul(2.3).add(t.mul(1.1))).mul(sin(q.y.mul(2.1).sub(t.mul(0.9)))).toVar();
  q.assign(q.mul(1.7).add(vec2(1.7, -2.3)));
  q.addAssign(vec2(cos(q.y.mul(0.9).sub(t.mul(0.8))), sin(q.x.mul(1.2).add(t.mul(0.5)))).mul(0.4));
  c.addAssign(sin(q.x.mul(1.9).sub(t.mul(1.3))).mul(sin(q.y.mul(2.2).add(t.mul(0.7)))));
  return pow(clamp(float(1).sub(abs(c.mul(0.5))), 0, 1), 7);
}).setLayout({ name: 'caustic', type: 'float', inputs: [{ name: 'p', type: 'vec2' }, { name: 't', type: 'float' }] });

// fluorescent tubes: mostly on, sometimes dipping, now and then dead for a moment
const flick = (t, ph) => {
  const a = hash1(floor(t.mul(11).add(ph.mul(57))).mul(1.3).add(ph.mul(91)));
  const b = hash1(floor(t.mul(1.7).add(ph.mul(13))).add(ph.mul(7)));
  return select(b.lessThan(0.22), float(0.04), select(a.lessThan(0.3), float(0.25), float(1.0)));
};

const col3 = c => new THREE.Color(c[0], c[1], c[2]);
const val = v => ({ value: v });

export class Mats {
  constructor(seed) {
    // four point lights: three flares and the flash of the cold lamp (xyz position, w strength; rgb colour)
    const pl = [0, 1, 2, 3].map(() => new THREE.Vector4()), plc = [0, 1, 2, 3].map(() => new THREE.Vector3());
    this.plNode = uniformArray(pl); this.plcNode = uniformArray(plc);
    this.G = {
      time: uniform(0),
      fogColor: uniform(new THREE.Color(0.02, 0.02, 0.018)),
      fogDensity: uniform(0.03),
      voidFogColor: uniform(new THREE.Color(0.0, 0.0, 0.004)),
      voidFogDensity: uniform(0.0055),
      camDir: uniform(new THREE.Vector3(0, 0, -1)),
      flash: uniform(0),
      camUnder: uniform(0),
      sunDir: uniform(new THREE.Vector3(0.45, 0.4, -0.8).normalize()),
      sunColor: uniform(new THREE.Color(0.2, 0.23, 0.33)),
      skyAmbient: uniform(new THREE.Color(0.034, 0.04, 0.062)),
      waterLevel: uniform(WL),
      uPL: val(pl), uPLc: val(plc),
    };
    this.styles = new Map();
    this.white = makeWhite();
    this.palette = makePalette();
    const shellTex = makeShell(seed);
    this.shell = this.make({ map: shellTex, stain: 1 });
    this.stone = this.make({ map: shellTex, tint: [0.62, 0.55, 0.85], stain: 1 }); // what the outside builds with
    this.glow = this.make({ map: this.white, glow: 1 });
    this.prop = this.make({ map: this.palette, stain: 0.7 });
    this.water = this.makeWater();
    // writing: only darkens what is behind it, so it needs no light of its own
    const wt = texture(makeWriting(seed)), G = this.G;
    this.writing = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    this.writing.fragmentNode = Fn(() => {
      const tx = wt.sample(uv()), dist = length(positionWorld.sub(cameraPosition));
      const f = float(1).sub(exp(G.fogDensity.mul(G.fogDensity).mul(dist).mul(dist).negate()));
      return vec4(mix(tx.rgb.mul(0.5), G.fogColor, f), tx.a.mul(float(1).sub(f.mul(0.7))));
    })();
  }

  // bare: geometry without baked light (creatures, the beam) - reads as no light, sky 0, caustics 1
  make({ map, tint = [1, 1, 1], flick: fl = [1, 0.96, 0.85], glow = 0, stain = 1, rim = 0, caustic: cst = 1, ambient = [0, 0, 0], side = THREE.FrontSide, bare = false, fade = false }) {
    const G = this.G, PL = this.plNode, PLc = this.plcNode;
    const U = {
      map: texture(map), tint: uniform(col3(tint)), flickColor: uniform(col3(fl)), uAmbient: uniform(col3(ambient)),
    };
    const m = new THREE.MeshBasicNodeMaterial({ side, fog: false, transparent: fade, depthWrite: !fade });
    m.uniforms = U;
    const vTint = bare ? null : attribute('aTint', 'vec4'); // rgb: shade toward the neighbouring district; a: opacity of an overlay layer
    const vLight = bare ? vec3(0) : attribute('aLight', 'vec3');
    const vData = bare ? vec4(0, 0, 0, 1) : attribute('aData', 'vec4');
    // flicker depends only on per-quad data and time: do it once per vertex
    const fk = bare ? float(0) : vertexStage(vData.x.mul(flick(G.time, vData.y)));

    m.fragmentNode = Fn(() => {
      const albedo = U.map.sample(uv()).rgb.mul(U.tint).toVar();
      if (!bare) albedo.mulAssign(vTint.rgb);
      const toP = positionWorld.sub(cameraPosition);
      const dist = length(toP);
      const V = toP.div(max(dist, 1e-4));
      let col;
      if (glow) {
        col = albedo.mul(vLight.add(U.flickColor.mul(fk)).add(U.uAmbient));
      } else {
        const N = normalize(normalWorld);
        if (stain > 0) {
          const st = vnoise(positionWorld.mul(0.45)).mul(0.6).add(vnoise(positionWorld.mul(1.9).add(7.3)).mul(0.4));
          albedo.mulAssign(mix(float(1), st.mul(0.6).add(0.6), stain));
        }
        const light = vLight.add(U.uAmbient).add(U.flickColor.mul(fk)).toVar();
        if (!bare) light.addAssign(vData.z.mul(G.skyAmbient.add(G.sunColor.mul(max(dot(N, G.sunDir), 0)))));
        if (cst > 0) {
          If(vData.w.mul(cst).greaterThan(0.01).and(positionWorld.y.lessThan(G.waterLevel)), () => {
            const dep = G.waterLevel.sub(positionWorld.y);
            const c = caustic(positionWorld.xz.add(vec2(0.31, 0.47).mul(positionWorld.y)), G.time);
            light.addAssign(vec3(0.28, 0.72, 0.68).mul(c).mul(exp(dep.mul(-0.13))).mul(vData.w.mul(cst)));
          });
        }
        for (let i = 0; i < 4; i++) { // flares, and the flash of the cold lamp
          const p = PL.element(i), d = p.xyz.sub(positionWorld), dd = dot(d, d);
          const nl = clamp(dot(N, d.mul(inverseSqrt(dd.add(1e-4)))), 0, 1);
          light.addAssign(PLc.element(i).mul(p.w.mul(nl.mul(0.65).add(0.35)).div(dd.mul(0.3).add(1))));
        }
        const cone = smoothstep(0.80, 0.97, dot(V, G.camDir));
        const nl = clamp(dot(N, V.negate()), 0, 1);
        light.addAssign(vec3(1.0, 0.94, 0.8).mul(G.flash.mul(cone).mul(nl.mul(0.7).add(0.3)).mul(1.7).div(dist.mul(dist).mul(0.02).add(1))));
        col = albedo.mul(light);
        if (rim > 0) col = col.add(pow(float(1).sub(nl), 3).mul(rim).mul(G.fogColor.mul(1.6).add(0.025)));
      }
      const sky = bare ? float(0) : vData.z.mul(float(1).sub(G.camUnder));
      const fc = mix(G.fogColor, G.voidFogColor, sky);
      const fd = mix(G.fogDensity, G.voidFogDensity, sky);
      let f = float(1).sub(exp(fd.mul(fd).mul(dist).mul(dist).negate()));
      if (glow) f = f.mul(0.8);
      return vec4(mix(col, fc, f), fade ? vTint.a : 1);
    })();
    return m;
  }

  makeWater() {
    const G = this.G;
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const vLight = attribute('aLight', 'vec3');
    m.fragmentNode = Fn(() => {
      const toP = positionWorld.sub(cameraPosition);
      const dist = length(toP);
      const V = toP.div(max(dist, 1e-4));
      const lit = vLight.add(0.03);
      const col = vec3(0).toVar(), a = float(0).toVar();
      If(abs(normalWorld.y).greaterThan(0.5), () => {
        const c = caustic(positionWorld.xz, G.time);
        If(cameraPosition.y.greaterThan(G.waterLevel), () => {
          const fres = pow(float(1).sub(abs(V.y)), 3);
          col.assign(mix(vec3(0.012, 0.07, 0.08), vec3(0.25, 0.42, 0.42), fres).mul(lit).mul(1.6).add(lit.mul(c).mul(0.35)));
          a.assign(mix(0.7, 0.96, fres));
        }).Else(() => {
          const fres = pow(float(1).sub(abs(V.y)), 2);
          col.assign(mix(vec3(0.2, 0.5, 0.48).mul(lit.add(0.25)).add(c.mul(0.55)), vec3(0.01, 0.07, 0.085), fres));
          a.assign(mix(0.55, 0.97, fres));
        });
      }).Else(() => {
        const c = caustic(vec2(positionWorld.x.add(positionWorld.z), positionWorld.y), G.time);
        const dep = exp(positionWorld.y.sub(G.waterLevel).mul(0.1));
        col.assign(vec3(0.02, 0.13, 0.15).mul(dep).add(vec3(0.12, 0.34, 0.34).mul(c).mul(dep)));
        a.assign(select(cameraPosition.y.lessThan(G.waterLevel).and(dist.lessThan(40)), float(0.35), float(0.72)));
      });
      const f = float(1).sub(exp(G.fogDensity.mul(G.fogDensity).mul(dist).mul(dist).negate()));
      return vec4(mix(col, G.fogColor, f.mul(0.9)), a);
    })();
    return m;
  }

  // kind: 'w' wallpaper, 'f' floor, 'c' ceiling, 't' tile. Textures are painted by CPPNs on first use.
  get(kind, R) {
    let st = this.styles.get(R.id);
    if (!st) { st = {}; this.styles.set(R.id, st); }
    let m = st[kind];
    if (m) return m;
    if (kind.length > 1) { // 'wo', 'fo', 'co', 'to': the same surface as a see-through layer, laid over the neighbouring district's
      m = this.make({ map: this.get(kind[0], R).uniforms.map.value, flick: R.lc, stain: kind[0] === 't' ? 0.55 : 1, fade: true });
      st[kind] = m;
      return m;
    }
    const map = kind === 'w' ? makeWall(R) : kind === 'f' ? makeFloor(R) : kind === 'c' ? makeCeil(R) : makeTile(R);
    m = this.make({ map, flick: R.lc, stain: kind === 't' ? 0.55 : 1 });
    st[kind] = m;
    return m;
  }

  // Drop textures for districts no loaded chunk refers to.
  prune(live, force = false) {
    if (!force && this.styles.size < 48) return;
    for (const [id, st] of this.styles) {
      if (live.has(id)) continue;
      for (const k in st) { st[k].uniforms.map.value.dispose(); st[k].dispose(); }
      this.styles.delete(id);
    }
  }
}
