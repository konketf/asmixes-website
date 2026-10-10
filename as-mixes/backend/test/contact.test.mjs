import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { D1SQLite, edgeBindings } from './helpers.mjs';
import { createContactHandler, cleanupContact } from '../src/contact.mjs';
import { createWorker } from '../src/worker.mjs';

const valid = () => ({ name: 'Artist', email: 'artist@example.com', service: 'Mixing', trackCount: 60, message: 'Hello! Here are the project details.', token: 'test-token' });
function setup(t, options = {}) {
  const db = new D1SQLite();
  db.db.exec(readFileSync(new URL('../migrations/0002_contact_limits.sql', import.meta.url), 'utf8'));
  t.after(() => db.db.close());
  const sent = [], verified = [];
  const env = { ...edgeBindings(), APP_MODE: 'public', PUBLIC_ORIGIN: 'https://konketf.github.io', CONTACT_ALLOWED_ORIGINS: '["https://konketf.github.io","https://asmixes.com"]', DB: db,
    TURNSTILE_SECRET: 'test-only-secret', CONTACT_RATE_SECRET: 'test-only-hmac-secret-at-least-32-characters',
    RESEND_API_KEY: 'test-only-resend-key', CONTACT_RECIPIENT: 'recipient@example.com' };
  const handler = createContactHandler(async (url, init) => {
    if (url === 'https://api.resend.com/emails') {
      assert.equal(init.headers.Authorization, `Bearer ${env.RESEND_API_KEY}`);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.method, 'POST');
      sent.push(JSON.parse(init.body));
      if (options.emailFailure) throw new Error('private provider diagnostic recipient@example.com');
      if (options.providerTimeout) throw new DOMException('private timeout diagnostic', 'TimeoutError');
      if (options.providerStatus) return Response.json({ name: 'private-error', message: 'private provider diagnostic recipient@example.com' }, { status: options.providerStatus });
      if (options.invalidProviderJSON) return new Response('not JSON');
      return Response.json(options.emptyAcceptance ? {} : { id: 'test-message-id' });
    }
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    verified.push({ url, init });
    if (options.verificationFailure) throw new Error('private verify diagnostic');
    return Response.json(options.verification || { success: true, hostname: 'konketf.github.io', action: 'contact' });
  });
  const call = (data = valid(), { origin = 'https://konketf.github.io', method = 'POST', headers = {}, raw, ip = '192.0.2.1' } = {}) => {
    const h = new Headers({ 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers });
    if (origin !== null) h.set('Origin', origin);
    return handler(new Request('https://portfolio.example.workers.dev/api/contact', { method, headers: h, body: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? undefined : raw ?? JSON.stringify(data) }), env);
  };
  return { env, db, sent, verified, call };
}

test('contact accepts validated enquiry with fixed sender, secret recipient and Resend Reply-To', async t => {
  const f = setup(t); const response = await f.call();
  assert.equal(response.status, 200); assert.equal((await response.json()).accepted, true);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), f.env.PUBLIC_ORIGIN);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].from, 'contact@asmixes.com');
  assert.equal(f.sent[0].reply_to, 'artist@example.com'); assert.deepEqual(f.sent[0].to, ['recipient@example.com']);
  assert.equal(f.sent[0].html, undefined); assert.equal(f.sent[0].headers, undefined);
  assert.match(f.sent[0].text, /Audio tracks per mix: 60/);
  assert.equal(f.verified[0].init.body.get('secret'), f.env.TURNSTILE_SECRET);
});

test('planned primary domain requires its own verified hostname', async t => {
  const f = setup(t, { verification: { success: true, hostname: 'asmixes.com', action: 'contact' } });
  assert.equal((await f.call(valid(), { origin: 'https://asmixes.com' })).status, 200);
  assert.equal((await f.call()).status, 400);
});

test('contact rejects invalid fields, header injection and relay controls before verification', async t => {
  const f = setup(t); f.env.CONTACT_IP_LIMIT = '50';
  for (const patch of [{ email: 'a@example.com\r\nBcc: victim@example.com' }, { name: 'A\nBcc: x' }, { email: 'a@example.com,b@example.com' }, { email: 'a..b@example.com' }, { service: 'Anything' }, { trackCount: 61 }, { trackCount: 0 }, { trackCount: 1.5 }, { trackCount: '2' }, { message: '' }, { message: 'x'.repeat(5001) }, { message: 'a\u0000b' }, { name: 'x'.repeat(101) }, { token: '' }, { token: 'a'.repeat(2049) }, { to: 'victim@example.com' }, { from: 'forged@example.com' }, { replyTo: 'other@example.com' }, { html: '<script>alert(1)</script>' }]) {
    assert.equal((await f.call({ ...valid(), ...patch })).status, 400);
  }
  assert.equal(f.sent.length, 0); assert.equal(f.verified.length, 0);
});

test('markup is sent only as plain text and never interpolated into headers', async t => {
  const f = setup(t); assert.equal((await f.call({ ...valid(), name: '<b>Artist</b>', message: '<script>alert(1)</script>\nSubject: forged' })).status, 200);
  assert.equal(f.sent[0].html, undefined); assert.equal(f.sent[0].subject, 'AS Mixes — Project enquiry');
});

test('missing, expired, reused, wrong-host and wrong-action tokens fail closed', async t => {
  for (const verification of [{ success: false, 'error-codes': ['timeout-or-duplicate'] }, { success: true, hostname: 'evil.example', action: 'contact' }, { success: true, hostname: 'konketf.github.io', action: 'login' }, null]) {
    const f = setup(t, { verification: verification ?? { success: false } });
    assert.equal((await f.call()).status, 400); assert.equal(f.sent.length, 0);
    const data = valid(); delete data.token; assert.equal((await f.call(data)).status, 400);
  }
});

test('Turnstile outage and provider failure never report success or leak diagnostics', async t => {
  for (const options of [{ verificationFailure: true }, { emailFailure: true }, { providerTimeout: true }, { emptyAcceptance: true }, { invalidProviderJSON: true }, ...[401, 403, 422, 429, 500].map(providerStatus => ({ providerStatus }))]) {
    const f = setup(t, options); const response = await f.call();
    assert.equal(response.status, 503); const body = await response.text();
    assert.doesNotMatch(body, /accepted|diagnostic|recipient@example/);
  }
});

test('per-IP counters survive requests and enforce concurrent submissions atomically', async t => {
  const f = setup(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.call()));
  assert.equal(responses.filter(r => r.status === 200).length, 5);
  assert.equal(responses.filter(r => r.status === 429).length, 3);
  assert.equal(responses.find(r => r.status === 429).headers.get('Retry-After'), '600');
  const rows = f.db.db.prepare('SELECT * FROM contact_limits').all();
  assert.ok(rows.every(row => !row.key.includes('192.0.2.1')));
});

test('global cap is atomic across clients and returns a clear private error', async t => {
  const f = setup(t); f.env.CONTACT_DAILY_LIMIT = '2';
  const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => f.call(valid(), { ip: `192.0.2.${i + 1}` })));
  assert.equal(f.sent.length, 2); assert.equal(responses.filter(r => r.status === 200).length, 2);
  const response = responses.find(r => r.status === 503);
  const text = await response.text(); assert.match(text, /daily sending limit/); assert.match(text, /tomorrow/); assert.doesNotMatch(text, /D1|global:|SQL|secret|100/);
});

test('expired counters are cleaned up while active counters remain', async t => {
  const f = setup(t);
  f.db.db.prepare('INSERT INTO contact_limits VALUES (?,1,?)').run('expired', Date.now() - 1);
  f.db.db.prepare('INSERT INTO contact_limits VALUES (?,1,?)').run('active', Date.now() + 60000);
  await cleanupContact(f.env);
  assert.deepEqual(f.db.db.prepare('SELECT key FROM contact_limits').all().map(row => row.key), ['active']);
  assert.equal((await f.call()).status, 200);
});

test('counter cleanup is bounded and repeated batches clear expired rows', async t => {
  const f = setup(t); const add = f.db.db.prepare('INSERT INTO contact_limits VALUES (?,1,0)');
  for (let i = 0; i < 501; i++) add.run(`expired-${i}`);
  await cleanupContact(f.env); assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM contact_limits').get().n, 1);
  await cleanupContact(f.env); assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM contact_limits').get().n, 0);
});

test('public scheduled handler cleans expired counters without contact traffic', async t => {
  const f = setup(t);
  f.db.db.prepare('INSERT INTO contact_limits VALUES (?,1,0)').run('expired-with-no-traffic');
  const pending = [];
  await createWorker().scheduled({}, f.env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM contact_limits').get().n, 0);
});

test('malformed JSON, oversized declared/actual bodies and content encodings are rejected', async t => {
  const f = setup(t);
  assert.equal((await f.call(null, { raw: '{' })).status, 400);
  assert.equal((await f.call(null, { raw: 'x'.repeat(24577) })).status, 413);
  assert.equal((await f.call(valid(), { headers: { 'Content-Length': '999999' } })).status, 413);
  assert.equal((await f.call(valid(), { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await f.call(valid(), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(f.sent.length, 0);
});

test('strict origins, narrow preflight and missing Resend secrets fail closed', async t => {
  const f = setup(t);
  for (const origin of [null, 'https://evil.example', 'https://asmixes.com.evil.example']) {
    const r = await f.call(valid(), { origin }); assert.equal(r.status, 403); assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal((await f.call(valid(), { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } })).status, 204);
  assert.equal((await f.call(valid(), { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'PUT' } })).status, 403);
  assert.equal((await f.call(valid(), { method: 'GET' })).status, 405);
  delete f.env.RESEND_API_KEY; assert.equal((await f.call()).status, 503);
});

test('production routing exposes contact only in public mode and keeps other routes read-only', async t => {
  const f = setup(t); const worker = createWorker();
  const request = (path, method = 'POST') => new Request('https://portfolio.example.workers.dev' + path, { method, headers: { Origin: f.env.PUBLIC_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(valid()) });
  delete f.env.RESEND_API_KEY;
  assert.equal((await worker.fetch(request('/api/contact'), f.env)).status, 503);
  assert.equal((await worker.fetch(request('/api/projects'), f.env)).status, 405);
  assert.equal((await worker.fetch(request('/api/contact'), { ...f.env, APP_MODE: 'admin', ADMIN_ORIGIN: 'https://portfolio.example.workers.dev' })).status, 503);
});

test('missing or malformed provider credentials and recipients fail before any outbound call', async t => {
  for (const patch of [{ RESEND_API_KEY: undefined }, { RESEND_API_KEY: 'key\r\nInjected: yes' }, { CONTACT_RECIPIENT: undefined }, { CONTACT_RECIPIENT: 'a@example.com,b@example.com' }, { CONTACT_RECIPIENT: 'a@example.com\r\nBcc: b@example.com' }, { TURNSTILE_SECRET: undefined }, { CONTACT_RATE_SECRET: undefined }]) {
    const f = setup(t); Object.assign(f.env, patch);
    const response = await f.call(); assert.equal(response.status, 503);
    assert.equal(f.verified.length, 0); assert.equal(f.sent.length, 0);
    assert.doesNotMatch(await response.text(), /recipient@example|test-only|RESEND_API_KEY|CONTACT_RECIPIENT/);
  }
});
