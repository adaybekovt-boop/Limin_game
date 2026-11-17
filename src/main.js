import * as THREE from 'three';
import { Generator, CS, WL, HALL, WET, VOID, TOP, BOT, SG, NEED } from './gen.js';
import { Mats } from './materials.js';
import { World } from './world.js';
import { Sky } from './sky.js';
import { Post } from './post.js';
import { Player, WALK, SWIM, FLY } from './player.js';
import { Creatures } from './creatures.js';
import { Sound } from './audio.js';
import { ITEMS, itemGeometry } from './items.js';
import { CAMERA } from './camera.js';
import { iconTag, itemIcon } from './icons.js';
import { makeFace, drawFace, drawEye } from './scares.js';
import { RADIO } from './gen.js';
import { settings, buildSettingsUI } from './settings.js';

THREE.ColorManagement.enabled = false;

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
// Progress is written to the browser's storage every few seconds, so a reload, a crashed tab or a lost
// graphics device puts you back where you were, not at the start.
const SAVE = 'limen.save.v1';
let saved = null;
try { saved = JSON.parse(localStorage.getItem(SAVE) || 'null'); } catch (e) { saved = null; }
if (saved && params.has('seed') && (parseInt(params.get('seed'), 10) >>> 0) !== saved.seed) saved = null;
const seed = params.has('seed') ? parseInt(params.get('seed'), 10) >>> 0 : saved ? saved.seed : (Math.random() * 4294967296) >>> 0;

const canvas = $('c');
// WebGPU when the browser has it, WebGL 2 otherwise; the TSL materials compile for either.
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
await renderer.init();
const backend = renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2';
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(59, 1, 0.07, 2200);
camera.rotation.order = 'YXZ';
scene.add(camera);

const gen = new Generator(seed);
const mats = new Mats(seed);
const world = new World(scene, gen, mats);
const sound = new Sound();
const player = new Player(world, camera, sound);
const creatures = new Creatures(scene, world, gen, mats, sound);
const sky = new Sky(scene, seed, mats.G.sunDir.value);
const post = new Post(renderer);

// New chunks get their GPU pipelines compiled asynchronously before they join the scene (no compile stalls).
world.prepare = obj => renderer.compileAsync(obj, camera, scene);
if (saved) gen.setDim(saved.dim);
player.place(gen.spawnX, gen.spawnZ, 0);
if (saved) {
  world.taken = new Set(saved.taken);
  world.ensure(saved.x, saved.z, 1);
  player.place(saved.x, saved.z, saved.yaw);
  player.y = saved.y; player.composure = Math.max(40, saved.composure); player.battery = saved.battery;
} else world.ensure(player.x, player.z, 1);

// ---- the story, on eight tapes, played in order whichever cassette you find ----
// how many of each the thresholds ask for
const NEEDS = { key: 4, pearl: 3, shard: 3 };
// the pump computer's code and the radio's station: fixed for a world, different in every world
const CODE = String(1000 + (seed % 9000));
const STATION = 88.4 + ((seed >>> 7) % 190) / 10;
const NUM = ['none', 'one', 'two', 'three', 'four', 'five', 'six'];
const PARTS = ['grease', 'gaskets', 'wax', 'oilskin'];
const TAPES = [
  'tape one. if you are hearing this you came through the same wall i did. i was a surveyor. i have been measuring this place. it does not hold still to be measured. take the shotgun. you will want it.',
  'tape two. the lit floors go on in every direction, but they are arranged. chairs gather in rings; in the middle of a ring there is always a key. i do not know who leaves them. four of them unlock the way down.',
  'tape three. the way down is a hatch with a wheel on it, and the water underneath pushes back. the pump computer in the offices can vent it. i wrote the code on a page and left it in my camp, and another in the ward. the water will drown the shotgun too: grease the action and seal the breech before you go.',
  'tape four. the things that live here are residents. we are the visitors. two barrels will put one down. another comes to stand where it stood. count your shells.',
  'tape five. under the water the classrooms kept their desks, and something keeps a pearl on the teacher\'s desk. three pearls and the black doors will know you, but the black doors have no power. there are fuses in the projection booths. wax the shells and wrap the gun in oilskin, or it will only click.',
  'tape six. where there is no light at all, the hum stops too. keep the torch on, or strike a flare. i lit one and counted what stood at the edge of it. i stopped counting.',
  'tape seven. past the black doors is the outside. it is not sky. everything out there is arranged around a point, the way filings sit round a magnet. the lanterns lead in. go to the point. bring back three splinters.',
  'tape eight. the white door on the lit floors only opens for someone it has heard of. i left a radio by a wooden door out there and i am talking into the other end of it. find the station. i am on the other side. i can hear my own kitchen.',
];

// ---- state ------------------------------------------------------------------
const keys = new Set();
const input = { f: 0, s: 0, up: false, down: false, crouch: false, sprint: false, jump: false, dx: 0, dy: 0 };
const mix = { hall: 1, water: 0, void: 0 };
const fog = new THREE.Color(0.02, 0.02, 0.018);
const camDir = new THREE.Vector3();
const scratch = { realm: 0, floor: 0, ceil: 0, solid: 0, R: null };
const inv = { key: 0, pearl: 0, shard: 0, medkit: 0, flare: 0, shells: 0, loaded: 0, shotgun: false, tapes: 0, grease: 0, gaskets: 0, wax: 0, oilskin: 0, memo: 0, fuse: 0, vented: 0, powered: 0, tuned: 0, camScare: 0 };
if (saved) {
  Object.assign(inv, saved.inv);
  if (inv.freezer) { inv.shotgun = true; inv.loaded = 2; inv.shells += inv.charges || 0; } // a save from before the shotgun
  delete inv.freezer; delete inv.charges;
}
let started = false, running = false, locked = false, ended = false, ready = false, hover = false, lockFails = 0;
let mouseX = 0.5, mouseIn = false;
let time = 0, last = performance.now(), pxScale = 1;
let radius = 2, probeT = 0, objT = 0;
let labelKey = -1, labelT = 0, noteT = 0, hintT = 0, tapeT = 0;
let blackout = 0, fade = 1, displaced = 0, flashAmt = 0, threat = 0, darkAmt = 0, found = 0;
let cine = null, introPlayed = !!saved;
const storySeen = new Set(saved && saved.stories ? saved.stories : []);
let transit = null, portal = null, fireT = 0, beamT = 0, flashT = 0, kick = 0, reloadT = 0;
let goal = { text: '', target: null };
const visited = new Set();
const hinted = { swim: false, fly: false, dark: false };
const flares = [];

function resize() {
  const w = window.innerWidth, h = window.innerHeight, pr = Math.min(window.devicePixelRatio || 1, 1.5);
  if (w < 2 || h < 2) return; // a window folded away to nothing: keep the last size
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  player.view.fit(w / h);
  post.resize(Math.floor(w * pr), Math.floor(h * pr));
  pxScale = h / 900;
}
window.addEventListener('resize', resize);
resize();

// ---- things held in the hand and left on the ground ----------------------------
const GUN_S = 0.92;
const gun = new THREE.Mesh(itemGeometry('shotgun', GUN_S, 0.5), mats.glow);
gun.rotation.order = 'YXZ';
gun.position.set(0.2, -0.2, -0.5); gun.rotation.y = Math.PI + 0.05; gun.visible = inv.shotgun;
camera.add(gun);
// the flash at the muzzles: a few bright blocks for a frame or two
const beamMat = mats.make({ map: mats.white, glow: 1, ambient: [2.6, 1.7, 0.6], bare: true });
const beam = new THREE.Group();
for (const [x, y, z, s] of [[0, 0, 0.06, 0.09], [0.03, 0.02, 0.15, 0.06], [-0.03, -0.01, 0.13, 0.05], [0, 0.03, 0.22, 0.035]]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s * 1.6), beamMat);
  m.position.set(x, y, z); m.rotation.z = x * 20 + z * 9; m.frustumCulled = false;
  beam.add(m);
}
beam.position.set(0, 0.03 * GUN_S, 0.41 * GUN_S); beam.visible = false;
gun.add(beam);
const PL = mats.G.uPL.value, PLc = mats.G.uPLc.value;

// ---- hud ----------------------------------------------------------------------
const NAMES = ['the lit floors', 'the unlit floors', 'the drowned floors', 'the unlit water', 'the outside', 'the outside'];
function label(text) { $('label').textContent = text; $('label').style.opacity = 1; labelT = 4.5; }
function note(text) { $('note').textContent = text; $('note').style.opacity = 1; noteT = 5; }
function hint(text) { $('hint').textContent = text; $('hint').style.opacity = 1; hintT = 9; }
function tape(text) { $('tape').textContent = text; $('tape').style.opacity = 1; tapeT = 6 + text.length * 0.07; }
creatures.onNote = name => note('resident: ' + name);

function showGear() {
  const tok = (n, type, name) => `<span class="${n >= NEEDS[type] ? 'done' : ''}">${iconTag(type, 22)}<b>${Math.min(n, NEEDS[type])}/${NEEDS[type]}</b> ${name}</span>`;
  $('inv').innerHTML = tok(inv.key, 'key', 'keys') + tok(inv.pearl, 'pearl', 'pearls') + tok(inv.shard, 'shard', 'splinters');
  const g = [];
  if (inv.shotgun) g.push(`<span>${iconTag(gunVariant(), 30)}${soaked() ? '<em class="wet">soaked</em>' : sealed() ? '<em class="wet">sealed</em>' : ''}<em>${reloadT > 0 ? 'reloading' : '▮'.repeat(inv.loaded) + '▯'.repeat(2 - inv.loaded)}</em>${iconTag('shells', 30)}<em>× ${inv.shells}</em><kbd>LMB</kbd></span>`);
  if (inv.medkit) g.push(`<span>${iconTag('medkit', 32)}<em>× ${inv.medkit}</em><kbd>Q</kbd></span>`);
  if (inv.flare) g.push(`<span>${iconTag('flare', 32)}<em>× ${inv.flare}</em><kbd>G</kbd></span>`);
  if (!sealed() && (PARTS.some(p => inv[p]) || gen.dim === 1)) g.push(`<span class="kit"><em>seal kit</em>${PARTS.map(p => iconTag(p, 24, inv[p] ? 'have' : '')).join('')}</span>`);
  if (inv.memo && !inv.vented) g.push(`<span>${iconTag('memo', 28)}<em>code ${CODE}</em></span>`);
  if (inv.fuse) g.push(`<span>${iconTag('fuse', 28)}<em>a fuse</em></span>`);
  if (inv.tapes) g.push(`<span>${iconTag('cassette', 28)}<em>${inv.tapes}/${TAPES.length} tapes</em></span>`);
  $('gear').innerHTML = g.join('');
  $('gearBox').style.display = g.length ? 'block' : 'none';
}

// ---- menu and settings ----------------------------------------------------------
function panel(id) { for (const p of ['pMain', 'pSettings', 'pControls']) $(p).hidden = p !== id; }
function applySettings() {
  sound.setVolumes({ master: settings.master, ambience: settings.ambience, effects: settings.effects, music: settings.music, bass: settings.bass });
  CAMERA.degPerCount = 0.175 * settings.sens;
  CAMERA.hfov = settings.fov;
  player.view.shakeScale = settings.shake;
  player.view.fit(window.innerWidth / window.innerHeight);
  post.U.gain.value = settings.brightness;
  post.U.fx.value = settings.fx;
  $('rec').style.display = settings.fx > 0.05 ? 'block' : 'none';
}
const settingsUI = buildSettingsUI($('settingsGrid'), applySettings);
applySettings();
$('bSettings').addEventListener('click', () => { sound.init(); sound.ui(); panel('pSettings'); });
$('bControls').addEventListener('click', () => { sound.init(); sound.ui(); panel('pControls'); });
$('bReset').addEventListener('click', () => { sound.ui(); settingsUI.reset(); });
for (const el of document.querySelectorAll('[data-back]')) el.addEventListener('click', () => { sound.ui(); panel('pMain'); });

world.onCollect = it => {
  const def = ITEMS[it.type];
  found++;
  sound.chime();
  switch (it.type) {
    case 'key': case 'pearl': case 'shard':
      inv[it.type]++;
      note(`found ${def.label}. ${inv[it.type] >= NEEDS[it.type] ? 'that is enough of them.' : inv[it.type] + ' of ' + NEEDS[it.type] + '.'}`);
      break;
    case 'cassette':
      if (inv.tapes < TAPES.length) tape(TAPES[inv.tapes++]); else note('a cassette. it is blank.');
      break;
    case 'medkit': inv.medkit++; note('found a first-aid kit. Q to use it.'); break;
    case 'flare': inv.flare += 2; note('found two flares. G to strike one.'); break;
    case 'shotgun':
      if (inv.shotgun) { inv.shells += 2; note('another shotgun. you take the two shells out of it.'); break; }
      inv.shotgun = true; inv.loaded = 2; inv.shells += 4; gun.visible = true;
      note('found a shotgun. both barrels are loaded.'); hint('left mouse button: fire · R: reload. two barrels put a resident down.');
      break;
    case 'memo':
      inv.memo = 1;
      tape(`a page in the surveyor's hand: "pump computer, offices: ${CODE}. vents the hatch. type it quickly. it watches the corridor while you type."`);
      break;
    case 'fuse':
      if (inv.fuse || inv.powered) { inv.shells += 2; note('another fuse. you only need the one. there are two shells in the box with it.'); break; }
      inv.fuse = 1; note('found a fuse. the black doors have a box beside them with nothing in it.');
      break;
    case 'grease': case 'gaskets': case 'wax': case 'oilskin':
      if (inv[it.type]) { inv.shells += 2; note(`another ${def.label.replace(/^an? /, '')}. you have one. there are two shells tucked in with it.`); break; }
      inv[it.type] = 1;
      if (sealed()) { gunWet = 0; note('you have all of it. grease in the action, rubber round the breech, wax over every shell, oilskin over the lot. it will fire under water now.'); sound.reload(); }
      else note(`found ${def.label}. ${PARTS.filter(p => inv[p]).length} of 4 things to keep the shotgun dry.`);
      break;
    case 'shells': inv.shells += 4; note('found four shells.'); if (inv.shotgun && inv.loaded === 0) reload(); break;
    case 'battery': player.battery = Math.min(100, player.battery + 60); note('found a torch cell. the torch brightens.'); break;
    default: player.stamina = 100; player.tired = false; player.freeRun = 25; note('found a can, still cold. you could run for a while.');
  }
  showGear();
  objT = 0;
  saveGame();
};

let errors = 0, saveT = 0;
// Being noticed: a jolt of the camera, a tear across the picture, a sound. Not more than once every few seconds,
// so it stays a shock and does not turn into noise.
let jolt = 0, glitch = 0, alertT = 0;
creatures.onAlert = (c, k) => {
  if (alertT > 0) return;
  alertT = 3.5; jolt = Math.min(1.3, jolt + k); glitch = Math.min(1, glitch + k * 0.8);
  sound.notice(k);
};
function saveGame() {
  if (!started || ended) return;
  try {
    localStorage.setItem(SAVE, JSON.stringify({
      seed, dim: gen.dim, x: player.x, y: player.y, z: player.z, yaw: player.yaw, inv, taken: [...world.taken],
      composure: player.composure, battery: player.battery, time, found, displaced, stories: [...storySeen],
    }));
  } catch (e) { /* storage full or unavailable: play on without saving */ }
}
$('bNew').hidden = !saved;
$('bNew').addEventListener('click', () => { try { localStorage.removeItem(SAVE); } catch (e) { /* nothing to clear */ } started = false; location.href = location.pathname; });
// if the graphics device is lost (driver reset, out of memory), keep the progress and start the page again
renderer.onDeviceLost = () => { saveGame(); started = false; setTimeout(() => location.reload(), 400); };

function showOverlay(paused) {
  $('overlay').style.display = 'flex';
  document.body.classList.remove('play');
  panel('pMain');
  $('bPlay').textContent = !ready ? 'preparing' : paused || saved ? 'continue' : 'enter';
  $('bPlay').disabled = !ready;
  $('lockNote').textContent = lockFails && !hover ? 'the browser did not capture the mouse — press the button once more'
    : hover ? 'mouse capture is unavailable here — fullscreen (F11) keeps the pointer inside the game' : '';
  $('stats').textContent = paused
    ? `seed ${seed} · ${Math.round(player.dist)} m walked · ${visited.size} districts · ${found} things found · ${inv.tapes}/${TAPES.length} tapes · ${creatures.seen.size} residents met · displaced ${displaced} times`
    : `seed ${seed} · ${backend}`;
}
function begin() {
  sound.init(); sound.menu(false);
  started = true; running = true;
  $('overlay').style.display = 'none'; $('end').style.display = 'none';
  document.body.classList.add('play');
  if (!introPlayed) { introPlayed = true; startCine('intro'); }
  else if (hintT <= 0 && time < 1) hint('WASD move · SHIFT run · CTRL crouch · F torch · E use · ESC pause');
  showGear();
}
function pause() { if (!started) return; $('scare').style.display = 'none'; closeUI(); running = false; keys.clear(); saveGame(); showOverlay(true); sound.menu(true); }
// the menu has its own music; a browser only lets sound start once the page has been clicked or a key pressed
function wake() { if (running || sound.menuOn) return; sound.init(); sound.menu(true); }
window.addEventListener('pointerdown', wake);
window.addEventListener('keydown', wake);

// ---- input --------------------------------------------------------------------
// As in the reference build: the mouse is captured (pointer lock) and read as raw counts, the game runs
// only while it is captured, and Esc releases it and pauses. F11 fullscreen is recommended, not required.
// Where the browser refuses to capture the mouse twice in a row, the game still starts: the hidden cursor
// turns the view, and holding it at the left or right edge of the window keeps turning.
function lockFail() {
  lockFails++;
  if (lockFails >= 2 && !running) { hover = true; begin(); } else if (!running) showOverlay(started);
}
function requestLock() {
  if (!ready || locked) return;
  try {
    const p = canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(e => {
      // NotSupportedError: no raw input here, take the ordinary pointer; anything else (e.g. right after Esc) needs another click
      if (e && e.name === 'NotSupportedError') { try { const q = canvas.requestPointerLock(); if (q && q.catch) q.catch(lockFail); } catch (e2) { lockFail(); } }
      else lockFail();
    });
  } catch (e) { lockFail(); }
}
function enter() {
  if (!ready) return;
  sound.init();
  // fullscreen first: there the pointer has nowhere else to go, and the browser hands Ctrl+W to the game
  if (settings.fullscreen && !document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().then(() => { if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock().catch(() => {}); }).catch(() => {});
  }
  if (hover) begin(); else requestLock();
}
$('bPlay').addEventListener('click', enter);
$('end').addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') $('end').classList.add('all'); });
$('bKeep').addEventListener('click', () => { sound.ui(); enter(); });
$('bAgain').addEventListener('click', () => { try { localStorage.removeItem(SAVE); } catch (e) { /* nothing to clear */ } started = false; location.href = location.pathname; });
canvas.addEventListener('click', () => { if (!locked && !hover) requestLock(); });
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (locked) { lockFails = 0; hover = false; begin(); } else if (running && !hover) pause();
});
document.addEventListener('pointerlockerror', lockFail);
// A held key is only forgotten on its keyup. If that keyup goes elsewhere, Shift and Ctrl can be re-read from any event.
function healModifiers(e) {
  if (!e.shiftKey) { keys.delete('ShiftLeft'); keys.delete('ShiftRight'); }
  if (!e.ctrlKey) { keys.delete('ControlLeft'); keys.delete('ControlRight'); }
}
window.addEventListener('mousedown', e => {
  if (!running) return;
  if (hover && !locked) requestLock(); // keep trying to capture the pointer
  if (e.button === 0) fire();
});
window.addEventListener('mousemove', e => {
  healModifiers(e);
  if (!running || !(locked || hover)) return;
  input.dx += e.movementX; input.dy += e.movementY;
  mouseX = e.clientX / window.innerWidth; mouseIn = true;
});
document.addEventListener('mouseleave', e => {
  // not captured and the pointer has left the window: keep turning the way it went, and say how to get it back
  if (running && hover) {
    mouseIn = true;
    mouseX = e.clientX <= 2 ? 0 : e.clientX >= window.innerWidth - 2 ? 1 : mouseX;
    hint('the pointer left the window — click the game, or press F11 for fullscreen');
  } else mouseIn = false;
});
document.addEventListener('visibilitychange', () => keys.clear());
window.addEventListener('contextmenu', e => { if (running) e.preventDefault(); });
window.addEventListener('keydown', e => {
  if (!e.code.startsWith('Shift') && !e.code.startsWith('Control')) healModifiers(e);
  // Ctrl is crouch, so keep the browser's Ctrl shortcuts (save, bookmark, find...) from firing mid-step
  if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow') || (running && e.ctrlKey)) e.preventDefault();
  if (e.repeat) return;
  if (ui && running && e.code !== 'Escape') { e.preventDefault(); uiKey(e); return; }
  if (e.code === 'KeyM') sound.setMuted(!sound.muted);
  if (running && (cine || transit) && (e.code === 'Space' || e.code === 'Enter')) skipCine();
  if (e.code === 'Escape') { // Esc pauses (the browser also lets go of the mouse on Esc, which pauses by itself); in the menu it goes back
    if (running) { if (locked) document.exitPointerLock(); else pause(); } else if ($('pMain').hidden) { sound.ui(); panel('pMain'); }
  } else if (e.code === 'KeyP') {
    if (running) { if (locked) document.exitPointerLock(); else pause(); } else if (!ended) enter();
  }
  if (!running) return;
  if (e.code === 'KeyR') reload();
  keys.add(e.code);
  if (e.code === 'KeyF') player.flash = !player.flash;
  if (e.code === 'Space') input.jump = true;
  if (e.code === 'KeyE') { if (inter) inter.act(); else usePortal(); }
  if (e.code === 'KeyQ') useMedkit();
  if (e.code === 'KeyG') strikeFlare();
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); if (running && hover) pause(); });
// Ctrl+W cannot be blocked in a normal tab; at least ask before the game is thrown away
window.addEventListener('beforeunload', e => { saveGame(); if (running && time > 20) { e.preventDefault(); e.returnValue = ''; } });

// ---- using things ---------------------------------------------------------------
function useMedkit() {
  if (!inv.medkit) return;
  if (player.composure >= 99) { note('you are steady enough.'); return; }
  inv.medkit--; player.composure = Math.min(100, player.composure + 55); player.hurtT = 0;
  sound.heal(); note('you use a first-aid kit.'); showGear();
}

function strikeFlare() {
  if (!inv.flare) return;
  if (flares.length >= 3) { const old = flares.shift(); scene.remove(old.mesh); }
  inv.flare--;
  const mesh = new THREE.Mesh(itemGeometry('flare'), mats.glow);
  mesh.position.set(player.x, player.y + (player.mode === WALK ? 0.08 : 0.9), player.z);
  mesh.rotation.z = 1.4;
  scene.add(mesh);
  flares.push({ mesh, t: 50 });
  sound.strike(); note('you strike a flare and leave it.'); showGear();
}

// break it open and put in what there is: about a second and a half with nothing in the barrels
function reload() {
  if (!inv.shotgun || reloadT > 0 || inv.loaded >= 2 || transit || cine || blackout) return;
  if (inv.shells <= 0) { note('no shells left.'); return; }
  reloadT = 1.5; sound.reload(); showGear();
}
const RANGE = 24;
function fire() {
  if (!inv.shotgun || fireT > 0 || reloadT > 0 || transit || cine || blackout) return;
  if (inv.loaded <= 0) {
    if (inv.shells > 0) reload(); else { sound.click(); note('both barrels are empty, and there are no shells.'); fireT = 0.4; }
    return;
  }
  if (soaked()) {
    sound.misfire(); fireT = 0.5; kick = 0.25;
    note(['the shotgun only clicks. the shells are soaked.', 'click. water runs out of the breech.', 'nothing. it is full of water.'][Math.floor(Math.random() * 3)]);
    return;
  }
  inv.loaded--; fireT = 0.38; kick = 1;
  const o = camera.position, d = camDir;
  // shot spreads: anything within a hand's breadth of the line is hit, wider the further it has gone
  const hit = creatures.rayHit(o.x, o.y, o.z, d.x, d.y, d.z, RANGE, 0.28);
  const wall = world.rayStatic(o.x, o.y, o.z, d.x, d.y, d.z, hit ? hit.t + 0.6 : RANGE);
  if (hit && hit.t <= wall + 0.3) {
    const r = creatures.shot(hit.c, d.x, d.y, d.z);
    sound.thud();
    note(r === 'down' ? 'it goes down.' : r === 'flinch' ? 'it hardly notices.' : 'it reels.');
  }
  beam.visible = true; beamT = 0.06; beam.rotation.z = Math.random() * 6.28;
  PL[3].set(o.x + d.x * 1.1, o.y + d.y * 1.1 - 0.1, o.z + d.z * 1.1, 0); flashT = 0.16;
  jolt = Math.min(1.3, jolt + 0.55); glitch = Math.min(1, glitch + 0.25);
  sound.blast(); showGear();
  if (inv.loaded === 0 && inv.shells > 0) fireT = 0.55; // then it reloads by itself (see simulate)
}

// ---- ways through ---------------------------------------------------------------
function portalNear() {
  const S = gen.site(Math.floor(Math.floor(player.x / CS) / SG), Math.floor(Math.floor(player.z / CS) / SG));
  if (S.kind === 'none' || (S.to < 0 && S.kind !== 'exit')) return null;
  if (Math.hypot(S.px - player.x, S.pz - player.z) > 2.6) return null;
  if (gen.dim === 2 && Math.abs(player.y - 0.5) > 3) return null;
  return S;
}
function portalText(S) {
  if (S.kind === 'exit') return inv.shard < NEEDS.shard ? `the white door has no handle, only three hollows. it wants splinters of starlight (${inv.shard}/${NEEDS.shard}).`
    : !inv.tuned ? 'the white door does not know you are coming. somebody out in the outside has to tell it.' : 'E — open the white door';
  if (S.to === 1) return inv.key < NEEDS.key ? `the wheel is chained with four padlocks. it wants brass keys (${inv.key}/${NEEDS.key}).`
    : !inv.vented ? 'the padlocks open, but the wheel will not turn: the water under it is pushing back. the pump computer can vent it.' : 'E — turn the wheel and go down';
  if (S.to === 2) return inv.pearl < NEEDS.pearl ? `the black door does not know you. it wants pearls (${inv.pearl}/${NEEDS.pearl}).`
    : !inv.powered ? 'the black door is dead. the fuse box beside it is empty.' : 'E — go through the black door';
  return 'E — go through, back to the lit floors';
}
function usePortal() {
  const S = portal;
  if (!S || transit || cine || blackout) return;
  if (S.kind === 'exit') {
    if (inv.shard < NEEDS.shard || !inv.tuned) { note('it does not open.'); return; }
    startCine('end');
    return;
  }
  if ((S.to === 1 && (inv.key < NEEDS.key || !inv.vented)) || (S.to === 2 && (inv.pearl < NEEDS.pearl || !inv.powered))) { note('it does not open.'); return; }
  transit = { kind: 'portal', t: 0, to: S.to, si: S.si, sj: S.sj, arrived: false };
  bars(true);
  if (S.to === 1) sound.descend(); else sound.door();
}

// ---- scenes -------------------------------------------------------------------
// Waking up at the start, the passage between the floors, and the way out. While one plays the game
// still runs underneath; the scene only takes the camera, the controls and the fade.
const ease = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (t, a, b) => ease((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;
const shotEul = new THREE.Euler(0, 0, 0, 'YXZ');
let fovAdd = 0, capKey = '';
function bars(on) { document.body.classList.toggle('cine', on); }
function caption(head, text) {
  const k = head + '|' + text;
  if (k === capKey) return;
  capKey = k;
  if (text || head) { $('capH').textContent = head; $('capT').textContent = text; }
  $('cap').style.opacity = text || head ? 1 : 0;
}
// the camera, moved from where the player's eyes are: down, pitched, rolled, pushed forward, wider
function shot(dy, pitch, roll, fwd, fov) {
  const v = player.view;
  camera.quaternion.setFromEuler(shotEul.set(v.pitch + pitch, v.yaw, roll, 'YXZ'));
  camera.position.y += dy;
  camera.position.x -= Math.sin(v.yaw) * fwd; camera.position.z -= Math.cos(v.yaw) * fwd;
  if (Math.abs(fov - fovAdd) > 0.01) { fovAdd = fov; player.view.fit(window.innerWidth / window.innerHeight); camera.fov += fov; camera.updateProjectionMatrix(); }
}
const fadeCol = post.U.fadeCol.value;
const CHAPTER = [
  ['i · the lit floors', 'light behind a door. carpet. the hum. it is the same building. it is always the same building.'],
  ['ii · the drowned floors', 'you climb down. the ladder goes on for longer than the building is tall. at the bottom the water is warm, and you find you do not need to breathe.'],
  ['iii · the outside', 'the door opens onto nothing at all. you step out anyway. there is no wind and no down, and the stars are much too close.'],
];
const INTRO = 11.2, OUT = 2.4, HOLD = 4.2, IN = 2.4, END = 3.4;
function startCine(kind) {
  cine = { kind, t: 0, cue: 0 };
  bars(true);
  if (kind === 'intro') { fade = 1; fadeCol.setRGB(0, 0, 0); sound.wake(); }
  if (kind === 'end') { sound.door(); sound.ending(); }
}
function endCine() {
  cine = null; bars(false); caption('', ''); shot(0, 0, 0, 0, 0);
}
function skipCine() {
  if (transit) {
    if (!transit.arrived) { arrive(transit.to, transit.si, transit.sj); transit.arrived = true; }
    transit.t = Math.max(transit.t, OUT + HOLD + IN - 0.5);
    return;
  }
  if (cine && cine.kind === 'intro') cine.t = Math.max(cine.t, INTRO - 0.4);
  else if (cine && cine.kind === 'end') cine.t = END;
}
function runCine(dt) {
  if (transit) return runPortal(transit, dt);
  const c = cine, t = (c.t += dt);
  if (c.kind === 'intro') {
    // eyes open, twice; on the floor, on your side; up onto your knees; up
    let f = 1;
    if (t >= 2.2) f = 1 - 0.75 * seg(t, 2.2, 2.6);
    if (t >= 2.6) f = 0.25 + 0.7 * seg(t, 2.6, 2.85);
    if (t >= 2.85) f = 0.95 * (1 - seg(t, 2.85, 3.7));
    fade = f; fadeCol.setRGB(0, 0, 0);
    const lie = 1 - seg(t, 5.6, 7.4), kneel = 1 - seg(t, 8.4, 10.6);
    const eyeY = lerp(lerp(0.2, 0.86, 1 - lie), player.eye, 1 - kneel);
    const breathe = Math.sin(t * 2.3) * 0.022 * kneel;
    const roll = 1.32 * lie * (1 - 0.2 * seg(t, 3.7, 5.6)) + Math.sin(t * 1.7) * 0.05 * (1 - lie) * kneel + Math.sin(t * 3.1) * 0.04 * seg(t, 8.4, 9.4) * kneel;
    const pitch = kneel * lerp(-0.12, -0.85 + 0.12 * Math.sin(t * 0.9), 1 - lie);
    shot(eyeY - player.eye + breathe, pitch, roll, 0, 0);
    if (t < 3.4) caption('january 1996', 'you leaned against the wall at the end of the office corridor. the wall was not there.');
    else if (t < 4.0) caption('', '');
    else if (t < 7.6) caption('', 'the floor is damp. the lights hum a note you have never heard. your camera is still recording.');
    else caption('', '');
    if (c.cue === 0 && t > 5.6) { c.cue = 1; sound.rustle(); }
    if (c.cue === 1 && t > 8.4) { c.cue = 2; sound.rustle(); sound.step('carpet', 0.4); }
    if (c.cue === 2 && t > 10.0) { c.cue = 3; sound.step('carpet', 0.5); }
    if (t >= INTRO) { endCine(); fade = 0; hint('WASD move · SHIFT run · CTRL crouch · F torch · E use · ESC pause'); labelKey = -1; }
    return;
  }
  // the way out: walk to the door as the light comes through it, then the last page
  fadeCol.setRGB(1, 0.99, 0.95);
  fade = seg(t, 1.0, END);
  shot(Math.sin(t * 6) * 0.015, -0.05 * seg(t, 0, 1), 0, 1.9 * seg(t, 0, END), -12 * seg(t, 0.5, END));
  if (t < 1.6) caption('', 'the three splinters go into the three hollows. something on the other side turns.');
  else caption('', '');
  if (t >= END) { endCine(); finish(); }
}
function runPortal(c, dt) {
  const t = (c.t += dt), to = c.to;
  const COL = [[1, 0.93, 0.78], [0, 0.02, 0.04], [0.62, 0.55, 1.0]][to];
  if (t < OUT) {
    fadeCol.setRGB(...COL);
    if (to === 1) { fade = seg(t, 1.1, OUT); shot(-1.8 * Math.pow(seg(t, 0.9, OUT), 2), -1.25 * seg(t, 0, 0.9), 0, 0, 0); }
    else if (to === 2) { fade = seg(t, 1.0, OUT); shot(0, 0.05 * seg(t, 0, OUT), 0.25 * seg(t, 1, OUT), 1.6 * seg(t, 0, OUT), 34 * seg(t, 0.5, OUT)); }
    else { fade = seg(t, 0.9, OUT); shot(0, 0, 0, 1.3 * seg(t, 0, OUT), 0); }
    return;
  }
  if (t < OUT + HOLD) {
    if (!c.arrived) { arrive(c.to, c.si, c.sj); c.arrived = true; sound.chapter(to); }
    fade = 1;
    const k = seg(t, OUT, OUT + 0.9);
    fadeCol.setRGB(lerp(COL[0], 0, k), lerp(COL[1], 0, k), lerp(COL[2], 0, k));
    caption(t < OUT + HOLD - 0.7 ? CHAPTER[to][0] : '', t < OUT + HOLD - 0.7 ? CHAPTER[to][1] : '');
    shot(to === 1 ? -0.6 : 0, to === 1 ? 1.0 : 0, to === 2 ? 0.8 : 0, 0, to === 2 ? 34 : 0);
    return;
  }
  const k = seg(t, OUT + HOLD, OUT + HOLD + IN);
  fadeCol.setRGB(0, 0, 0); fade = 1 - k;
  if (to === 1) shot(-0.6 * (1 - k), 1.0 * (1 - k), 0, 0, 0);
  else if (to === 2) shot(0, 0, 0.8 * (1 - k), 0, 34 * (1 - k));
  else shot(0, -0.35 * (1 - k), 0.05 * Math.sin(t * 3) * (1 - k), 0, 0);
  caption('', '');
  if (t >= OUT + HOLD + IN) { transit = null; bars(false); fade = 0; shot(0, 0, 0, 0, 0); labelKey = -1; }
}
function finish() {
  ended = true; running = false;
  document.body.classList.remove('play');
  if (locked) document.exitPointerLock();
  const ts = Math.floor(time), two = v => String(v).padStart(2, '0');
  $('endStats').innerHTML = `recorded ${two(Math.floor(ts / 3600))}:${two(Math.floor(ts / 60) % 60)}:${two(ts % 60)} · ${(player.dist / 1000).toFixed(1)} km walked · ${visited.size} districts · ${found} things found · ${inv.tapes}/${TAPES.length} tapes · displaced ${displaced} times`;
  const met = [];
  for (const sp of creatures.species.values()) if (sp.seen) met.push(sp.name);
  $('endMet').textContent = met.length ? 'residents met: ' + met.join(' · ') : 'you met none of the residents. they met you.';
  const end = $('end');
  end.classList.remove('all'); end.style.display = 'none'; void end.offsetWidth; end.style.display = 'flex';
  fade = 0; fadeCol.setRGB(0, 0, 0);
  setTimeout(() => sound.menu(true), 9000);
  try { localStorage.removeItem(SAVE); } catch (e) { /* nothing to clear */ }
}

// ---- rooms that tell you something the first time you walk in ----------------------
const STORY = {
  cinema: 'a cinema. the screen is lit and showing nothing. every seat faces it, except one, which faces the way you came in.',
  playground: 'a playground, under a ceiling. one of the swings stopped at the top of its arc and has stayed there.',
  classroom: 'a classroom, flooded to the desk tops. the lesson on the board has been rubbed out. the windows show a daylight that has nowhere to come from.',
  ring: 'chairs in a circle, as for a meeting. whatever they met about is in the middle.',
  storage: 'a store room, stocked carefully, by someone who expected to be here a long time.',
  ward: 'a ward. the beds are made with hospital corners. the drips are hung, and empty.',
  office: 'an office. the chair is pushed back from the desk. the plant in the corner is the only thing here still alive.',
  party: 'a birthday. ten chairs, ten paper hats, a cake nobody cut. the candle has been burning since long before you came. one chair is on its back, as if somebody left in a hurry. or was taken.',
  laundry: 'a laundrette. machine four is still running; you can hear it turning. there is nothing inside it. the folded shirts on the table are your size.',
  waiting: 'a waiting room. NOW SERVING: 0. there is a coat over one of the chairs. you know the coat. you lost it years ago.',
  nursery: 'a child\'s room, kept exactly as it was left. the night light is on. the bear is facing the wardrobe. the wardrobe is open the width of a hand.',
  chapel: 'someone built a chapel around a door that does not open. the cushions are worn where people knelt. they were not praying. they were waiting for a knock.',
  camp: 'the surveyor\'s camp. this is where the tapes were made. tally marks cover the wall, a week at a time, and stop on a wednesday. the instrument is still set up, pointed at the empty corner.',
};
const STORY_WET = {
  cinema: 'a drowned cinema. the screen still glows under the water. the seats sway, very slightly, all together.',
  playground: 'a playground at the bottom of the water. the swing that stopped at the top of its arc is still up there.',
  classroom: 'the same classroom, deeper. something keeps a pearl on the teacher\'s desk, the way you would keep an apple.',
  waiting: 'a waiting room under the water. NOW SERVING: 0. they waited until the water came up, and then they went on waiting.',
  party: 'the birthday again, drowned. the balloons are still pressed against the ceiling. the candle is still burning.',
  laundry: 'a laundrette full of water. machine four is still running.',
  chapel: 'a drowned chapel. the door at the front has light under it, even here.',
};
function roomStory() {
  if (tapeT > 0 || transit || cine) return;
  const P = gen.pieceAt(Math.floor(player.x / CS), Math.floor(player.z / CS));
  if (!P) return;
  const text = (gen.dim === 1 && STORY_WET[P.kind]) || STORY[P.kind], k = gen.dim + ':' + P.kind;
  if (!text || storySeen.has(k)) return;
  storySeen.add(k);
  tape(text);
}
function arrive(to, si, sj) {
  gen.setDim(to);
  world.reset(); creatures.clear();
  for (const f of flares) scene.remove(f.mesh);
  flares.length = 0;
  const S = gen.site(si, sj);
  const px = S.px === undefined ? player.x : S.px, pz = S.pz === undefined ? player.z : S.pz; // a site with no way through: stay over the same spot
  let x = px, z = pz + 1.8;
  world.ensure(x, z, 1);
  if (to !== 2) {
    for (const [ax, az] of [[0, 1.8], [0, -1.8], [1.8, 0], [-1.8, 0], [1.8, 1.8], [-1.8, -1.8]]) {
      const f = world.cellInfo(px + ax, pz + az, scratch).floor;
      if (!world.collides(px + ax, f + 0.03, pz + az, 0.32, 1.75)) { x = px + ax; z = pz + az; break; }
    }
  }
  player.place(x, z, Math.atan2(px - x, pz - z) + Math.PI);
  if (to === 2) player.y = 0.05;
  labelKey = -1; objT = 0; portal = null;
  saveGame();
}

// what to do next, and roughly which way it lies
function siteW(S, lu, lv) { return S.orient ? [S.i0 * CS + lv, S.j0 * CS + lu] : [S.i0 * CS + lu, S.j0 * CS + lv]; }
function objective() {
  if (ended) return { text: 'there is only further.', target: null };
  const d = gen.dim, px = player.x, pz = player.z;
  const g = inv.shard >= NEEDS.shard ? 3 : inv.pearl >= NEEDS.pearl ? 2 : inv.key >= NEEDS.key ? 1 : 0, gd = [0, 1, 2, 0][g];
  const itemGoal = (types, rooms, text) => {
    const S = gen.nearestSite(px, pz, s => rooms[s.kind] && types.some(p => siteHas(s, p)));
    const t = S && partIn(S, types);
    return { text, target: t ? [t.x, t.z, t.y] : null, icon: t ? t.type : types[0] };
  };
  const siteGoal = (test, uv, icon, text, rings) => {
    const S = gen.nearestSite(px, pz, test, rings);
    const w = S && (uv ? siteW(S, uv[0], uv[1]) : [S.px, S.pz]);
    return { text, target: w ? [w[0], w[1], d === 1 && S ? -5 : d === 2 ? 0.5 : null] : null, icon };
  };
  const tokens = (text, icon) => {
    const S = gen.nearestSite(px, pz, s => {
      if (s.kind !== 'ring' && s.kind !== 'playground' && s.kind !== 'classroom' && s.kind !== 'cinema') return false;
      gen._piece(s);
      return s.token && !world.taken.has(s.token.id);
    });
    return { text, target: S ? [S.token.x, S.token.z, S.token.y] : null, icon };
  };
  const seal = want => {
    const miss = want.filter(p => !inv[p]);
    return itemGoal(miss, PART_ROOMS, d === 0
      ? `before you go down: water will drown the shotgun. find gun grease (store rooms) and rubber seals (offices, the surveyor's camp). ${2 - miss.length}/2`
      : `the shotgun is useless wet. find wax (drowned chapels, the drowned birthday) and an oilskin (drowned laundrettes, waiting rooms). ${2 - miss.length}/2`);
  };
  if (d === 0 && g === 0) return tokens(`find four brass keys (${inv.key}/${NEEDS.key}). chairs gather in a ring around each one; one hangs in every playground.`, 'key');
  if (d === 0 && g === 1) {
    if (inv.shotgun && !(inv.grease && inv.gaskets)) return seal(['grease', 'gaskets']);
    if (!inv.vented) {
      if (!inv.memo) return itemGoal(['memo'], { camp: 1, ward: 1 }, 'the hatch is held shut by the water under it. the pump computer in the offices can vent it, but it asks for a code. the surveyor wrote it down: look in the camp, or the ward.');
      return siteGoal(s => s.kind === 'office', [4.5, 3.5], 'terminal', `vent the hatch from the pump computer in an office. the code on the page is ${CODE}.`);
    }
    return siteGoal(s => s.to === 1, null, 'hatch', 'the hatch is vented. find it and turn the wheel.');
  }
  if (d === 1 && g === 1) {
    if (inv.shotgun && !(inv.wax && inv.oilskin)) return seal(['wax', 'oilskin']);
    return tokens(`find three pearls (${inv.pearl}/${NEEDS.pearl}). drowned classrooms and cinemas keep them, and the rings of chairs below.`, 'pearl');
  }
  if (g === 2 && !inv.powered) {
    if (d === 1 && !inv.fuse) return itemGoal(['fuse'], { cinema: 1, waiting: 1 }, 'the black doors have no power. find a fuse: drowned cinemas keep spares in the projection booth, drowned waiting rooms behind the counter.');
    if (d === 1) return siteGoal(s => s.to === 2, [1.8, 5.0], 'fusebox', 'put the fuse into the empty box beside a black door.');
    if (!inv.fuse) return siteGoal(s => s.to === 1, null, 'hatch', 'the black doors are dead. the fuses are kept below the water: go down a hatch.');
  }
  if (d === 2 && g === 2) {
    const R = gen.nearestFocus(px, pz, r => !world.taken.has(gen.focusItemId(r)));
    return { text: `find three splinters of starlight (${inv.shard}/${NEEDS.shard}). everything out here faces the place they lie; the lanterns lead in.`, target: R ? [R.sx * CS, R.sz * CS, R.fy + 1.5] : null, icon: 'shard' };
  }
  if (d === 2 && g === 3 && !inv.tuned) return siteGoal(s => s.to === 0, RADIO, 'radio', 'the white door is deaf to you. somebody left a radio beside a wooden door out here: tune it until a voice comes through.');
  if (d === 0 && g === 3) return siteGoal(s => s.kind === 'exit', null, 'exit', 'take the splinters to the white door.', 9);
  if (d !== gd) return siteGoal(s => s.to === gd, null, gd === 1 ? 'hatch' : gd === 2 ? 'stardoor' : 'door', 'find ' + (gd === 1 ? 'a hatch in the floor.' : gd === 2 ? 'a black door.' : 'a wooden door with light behind it.'));
  return siteGoal(s => s.to === 2, null, 'stardoor', 'the black door has power now. go through.');
}

// ---- things you use: the pump computer, the fuse box, the radio ---------------------------
let inter = null, ui = null, scareSoon = 0;
function interactNear() {
  if (transit || cine || scare) return null;
  const S = gen.site(Math.floor(Math.floor(player.x / CS) / SG), Math.floor(Math.floor(player.z / CS) / SG));
  const near = (lu, lv, r) => { const w = siteW(S, lu, lv); return Math.hypot(w[0] - player.x, w[1] - player.z) < r; };
  if (gen.dim === 0 && S.kind === 'office' && near(4.5, 3.6, 1.5)) return { text: 'E — use the computer', act: openTerm };
  if (S.kind === 'stardoor' && !inv.powered && near(1.8, 5.0, 1.7)) return { text: inv.fuse ? 'E — put the fuse in' : 'an empty socket in the fuse box. it wants a fuse.', act: inv.fuse ? insertFuse : () => note('you have no fuse.') };
  if (gen.dim === 2 && S.kind === 'door' && Math.abs(player.y - 0.5) < 2.5 && near(RADIO[0], RADIO[1], 1.9)) return { text: 'E — tune the radio', act: openRadio };
  return null;
}
function insertFuse() {
  inv.fuse = 0; inv.powered = 1;
  sound.power(); jolt = Math.min(1.3, jolt + 0.4); glitch = Math.min(1, glitch + 0.4);
  PL[3].set(player.x, player.y + 1.5, player.z, 0); flashT = 0.3; PLc[3].set(0.6, 0.4, 1.6);
  note('the fuse goes in with a crack. behind the black door something hums awake. every black door has power now.');
  showGear(); objT = 0; saveGame();
}
// the pump computer: a menu, a log, the hatch pressure (and the code), and the camera feeds
const TERM_HEAD = 'LIMEN HYDRAULIC · PUMP CONTROL · SUBLEVEL B-7\n' + '─'.repeat(46) + '\n';
const TERM_LOG = [
  '14 NOV 1995   pressure on B-7 rising again. maintenance says the water under the floor is "the same water as before". asked what that means. no answer.',
  '02 DEC 1995   the hatch sweats. there is a sound under it like a crowd in a swimming bath.',
  '31 DEC 1995   code changed. wrote it down for the surveyor, in case i forget. i keep forgetting things here. the corridor outside is longer than it was this morning.',
  '01 JAN 1996   nobody came in today. the cameras say somebody did.',
];
function openTerm() {
  ui = { kind: 'term', screen: 'boot', input: '', wrong: 0, t: 0 };
  $('term').style.display = 'flex'; keys.clear(); sound.accept(); renderTerm();
}
function openRadio() {
  ui = { kind: 'radio', f: STATION > 98 ? 89 + Math.random() * 3 : 104 + Math.random() * 3, lock: 0, t: 0, heard: inv.tuned ? 999 : 0 };
  $('radioUI').style.display = 'flex'; keys.clear(); sound.radio(true);
}
function closeUI() {
  if (!ui) return;
  if (ui.kind === 'radio') sound.radio(false);
  $(ui.kind === 'term' ? 'term' : 'radioUI').style.display = 'none';
  if (ui.kind === 'term' && ui.cams && !inv.camScare) { inv.camScare = 1; scareSoon = 2.2; }
  ui = null; input.dx = input.dy = 0; showGear(); objT = 0;
}
function renderTerm() {
  const u = ui; let s = TERM_HEAD;
  if (u.screen === 'boot') s += 'BOOT ......... OK\nPUMPS ........ 2 OF 3\nCAMERAS ...... 3 OF 4\nOPERATOR ..... NONE\n';
  else if (u.screen === 'menu') s += '1   READ LOG\n2   HATCH PRESSURE\n3   CAMERA FEEDS\n0   LOG OFF\n\n> ';
  else if (u.screen === 'log') s += TERM_LOG.join('\n\n') + '\n\n[any key]';
  else if (u.screen === 'hatch') {
    if (inv.vented) s += 'HATCH B-7 .......... 0.0 BAR   [VENTED]\n\nthe way down is open.\n\n[any key]';
    else s += 'HATCH B-7 .......... 4.8 BAR   [SEALED]\nVENTING REQUIRES SUPERVISOR CODE\n\nCODE: ' + (u.input + '____').slice(0, 4) + (u.msg ? '\n\n' + u.msg : '') + (inv.memo ? '\n\n(the page in your pocket says ' + CODE + ')' : '');
  } else if (u.screen === 'vent') {
    const k = Math.min(1, u.t / 3), n = Math.round(k * 24);
    s += 'VENTING B-7\n\n[' + '█'.repeat(n) + '·'.repeat(24 - n) + '] ' + Math.round(k * 100) + '%\n\n' + (4.8 * (1 - k)).toFixed(1) + ' BAR';
  } else if (u.screen === 'cams') {
    s += 'CAMERA 1 · CORRIDOR 9 .......... NO SIGNAL\nCAMERA 2 · OFFICES ............. MOTION\n';
    if (u.t > 1.2) s += '   a figure at the pump computer. it is holding a shotgun.\n';
    if (u.t > 2.6) s += '   behind it, in the doorway, something tall\n   is waiting for it to turn round.\n';
    if (u.t > 3.6) s += 'CAMERA 3 · B-7 ................. WATER\nCAMERA 4 · ' + (Math.random() < 0.5 ? '▓▒░▒▓░▒' : '░▓▒░▓▒░') + '\n\n[any key]';
  }
  $('termText').textContent = s;
}
function uiKey(e) {
  const u = ui;
  if (e.code === 'KeyE' && !(u.kind === 'term' && u.screen === 'hatch' && !inv.vented && false)) { closeUI(); return; }
  if (u.kind === 'radio') { keys.add(e.code); return; }
  sound.key();
  const digit = /^Digit(\d)$/.exec(e.code) || /^Numpad(\d)$/.exec(e.code), n = digit ? digit[1] : null;
  if (u.screen === 'menu') {
    if (n === '1') u.screen = 'log'; else if (n === '2') { u.screen = 'hatch'; u.input = ''; u.msg = ''; } else if (n === '3') { u.screen = 'cams'; u.t = 0; u.cams = true; } else if (n === '0') { closeUI(); return; }
  } else if (u.screen === 'hatch' && !inv.vented) {
    if (n && u.input.length < 4) u.input += n;
    else if (e.code === 'Backspace') u.input = u.input.slice(0, -1);
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (u.input === CODE) { u.screen = 'vent'; u.t = 0; sound.accept(); sound.hiss(); }
      else {
        u.wrong++; u.input = ''; sound.deny();
        u.msg = 'ACCESS DENIED (' + u.wrong + '/3)';
        if (u.wrong >= 3) { closeUI(); startScare('face'); note('the screen goes black. something on the other side of it saw you.'); return; }
      }
    } else if (e.code === 'Escape') u.screen = 'menu';
  } else if (u.screen === 'log' || u.screen === 'hatch' || (u.screen === 'cams' && u.t > 3.6)) u.screen = 'menu';
  renderTerm();
}
function uiTick(dt) {
  const u = ui; u.t += dt;
  if (u.kind === 'term') {
    if (u.screen === 'boot' && u.t > 1.2) u.screen = 'menu';
    if (u.screen === 'vent' && u.t >= 3) { inv.vented = 1; u.screen = 'hatch'; jolt = Math.min(1.3, jolt + 0.5); note('somewhere close, a hatch lets go of its breath.'); saveGame(); renderTerm(); }
    if (u.screen === 'boot' || u.screen === 'vent' || u.screen === 'cams') renderTerm();
    return;
  }
  // the radio: A / D or the arrows, or the mouse, move the needle
  const k = c => keys.has(c);
  const dir = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
  u.f = Math.max(87.5, Math.min(108, u.f + dir * dt * (k('ShiftLeft') ? 0.6 : 2.4) + input.dx * 0.004));
  input.dx = input.dy = 0;
  const c = Math.max(0, 1 - Math.abs(u.f - STATION) / 0.6);
  sound.radioSet(c, dt);
  u.lock = c > 0.85 ? u.lock + dt : Math.max(0, u.lock - dt * 2);
  if (u.lock > 1.5 && !inv.tuned) { inv.tuned = 1; u.heard = 0; sound.chime(); saveGame(); }
  if (inv.tuned) u.heard += dt * (c > 0.6 ? 1 : 0);
  $('radFreq').textContent = 'FM ' + u.f.toFixed(1) + (c > 0.85 ? '  ◉' : '');
  $('radNeedle').style.left = ((u.f - 88) / 20) * 100 + '%';
  $('radSig').firstChild.style.width = Math.round(c * 100) + '%';
  const msg = '"... if anyone is on ' + STATION.toFixed(1) + ' ... this is the surveyor. i am on the other side of the white door. it only opens for someone who has heard this, and now you have. bring the splinters. it is morning here. come home."';
  $('radText').textContent = !inv.tuned ? (c > 0.3 ? 'a voice, under the static, too broken to follow ...' : 'static.') : c > 0.6 ? msg.slice(0, Math.min(msg.length, Math.floor(u.heard * 26))) : 'you have lost the station.';
}

// which rooms keep which of the sealing things
const PART_ROOMS = { storage: 1, office: 1, camp: 1, laundry: 1, waiting: 1, chapel: 1, party: 1 };
function siteHas(s, type) {
  gen._piece(s);
  for (const it of s.content.items.values()) if (it.type === type && !world.taken.has(it.id)) return true;
  return false;
}
function partIn(s, types) {
  for (const it of s.content.items.values()) if (types.includes(it.type) && !world.taken.has(it.id)) return it;
  return null;
}

// ---- the shotgun and water ----------------------------------------------------------
// Down in the drowned floors the water gets into the action and the shells; it will only click until it has
// been sealed with the four things: grease and rubber seals from the lit floors, wax and an oilskin from below.
let gunWet = 0, wetShown = false, wetHinted = false;
function sealed() { return PARTS.every(p => inv[p]); }
function gunVariant() { return sealed() ? 'shotgun_sealed' : soaked() ? 'shotgun_wet' : 'shotgun'; }
function soaked() { return inv.shotgun && !sealed() && gunWet > 0.3; }
function updateWet(dt) {
  const inWater = player.info.realm === WET && player.y + 0.8 < WL;
  if (inWater) gunWet = Math.min(1, gunWet + dt * 1.5);
  else gunWet = Math.max(0, gunWet - dt / (gen.dim === 1 ? 90 : 25)); // it dries, slowly; faster away from the water
  const gv = gunVariant();
  if (gun.userData.v !== gv) { gun.userData.v = gv; gun.geometry = itemGeometry(gv, GUN_S, 0.5); }
  if (soaked() !== wetShown) {
    wetShown = soaked(); showGear();
    if (wetShown && !wetHinted) { wetHinted = true; hint('the water is in the shotgun. it will not fire wet. the seal kit: grease and seals from above, wax and an oilskin from down here.'); }
  }
}

// ---- screamers ------------------------------------------------------------------
// Rare, and never two close together: a face out of nowhere, or the lights going and coming back with
// something standing in front of you. They can be turned off in the settings.
let scare = null, scareT = 70 + Math.random() * 50, faceBase = null;
const scareC = $('scareC').getContext('2d');
const SCARE_BG = { dry: 'radial-gradient(ellipse at center, #1b1a16 0%, #000 72%)', drowned: 'radial-gradient(ellipse at center, #0b2a2c 0%, #010809 75%)', void: 'radial-gradient(ellipse at center, #140a26 0%, #000 70%)', eye: '#000' };
function startScare(kind) {
  if (scare || cine || transit || blackout || ui || !settings.screamers) return false;
  if (kind === 'figure' && gen.dim !== 0) kind = 'face';
  const look = gen.dim === 1 ? 'drowned' : gen.dim === 2 ? (Math.random() < 0.5 ? 'eye' : 'void') : 'dry';
  scare = { kind, look, t: 0, c: null, hit: false };
  if (kind === 'face') { faceBase = makeFace((Math.random() * 4294967296) >>> 0, look); $('scare').style.background = SCARE_BG[look]; }
  else sound.lightsOut();
  return true;
}
function scareHit() {
  scare.hit = true;
  sound.scream(1, scare.look === 'drowned' ? 'water' : scare.look === 'void' || scare.look === 'eye' ? 'void' : 'dry');
  jolt = 1.3; glitch = 1; player.dread(9); player.hurtT = 0.7;
}
function runScare(dt) {
  const s = scare, t = (s.t += dt), el = $('scare');
  if (s.kind === 'face') {
    if (!s.hit) scareHit();
    const L = s.look, dur = L === 'eye' ? 0.66 : L === 'drowned' ? 0.75 : 0.62;
    if (t < dur) {
      el.style.display = 'flex';
      const k = t / dur, j = (a = 3) => (Math.random() - 0.5) * a, C = $('scareC');
      if (L === 'eye') { drawEye(scareC, t); C.style.transform = `translate(${j(1.5)}vw, ${j(1.5)}vh) scale(${1.45 + 0.15 * k})`; }
      else if (L === 'drowned') { drawFace(scareC, faceBase, t, L); C.style.transform = `translate(${j(2) + Math.sin(t * 9) * 2}vw, ${(1 - Math.min(1, k * 2.2)) * 70}vh) scale(${1.0 + 0.3 * k})`; }
      else if (L === 'void') { drawFace(scareC, faceBase, t, L); C.style.transform = `translate(${j(5)}vw, ${j(5)}vh) scale(${Math.random() < 0.15 ? 1.6 : 1.2 + 0.2 * k})`; }
      else { drawFace(scareC, faceBase, t); C.style.transform = `translate(${j()}vw, ${j()}vh) scale(${0.8 + 0.6 * k * k}) rotate(${j()}deg)`; }
    } else { el.style.display = 'none'; scare = null; }
    return;
  }
  // the lights go out; when they come back it is standing there, close; then it screams
  fadeCol.setRGB(0, 0, 0);
  if (t < 0.12) fade = Math.max(fade, t / 0.12);
  else if (t < 1.35) fade = 1;
  else {
    if (!s.c) {
      const yaw = player.view.yaw, x = player.x - Math.sin(yaw) * 2.8, z = player.z - Math.cos(yaw) * 2.8, info = world.cellInfo(x, z, scratch);
      if (info.realm === HALL && !info.solid && !world.collides(x, info.floor + 0.05, z, 0.3, 1.8) && world.los(player.x, player.z, x, z)) {
        const sp = creatures.speciesFor(info.R, HALL, Math.random() < 0.5 ? 0 : 1);
        s.c = creatures.spawn(sp, x, info.floor + 0.02, z, false);
        s.c.still = 0.75; s.c.yaw = Math.atan2(player.x - x, player.z - z);
      } else { s.kind = 'face'; s.t = 0; faceBase = makeFace((Math.random() * 4294967296) >>> 0); fade = 0; return; }
    }
    fade = Math.max(0, 1 - (t - 1.35) / 0.08);
    if (t > 1.72 && !s.hit) scareHit();
    if (t > 2.1) { if (s.c) s.c.dead = true; scare = null; }
  }
}
function tickScares(dt, dark) {
  if (scare) return runScare(dt);
  if (scareSoon > 0 && (scareSoon -= dt) <= 0) { startScare('figure'); return; }
  if (!settings.screamers || cine || transit || blackout || ended) return;
  const dread = 1 - player.composure / 100;
  scareT -= dt * (1 + 1.6 * dark + (dread > 0.4 ? 0.8 : 0)) * (gen.dim === 2 ? 0.6 : 1);
  if (scareT <= 0 && time > 60) {
    scareT = 100 + Math.random() * 130;
    startScare(Math.random() < (gen.dim === 0 ? 0.5 : 0) ? 'figure' : 'face');
  }
  // the bear in the child's room was facing the wardrobe for a reason
  const P = gen.pieceAt(Math.floor(player.x / CS), Math.floor(player.z / CS));
  if (P && P.kind === 'nursery' && !storySeen.has('scare:' + P.si + ':' + P.sj)) {
    const lu = 4.5, lv = 1.0, wx = P.orient ? P.i0 * CS + lv : P.i0 * CS + lu, wz = P.orient ? P.j0 * CS + lu : P.j0 * CS + lv;
    if (Math.hypot(player.x - wx, player.z - wz) < 1.5 && startScare('face')) storySeen.add('scare:' + P.si + ':' + P.sj);
  }
}

// ---- game ---------------------------------------------------------------------
function displace() {
  const a = Math.random() * 6.2832, d = 200 + Math.random() * 200;
  const [x, z] = gen.findOpen(player.x + Math.cos(a) * d, player.z + Math.sin(a) * d);
  creatures.clear();
  world.ensure(x, z, 1);
  player.place(x, z, Math.random() * 6.2832);
  player.composure = 65; player.stamina = 100;
  displaced++;
  labelKey = -1; objT = 0;
  note('you are somewhere else.');
}

function simulate(dt) {
  const k = c => keys.has(c);
  input.f = (k('KeyW') ? 1 : 0) - (k('KeyS') ? 1 : 0);
  input.s = (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0);
  input.up = k('Space');
  input.down = input.crouch = k('ControlLeft') || k('ControlRight') || k('KeyC');
  input.sprint = k('ShiftLeft') || k('ShiftRight');
  input.dx += ((k('ArrowRight') ? 1 : 0) - (k('ArrowLeft') ? 1 : 0)) * dt * CAMERA.arrowYaw / CAMERA.degPerCount;
  input.dy += ((k('ArrowDown') ? 1 : 0) - (k('ArrowUp') ? 1 : 0)) * dt * CAMERA.arrowPitch / CAMERA.degPerCount;
  if (hover && !locked && mouseIn) { // no capture: resting the hidden cursor at the side of the window keeps the view turning
    if (mouseX < 0.07) input.dx -= ((0.07 - mouseX) / 0.07) * dt * 1100;
    else if (mouseX > 0.93) input.dx += ((mouseX - 0.93) / 0.07) * dt * 1100;
  }
  if (blackout || transit || cine) { input.f = input.s = 0; input.jump = false; input.dx = input.dy = 0; input.up = input.down = input.crouch = input.sprint = false; }
  if (settings.invertY) input.dy = -input.dy;
  player.update(dt, input, time);
  if (cine || transit) runCine(dt);
  else roomStory();
  updateWet(dt);
  input.dx = input.dy = 0; input.jump = false;

  camera.getWorldDirection(camDir);
  world.updateDynamics(dt, time, camera.position, camDir);
  if (world.creaks) sound.creak(Math.random() * 2 - 1);
  threat = creatures.update(dt, time, player, camera.position, camDir);
  world.updateItems(time, player.x, player.y + 0.9, player.z);

  // the shotgun in the hands; flares on the ground
  const wasFire = fireT;
  fireT = Math.max(0, fireT - dt); kick = Math.max(0, kick - dt * 4.5);
  if (wasFire > 0 && fireT <= 0 && inv.shotgun && inv.loaded === 0 && inv.shells > 0) reload();
  let dip = 0;
  if (reloadT > 0) {
    reloadT -= dt;
    dip = Math.min(1, (1.5 - reloadT) * 5, Math.max(0, reloadT) * 5); // down and broken open, then back up
    if (reloadT <= 0) { const n = Math.min(2 - inv.loaded, inv.shells); inv.loaded += n; inv.shells -= n; reloadT = 0; showGear(); }
  }
  const sway = Math.sin(time * 1.7) * 0.004;
  gun.position.set(0.2 - dip * 0.05, -0.2 - dip * 0.1 + sway, -0.5 + kick * 0.11);
  gun.rotation.x = kick * 0.3 - dip * 0.75; gun.rotation.z = dip * 0.5;
  if (beamT > 0 && (beamT -= dt) <= 0) beam.visible = false;
  flashT = Math.max(0, flashT - dt);
  PL[3].w = flashT * 42; PLc[3].set(1.7, 1.05, 0.45);
  let lit = flashAmt > 0.5 && player.battery > 0;
  for (let q = 0; q < 3; q++) {
    const f = flares[q];
    if (!f) { PL[q].w = 0; continue; }
    f.t -= dt;
    const fl = 0.75 + 0.25 * Math.sin(time * 23 + q) * Math.sin(time * 7.1 + q * 2), life = Math.min(1, f.t / 6);
    PL[q].set(f.mesh.position.x, f.mesh.position.y + 0.25, f.mesh.position.z, 3.2 * fl * life); PLc[q].set(1.0, 0.3, 0.12);
    if (Math.hypot(f.mesh.position.x - player.x, f.mesh.position.z - player.z) < 11) lit = true;
    if (f.t <= 0) { scene.remove(f.mesh); flares.splice(q, 1); }
  }

  const info = player.info, dim = gen.dim;
  if (info.R) { visited.add(info.R.id); sound.setDistrict(info.R.id); }
  const dark = dim !== 2 && info.R && info.R.dark;
  darkAmt += ((dark ? 1 : 0) - darkAmt) * (1 - Math.exp(-1.5 * dt));
  if (dark) {
    if (!lit) player.dread(dt * 1.3); // the dark itself wears you down
    if (!hinted.dark) { hinted.dark = true; hint('no light here at all. keep the torch on (F), or strike a flare (G).'); }
  }
  const lk = dim * 2 + (dark ? 1 : 0);
  if (lk !== labelKey) { labelKey = lk; label(NAMES[lk]); }
  alertT -= dt; jolt *= Math.exp(-3.2 * dt); glitch *= Math.exp(-3.5 * dt);
  // the nearer something is, the less steady the hands holding the camera
  player.view.tremor = jolt * 1.5 + Math.max(0, threat - 0.4) * 0.8;
  if (player.winded) { player.winded = false; note('too winded to jump.'); }
  if (player.mode === SWIM && !hinted.swim) { hinted.swim = true; hint('swim where you look · SPACE rise · CTRL sink · SHIFT faster'); }
  if (player.mode === FLY && !hinted.fly) { hinted.fly = true; hint('nothing holds you here · SPACE up · CTRL down · SHIFT faster'); }

  portal = transit || cine ? null : portalNear();
  inter = interactNear();
  const pr = $('prompt');
  if (inter) { pr.textContent = inter.text; pr.style.opacity = 1; }
  else if (portal) { pr.textContent = portalText(portal); pr.style.opacity = 1; } else pr.style.opacity = 0;

  objT -= dt;
  if (objT <= 0) { objT = 0.4; goal = objective(); $('obj').textContent = goal.text; }

  if (!transit && !cine) {
    if (player.composure <= 0 && !blackout) { blackout = 1; sound.stinger(1.2); }
    if (blackout === 1) { fade = Math.min(1, fade + dt * 0.9); if (fade >= 1) { displace(); blackout = 2; } }
    else if (blackout === 2) { fade = Math.max(0, fade - dt * 0.4); if (fade <= 0) blackout = 0; }
    else fade = Math.max(0, fade - dt * 0.6);
  }
  tickScares(dt, darkAmt);
}

function atmosphere(dt) {
  const info = world.cellInfo(camera.position.x, camera.position.z, scratch);
  const out = info.realm === VOID || camera.position.y > TOP || camera.position.y < BOT;
  const under = !out && info.realm === WET && camera.position.y < WL;
  const tv = out ? 1 : 0, tw = !tv && under ? 1 : 0, th = 1 - tv - tw;
  const k = 1 - Math.exp(-2.6 * dt);
  mix.hall += (th - mix.hall) * k; mix.water += (tw - mix.water) * k; mix.void += (tv - mix.void) * k;
  const R = info.R, depth = Math.max(0, WL - camera.position.y), wd = Math.exp(-depth * 0.07) * (1 - 0.95 * darkAmt);
  const hr = R ? R.fog[0] : 0.02, hg = R ? R.fog[1] : 0.02, hb = R ? R.fog[2] : 0.02;
  const tr = mix.hall * hr + mix.water * 0.01 * wd, tg = mix.hall * hg + mix.water * 0.075 * wd, tb = mix.hall * hb + mix.water * 0.085 * wd + mix.void * 0.004;
  const kf = 1 - Math.exp(-1.5 * dt);
  if (!(fog.r + fog.g + fog.b >= 0)) fog.setRGB(0, 0, 0); // never let one bad number black the picture out for good
  fog.r += (tr - fog.r) * kf; fog.g += (tg - fog.g) * kf; fog.b += (tb - fog.b) * kf;
  const G = mats.G;
  G.fogColor.value.copy(fog);
  G.fogDensity.value = (mix.hall * (0.03 + 0.02 * darkAmt) + mix.water * 0.058) * settings.fog + mix.void * 0.0055;
  G.camUnder.value = under ? 1 : 0;
  G.time.value = time;
  G.camDir.value.copy(camDir);
  const dread = Math.max(0, Math.min(1, 1 - player.composure / 100));
  flashAmt += ((player.flash ? 1 : 0) - flashAmt) * (1 - Math.exp(-14 * dt));
  const sputter = threat > 0.55 && Math.sin(time * 31) * Math.sin(time * 17.3) > 0.55 ? 0.25 : 1;
  const bat = player.battery, cell = bat <= 0 ? 0.16 : bat < 15 ? 0.45 + 0.4 * Math.abs(Math.sin(time * 9) * Math.sin(time * 2.3)) : 1;
  G.flash.value = flashAmt * sputter * cell;
  sky.group.visible = gen.dim === 2;

  post.U.time.value = time;
  post.U.under.value += ((under ? 1 : 0) - post.U.under.value) * k;
  post.U.dread.value += (Math.max(dread, threat * 0.5) - post.U.dread.value) * (1 - Math.exp(-3 * dt));
  post.U.hit.value = player.hurtT;
  post.U.fade.value = fade;
  // out there the camera was never meant to work: more noise in the picture, and now and then it loses its place
  const lost = Math.sin(time * 0.71) * Math.sin(time * 1.93 + 1) > 0.62 ? 0.3 : 0.05;
  post.U.noise.value = mix.void * settings.fx;
  post.U.glitch.value = Math.min(1, glitch + Math.max(0, threat - 0.55) * 0.5 + mix.void * lost * settings.fx);
  post.U.bloom.value = 0.85 + 0.4 * mix.void;
  sky.update(camera, time, mix, pxScale);
  sound.update(dt, mix, under, Math.max(dread, threat * 0.7), darkAmt, threat);

  radius = gen.dim === 2 ? 3 : 2;
  world.update(camera.position.x, camera.position.z, radius, 7);
  world.cull(camera.position.x, camera.position.z, gen.dim === 2 ? Infinity : 3 / G.fogDensity.value);

  // hud
  const c = Math.max(0, player.composure);
  $('comp').style.width = c + '%';
  $('compWrap').style.opacity = c < 99 ? 1 : 0.45;
  $('stam').style.width = player.stamina + '%';
  $('stamWrap').style.opacity = player.stamina < 99 ? 1 : 0.45;
  $('bat').style.width = player.battery + '%';
  $('batWrap').style.opacity = player.flash || player.battery < 30 ? 1 : 0.45;
  if (labelT > 0 && (labelT -= dt) <= 0) $('label').style.opacity = 0;
  if (noteT > 0 && (noteT -= dt) <= 0) $('note').style.opacity = 0;
  if (hintT > 0 && (hintT -= dt) <= 0) $('hint').style.opacity = 0;
  if (tapeT > 0 && (tapeT -= dt) <= 0) $('tape').style.opacity = 0;
  // the camera's own display: time recorded, and a date it has long since lost track of
  const ts = Math.floor(time), two = v => String(v).padStart(2, '0');
  $('recT').textContent = 'REC ' + two(Math.floor(ts / 3600)) + ':' + two(Math.floor(ts / 60) % 60) + ':' + two(ts % 60);
  $('recD').textContent = 'JAN 01 1996  ' + two((3 + Math.floor(ts / 60)) % 24) + ':' + two(ts % 60);
  updateRadar();
}

// ---- the radar: a compass tape across the top of the picture, with a small model of each thing it points at:
// what you are after (large, gold), and the useful things lying close by (small) -------------------------------
let RW = 460, RPPR = 460 / 2.4, radPlaceT = 0;
const RFOV = 2.4;
// centred if the middle of the screen is free; otherwise squeezed into the gap between the objective and the REC display
function placeRadar() {
  const g = $('goal').getBoundingClientRect(), r = $('rec').getBoundingClientRect(), W = window.innerWidth, a = g.right + 14, b = r.left - 14;
  let w = 460, left = W / 2 - 230;
  if (left < a || left + w > b) { w = Math.max(220, Math.min(460, b - a)); left = a + (b - a - w) / 2; }
  RW = w; RPPR = w / RFOV;
  const st = $('radar').style; st.left = left + 'px'; st.marginLeft = '0'; st.width = w + 'px';
}
const radDirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map((t, q) => { const el = document.createElement('span'); el.textContent = t; if (q % 2 === 0) el.className = 'c'; $('radDirs').appendChild(el); return { el, b: q * 0.7854 }; });
const radMarks = [];
for (let q = 0; q < 6; q++) {
  const el = document.createElement('div'); el.className = 'rm';
  const img = document.createElement('img'), sm = document.createElement('small');
  el.appendChild(img); el.appendChild(sm); $('radMarks').appendChild(el);
  radMarks.push({ el, img, sm, type: '' });
}
const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
const RADAR_SKIP = { battery: 1, tonic: 1 };
function updateRadar() {
  const R = $('radar');
  if (!running || !settings.marker || cine || transit) { R.style.opacity = 0; return; }
  R.style.opacity = 1;
  if ((radPlaceT -= 1) <= 0) { radPlaceT = 20; placeRadar(); }
  const head = -player.yaw, off = RW / 2 - head * RPPR, p15 = RPPR * Math.PI / 12, p45 = p15 * 3;
  const tp = $('radTape').style;
  tp.backgroundSize = `${p15}px 5px, ${p45}px 11px`;
  tp.backgroundPosition = `${off % p15}px 0, ${off % p45}px 0`;
  for (const d of radDirs) { const rel = wrapA(d.b - head); d.el.style.left = RW / 2 + rel * RPPR + 'px'; d.el.style.opacity = Math.abs(rel) < RFOV / 2 - 0.12 ? 1 : 0; }
  const list = [];
  const t = goal.target;
  if (t) list.push({ x: t[0], z: t[1], y: t[2], icon: goal.icon || 'key', main: true });
  const near = [];
  for (const ch of world.chunks.values()) {
    if (Math.abs(ch.cx - world.pcx) > 1 || Math.abs(ch.cz - world.pcz) > 1) continue;
    for (const m of ch.items) {
      const it = m.userData.item, dx = it.x - player.x, dz = it.z - player.z, dd = dx * dx + dz * dz;
      if (dd > 26 * 26 || Math.abs(it.y - player.y) > 8 || RADAR_SKIP[it.type]) continue;
      if (t && Math.hypot(it.x - t[0], it.z - t[1]) < 1.5) continue;
      near.push({ x: it.x, z: it.z, y: it.y, icon: it.type, dd });
    }
  }
  near.sort((a, b) => a.dd - b.dd);
  for (let q = 0; q < near.length && list.length < radMarks.length; q++) list.push(near[q]);
  for (let q = 0; q < radMarks.length; q++) {
    const M = radMarks[q], e = list[q];
    if (!e) { M.el.style.display = 'none'; continue; }
    M.el.style.display = 'flex';
    const dx = e.x - player.x, dz = e.z - player.z, rel = wrapA(Math.atan2(dx, -dz) - head), edge = Math.abs(rel) > RFOV / 2 - 0.1;
    const x = RW / 2 + Math.max(-RFOV / 2 + 0.1, Math.min(RFOV / 2 - 0.1, rel)) * RPPR;
    M.el.style.left = x + 'px';
    M.el.className = 'rm' + (e.main ? ' main' : '') + (edge ? ' edge' : '');
    if (M.type !== e.icon) { M.type = e.icon; M.img.src = itemIcon(e.icon, 72); }
    const dy = e.y == null ? 0 : e.y - (player.y + 1), dist = Math.round(Math.hypot(dx, dz));
    M.sm.textContent = (edge ? (rel < 0 ? '‹ ' : '') : '') + dist + ' m' + (Math.abs(dy) > 2.5 ? (dy > 0 ? ' ▲' : ' ▼') : '') + (edge && rel > 0 ? ' ›' : '');
    M.el.style.zIndex = e.main ? 2 : 1;
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  try {
    if (running) { if (ui) uiTick(dt); else { time += dt; simulate(dt); } }
    else { camera.getWorldDirection(camDir); sound.tickMenu(); }
    atmosphere(running ? dt : 0.0001);
    post.render(scene, camera);
    errors = 0;
    if (running && now - saveT > 5000) { saveT = now; saveGame(); }
  } catch (e) {
    // one bad frame must not end the game: log it, carry on, and if it keeps happening save and say so
    console.error(e);
    if (++errors === 30) { saveGame(); note('something went wrong. your progress is saved — reload the page to carry on.'); }
  }
}

// ---- debug / test hooks ---------------------------------------------------------
window.__limen = {
  seed, gen, world, player, creatures, mats, camera, mix, post, renderer, scene, keys, inv, sound, flares,
  get state() { return { backend, time, fade, blackout, radius, running, threat, found, ended, dim: gen.dim, goal: goal.text, prompt: portal ? portalText(portal) : null, transit: !!transit, chunks: world.chunks.size, queue: world.queue.length }; },
  // advance the simulation by hand (for tests when the tab is not animating)
  step(n = 1, dt = 1 / 60) { for (let q = 0; q < n; q++) { time += dt; simulate(dt); atmosphere(dt); } post.render(scene, camera); },
  start: begin, fire, reload, pause, usePortal, skipCine, finish, startScare, openTerm, openRadio, closeUI, insertFuse, get ui() { return ui; }, get inter() { return inter; }, CODE, STATION, uiKey, uiTick, get gunWet() { return gunWet; }, get cine() { return cine || transit; }, useMedkit, strikeFlare, showGear, saveGame,
  // step straight into a dimension at the start site (0 lit, 1 drowned, 2 outside)
  goDim(d, si = -1, sj = 0) { arrive(d, si, sj); },
};

// build the pipelines for what is around the start before the first frame, so walking in does not hitch
showOverlay(false);
$('stats').textContent = `seed ${seed} · ${backend} · preparing`;
atmosphere(0.0001);
await renderer.compileAsync(scene, camera).catch(() => {});
ready = true;
showOverlay(false);
requestAnimationFrame(frame);
