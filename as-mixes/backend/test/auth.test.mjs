import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair } from 'jose';
import { fixture, token } from './helpers.mjs';
import { verifyAdmin } from '../src/auth.mjs';

test('valid Access JWT permits only the owner', async t => {
  const f = await fixture(t);
  const r = await f.call('/api/admin/session'); assert.equal(r.status, 200); assert.equal((await r.json()).email, 'owner@example.com');
});
for (const [label, claims, expected] of [
  ['wrong issuer', { iss: 'https://evil.example' }, 401],
  ['wrong audience', { aud: 'other-app' }, 401],
  ['expired token', { exp: 1 }, 401],
  ['not-yet-valid token', { nbf: Math.floor(Date.now() / 1000) + 10000 }, 401],
  ['different email', { email: 'someone@example.com' }, 403],
]) test('rejects ' + label, async t => {
  const f = await fixture(t), jwt = await token(claims);
  await assert.rejects(verifyAdmin(new Request(f.env.ADMIN_ORIGIN, { headers: { 'Cf-Access-Jwt-Assertion': jwt } }), f.env, f.keys), error => error.status === expected);
});
test('rejects forged signature and missing expiration', async t => {
  const f = await fixture(t), attacker = await generateKeyPair('RS256');
  for (const jwt of [await token({}, attacker.privateKey), await token({}, undefined, ['exp']), 'not.a.jwt']) {
    await assert.rejects(verifyAdmin(new Request(f.env.ADMIN_ORIGIN, { headers: { 'Cf-Access-Jwt-Assertion': jwt } }), f.env, f.keys), error => error.status === 401);
  }
});
test('all admin resources reject anonymous requests including spoofed email headers', async t => {
  const f = await fixture(t);
  for (const path of ['/admin/', '/admin/admin.js', '/assets/site.css', '/api/admin/projects', '/api/admin/session', '/media/00000000-0000-4000-8000-000000000000']) {
    const r = await f.call(path, { anonymous: true, headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' } }); assert.equal(r.status, 401, path);
  }
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) assert.equal((await f.call('/api/admin/projects', { method, anonymous: true, body: {} })).status, 401);
});
test('missing configuration fails closed', async t => {
  const f = await fixture(t); f.env.ADMIN_EMAIL = ''; assert.equal((await f.call('/api/admin/session')).status, 503);
});
test('rejects cross-origin mutation, preflight, and missing custom header', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/admin/projects', { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.call('/api/admin/projects', { method: 'POST', body: {}, headers: { 'X-AS-Mixes-Request': '0' } })).status, 403);
  assert.equal((await f.call('/api/admin/projects', { method: 'OPTIONS' })).status, 403);
});
test('public deployment exposes no write or admin interface', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/admin/projects', { mode: 'public' })).status, 404);
  assert.equal((await f.call('/admin/', { mode: 'public' })).status, 404);
  assert.equal((await f.call('/api/projects', { method: 'POST', body: {}, mode: 'public', headers: { Origin: f.env.PUBLIC_ORIGIN } })).status, 405);
});
test('CORS grants only configured public origin without credentials', async t => {
  const f = await fixture(t);
  const r = await f.call('/api/projects', { mode: 'public', headers: { Origin: f.env.PUBLIC_ORIGIN } });
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), f.env.PUBLIC_ORIGIN); assert.equal(r.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal((await f.call('/api/projects', { mode: 'public', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.call('/api/projects', { mode: 'public', method: 'OPTIONS', headers: { Origin: f.env.PUBLIC_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' } })).status, 204);
});
