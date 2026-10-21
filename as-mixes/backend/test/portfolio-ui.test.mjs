import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../dist/assets/portfolio.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../dist/index.html', import.meta.url), 'utf8');
const project = { title: '<b>Synthetic recording</b>', artist: 'Test artist', credit: 'Mixing', description: 'Test description',
  artworkUrl: '/media/11111111-1111-1111-1111-111111111111', audioUrl: '/media/22222222-2222-2222-2222-222222222222' };

// Minimal DOM fixture, matching the dependency-free contact UI tests.
function ui(result, config = { apiOrigin: 'https://api.example.test' }) {
  const document = { activeElement: null };
  function element(tag) {
    return { tag, children: [], attributes: {}, listeners: {}, hidden: false, textContent: '', pauses: 0, isConnected: true,
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); },
      pause() { this.pauses++; }, focus() { document.activeElement = this; },
    };
  }
  const grid = element('div'), status = element('p'), retry = element('button');
  retry.hidden = true;
  document.createElement = element;
  document.querySelector = () => ({ querySelector: selector => ({ '.work-grid': grid, '#portfolio-status': status, '#portfolio-retry': retry })[selector] });
  const requests = [], timers = new Map();
  let timerId = 0;
  const done = vm.runInNewContext(source, { document, window: { AS_MIXES_PORTFOLIO: config }, URL, AbortController,
    setTimeout(fn, delay) { assert.ok([15000, 1500].includes(delay)); timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, init) => { requests.push({ url, init }); if (result instanceof Error) throw result; return typeof result === 'function' ? result(init) : result; },
  });
  return { grid, status, retry, document, requests, timers, done, click: () => retry.listeners.click() };
}

test('initial HTML has an accessible loading state and no demonstration cards', () => {
  const work = html.match(/<section class="section wrap" id="work">([\s\S]*?)<\/section>/)[1];
  assert.doesNotMatch(work, /<article|Fault Lines|Afterlight|Static Ground|layout example|PLACEHOLDER/i);
  assert.match(work, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(work, /Loading audio previews/);
  assert.match(work, /type="button" hidden/);
  assert.match(work, /<noscript>.*Enable JavaScript/);
  assert.match(work, /class="work-grid" aria-busy="true"><\/div>/);
});

test('delayed request stays empty and busy; duplicate requests are blocked', async () => {
  let complete;
  const f = ui(() => new Promise(resolve => { complete = resolve; }));
  assert.equal(f.grid.children.length, 0);
  assert.equal(f.grid.attributes['aria-busy'], 'true');
  assert.match(f.status.textContent, /Loading/);
  assert.equal(f.retry.disabled, true);
  await f.click(); assert.equal(f.requests.length, 1);
  complete(Response.json({ projects: [project] })); await f.done;
  assert.equal(f.grid.children.length, 1);
  assert.equal(f.grid.attributes['aria-busy'], 'false');
  assert.equal(f.timers.size, 0);
});

test('success renders only API projects as text and preserves media and exclusive playback', async () => {
  const f = ui(Response.json({ projects: [project, { ...project, title: 'Second' }] })); await f.done;
  assert.equal(f.grid.children.length, 2);
  assert.equal(f.grid.querySelectorAll('h3')[0].textContent, project.title);
  assert.equal(f.grid.querySelectorAll('b').length, 0);
  assert.equal(f.requests[0].url.href, 'https://api.example.test/api/projects');
  assert.equal(f.requests[0].init.credentials, 'omit');
  assert.equal(f.requests[0].init.cache, 'no-store');
  const [first, second] = f.grid.querySelectorAll('audio');
  assert.equal(first.src, 'https://api.example.test' + project.audioUrl);
  assert.equal(first.controls, true); assert.equal(first.preload, 'none');
  assert.match(first.attributes['aria-label'], /Listen to/);
  first.listeners.play(); assert.equal(second.pauses, 1); assert.equal(first.pauses, 0);
  assert.equal(f.retry.hidden, true);
});

test('empty published portfolio has a clear empty state', async () => {
  const f = ui(Response.json({ projects: [] })); await f.done;
  assert.match(f.status.textContent, /No audio previews are published yet/);
  assert.equal(f.grid.children.length, 0); assert.equal(f.retry.hidden, true);
  assert.equal(f.grid.attributes['aria-busy'], 'false');
});

test('network, HTTP, JSON and schema failures expose retry without partial cards', async () => {
  for (const result of [new Error('Offline'), new Response('', { status: 503 }), new Response('invalid JSON'),
    Response.json(null), Response.json({}), Response.json({ projects: Array(101).fill(project) }),
    Response.json({ projects: [project, { ...project, audioUrl: 'https://untrusted.test/audio' }] })]) {
    const f = ui(result); await f.done;
    assert.equal(f.grid.children.length, 0); assert.match(f.status.textContent, /could not be loaded/);
    assert.equal(f.retry.hidden, false); assert.equal(f.retry.disabled, false);
    assert.equal(f.grid.attributes['aria-busy'], 'false'); assert.equal(f.timers.size, 0);
  }
});

test('retry recovers, prevents duplicate requests and preserves keyboard focus', async () => {
  let attempt = 0, complete;
  const f = ui(() => ++attempt === 1 ? new Response('', { status: 503 }) : new Promise(resolve => { complete = resolve; }));
  await f.done; f.retry.focus();
  const pending = f.click(); await f.click();
  assert.equal(f.requests.length, 2); assert.equal(f.retry.disabled, true);
  assert.match(f.status.textContent, /Loading/);
  complete(Response.json({ projects: [project] })); await pending;
  assert.equal(f.grid.children.length, 1); assert.equal(f.retry.hidden, true);
  assert.equal(f.document.activeElement, f.status);
});

test('stalled requests abort and offer retry', async () => {
  const f = ui(({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')))));
  [...f.timers.values()][0](); await f.done;
  assert.equal(f.requests[0].init.signal.aborted, true);
  assert.match(f.status.textContent, /could not be loaded/);
  assert.equal(f.retry.hidden, false); assert.equal(f.grid.attributes['aria-busy'], 'false');
});

test('missing or invalid API configuration fails closed', async () => {
  for (const config of [null, {}, { apiOrigin: 'http://api.example.test' }, { apiOrigin: 'https://api.example.test/path' }]) {
    const f = ui(null, config); await f.done;
    assert.equal(f.requests.length, 0); assert.equal(f.grid.children.length, 0);
    assert.match(f.status.textContent, /could not be loaded/); assert.equal(f.retry.hidden, false);
  }
});

test('artwork network failure retries once and recovers without replacing players or fetching metadata', async () => {
  const f = ui(Response.json({ projects: [project, { ...project, title: 'Second' }] })); await f.done;
  const [image, second] = f.grid.querySelectorAll('img');
  const players = f.grid.querySelectorAll('audio');
  assert.equal(typeof image.listeners.error, 'function', 'Image failures need a recovery path');
  image.listeners.error();
  assert.equal(f.timers.size, 1);
  const [id, retry] = [...f.timers][0]; f.timers.delete(id); retry();
  assert.equal(image.src, 'https://api.example.test' + project.artworkUrl);
  image.listeners.load();
  assert.equal(image.hidden, false); assert.equal(second.hidden, false);
  assert.deepEqual(f.grid.querySelectorAll('audio'), players);
  assert.equal(players[0].pauses, 0); assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
});

test('missing or undecodable artwork stops automatic requests and offers an independent manual retry', async () => {
  const f = ui(Response.json({ projects: [project] })); await f.done;
  const [image] = f.grid.querySelectorAll('img'), [retry] = f.grid.querySelectorAll('button');
  assert.ok(retry, 'Failed artwork needs a local retry control');
  image.listeners.error();
  const [id, automatic] = [...f.timers][0]; f.timers.delete(id); automatic();
  image.listeners.error();
  assert.equal(f.timers.size, 0); assert.equal(image.hidden, true); assert.equal(retry.disabled, false);
  retry.focus(); retry.listeners.click(); retry.listeners.click();
  assert.equal(retry.disabled, true);
  image.listeners.load();
  assert.equal(image.hidden, false); assert.notEqual(f.document.activeElement, retry);
  assert.equal(f.requests.length, 1);
});

test('a successful image cancels pending recovery without extra requests', async () => {
  const f = ui(Response.json({ projects: [project] })); await f.done;
  const [image] = f.grid.querySelectorAll('img');
  assert.equal(typeof image.listeners.error, 'function');
  image.listeners.error(); image.listeners.load();
  assert.equal(f.timers.size, 0);
  image.listeners.error();
  assert.equal(f.timers.size, 0, 'Each artwork has only one automatic retry budget');
});

test('a detached cover does not restart its failed image request', async () => {
  const f = ui(Response.json({ projects: [project] })); await f.done;
  const [image] = f.grid.querySelectorAll('img'), cover = f.grid.children[0].children[0];
  image.listeners.error(); cover.isConnected = false;
  const [id, automatic] = [...f.timers][0]; f.timers.delete(id); automatic();
  assert.equal(image.hidden, true); assert.equal(f.timers.size, 0);
});
