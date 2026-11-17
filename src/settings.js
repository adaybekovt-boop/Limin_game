// Player settings: kept in localStorage, edited from the menu.
const KEY = 'limen.settings.v1';
export const DEFAULTS = {
  master: 0.8, ambience: 0.6, effects: 0.8, music: 0.6, bass: 0.35,
  sens: 1, invertY: false, fov: 90, shake: 1,
  brightness: 1, fx: 1, fog: 1.3, marker: true, fullscreen: true, screamers: true,
};

// one row per setting; rows with only `head` start a group
export const SCHEMA = [
  { head: 'sound' },
  { k: 'master', label: 'overall volume', min: 0, max: 1, step: 0.05, pct: true },
  { k: 'ambience', label: 'ambience (hum, water, the outside)', min: 0, max: 1, step: 0.05, pct: true },
  { k: 'effects', label: 'effects (steps, residents, the shotgun)', min: 0, max: 1, step: 0.05, pct: true },
  { k: 'music', label: 'music', min: 0, max: 1, step: 0.05, pct: true },
  { k: 'bass', label: 'bass', min: 0, max: 1, step: 0.05, pct: true, hint: 'lower it if the low end is tiring' },
  { head: 'mouse and camera' },
  { k: 'sens', label: 'mouse sensitivity', min: 0.2, max: 3, step: 0.05, fmt: v => v.toFixed(2) + '×' },
  { k: 'invertY', label: 'invert vertical look', bool: true },
  { k: 'fov', label: 'field of view', min: 70, max: 110, step: 1, fmt: v => v + '°' },
  { k: 'shake', label: 'camera sway', min: 0, max: 1.5, step: 0.05, pct: true, hint: '0 keeps the view perfectly steady' },
  { head: 'display' },
  { k: 'brightness', label: 'brightness', min: 0.7, max: 1.8, step: 0.05, fmt: v => v.toFixed(2) },
  { k: 'fx', label: 'camera look (grain, tape glitches)', min: 0, max: 1.5, step: 0.05, pct: true, hint: '0 gives a clean picture' },
  { k: 'fog', label: 'fog', min: 0.5, max: 2, step: 0.05, pct: true },
  { k: 'marker', label: 'show the direction marker', bool: true },
  { k: 'screamers', label: 'screamers (sudden loud scares)', bool: true, hint: 'turn off if jump scares are too much' },
  { k: 'fullscreen', label: 'go fullscreen when entering', bool: true, hint: 'fullscreen keeps the mouse inside the game' },
];

function load() {
  const s = { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const k in DEFAULTS) if (typeof raw[k] === typeof DEFAULTS[k]) s[k] = raw[k];
  } catch (e) { /* first run, or storage is unavailable */ }
  return s;
}

export const settings = load();
export function saveSettings() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* not stored; still applies */ } }

// Builds the rows into `box`; calls onChange(key) after every change.
export function buildSettingsUI(box, onChange) {
  const show = [];
  box.innerHTML = '';
  for (const r of SCHEMA) {
    if (r.head) { const h = document.createElement('h3'); h.textContent = r.head; box.appendChild(h); continue; }
    const row = document.createElement('label'); row.className = 'row';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = r.label;
    if (r.hint) { const hint = document.createElement('small'); hint.textContent = r.hint; name.appendChild(hint); }
    const inp = document.createElement('input'), val = document.createElement('span'); val.className = 'val';
    if (r.bool) { inp.type = 'checkbox'; }
    else { inp.type = 'range'; inp.min = r.min; inp.max = r.max; inp.step = r.step; }
    const sync = () => {
      if (r.bool) { inp.checked = settings[r.k]; val.textContent = settings[r.k] ? 'on' : 'off'; }
      else { inp.value = settings[r.k]; val.textContent = r.pct ? Math.round(settings[r.k] * 100) + '%' : r.fmt(settings[r.k]); }
    };
    inp.addEventListener('input', () => {
      settings[r.k] = r.bool ? inp.checked : parseFloat(inp.value);
      sync(); saveSettings(); onChange(r.k);
    });
    show.push(sync); sync();
    row.append(name, inp, val);
    box.appendChild(row);
  }
  return {
    reset() { Object.assign(settings, DEFAULTS); saveSettings(); for (const f of show) f(); onChange(null); },
  };
}
