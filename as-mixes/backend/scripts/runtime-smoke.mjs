// Offline smoke test of the bundled production code in workerd/Miniflare.
// Miniflare comes with the locked Wrangler installation; no cloud account is used.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey); jwk.kid = 'runtime-test';
const origin = 'https://admin.example.workers.dev';
const bindings = { DB: 'runtime-portfolio', MEDIA: 'runtime-media' };
const options = { modules: true, compatibilityDate: '2026-10-08', d1Databases: { DB: bindings.DB }, r2Buckets: { MEDIA: bindings.MEDIA } };
const publicConfig = JSON.parse(await readFile(new URL('../wrangler.public.jsonc', import.meta.url), 'utf8'));
const ratelimits = Object.fromEntries(publicConfig.ratelimits.map(({ name, ...value }) => [name, value]));
const contactOrigin = 'https://asmixes.com';
const contactSecrets = { RESEND_API_KEY: 'test-only-resend-key', CONTACT_RECIPIENT: 'recipient@example.com',
  TURNSTILE_SECRET: 'test-only-turnstile-secret', CONTACT_RATE_SECRET: 'test-only-hmac-secret-at-least-32-characters' };
const outboundRequests = [], unexpectedDestinations = [];
let providerStatus = 200, providerBody = { id: 'offline-acceptance-id' };
let verification = { success: true, hostname: 'asmixes.com', action: 'contact' };
// Intercept the entire outgoing service, not global.fetch: workerd must construct
// and execute the real fetch request, including validating its redirect mode.
const mockContactNetwork = async request => {
  const url = new URL(request.url);
  outboundRequests.push(url.origin + url.pathname);
  if (url.href === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('Authorization'), null);
    return Response.json(verification);
  }
  if (url.href === 'https://api.resend.com/emails') {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('Authorization'), `Bearer ${contactSecrets.RESEND_API_KEY}`);
    const payload = await request.json();
    assert.equal(payload.from, 'contact@asmixes.com');
    assert.deepEqual(payload.to, [contactSecrets.CONTACT_RECIPIENT]);
    assert.equal(payload.reply_to, 'artist@example.com');
    assert.equal(payload.html, undefined);
    return new Response(typeof providerBody === 'string' ? providerBody : JSON.stringify(providerBody), {
      status: providerStatus, headers: { 'Content-Type': 'application/json',
        ...(providerStatus >= 300 && providerStatus < 400 ? { Location: 'https://redirect-target.invalid/leak' } : {}) },
    });
  }
  // A redirect must never reach this destination or carry Authorization to it.
  unexpectedDestinations.push(url.origin);
  return new Response('Unexpected outbound destination blocked by offline test', { status: 500 });
};
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
  { ...options, name: 'public', ratelimits, routes: ['api.asmixes.com/*', 'konketf.github.io/*'], scriptPath: fileURLToPath(new URL('../build/public/worker.js', import.meta.url)), bindings: { APP_MODE: 'public', PUBLIC_ORIGIN: 'https://konketf.github.io' }, outboundService: mockContactNetwork },
  { ...options, name: 'contact', ratelimits: Object.fromEntries(Object.entries(ratelimits).map(([name, value]) => [name, { ...value, simple: { ...value.simple, limit: 1000 } }])), routes: ['contact.example.workers.dev/*', 'asmixes.com/*'], scriptPath: fileURLToPath(new URL('../build/public/worker.js', import.meta.url)),
    bindings: { APP_MODE: 'public', PUBLIC_ORIGIN: contactOrigin,
      CONTACT_ALLOWED_ORIGINS: JSON.stringify([contactOrigin, 'https://www.asmixes.com']), ...contactSecrets },
    outboundService: mockContactNetwork },
  { ...options, name: 'limited', scriptPath: fileURLToPath(new URL('../build/public/worker.js', import.meta.url)),
    ratelimits: Object.fromEntries(Object.entries(ratelimits).map(([name, value], i) => [name, {
      namespace_id: String(2001 + i), simple: { limit: 1, period: 60 },
    }])), bindings: { APP_MODE: 'public', PUBLIC_ORIGIN: contactOrigin, ...contactSecrets }, outboundService: mockContactNetwork },
  { ...options, name: 'admin', routes: ['admin.example.workers.dev/*'], scriptPath: fileURLToPath(new URL('../build/admin/worker.js', import.meta.url)), bindings: { APP_MODE: 'admin', ADMIN_ORIGIN: origin, ADMIN_EMAIL: 'owner@example.com', ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', ACCESS_AUD: 'runtime-audience', STORAGE_QUOTA_BYTES: '1073741824' }, outboundService: 'jwks', serviceBindings: { ASSETS: async () => new Response('<!doctype html><title>Admin fixture</title>', { headers: { 'Content-Type': 'text/html' } }) } },
  { name: 'jwks', modules: true, script: `export default { fetch() { return Response.json(${JSON.stringify({ keys: [jwk] })}); } };` },
] }));

try {
  await mf.ready;
  const db = await mf.getD1Database('DB', 'admin');
  const schema = (await readFile(new URL('../migrations/0001_portfolio.sql', import.meta.url), 'utf8')) + '\n' + (await readFile(new URL('../migrations/0002_contact_limits.sql', import.meta.url), 'utf8'));
  for (const sql of schema.split(';').filter(value => value.trim())) await db.prepare(sql).run();
  const limited = await mf.getWorker('limited');
  for (const path of ['/api/contact', '/api/projects']) {
    const init = { method: path.endsWith('contact') ? 'POST' : 'GET',
      headers: { Origin: contactOrigin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.99' },
      ...(path.endsWith('contact') ? { body: '{}' } : {}) };
    assert.equal((await limited.fetch('https://limited.example' + path, init)).status, path.endsWith('contact') ? 400 : 200);
    const denied = await limited.fetch('https://limited.example' + path, init);
    assert.equal(denied.status, 429); assert.equal(denied.headers.get('Retry-After'), '60');
    init.headers['CF-Connecting-IP'] = '192.0.2.100';
    assert.equal((await limited.fetch('https://limited.example' + path, init)).status, 429);
  }
  console.log('Local edge bindings passed: per-IP and aggregate rejection for contact and public reads.');
  const admin = await mf.getWorker('admin'), publicWorker = await mf.getWorker('public');
  // Contact configuration is intentionally absent: production code must fail closed.
  const contact = await publicWorker.fetch('https://api.asmixes.com/api/contact', { method: 'POST', headers: { Origin: 'https://konketf.github.io', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(contact.status, 503);
  const preflight = await publicWorker.fetch('https://api.asmixes.com/api/contact', { method: 'OPTIONS', headers: { Origin: 'https://konketf.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  const contactWorker = await mf.getWorker('contact');
  const submit = () => contactWorker.fetch('https://api.asmixes.com/api/contact', {
    method: 'POST', headers: { Origin: contactOrigin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
    body: JSON.stringify({ name: 'Offline fixture', email: 'artist@example.com', service: 'Mixing',
      trackCount: 60, message: 'Offline runtime regression fixture.', token: 'offline-test-token' }),
  });
  const providerCases = [
    { label: 'accepted', status: 200, body: { id: 'offline-acceptance-id' } },
    ...[301, 302, 303, 307, 308, 401, 403, 422, 429, 500].map(status => ({
      label: `HTTP ${status}`, status, body: { error: 'fixture provider detail' },
    })),
    { label: 'invalid JSON', status: 200, body: 'fixture provider detail' },
    { label: 'missing acceptance', status: 200, body: {} },
  ];
  for (const scenario of providerCases) {
    // Only this test's ephemeral local counter table is reset. No remote bindings.
    await db.prepare('DELETE FROM contact_limits').run();
    outboundRequests.length = 0;
    providerStatus = scenario.status; providerBody = scenario.body;
    const response = await submit(), result = await response.json();
    assert.equal(response.status, scenario.label === 'accepted' ? 200 : 503, scenario.label);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), contactOrigin);
    assert.deepEqual(outboundRequests, ['https://challenges.cloudflare.com/turnstile/v0/siteverify', 'https://api.resend.com/emails'], scenario.label);
    if (scenario.label === 'accepted') {
      assert.equal(result.accepted, true);
      assert.match(result.message, /has been accepted/);
    } else {
      assert.deepEqual(result, { error: 'Messages cannot be sent right now. Please try again later or email contact@asmixes.com.' });
    }
  }
  for (const rejectedVerification of [
    { success: false }, { success: true, hostname: 'wrong.invalid', action: 'contact' },
    { success: true, hostname: 'asmixes.com', action: 'wrong' },
  ]) {
    await db.prepare('DELETE FROM contact_limits').run();
    outboundRequests.length = 0; verification = rejectedVerification;
    const response = await submit();
    assert.equal(response.status, 400);
    assert.deepEqual(outboundRequests, ['https://challenges.cloudflare.com/turnstile/v0/siteverify']);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM contact_limits WHERE key LIKE 'global:%'").first()).count, 0);
  }
  assert.deepEqual(unexpectedDestinations, []);
  console.log(`Local contact runtime passed: ${providerCases.length} provider scenarios, Turnstile hostname/action rejection, and zero unmocked outbound requests.`);
  const jwt = await new SignJWT({ email: 'owner@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'runtime-test' }).setIssuer('https://test-team.cloudflareaccess.com').setAudience('runtime-audience').setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const call = async (path, method = 'GET', body, revision) => {
    const headers = { 'Cf-Access-Jwt-Assertion': jwt, Origin: origin, 'X-AS-Mixes-Request': '1' };
    if (revision) headers['X-Project-Revision'] = String(revision);
    if (body && !(body instanceof Uint8Array)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const response = await admin.fetch(origin + path, { method, headers, body });
    const data = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  };
  assert.equal((await admin.fetch(origin + '/admin/')).status, 401);
  assert.equal((await admin.fetch(origin + '/admin/admin.js')).status, 401);
  assert.equal((await admin.fetch(origin + '/admin/', { headers: { 'Cf-Access-Jwt-Assertion': jwt } })).status, 200);
  assert.equal((await call('/api/admin/session')).email, 'owner@example.com');
  let project = await call('/api/admin/projects', 'POST', { title: 'Runtime preview', artist: 'Test artist' });
  const mp3 = new Uint8Array(834); mp3.set([255,251,144,0],0); mp3.set([255,251,144,0],417);
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCuoAAAAASUVORK5CYII=', 'base64'));
  project = await call(`/api/admin/projects/${project.id}/audio`, 'PUT', mp3, project.revision);
  project = await call(`/api/admin/projects/${project.id}/artwork`, 'PUT', png, project.revision);
  const publicCall = path => publicWorker.fetch('https://api.asmixes.com' + path, { headers: { Origin: 'https://konketf.github.io', 'CF-Connecting-IP': '192.0.2.1' } });
  assert.equal((await publicCall(project.audioUrl)).status, 404);
  const edit = published => ({ title: project.title, artist: project.artist, description: project.description, credit: project.credit, published, revision: project.revision });
  project = await call(`/api/admin/projects/${project.id}`, 'PATCH', edit(true));
  assert.equal((await (await publicCall('/api/projects')).json()).projects.length, 1);
  const media = await publicWorker.fetch('https://api.asmixes.com' + project.audioUrl, { headers: { Range: 'bytes=0-9', 'CF-Connecting-IP': '192.0.2.1' } });
  assert.equal(media.status, 206); assert.equal((await media.arrayBuffer()).byteLength, 10);
  project = await call(`/api/admin/projects/${project.id}`, 'PATCH', edit(false));
  assert.equal((await publicCall(project.audioUrl)).status, 404);
  await call(`/api/admin/projects/${project.id}`, 'DELETE', { revision: project.revision });
  assert.equal((await call('/api/admin/projects')).projects.length, 0);
  console.log('Local Workers runtime passed: JWT/JWKS authentication, protected assets, real D1/R2 uploads, publish/unpublish, byte ranges and deletion.');
} finally { await mf.dispose(); }
