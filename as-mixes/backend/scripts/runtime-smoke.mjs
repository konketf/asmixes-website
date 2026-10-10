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
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
  { ...options, name: 'public', routes: ['public.example.workers.dev/*', 'konketf.github.io/*'], scriptPath: fileURLToPath(new URL('../build/public/worker.js', import.meta.url)), bindings: { APP_MODE: 'public', PUBLIC_ORIGIN: 'https://konketf.github.io' } },
  { ...options, name: 'admin', routes: ['admin.example.workers.dev/*'], scriptPath: fileURLToPath(new URL('../build/admin/worker.js', import.meta.url)), bindings: { APP_MODE: 'admin', ADMIN_ORIGIN: origin, ADMIN_EMAIL: 'owner@example.com', ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', ACCESS_AUD: 'runtime-audience', STORAGE_QUOTA_BYTES: '1073741824' }, outboundService: 'jwks', serviceBindings: { ASSETS: async () => new Response('<!doctype html><title>Admin fixture</title>', { headers: { 'Content-Type': 'text/html' } }) } },
  { name: 'jwks', modules: true, script: `export default { fetch() { return Response.json(${JSON.stringify({ keys: [jwk] })}); } };` },
] }));

try {
  await mf.ready;
  const db = await mf.getD1Database('DB', 'admin');
  const schema = (await readFile(new URL('../migrations/0001_portfolio.sql', import.meta.url), 'utf8')) + '\n' + (await readFile(new URL('../migrations/0002_contact_limits.sql', import.meta.url), 'utf8'));
  for (const sql of schema.split(';').filter(value => value.trim())) await db.prepare(sql).run();
  const admin = await mf.getWorker('admin'), publicWorker = await mf.getWorker('public');
  // Contact configuration is intentionally absent: production code must fail closed.
  const contact = await publicWorker.fetch('https://public.example.workers.dev/api/contact', { method: 'POST', headers: { Origin: 'https://konketf.github.io', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(contact.status, 503);
  const preflight = await publicWorker.fetch('https://public.example.workers.dev/api/contact', { method: 'OPTIONS', headers: { Origin: 'https://konketf.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.status, 204);
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
  const publicCall = path => publicWorker.fetch('https://public.example.workers.dev' + path, { headers: { Origin: 'https://konketf.github.io' } });
  assert.equal((await publicCall(project.audioUrl)).status, 404);
  const edit = published => ({ title: project.title, artist: project.artist, description: project.description, credit: project.credit, published, revision: project.revision });
  project = await call(`/api/admin/projects/${project.id}`, 'PATCH', edit(true));
  assert.equal((await (await publicCall('/api/projects')).json()).projects.length, 1);
  const media = await publicWorker.fetch('https://public.example.workers.dev' + project.audioUrl, { headers: { Range: 'bytes=0-9' } });
  assert.equal(media.status, 206); assert.equal((await media.arrayBuffer()).byteLength, 10);
  project = await call(`/api/admin/projects/${project.id}`, 'PATCH', edit(false));
  assert.equal((await publicCall(project.audioUrl)).status, 404);
  await call(`/api/admin/projects/${project.id}`, 'DELETE', { revision: project.revision });
  assert.equal((await call('/api/admin/projects')).projects.length, 0);
  console.log('Local Workers runtime passed: JWT/JWKS authentication, protected assets, real D1/R2 uploads, publish/unpublish, byte ranges and deletion.');
} finally { await mf.dispose(); }
