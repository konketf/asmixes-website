import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../dist/assets/contact.js', import.meta.url), 'utf8');
function ui(result, { configured = true, theme } = {}) {
  const listeners = {}, scriptListeners = {}, status = { textContent: '' }, button = {}, requests = [];
  let widgetOptions, resets = 0, tokenResets = 0, removed = 0;
  const documentListeners = {}, renderedThemes = [];
  const values = { name: 'Artist', email: 'artist@example.com', service: 'Mixing', trackCount: '60', message: 'Please keep this message.' };
  const form = { querySelector: () => button, addEventListener: (event, fn) => { listeners[event] = fn; }, reportValidity: () => true, reset: () => { resets++; values.message = ''; } };
  const document = { querySelector: selector => selector === '#contact-form' ? form : status,
    addEventListener: (event, fn) => { documentListeners[event] = fn; },
    createElement: () => ({ addEventListener: (event, fn) => { scriptListeners[event] = fn; } }), head: { append() {} } };
  const window = { AS_MIXES_PORTFOLIO: { apiOrigin: 'https://portfolio.example.workers.dev', turnstileSiteKey: configured ? 'test-public-site-key' : null }, turnstile: {
    render(selector, options) { assert.equal(selector, '#contact-verification'); assert.equal(options.theme, theme || 'auto'); assert.equal(options.action, 'contact'); renderedThemes.push(options.theme); widgetOptions = options; return 'widget'; }, reset() { tokenResets++; }, remove() { removed++; },
  } };
  if (theme) window.AS_MIXES_THEME = { theme };
  const fetch = async (url, init) => { requests.push({ url, init }); if (result instanceof Error) throw result; return typeof result === 'function' ? result() : result; };
  class FormData { get(key) { return values[key]; } }
  vm.runInNewContext(source, { document, window, fetch, FormData, URL, AbortSignal });
  if (configured) scriptListeners.load();
  return { button, status, values, requests, scriptListeners, renderedThemes, removed: () => removed,
    changeTheme(value) { theme = value; window.AS_MIXES_THEME = { theme }; documentListeners['asmixes:themechange'](); },
    token: () => widgetOptions.callback('test-token'), expire: () => widgetOptions['expired-callback'](), submit: () => listeners.submit({ preventDefault() {} }), resets: () => resets, tokenResets: () => tokenResets };
}

test('Turnstile follows the effective theme and requires fresh verification after changing it', () => {
  const f = ui(null, { theme: 'dark' }); f.token(); f.changeTheme('light');
  assert.deepEqual(f.renderedThemes, ['dark', 'light']); assert.equal(f.removed(), 1);
  assert.equal(f.button.disabled, true); assert.equal(f.values.message, 'Please keep this message.');
  f.token(); assert.equal(f.button.disabled, false);
});

test('changing theme during submission defers widget replacement until the response', async () => {
  let complete;
  const f = ui(() => new Promise(resolve => { complete = resolve; }), { theme: 'light' });
  f.token(); const pending = f.submit(); f.changeTheme('dark'); assert.equal(f.removed(), 0);
  complete(Response.json({ error: 'Please retry.' }, { status: 503 })); await pending;
  assert.equal(f.removed(), 1); assert.deepEqual(f.renderedThemes, ['light', 'dark']);
  assert.equal(f.values.message, 'Please keep this message.'); assert.equal(f.button.disabled, true);
});

test('UI sends JSON without credentials and clears fields only after explicit acceptance', async () => {
  const f = ui(Response.json({ accepted: true })); assert.equal(f.button.disabled, true);
  f.token(); assert.equal(f.button.disabled, false); await f.submit();
  assert.equal(f.requests[0].init.credentials, 'omit'); assert.equal(JSON.parse(f.requests[0].init.body).trackCount, 60);
  assert.equal(f.resets(), 1); assert.match(f.status.textContent, /accepted/); assert.equal(f.tokenResets(), 1);
});

test('UI preserves message and supports fresh-token retry after provider failure', async () => {
  let attempt = 0;
  const f = ui(() => ++attempt === 1 ? Response.json({ error: 'Please retry.' }, { status: 503 }) : Response.json({ accepted: true }));
  f.token(); await f.submit(); assert.equal(f.resets(), 0); assert.equal(f.values.message, 'Please keep this message.'); assert.equal(f.status.textContent, 'Please retry.');
  assert.equal(f.button.disabled, true); f.token(); await f.submit(); assert.equal(f.resets(), 1);
});

test('UI never claims success for network failures, invalid JSON or unconfirmed responses', async () => {
  for (const result of [new Error('Network unavailable'), new Response('Not JSON'), Response.json({ accepted: false })]) {
    const f = ui(result); f.token(); await f.submit(); assert.equal(f.resets(), 0); assert.equal(f.values.message, 'Please keep this message.'); assert.doesNotMatch(f.status.textContent, /Thanks/);
  }
});

test('UI rejects expired token, blocks duplicate clicks, and fails closed without site key', async () => {
  let complete;
  const f = ui(() => new Promise(resolve => { complete = resolve; }));
  f.token(); f.expire(); await f.submit(); assert.equal(f.requests.length, 0);
  f.token(); const pending = f.submit(); await f.submit(); assert.equal(f.requests.length, 1);
  complete(Response.json({ accepted: true })); await pending;
  const disabled = ui(null, { configured: false }); await disabled.submit(); assert.equal(disabled.requests.length, 0); assert.equal(disabled.button.disabled, true); assert.match(disabled.status.textContent, /contact@asmixes.com/);
});
