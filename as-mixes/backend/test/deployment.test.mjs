import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { prepareFallback } from '../scripts/prepare-fallback.mjs';
import fallback from '../src/fallback.mjs';
import worker from '../src/worker.mjs';
import { D1SQLite, fixture } from './helpers.mjs';

const config = JSON.parse(readFileSync(new URL('../wrangler.public.jsonc', import.meta.url), 'utf8'));
test('production configuration permits both HTTPS contact origins and canonical portfolio access', async t => {
  const DB = new D1SQLite(); t.after(() => DB.db.close());
  assert.equal(config.vars.PUBLIC_ORIGIN, 'https://asmixes.com');
  assert.deepEqual(JSON.parse(config.vars.CONTACT_ALLOWED_ORIGINS), ['https://asmixes.com', 'https://www.asmixes.com']);
  for (const origin of JSON.parse(config.vars.CONTACT_ALLOWED_ORIGINS)) {
    const response = await worker.fetch(new Request('https://api.example/api/contact', { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
    } }), config.vars);
    assert.equal(response.status, 204); assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  }
  for (const target of [worker, fallback]) {
    const response = await target.fetch(new Request('https://api.example/api/projects', { headers: { Origin: config.vars.PUBLIC_ORIGIN } }), { ...config.vars, DB });
    assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), config.vars.PUBLIC_ORIGIN);
    const range = await target.fetch(new Request('https://api.example/media/test', { method: 'OPTIONS', headers: {
      Origin: config.vars.PUBLIC_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range',
    } }), config.vars);
    assert.equal(range.status, 204);
    const admin = await target.fetch(new Request('https://api.example/api/admin/projects'), { ...config.vars, DB });
    assert.equal(admin.status, 404);
  }
  const denied = await worker.fetch(new Request('https://api.example/api/contact', { method: 'OPTIONS', headers: { Origin: 'https://attacker.example' } }), config.vars);
  assert.equal(denied.status, 403);
});

test('fallback preserves published audio seeking and draft privacy at the canonical origin', async t => {
  const f = await fixture(t);
  let project = await f.complete();
  const env = { ...f.env, ...config.vars };
  const call = () => fallback.fetch(new Request('https://api.example' + project.audioUrl, {
    headers: { Origin: env.PUBLIC_ORIGIN, Range: 'bytes=0-9' },
  }), env);
  assert.equal((await call()).status, 404);
  project = await (await f.update(project, { published: true })).json();
  const audio = await call();
  assert.equal(audio.status, 206); assert.equal(audio.headers.get('Access-Control-Allow-Origin'), env.PUBLIC_ORIGIN);
  assert.equal(audio.headers.get('Content-Range'), 'bytes 0-9/834'); assert.equal((await audio.arrayBuffer()).byteLength, 10);
  project = await (await f.update(project, { published: false })).json();
  assert.equal((await call()).status, 404);
});

test('fallback disables email before accessing secrets or storage and preserves public bindings', async () => {
  const response = await fallback.fetch(new Request('https://api.example/api/contact', { method: 'POST', body: '{}' }), { APP_MODE: 'public' });
  assert.equal(response.status, 503); assert.match((await response.json()).error, /contact@asmixes.com/);
  const output = prepareFallback();
  const recovery = JSON.parse(readFileSync(path.join(output, 'wrangler.json'), 'utf8'));
  assert.deepEqual(recovery.vars, config.vars); assert.deepEqual(recovery.r2_buckets, config.r2_buckets);
  assert.equal(recovery.d1_databases[0].database_id, config.d1_databases[0].database_id);
  assert.equal(recovery.name, config.name); assert.deepEqual(recovery.triggers, config.triggers);
  const window = {}; vm.runInNewContext(readFileSync(path.join(output, 'site/assets/portfolio-config.js'), 'utf8'), { window });
  assert.equal(window.AS_MIXES_PORTFOLIO.turnstileSiteKey, null);
  assert.match(window.AS_MIXES_PORTFOLIO.apiOrigin, /^https:\/\//);
  const html = readFileSync(path.join(output, 'site/index.html'), 'utf8');
  assert.match(html, /mailto:contact@asmixes.com/); assert.doesNotMatch(html, /hello@example.com/);
  assert.equal(readFileSync(path.join(output, 'site/assets/portfolio.js'), 'utf8'), readFileSync(new URL('../../dist/assets/portfolio.js', import.meta.url), 'utf8'));
  const active = {}; vm.runInNewContext(readFileSync(new URL('../../dist/assets/portfolio-config.js', import.meta.url), 'utf8'), { window: active });
  assert.equal(active.AS_MIXES_PORTFOLIO.turnstileSiteKey, '0x4AAAAAAFTIxAyb1vI8nf5M');
});
