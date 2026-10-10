import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../dist/assets/contact.js', import.meta.url), 'utf8');
function ui(result, { configured = true } = {}) {
  const listeners = {}, scriptListeners = {}, status = { textContent: '' }, button = {}, requests = [];
  let widgetOptions, resets = 0, tokenResets = 0;
  const values = { name: 'Artist', email: 'artist@example.com', service: 'Mixing', trackCount: '60', message: 'Please keep this message.' };
  const form = { querySelector: () => button, addEventListener: (event, fn) => { listeners[event] = fn; }, reportValidity: () => true, reset: () => { resets++; values.message = ''; } };
  const document = { querySelector: selector => selector === '#contact-form' ? form : status,
    createElement: () => ({ addEventListener: (event, fn) => { scriptListeners[event] = fn; } }), head: { append() {} } };
  const window = { AS_MIXES_PORTFOLIO: { apiOrigin: 'https://portfolio.example.workers.dev', turnstileSiteKey: configured ? 'test-public-site-key' : null }, turnstile: {
    render(selector, options) { assert.equal(selector, '#contact-verification'); widgetOptions = options; return 'widget'; }, reset() { tokenResets++; },
  } };
  const fetch = async (url, init) => { requests.push({ url, init }); if (result instanceof Error) throw result; return typeof result === 'function' ? result() : result; };
  class FormData { get(key) { return values[key]; } }
  vm.runInNewContext(source, { document, window, fetch, FormData, URL, AbortSignal });
  if (configured) scriptListeners.load();
  return { button, status, values, requests, scriptListeners, token: () => widgetOptions.callback('test-token'), expire: () => widgetOptions['expired-callback'](), submit: () => listeners.submit({ preventDefault() {} }), resets: () => resets, tokenResets: () => tokenResets };
}

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
