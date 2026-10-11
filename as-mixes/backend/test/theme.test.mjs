import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../dist/assets/theme.js', import.meta.url), 'utf8');
function setup({ saved, light = false, storageUnavailable = false } = {}) {
  const docEvents = {}, winEvents = {}, mediaEvents = {}, controlEvents = {}, notifications = [];
  const values = new Map(saved === undefined ? [] : [['asmixes-theme', saved]]);
  const root = { dataset: {} }, control = { disabled: true };
  const inputs = ['light', 'system', 'dark'].map(value => ({ name: 'theme', value, checked: value === 'system' }));
  const metas = [0, 1].map(() => ({ removeAttribute(name) { this[name] = undefined; } }));
  const media = { matches: light, addEventListener: (name, callback) => { mediaEvents[name] = callback; } };
  let loaded = false;
  control.addEventListener = (name, callback) => { controlEvents[name] = callback; };
  const window = { addEventListener: (name, callback) => { winEvents[name] = callback; } };
  const document = { documentElement: root,
    querySelector: () => loaded ? control : null, querySelectorAll: selector => selector.startsWith('#theme-switch') ? (loaded ? inputs : []) : metas,
    addEventListener: (name, callback) => { docEvents[name] = callback; },
    dispatchEvent: event => { notifications.push(event.detail.theme); },
  };
  const localStorage = {
    getItem(key) { if (storageUnavailable) throw new Error('Blocked'); return values.get(key) ?? null; },
    setItem(key, value) { if (storageUnavailable) throw new Error('Blocked'); values.set(key, value); },
  };
  vm.runInNewContext(source, { window, document, localStorage, matchMedia: () => media,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  return { root, metas, values, notifications, control, inputs, selected: () => inputs.find(input => input.checked)?.value, api: window.AS_MIXES_THEME,
    load() { loaded = true; docEvents.DOMContentLoaded(); },
    choose(value) { const target = inputs.find(input => input.value === value); inputs.forEach(input => { input.checked = input === target; }); controlEvents.change({ target }); },
    system(value) { media.matches = value; mediaEvents.change(); },
    storage(key, newValue) { winEvents.storage({ key, newValue }); },
  };
}

test('System is default and tracks OS theme changes, including browser theme color', () => {
  const f = setup(); assert.equal(f.api.preference, 'system'); assert.equal(f.root.dataset.theme, 'dark');
  f.load(); assert.equal(f.selected(), 'system'); assert.equal(f.control.disabled, false);
  f.system(true); assert.equal(f.root.dataset.theme, 'light');
  for (const meta of f.metas) { assert.equal(meta.content, '#f5f2eb'); assert.equal(meta.media, undefined); }
  f.system(false); assert.equal(f.root.dataset.theme, 'dark');
});

test('manual Light and Dark override OS changes and persist across page loads', () => {
  for (const preference of ['light', 'dark']) {
    const f = setup({ light: preference === 'dark' }); f.load(); f.choose(preference);
    assert.equal(f.root.dataset.theme, preference); assert.equal(f.values.get('asmixes-theme'), preference);
    const count = f.notifications.length; f.system(!f.api.theme.includes('light'));
    assert.equal(f.root.dataset.theme, preference); assert.equal(f.notifications.length, count);
    const next = setup({ saved: f.values.get('asmixes-theme'), light: preference === 'dark' });
    assert.equal(next.root.dataset.theme, preference); // Applied before DOMContentLoaded.
    next.load(); assert.equal(next.selected(), preference);
    assert.equal(next.metas[0].content, preference === 'light' ? '#f5f2eb' : '#171817');
  }
});

test('returning to System restores live OS tracking and persists System', () => {
  const f = setup({ saved: 'dark', light: true }); f.load(); f.choose('system');
  assert.equal(f.root.dataset.theme, 'light'); assert.equal(f.values.get('asmixes-theme'), 'system');
  f.system(false); assert.equal(f.root.dataset.theme, 'dark');
});

test('unavailable storage and malformed preferences fail gracefully', () => {
  const f = setup({ storageUnavailable: true, light: true }); f.load();
  assert.equal(f.api.preference, 'system'); f.choose('dark'); assert.equal(f.root.dataset.theme, 'dark');
  f.api.setPreference('invalid'); assert.equal(f.api.preference, 'dark');
  assert.equal(setup({ saved: 'invalid' }).api.preference, 'system');
});

test('storage events synchronize other tabs and preference removal restores System', () => {
  const f = setup({ light: true }); f.load(); f.storage('asmixes-theme', 'dark');
  assert.equal(f.root.dataset.theme, 'dark'); assert.equal(f.selected(), 'dark');
  f.storage('unrelated', 'light'); assert.equal(f.root.dataset.theme, 'dark');
  f.storage('asmixes-theme', null); assert.equal(f.api.preference, 'system'); assert.equal(f.root.dataset.theme, 'light');
});

test('theme initialization precedes styles without weakening CSP; admin does not load it', () => {
  const html = readFileSync(new URL('../../dist/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script src="assets\/theme.js"[^>]*>/)[0];
  assert.doesNotMatch(script, /defer|async/);
  assert.ok(html.indexOf(script) < html.indexOf('<link rel="stylesheet"'));
  assert.match(html, /<fieldset class="theme-switch" id="theme-switch" disabled>/);
  assert.match(html, /<legend>Color theme<\/legend>/);
  assert.deepEqual([...html.matchAll(/type="radio" name="theme" value="(\w+)"/g)].map(match => match[1]), ['light', 'system', 'dark']);
  assert.match(html, /value="system" checked/);
  const navigation = html.match(/<nav id="navigation"[\s\S]*?<\/nav>/)[0];
  assert.ok(navigation.indexOf('class="nav-contact"') < navigation.indexOf('id="theme-switch"'));
  assert.match(navigation, /id="theme-switch"/);
  for (const file of ['../../dist/admin/index.html', '../admin/admin/index.html']) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /theme.js|public-design.css|theme-switch/);
  }
});

test('waveform redraws on theme changes while reduced motion remains static', () => {
  const events = {}, strokes = [];
  let color = '#d98c58', animationRequests = 0;
  const context = { clearRect() {}, setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {},
    createLinearGradient() { return { colors: [], addColorStop(at, value) { this.colors.push(value); } }; },
    stroke() { strokes.push(this.strokeStyle.colors.slice()); },
  };
  const canvas = { getContext: () => context, getBoundingClientRect: () => ({ width: 400, height: 240 }) };
  vm.runInNewContext(readFileSync(new URL('../../dist/assets/hero-waveform.js', import.meta.url), 'utf8'), {
    document: { querySelector: () => canvas, hidden: false, addEventListener: (name, fn) => { events[name] = fn; } },
    matchMedia: query => ({ matches: query.includes('reduced-motion'), addEventListener() {} }),
    getComputedStyle: () => ({ color }), devicePixelRatio: 1,
    ResizeObserver: class { observe() {} }, IntersectionObserver: class { observe() {} },
    cancelAnimationFrame() {}, requestAnimationFrame() { animationRequests++; },
  });
  assert.ok(strokes.at(-1).includes('#d98c58'));
  color = '#98491f'; events['asmixes:themechange']();
  assert.ok(strokes.at(-1).includes('#98491f')); assert.equal(animationRequests, 0);
});
