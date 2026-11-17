// Everything you hear is synthesised: the hum of the lights, the pressure of the water, the thin
// singing of the outside, and whatever lives there.
//
// Mix: three groups (ambience, effects, music) with their own volumes, then a high-pass and a low
// shelf that keep the bottom octaves from pounding, then a compressor. The "bass" setting moves the shelf.
export class Sound {
  constructor() {
    this.ctx = null; this.muted = false;
    this.evT = 8; this.beatT = 0; this.musT = 40; this.pieces = 0; this.district = -1; this.lastEv = -1;
    this.vol = { master: 0.8, ambience: 0.6, effects: 0.8, music: 0.6, bass: 0.35 };
    this.menuOn = false; this.menuAt = 0; this.menuBar = 0;
  }

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const C = this.ctx = new AC();
    this.master = C.createGain();
    const comp = C.createDynamicsCompressor();
    comp.threshold.value = -22; comp.ratio.value = 5; comp.attack.value = 0.01; comp.release.value = 0.3;
    this.lp = C.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 18000;
    this.hp = C.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 42; this.hp.Q.value = 0.6;
    this.shelf = C.createBiquadFilter(); this.shelf.type = 'lowshelf'; this.shelf.frequency.value = 150;
    this.hp.connect(this.shelf); this.shelf.connect(this.lp); this.lp.connect(comp); comp.connect(this.master); this.master.connect(C.destination);
    this.gAmb = C.createGain(); this.gFx = C.createGain(); this.gMus = C.createGain();
    for (const g of [this.gAmb, this.gFx, this.gMus]) g.connect(this.hp);
    this.bus = C.createGain(); this.bus.connect(this.gFx);   // dry effects

    // reverb: a long noisy tail, for the size of the place
    const len = C.sampleRate * 3.5, ir = C.createBuffer(2, len, C.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    const rev = C.createConvolver(); rev.buffer = ir;
    const revHP = C.createBiquadFilter(); revHP.type = 'highpass'; revHP.frequency.value = 180; // no mud in the tail
    this.send = C.createGain(); this.send.gain.value = 0.5;
    this.send.connect(revHP); revHP.connect(rev); rev.connect(this.gFx);

    const nl = C.sampleRate * 2;
    this.noise = C.createBuffer(1, nl, C.sampleRate);
    this.brown = C.createBuffer(1, nl, C.sampleRate);
    const w = this.noise.getChannelData(0), b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < nl; i++) { w[i] = Math.random() * 2 - 1; last = (last + 0.02 * w[i]) / 1.02; b[i] = last * 3.5; }

    const osc = (type, f, g, dest) => {
      const o = C.createOscillator(), gn = C.createGain();
      o.type = type; o.frequency.value = f; gn.gain.value = g;
      o.connect(gn); gn.connect(dest); o.start();
      return o;
    };
    const loop = (buf, dest) => { const s = C.createBufferSource(); s.buffer = buf; s.loop = true; s.connect(dest); s.start(); return s; };
    const lfo = (rate, depth, param) => { const o = C.createOscillator(), g = C.createGain(); o.frequency.value = rate; g.gain.value = depth; o.connect(g); g.connect(param); o.start(); };

    // dry floors: mains hum (quiet), buzzing tubes, air moving in ducts. Each district is tuned a little differently.
    this.gHall = C.createGain(); this.gHall.gain.value = 0; this.gHall.connect(this.gAmb);
    const humLP = C.createBiquadFilter(); humLP.type = 'lowpass'; humLP.frequency.value = 500; humLP.connect(this.gHall);
    this.hum = [osc('sawtooth', 120, 0.03, humLP), osc('sine', 60, 0.03, humLP), osc('sawtooth', 119.3, 0.018, humLP)];
    this.buzz = C.createBiquadFilter(); this.buzz.type = 'bandpass'; this.buzz.frequency.value = 3400; this.buzz.Q.value = 9;
    this.buzzG = C.createGain(); this.buzzG.gain.value = 0.022; this.buzz.connect(this.buzzG); this.buzzG.connect(this.gHall);
    loop(this.noise, this.buzz);
    const air = C.createBiquadFilter(); air.type = 'bandpass'; air.frequency.value = 420; air.Q.value = 0.5;
    const ag = C.createGain(); ag.gain.value = 0.11; air.connect(ag); ag.connect(this.gHall);
    loop(this.brown, air);
    lfo(0.07, 0.05, ag.gain); lfo(0.031, 140, air.frequency); // the ducts breathe

    // drowned floors: pressure in the mids, not the subs, and a slow shimmer above it
    this.gWater = C.createGain(); this.gWater.gain.value = 0; this.gWater.connect(this.gAmb);
    const wl = C.createBiquadFilter(); wl.type = 'lowpass'; wl.frequency.value = 320;
    const wg = C.createGain(); wg.gain.value = 0.6; wl.connect(wg); wg.connect(this.gWater);
    loop(this.brown, wl);
    lfo(0.05, 90, wl.frequency);
    osc('sine', 58, 0.05, this.gWater); osc('sine', 87.3, 0.03, this.gWater);
    const sh = C.createBiquadFilter(); sh.type = 'bandpass'; sh.frequency.value = 1100; sh.Q.value = 3;
    const sg = C.createGain(); sg.gain.value = 0.02; sh.connect(sg); sg.connect(this.gWater);
    loop(this.noise, sh);
    lfo(0.09, 0.016, sg.gain); lfo(0.043, 500, sh.frequency);

    // the outside: a thin chord, each note drifting on its own
    this.gVoid = C.createGain(); this.gVoid.gain.value = 0; this.gVoid.connect(this.gAmb); this.gVoid.connect(this.send);
    for (const [f, g] of [[98, 0.045], [103.6, 0.035], [196.4, 0.03], [293.2, 0.022], [587.9, 0.01], [880.7, 0.004], [55, 0.035]]) {
      const o = C.createOscillator(), gn = C.createGain();
      o.frequency.value = f; gn.gain.value = g;
      lfo(0.03 + Math.random() * 0.12, g * 0.8, gn.gain);
      o.connect(gn); gn.connect(this.gVoid); o.start();
    }

    // something close: a thin whine and a breath of static that rise with it
    this.gNear = C.createGain(); this.gNear.gain.value = 0; this.gNear.connect(this.gFx);
    osc('sine', 2093, 0.012, this.gNear); osc('sine', 2168, 0.01, this.gNear); osc('sine', 311, 0.02, this.gNear);
    const nb = C.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = 5200; nb.Q.value = 1.5;
    const nbg = C.createGain(); nbg.gain.value = 0.02; nb.connect(nbg); nbg.connect(this.gNear);
    loop(this.noise, nb);

    // music: quiet, far off, and mostly reverb
    this.gMusic = C.createGain(); this.gMusic.gain.value = 0.9;
    this.gMusic.connect(this.gMus);
    const mrev = C.createConvolver(); mrev.buffer = ir;
    const ms = C.createGain(); ms.gain.value = 1.4; this.gMusic.connect(ms); ms.connect(mrev); mrev.connect(this.gMus);
    // the menu and the pause have their own music, on its own fader
    this.gMenu = C.createGain(); this.gMenu.gain.value = 0;
    this.menuLP = C.createBiquadFilter(); this.menuLP.type = 'lowpass'; this.menuLP.frequency.value = 1500;
    this.menuLP.connect(this.gMenu); this.gMenu.connect(this.gMusic);
    this.applyVolumes();
  }

  // Music for the menu and the pause: four slow chords that never quite come home, and a music box over them.
  menu(on) {
    this.menuOn = on;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.gMenu.gain.setTargetAtTime(on ? 1 : 0, t, on ? 1.4 : 0.25);
    if (on && this.menuAt < t + 0.2) this.menuAt = t + 0.2;
    this.applyVolumes();
  }
  mnote(f, at, dur, gain, type, attack) {
    const C = this.ctx, o = C.createOscillator(), g = C.createGain();
    o.type = type; o.frequency.setValueAtTime(f, at);
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(gain, at + attack); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(this.menuLP); o.start(at); o.stop(at + dur + 0.05);
  }
  tickMenu() {
    const C = this.ctx; if (!C || !this.menuOn) return;
    const CH = [[220, [0, 3, 7, 14]], [174.61, [0, 4, 7, 11]], [146.83, [0, 3, 7, 9]], [164.81, [0, 5, 7, 10]]];
    const BAR = 7.2, st = n => Math.pow(2, n / 12), R = Math.random;
    while (this.menuAt < C.currentTime + 1.5) {
      const at = this.menuAt, [root, iv] = CH[this.menuBar % 4];
      for (let q = 0; q < iv.length; q++) { // the pad: slow in, slow out, a little out of tune with itself
        const f = root * st(iv[q]);
        this.mnote(f * (1 + (R() - 0.5) * 0.004), at + q * 0.25, BAR + 2.2, 0.022, 'triangle', 2.4);
        this.mnote(f * 1.003, at + q * 0.25, BAR + 2.2, 0.014, 'sine', 2.8);
      }
      this.mnote(root / 2, at, BAR + 1, 0.03, 'sine', 1.8);
      const n = 2 + Math.floor(R() * 3); // the music box: a few notes of the chord, late and unsure
      let off = 0.6 + R() * 1.2;
      for (let q = 0; q < n; q++) {
        const f = root * 2 * st(iv[Math.floor(R() * iv.length)] + (R() < 0.3 ? 12 : 0));
        this.mnote(f, at + off, 3.2, 0.03, 'sine', 0.012);
        this.mnote(f * 3.01, at + off, 1.2, 0.005, 'sine', 0.012);
        off += 0.7 + R() * 1.5;
        if (off > BAR - 0.4) break;
      }
      this.menuAt += BAR; this.menuBar++;
    }
  }

  // master / ambience / effects / music: 0..1; bass: 0 (thin) .. 1 (full)
  setVolumes(v) { Object.assign(this.vol, v); this.applyVolumes(); }
  applyVolumes() {
    if (!this.ctx) return;
    const v = this.vol, t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : v.master, t, 0.05);
    this.gAmb.gain.setTargetAtTime(v.ambience * 1.5 * (this.menuOn ? 0.2 : 1), t, this.menuOn ? 0.5 : 0.05);
    this.gFx.gain.setTargetAtTime(v.effects * 1.2, t, 0.05);
    this.gMus.gain.setTargetAtTime(v.music, t, 0.05);
    this.shelf.gain.setTargetAtTime(-18 + 20 * v.bass, t, 0.05);   // -18 dB .. +2 dB below 150 Hz
    this.hp.frequency.setTargetAtTime(60 - 30 * v.bass, t, 0.05);
  }
  setMuted(m) { this.muted = m; this.applyVolumes(); }

  // every district hums in its own voice: 50 or 60 cycle mains, brighter or duller tubes
  setDistrict(id) {
    if (!this.ctx || id === this.district) return;
    this.district = id;
    const t = this.ctx.currentTime, base = id & 1 ? 50 : 60, det = ((id >>> 3) % 7) * 0.12;
    this.hum[0].frequency.setTargetAtTime(base * 2 + det, t, 1.5);
    this.hum[1].frequency.setTargetAtTime(base, t, 1.5);
    this.hum[2].frequency.setTargetAtTime(base * 2 - 0.7 - det, t, 1.5);
    this.buzz.frequency.setTargetAtTime(2600 + ((id >>> 6) % 9) * 220, t, 1.5);
    this.buzzG.gain.setTargetAtTime(0.012 + ((id >>> 10) % 5) * 0.005, t, 1.5);
  }

  burst(buf, type, f, q, gain, dur, pan = 0, rev = 0.4, f2 = 0, at = 0) {
    const C = this.ctx; if (!C) return;
    const t = C.currentTime + at, s = C.createBufferSource(), fl = C.createBiquadFilter(), g = C.createGain(), p = C.createStereoPanner();
    s.buffer = buf; s.loop = true; fl.type = type; fl.frequency.setValueAtTime(f, t); fl.Q.value = q;
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.012, dur * 0.3)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    p.pan.value = pan;
    s.connect(fl); fl.connect(g); g.connect(p); p.connect(this.bus);
    if (rev) { const r = C.createGain(); r.gain.value = rev; p.connect(r); r.connect(this.send); }
    s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
  }

  tone(f, dur, gain, pan = 0, f2 = 0, type = 'sine', at = 0) {
    const C = this.ctx; if (!C) return;
    const t = C.currentTime + at, o = C.createOscillator(), g = C.createGain(), p = C.createStereoPanner();
    o.type = type; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f2 || f * 0.5, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    p.pan.value = pan;
    o.connect(g); g.connect(p); p.connect(this.bus); p.connect(this.send); o.start(t); o.stop(t + dur + 0.1);
  }

  step(kind, vol) {
    if (!this.ctx) return;
    const v = vol * (0.85 + Math.random() * 0.3), r = Math.random();
    if (kind === 'carpet') this.burst(this.noise, 'lowpass', 520 + r * 260, 0.7, 0.16 * v, 0.1);
    else if (kind === 'tile') this.burst(this.noise, 'bandpass', 1200 + r * 700, 1.6, 0.15 * v, 0.07, 0, 0.8);
    else if (kind === 'wade') this.burst(this.noise, 'bandpass', 800 + r * 300, 0.8, 0.2 * v, 0.3, 0, 0.5, 350);
    else if (kind === 'swim') this.burst(this.noise, 'bandpass', 500 + r * 200, 0.6, 0.12 * v, 0.7, 0, 0.3, 220);
    else this.burst(this.noise, 'lowpass', 420, 0.6, 0.3 * v, 0.16);
  }

  splash(v) { this.burst(this.noise, 'bandpass', 1500, 0.6, 0.3 * v, 0.7, 0, 0.6, 300); }
  creak(pan) { this.burst(this.noise, 'bandpass', 300 + Math.random() * 400, 14, 0.4, 0.35, pan, 0.9, 200); }
  click() { this.burst(this.noise, 'bandpass', 1800, 4, 0.12, 0.05, 0, 0.2); }
  heal() { this.tone(330, 0.9, 0.08, 0, 330); this.tone(495, 1.2, 0.06, 0, 495); }
  strike() { this.burst(this.noise, 'bandpass', 2600, 0.8, 0.3, 0.9, 0, 0.5, 1200); }
  ui() { this.tone(660, 0.12, 0.05, 0, 620); }

  // it has seen you: a short rising scrape and a knock in the chest
  notice(k = 1) {
    if (!this.ctx) return;
    this.tone(160, 0.5, 0.07 * k, 0, 520, 'sawtooth');
    this.tone(233, 0.5, 0.05 * k, 0, 700, 'sawtooth', 0.03);
    this.burst(this.noise, 'bandpass', 900, 2, 0.16 * k, 0.45, 0, 0.7, 3600);
    this.tone(104, 0.2, 0.14 * k, 0, 70, 'sine', 0.42);
  }

// the shotgun: a crack, the body of the shot, and the room answering
  blast() {
    if (!this.ctx) return;
    this.burst(this.noise, 'highpass', 1800, 0.5, 0.55, 0.07, 0, 0.5);
    this.burst(this.noise, 'lowpass', 2400, 0.7, 0.85, 0.42, 0, 1.3, 180);
    this.burst(this.noise, 'bandpass', 700, 0.8, 0.35, 0.9, 0, 1.5, 220, 0.03);
    this.tone(150, 0.2, 0.3, 0, 55);
  }
  // break it open, two shells in, snap it shut
  reload() {
    if (!this.ctx) return;
    this.burst(this.noise, 'bandpass', 1500, 5, 0.22, 0.06, 0, 0.3); this.tone(320, 0.08, 0.05, 0, 210, 'triangle');
    for (const at of [0.5, 0.82]) { this.burst(this.noise, 'lowpass', 900, 1.2, 0.2, 0.07, 0, 0.2, 0, at); this.tone(520, 0.05, 0.03, 0, 430, 'sine', at); }
    this.burst(this.noise, 'bandpass', 2300, 5, 0.3, 0.05, 0, 0.4, 0, 1.25); this.burst(this.noise, 'lowpass', 700, 1, 0.22, 0.09, 0, 0.3, 0, 1.26);
  }
  // shot landing in something that is not a wall
  thud(pan = 0) {
    if (!this.ctx) return;
    this.burst(this.noise, 'lowpass', 650, 1.2, 0.4, 0.16, pan, 0.5, 200, 0.02);
    this.burst(this.noise, 'bandpass', 1900, 3, 0.14, 0.2, pan, 0.6, 600, 0.04);
  }

  // a screamer: hits at once, no swell. sawtooth voices tearing downward, a bark of noise, a thump
  // flavour: 'dry' (the lit floors), 'water' (muffled, bubbling), 'void' (high, glassy, with a swell under it)
  scream(k = 1, flavour = 'dry') {
    const C = this.ctx; if (!C) return;
    const t = C.currentTime, fm = flavour === 'void' ? 1.7 : flavour === 'water' ? 0.62 : 1;
    let dest = this.bus;
    if (flavour === 'water') { dest = C.createBiquadFilter(); dest.type = 'lowpass'; dest.frequency.value = 900; dest.Q.value = 3; dest.connect(this.bus); }
    const v = (f, f2, g, dur, type = 'sawtooth') => {
      const o = C.createOscillator(), gn = C.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f2, t + dur);
      gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(g * k, t + 0.008); gn.gain.setValueAtTime(g * k, t + dur * 0.5); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(gn); gn.connect(dest); gn.connect(this.send); o.start(t); o.stop(t + dur + 0.05);
    };
    for (const [f, g] of [[880, 0.09], [933, 0.08], [1244, 0.06], [1660, 0.045], [620, 0.08]]) v(f * fm * (0.97 + Math.random() * 0.06), f * fm * (flavour === 'void' ? 1.3 : 0.42), g * (flavour === 'water' ? 1.6 : 1), 0.95);
    if (flavour === 'water') for (let q = 0; q < 10; q++) this.burst(this.noise, 'bandpass', 400 + q * 160, 9, 0.12, 0.08, 0, 0.4, 900 + q * 200, q * 0.05);
    if (flavour === 'void') { this.tone(110, 1.4, 0.12, 0, 55); this.tone(3300, 1.2, 0.03, 0, 5200, 'sine'); }
    v(150, 55, 0.3, 0.45, 'square');
    this.burst(this.noise, 'bandpass', 2400, 0.8, 0.7 * k, 0.8, 0, 0.8, 700);
    this.burst(this.noise, 'highpass', 4500, 0.7, 0.45 * k, 0.22, 0, 0.4);
  }
  // the lights go: a relay clunk, the hum cut, then breathing that is not yours
  lightsOut() {
    if (!this.ctx) return;
    this.burst(this.noise, 'lowpass', 300, 1, 0.5, 0.18, 0, 0.6);
    this.burst(this.noise, 'bandpass', 2000, 6, 0.18, 0.05, 0, 0.3);
    if (this.gHall) { const t = this.ctx.currentTime; this.gHall.gain.cancelScheduledValues(t); this.gHall.gain.setValueAtTime(0, t); }
    for (let q = 0; q < 2; q++) this.burst(this.noise, 'bandpass', 520, 1.2, 0.09, 0.7, (Math.random() - 0.5) * 0.4, 0.4, 300, 0.35 + q * 0.75);
  }
  // the pump computer: keys, a refusal, the hiss of the hatch venting
  key() { this.tone(1800 + Math.random() * 300, 0.04, 0.025, 0, 1700, 'square'); }
  deny() { this.tone(220, 0.35, 0.08, 0, 210, 'square'); this.tone(165, 0.35, 0.06, 0, 160, 'square', 0.18); }
  accept() { this.tone(660, 0.12, 0.05, 0, 660, 'square'); this.tone(990, 0.2, 0.05, 0, 990, 'square', 0.12); }
  hiss() { this.burst(this.noise, 'highpass', 2500, 0.6, 0.35, 3.2, 0, 0.8, 900); this.burst(this.brown, 'lowpass', 300, 0.7, 0.4, 3.0, 0, 0.6, 120); }
  // a fuse going in: a crack and power coming up
  power() { this.burst(this.noise, 'bandpass', 2600, 2, 0.4, 0.12, 0, 0.5); this.tone(50, 2.5, 0.15, 0, 120, 'sawtooth'); this.tone(100, 2.5, 0.06, 0, 240, 'sawtooth'); }
  // the radio: static that clears into a slow tune as you come on to the station
  radio(on) {
    const C = this.ctx; if (!C) return;
    if (on && !this.rad) {
      const n = C.createBufferSource(); n.buffer = this.noise; n.loop = true;
      const bp = C.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 0.4;
      const gn = C.createGain(); gn.gain.value = 0.2; n.connect(bp); bp.connect(gn); gn.connect(this.gFx); n.start();
      const gs = C.createGain(); gs.gain.value = 0; gs.connect(this.gFx); gs.connect(this.send);
      const o1 = C.createOscillator(), o2 = C.createOscillator(); o1.type = 'triangle'; o2.type = 'sine'; o1.frequency.value = 392; o2.frequency.value = 196;
      const g2 = C.createGain(); g2.gain.value = 0.5; o1.connect(gs); o2.connect(g2); g2.connect(gs); o1.start(); o2.start();
      this.rad = { n, gn, gs, o1, o2, bp, mt: 0, i: 0 };
    } else if (!on && this.rad) {
      const r = this.rad, t = C.currentTime;
      r.gn.gain.setTargetAtTime(0, t, 0.05); r.gs.gain.setTargetAtTime(0, t, 0.05);
      r.n.stop(t + 0.3); r.o1.stop(t + 0.3); r.o2.stop(t + 0.3);
      this.rad = null;
    }
  }
  radioSet(c, dt) {
    const r = this.rad; if (!r) return;
    const t = this.ctx.currentTime, MEL = [392, 440, 392, 330, 349, 392, 294, 330, 262, 294, 330, 262];
    r.gn.gain.setTargetAtTime(0.025 + 0.22 * (1 - c), t, 0.05);
    r.gs.gain.setTargetAtTime(0.075 * c * c, t, 0.08);
    r.bp.frequency.setTargetAtTime(1300 + 2400 * (1 - c), t, 0.1);
    r.o1.detune.setTargetAtTime((1 - c) * 300 * Math.sin(t * 7), t, 0.05);
    if ((r.mt -= dt) <= 0) { r.mt = 0.55; const f = MEL[r.i++ % MEL.length]; r.o1.frequency.setTargetAtTime(f, t, 0.03); r.o2.frequency.setTargetAtTime(f / 2, t, 0.03); }
  }

  // a dry click and nothing: a wet shell
  misfire() { this.click(); this.burst(this.noise, 'lowpass', 400, 1, 0.12, 0.08, 0, 0.1, 0, 0.03); }

  // coming to: ears ringing, a breath
  wake() {
    if (!this.ctx) return;
    this.tone(3950, 7, 0.018, 0, 3900); this.tone(4410, 5, 0.008, 0.3, 4380);
    this.burst(this.noise, 'bandpass', 600, 1, 0.08, 1.4, 0, 0.3, 300, 2.6);
  }
  // cloth and a hand on the carpet, getting up
  rustle(at = 0) {
    if (!this.ctx) return;
    this.burst(this.noise, 'bandpass', 900, 0.7, 0.12, 0.5, 0, 0.2, 400, at);
    this.burst(this.noise, 'lowpass', 500, 0.7, 0.14, 0.3, 0.2, 0.2, 0, at + 0.35);
    this.burst(this.noise, 'bandpass', 700, 1, 0.07, 0.9, 0, 0.3, 350, at + 0.6);
  }
  // a new chapter: a low struck chord under the title
  chapter(to) {
    const C = this.ctx; if (!C) return;
    const root = [110, 98, 123.5][to] || 110, st = n => Math.pow(2, n / 12), t = C.currentTime + 0.1;
    for (const [n, g] of [[0, 0.06], [7, 0.04], [12, 0.035], [to === 2 ? 18 : 15, 0.025]]) this.note(root * st(n), t + n * 0.01, 6, g, 'triangle');
    this.tone(root / 2, 3, 0.05, 0, root / 2.05);
  }
  // the hatch: a lid, a ladder, then water
  descend() {
    if (!this.ctx) return;
    this.burst(this.noise, 'bandpass', 420, 6, 0.3, 0.4, 0, 1, 200);
    for (let q = 0; q < 5; q++) this.burst(this.noise, 'bandpass', 1300, 8, 0.08, 0.06, 0, 0.8, 0, 0.5 + q * 0.33);
    this.burst(this.noise, 'bandpass', 1500, 0.6, 0.3, 1.1, 0, 0.6, 250, 2.1);
  }
  // the way out: for once, a chord that resolves
  ending() {
    const C = this.ctx; if (!C) return;
    const t = C.currentTime + 0.2, st = n => Math.pow(2, n / 12), root = 146.8;
    [[0, 4, 7, 12], [5, 9, 12, 17], [7, 11, 14, 19], [0, 4, 7, 16]].forEach((ch, i) => {
      for (const n of ch) this.note(root * st(n), t + i * 2.4, 4.5, 0.045, 'triangle');
    });
    this.note(root * st(24), t + 7.4, 6, 0.03, 'sine');
  }

  // stepping through: everything drops away for a moment
  door() {
    if (!this.ctx) return;
    this.tone(220, 1.6, 0.22, 0, 70);
    this.burst(this.noise, 'lowpass', 1400, 0.6, 0.25, 1.3, 0, 1.2, 160);
  }

  chime() {
    if (!this.ctx) return;
    const base = [880, 987.8, 1046.5, 1174.7][Math.floor(Math.random() * 4)];
    this.tone(base, 0.9, 0.07, 0, base); this.tone(base * 1.5, 0.9, 0.06, 0, base * 1.5, 'sine', 0.09); this.tone(base * 2, 0.9, 0.05, 0, base * 2, 'sine', 0.2);
  }

  voice(v, gain, pan) {
    const C = this.ctx; if (!C) return;
    const t = C.currentTime, car = C.createOscillator(), mo = C.createOscillator(), mg = C.createGain(), g = C.createGain(), p = C.createStereoPanner();
    const f = Math.max(90, v.f); // keep even the deepest of them out of the sub range
    car.type = 'sawtooth';
    car.frequency.setValueAtTime(f, t);
    car.frequency.exponentialRampToValueAtTime(Math.max(70, f * v.fall), t + v.dur);
    mo.frequency.value = f * v.ratio; mg.gain.value = v.depth;
    mo.connect(mg); mg.connect(car.frequency);
    const pk = Math.max(0.001, gain * 0.45);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(pk, t + 0.05);
    g.gain.setValueAtTime(pk, t + v.dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + v.dur);
    p.pan.value = pan;
    const r = C.createGain(); r.gain.value = 0.9;
    car.connect(g); g.connect(p); p.connect(this.bus); p.connect(r); r.connect(this.send);
    car.start(t); mo.start(t); car.stop(t + v.dur + 0.1); mo.stop(t + v.dur + 0.1);
  }

  // being touched: a dissonant stab in the mids, with only a little weight under it
  stinger(v = 1) {
    if (!this.ctx) return;
    this.tone(92, 1.2, 0.16 * v, 0, 64);
    for (const f of [311, 329.5, 466.2]) this.tone(f, 1.5, 0.06 * v, 0, f * 0.7, 'sawtooth');
    this.burst(this.noise, 'bandpass', 2400, 1.2, 0.25 * v, 0.5, 0, 0.8, 400);
  }

  // one struck note: a sine with a faint overtone, into the music bus
  note(f, at, dur, gain, type = 'sine', bend = 1) {
    const C = this.ctx, o = C.createOscillator(), o2 = C.createOscillator(), g = C.createGain(), g2 = C.createGain();
    o.type = type; o.frequency.setValueAtTime(f, at);
    if (bend !== 1) o.frequency.exponentialRampToValueAtTime(f * bend, at + dur);
    o2.frequency.value = f * 3.01; g2.gain.value = 0.18;
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(gain, at + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(this.gMusic);
    o.start(at); o2.start(at); o.stop(at + dur + 0.05); o2.stop(at + dur + 0.05);
  }

  // Now and then, music. Returns the length of the piece in seconds.
  playPiece(mix) {
    const C = this.ctx; if (!C) return 0;
    const t0 = C.currentTime + 0.3, R = Math.random;
    const kind = mix.void > 0.5 ? (R() < 0.6 ? 2 : 3) : mix.water > 0.5 ? (R() < 0.5 ? 2 : 1) : (R() < 0.55 ? 0 : R() < 0.6 ? 1 : 2);
    this.pieces++;
    const st = n => Math.pow(2, n / 12);
    if (kind === 0) {
      // a music box that has been wound too many times: a small tune, repeated, each time a little lower and slower
      const scale = [0, 2, 3, 7, 8, 11, 12, 14, 15], root = 440 * st(Math.floor(R() * 5) - 2);
      const motif = []; let idx = 2 + Math.floor(R() * 4);
      for (let q = 0; q < 7; q++) { motif.push(idx); idx = Math.max(0, Math.min(scale.length - 1, idx + Math.floor(R() * 5) - 2)); }
      let at = t0, step = 0.36 + R() * 0.12, drop = 0;
      const reps = 4 + Math.floor(R() * 2);
      for (let r = 0; r < reps; r++) {
        for (let q = 0; q < motif.length; q++) {
          if (R() < 0.08) { at += step; continue; }
          const f = root * st(scale[motif[q]] + drop) * (1 + 0.004 * Math.sin(at * 3));
          this.note(f, at, 1.6, 0.05, 'sine', r === reps - 1 ? 0.985 : 1);
          if (q % 3 === 0) this.note(f / 2, at, 2.2, 0.02, 'triangle');
          at += step * (R() < 0.12 ? 1.6 : 1);
        }
        at += step * 2; step *= 1.13; drop -= r >= 2 ? 1 : 0;
      }
      return at - t0 + 3;
    }
    if (kind === 1) {
      // a piano in another room, played by someone unsure of the tune
      const root = 164.8 * st(Math.floor(R() * 7)), iv = [0, 1, 6, 8, 12, 13, 3, 7];
      let at = t0; const n = 9 + Math.floor(R() * 6);
      for (let q = 0; q < n; q++) {
        const f = root * st(iv[Math.floor(R() * iv.length)]) * (R() < 0.3 ? 2 : 1);
        this.note(f, at, 4.5, 0.06, 'triangle');
        if (R() < 0.35) this.note(f * st(R() < 0.5 ? 1 : 6), at + 0.07, 4, 0.035, 'triangle');
        at += 1.4 + R() * 2.4;
      }
      return at - t0 + 5;
    }
    if (kind === 2) {
      // voices, or something tuned like voices, holding a chord that does not resolve and slowly sags
      const root = (mix.water > 0.5 ? 123.5 : 146.8) * st(Math.floor(R() * 5)), dur = 26 + R() * 14;
      const lp = C.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 620; lp.Q.value = 2;
      const g = C.createGain();
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.09, t0 + dur * 0.35); g.gain.setValueAtTime(0.09, t0 + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      lp.connect(g); g.connect(this.gMusic);
      for (const n of [0, 1, 6, 12.08, 15]) {
        const o = C.createOscillator(), v = C.createOscillator(), vg = C.createGain();
        o.type = 'sawtooth'; o.frequency.setValueAtTime(root * st(n), t0); o.frequency.exponentialRampToValueAtTime(root * st(n - 0.6), t0 + dur);
        v.frequency.value = 4.2 + R() * 1.6; vg.gain.value = root * st(n) * 0.006;
        v.connect(vg); vg.connect(o.frequency); o.connect(lp);
        o.start(t0); v.start(t0); o.stop(t0 + dur + 0.1); v.stop(t0 + dur + 0.1);
      }
      return dur + 2;
    }
    // swells that rise out of nothing and are cut off, like a recording played backwards
    const root = 196 * st(Math.floor(R() * 6)), n = 4 + Math.floor(R() * 3);
    let at = t0;
    for (let q = 0; q < n; q++) {
      const len = 2.5 + R() * 2.5;
      for (const iv of [0, 6, 13]) {
        const o = C.createOscillator(), g = C.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(root * st(iv - q), at); o.frequency.linearRampToValueAtTime(root * st(iv - q) * 1.01, at + len);
        g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.05, at + len); g.gain.linearRampToValueAtTime(0.0001, at + len + 0.04);
        o.connect(g); g.connect(this.gMusic); o.start(at); o.stop(at + len + 0.1);
      }
      at += len + 0.8 + R() * 2;
    }
    return at - t0 + 3;
  }

  // Something heard in the distance. A different thing each time; eight or so per realm.
  event(mix, dark) {
    const R = Math.random, pan = R() * 2 - 1;
    const realm = mix.void > 0.5 ? 2 : mix.water > 0.5 ? 1 : 0, n = [9, 6, 6][realm];
    let k = Math.floor(R() * n);
    if (k === this.lastEv) k = (k + 1) % n;
    this.lastEv = k;
    if (realm === 0) {
      switch (k) {
        case 0: for (let q = 0; q < 3; q++) this.burst(this.noise, 'bandpass', 520, 6, 0.09, 0.09, pan, 1.5, 0, q * 0.27); break;                     // three knocks
        case 1: this.burst(this.noise, 'lowpass', 600, 0.8, 0.22, 0.35, pan, 1.6, 150); break;                                                  // a door, a long way off
        case 2: this.burst(this.noise, 'bandpass', 380, 1.2, 0.07, 2.6, pan, 0.8, 950); break;                                                  // air through a duct
        case 3: this.tone(1900 + R() * 600, 0.5, 0.025, pan, 1700); break;                                                                      // a tube pings as it warms
        case 4: for (let q = 0; q < 5; q++) this.burst(this.noise, 'lowpass', 500, 0.7, 0.05, 0.1, pan + (q - 2) * 0.08, 1.4, 0, q * 0.55); break; // footsteps that are not yours
        case 5: for (let q = 0; q < 14; q++) this.burst(this.noise, 'bandpass', 2500, 2, 0.02 + 0.02 * R(), 0.05, pan, 0.6, 0, q * 0.06); break;   // a radio between stations
        case 6: this.tone(88, 2.4, 0.05, pan, 104, 'sawtooth'); break;                                                                           // a pipe taking the strain
        case 7: for (let q = 0; q < 2; q++) for (let w = 0; w < 8; w++) this.tone(w % 2 ? 480 : 440, 0.07, 0.012, pan, w % 2 ? 480 : 440, 'sine', q * 1.6 + w * 0.06); break; // a telephone, two rooms away
        default: this.burst(this.noise, 'bandpass', 900 + R() * 600, 18, 0.2, 0.5, pan, 1.2, 500);                                              // a chair moved
      }
    } else if (realm === 1) {
      switch (k) {
        case 0: { const f = 180 + R() * 320; this.tone(f, 3.5, 0.08, pan, f * (0.55 + R() * 0.3)); break; }                                      // a call, bending down
        case 1: for (let q = 0; q < 6; q++) this.burst(this.noise, 'bandpass', 500 + q * 180, 9, 0.07, 0.07, pan, 0.4, 900 + q * 200, q * 0.09); break; // bubbles going up
        case 2: this.tone(1250, 1.8, 0.04, pan, 1240); break;                                                                                   // a ping, as from a machine
        case 3: this.burst(this.noise, 'bandpass', 700, 16, 0.25, 1.4, pan, 1.0, 260); break;                                                   // the walls shift
        case 4: this.tone(900, 0.12, 0.05, pan, 500); this.tone(700, 0.12, 0.04, pan, 400, 'sine', 0.35); break;                                // drops from the ceiling
        default: { const f = 260 + R() * 200; this.tone(f, 2.2, 0.05, pan, f * 1.25); this.tone(f * 1.5, 2.2, 0.03, -pan, f * 1.7, 'sine', 0.6); } // an answer
      }
    } else {
      switch (k) {
        case 0: this.tone(700 + R() * 900, 4, 0.02, pan, 600 + R() * 400); break;                                                               // glass
        case 1: for (let q = 0; q < 10; q++) this.burst(this.noise, 'highpass', 4000, 1, 0.03, 0.02, pan, 0.8, 0, q * (0.4 - q * 0.03)); break;    // something ticking faster
        case 2: for (const f of [392, 466.2, 554.4]) this.tone(f, 3, 0.012, pan, f * 0.97, 'sawtooth'); break;                                  // a held breath of voices
        case 3: this.tone(300, 2.5, 0.015, pan, 2600); break;                                                                                   // a sweep, searching
        case 4: this.burst(this.noise, 'bandpass', 500, 0.7, 0.05, 3, pan, 1.0, 1400); break;                                                   // a long exhalation
        default: this.tone(1400 + R() * 400, 0.3, 0.02, pan, 1300); this.tone(1050, 0.5, 0.015, -pan, 1000, 'sine', 0.5);
      }
    }
  }

  // mix: weights for dry / water / outside; under: camera submerged; dread 0..1; dark: in an unlit district
  update(dt, mix, under, dread, dark = 0, near = 0) {
    const C = this.ctx; if (!C) return;
    const t = C.currentTime;
    this.gHall.gain.setTargetAtTime(mix.hall * 0.5 * (1 - 0.93 * dark), t, 0.6); // where there is no light there is no hum either
    this.gWater.gain.setTargetAtTime(mix.water * 0.75 * (1 - 0.7 * dark), t, 0.4); // dark water is still water, but it holds its breath
    this.gVoid.gain.setTargetAtTime(mix.void * 0.9, t, 0.6);
    this.lp.frequency.setTargetAtTime(under ? 700 : 18000, t, 0.12);
    this.send.gain.setTargetAtTime(0.35 + 0.5 * mix.void, t, 0.5);
    this.gNear.gain.setTargetAtTime(Math.max(0, near - 0.3) * 1.3, t, 0.25);

    // sometimes, music
    this.musT -= dt;
    if (this.musT <= 0) this.musT = dark > 0.5 ? 25 : this.playPiece(mix) + 55 + Math.random() * 100; // no music where there is no light

    // things heard in the distance; in the dark they are rare, and the quiet is most of what there is
    this.evT -= dt;
    if (this.evT <= 0) { this.evT = (9 + Math.random() * 16) * (1 + 1.6 * dark); this.event(mix, dark); }

    // a pulse in the ears as composure goes: soft, in the low mids, never a thump
    if (dread > 0.3) {
      this.beatT -= dt;
      if (this.beatT <= 0) {
        this.beatT = 1.05 - 0.55 * dread;
        this.tone(96, 0.14, 0.11 * dread, 0, 68);
        this.tone(88, 0.16, 0.08 * dread, 0, 62, 'sine', 0.17);
      }
    }
  }
}
