// Scene -> bloom -> grade (grain, vignette, aberration, underwater wobble, dread).
// Runs as fullscreen TSL passes on render targets; bloom works at quarter resolution.
import * as THREE from 'three';
import { Fn, uniform, texture, uv, vec2, vec3, vec4, float, sin, cos, fract, floor, step, abs, dot, mix, smoothstep, max, length, pow } from 'three/tsl';

export class Post {
  constructor(renderer) {
    this.r = renderer;
    this.rt = new THREE.RenderTarget(4, 4, { samples: 4, depthBuffer: true });
    const lin = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.a = new THREE.RenderTarget(4, 4, lin);
    this.b = new THREE.RenderTarget(4, 4, lin);
    this.quad = new THREE.QuadMesh();

    const mk = node => { const m = new THREE.NodeMaterial(); m.fragmentNode = node; m.depthTest = false; m.depthWrite = false; return m; };

    const tSrc = texture(this.rt.texture);
    this.bright = mk(Fn(() => {
      const c = tSrc.sample(uv()).rgb;
      const l = max(c.r, max(c.g, c.b));
      return vec4(c.mul(smoothstep(0.55, 0.95, l)), 1);
    })());

    // separable 9-tap gaussian as 5 linear-filtered taps
    const blur = (src, d) => mk(Fn(() => {
      const t = texture(src), p = uv();
      const c = t.sample(p).rgb.mul(0.227).toVar();
      c.addAssign(t.sample(p.add(d.mul(1.385))).rgb.add(t.sample(p.sub(d.mul(1.385))).rgb).mul(0.316));
      c.addAssign(t.sample(p.add(d.mul(3.231))).rgb.add(t.sample(p.sub(d.mul(3.231))).rgb).mul(0.070));
      return vec4(c, 1);
    })());
    this.d = [0, 1, 2, 3].map(() => uniform(new THREE.Vector2()));
    this.blurs = [blur(this.a.texture, this.d[0]), blur(this.b.texture, this.d[1]), blur(this.a.texture, this.d[2]), blur(this.b.texture, this.d[3])];

    const U = this.U = {
      time: uniform(0), res: uniform(new THREE.Vector2(1, 1)),
      under: uniform(0), dread: uniform(0), hit: uniform(0), fade: uniform(0), bloom: uniform(0.9), gain: uniform(1), fx: uniform(1), glitch: uniform(0), noise: uniform(0), fadeCol: uniform(new THREE.Color(0, 0, 0)),
    };
    const tScene = texture(this.rt.texture), tBloom = texture(this.a.texture);
    const h = p => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));
    this.final = mk(Fn(() => {
      const p = uv().toVar();
      // --- tape: every line sits a hair off; now and then a band of the picture tears sideways; a bar of noise rolls up the frame
      const line = floor(p.y.mul(U.res.y).mul(0.5));
      const tick = floor(U.time.mul(13));
      const tear = step(float(0.955).sub(U.glitch.mul(0.6)), h(vec2(tick, 3.7))).mul(max(U.fx, U.glitch));
      const band = step(abs(p.y.sub(h(vec2(tick, 9.1)))), h(vec2(tick, 5.3)).mul(0.07).add(0.015));
      const roll = smoothstep(0.035, 0, abs(fract(p.y.add(U.time.mul(0.09))).sub(0.5))).mul(U.fx);
      p.x.addAssign(h(vec2(line, floor(U.time.mul(50)))).sub(0.5).mul(0.0013).mul(U.fx.add(U.noise.mul(2.5))));
      p.x.addAssign(band.mul(tear).mul(h(vec2(line, tick)).sub(0.4)).mul(0.05));
      p.x.addAssign(roll.mul(h(vec2(line, U.time)).sub(0.5)).mul(0.012));
      p.addAssign(vec2(sin(p.y.mul(21).add(U.time.mul(1.7))), cos(p.x.mul(17).add(U.time.mul(1.3)))).mul(U.under.mul(0.0024)));
      const c = p.sub(0.5), r2 = dot(c, c);
      p.subAssign(c.mul(U.dread.mul(0.03).mul(sin(U.time.mul(5)).mul(0.5).add(0.5)).mul(r2)));
      // colour channels drift apart toward the edges, and more when a tear passes
      const ab = float(0.0012).add(U.fx.mul(0.0016)).add(U.dread.mul(0.006)).add(U.hit.mul(0.02)).add(tear.mul(band).mul(0.012)).mul(r2.mul(3).add(1));
      const col = vec3(tScene.sample(p.add(c.mul(ab))).r, tScene.sample(p).g, tScene.sample(p.sub(c.mul(ab))).b).toVar();
      col.addAssign(tBloom.sample(p).rgb.mul(U.bloom));
      const l = dot(col, vec3(0.299, 0.587, 0.114));
      col.assign(mix(vec3(l), col, float(0.9).sub(U.dread.mul(0.4)).sub(U.fx.mul(0.08))));
      col.assign(col.div(col.mul(0.3).add(1)).mul(1.22));
      col.assign(pow(max(col, 0), vec3(0.9)));
      // tape colour: blacks lifted a little and pushed toward green, exposure hunting slightly
      col.assign(mix(col, col.mul(vec3(0.95, 1.03, 0.96)).add(0.012), U.fx.mul(0.6)));
      col.mulAssign(h(vec2(tick, 1.3)).sub(0.5).mul(0.035).mul(U.fx).add(1));
      col.mulAssign(float(1).sub(sin(p.y.mul(U.res.y).mul(3.14159)).mul(0.5).add(0.5).mul(0.06).mul(U.fx)));   // scanlines
      col.addAssign(roll.mul(h(p.mul(U.res).add(U.time)).mul(0.14)).add(tear.mul(band).mul(0.05)));
      col.mulAssign(mix(0.22, 1.0, smoothstep(0.9, 0.25, length(c).mul(U.dread.mul(0.6).add(1)))));
      // grain: coarse, like a small sensor in bad light
      const g = h(floor(p.mul(U.res).mul(0.6)).add(fract(U.time).mul(61))).sub(0.5);
      col.addAssign(g.mul(U.dread.mul(0.05).add(0.03).add(U.fx.mul(0.06)).add(U.noise.mul(0.13))));
      col.assign(mix(col, vec3(0.25, 0, 0), U.hit.mul(0.35)));
      return vec4(mix(col.mul(U.gain), U.fadeCol, U.fade), 1);
    })());
  }

  resize(w, h) {
    this.rt.setSize(w, h);
    const bw = Math.max(2, w >> 2), bh = Math.max(2, h >> 2);
    this.a.setSize(bw, bh); this.b.setSize(bw, bh);
    this.U.res.value.set(w, h);
    for (let q = 0; q < 2; q++) {
      const s = 1 + q * 1.5;
      this.d[q * 2].value.set(s / bw, 0);
      this.d[q * 2 + 1].value.set(0, s / bh);
    }
  }

  pass(mat, target) {
    this.quad.material = mat;
    this.r.setRenderTarget(target);
    this.quad.render(this.r);
  }

  render(scene, camera) {
    const r = this.r;
    r.setRenderTarget(this.rt);
    r.render(scene, camera);
    this.pass(this.bright, this.a);
    this.pass(this.blurs[0], this.b); this.pass(this.blurs[1], this.a);
    this.pass(this.blurs[2], this.b); this.pass(this.blurs[3], this.a);
    this.pass(this.final, null);
  }
}
