import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { prepareFallback } from '../scripts/prepare-fallback.mjs';
import fallback from '../src/fallback.mjs';
import worker from '../src/worker.mjs';
import { D1SQLite, fixture, edgeBindings } from './helpers.mjs';

const config = JSON.parse(readFileSync(new URL('../wrangler.public.jsonc', import.meta.url), 'utf8'));
test('production configuration permits both HTTPS contact origins and canonical portfolio access', async t => {
  const DB = new D1SQLite(); t.after(() => DB.db.close());
  assert.equal(config.vars.PUBLIC_ORIGIN, 'https://asmixes.com');
  assert.deepEqual(JSON.parse(config.vars.CONTACT_ALLOWED_ORIGINS), ['https://asmixes.com', 'https://www.asmixes.com']);
  for (const origin of JSON.parse(config.vars.CONTACT_ALLOWED_ORIGINS)) {
    const response = await worker.fetch(new Request('https://api.asmixes.com/api/contact', { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
    } }), config.vars);
    assert.equal(response.status, 204); assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  }
  for (const target of [worker, fallback]) {
    const response = await target.fetch(new Request('https://api.asmixes.com/api/projects', { headers: { Origin: config.vars.PUBLIC_ORIGIN, 'CF-Connecting-IP': '192.0.2.1' } }), { ...config.vars, ...edgeBindings(), DB });
    assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), config.vars.PUBLIC_ORIGIN);
    const range = await target.fetch(new Request('https://api.asmixes.com/media/test', { method: 'OPTIONS', headers: {
      Origin: config.vars.PUBLIC_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range',
    } }), config.vars);
    assert.equal(range.status, 204);
    const admin = await target.fetch(new Request('https://api.asmixes.com/api/admin/projects'), { ...config.vars, ...edgeBindings(), DB });
    assert.equal(admin.status, 404);
  }
  const denied = await worker.fetch(new Request('https://api.asmixes.com/api/contact', { method: 'OPTIONS', headers: { Origin: 'https://attacker.example' } }), config.vars);
  assert.equal(denied.status, 403);
});

test('fallback preserves published audio seeking and draft privacy at the canonical origin', async t => {
  const f = await fixture(t);
  let project = await f.complete();
  const env = { ...f.env, ...config.vars };
  const call = () => fallback.fetch(new Request('https://api.asmixes.com' + project.audioUrl, {
    headers: { Origin: env.PUBLIC_ORIGIN, 'CF-Connecting-IP': '192.0.2.1', Range: 'bytes=0-9' },
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
  const response = await fallback.fetch(new Request('https://api.asmixes.com/api/contact', { method: 'POST', body: '{}' }), { APP_MODE: 'public' });
  assert.equal(response.status, 503); assert.match((await response.json()).error, /contact@asmixes.com/);
  const output = prepareFallback();
  const recovery = JSON.parse(readFileSync(path.join(output, 'wrangler.json'), 'utf8'));
  assert.deepEqual(recovery.routes, config.routes);
  assert.equal(recovery.workers_dev, true);
  assert.deepEqual(recovery.ratelimits, config.ratelimits);
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


test('custom API domain and workers.dev fallback preserve CORS, publication and seeks', async t => {
  const f = await fixture(t), window = {};
  vm.runInNewContext(readFileSync(new URL('../../dist/assets/portfolio-config.js', import.meta.url), 'utf8'), { window });
  assert.equal(window.AS_MIXES_PORTFOLIO.apiOrigin, 'https://api.asmixes.com');
  assert.equal(window.AS_MIXES_PORTFOLIO.adminOrigin, 'https://as-mixes-admin.aleksandr-sinitson.workers.dev');
  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.routes, [{ pattern: 'api.asmixes.com', custom_domain: true }]);
  let project = await f.complete(); project = await (await f.update(project, { published: true })).json();
  for (const host of ['https://api.asmixes.com', 'https://as-mixes-portfolio.aleksandr-sinitson.workers.dev']) {
    const env = { ...f.env, ...config.vars };
    const headers = { Origin: env.PUBLIC_ORIGIN, 'CF-Connecting-IP': '192.0.2.1' };
    const projects = await worker.fetch(new Request(host + '/api/projects', { headers }), env);
    assert.equal(projects.status, 200);
    assert.equal(projects.headers.get('Access-Control-Allow-Origin'), env.PUBLIC_ORIGIN);
    const published = (await projects.json()).projects[0];
    assert.equal(new URL(published.audioUrl, host).origin, host);
    for (const range of ['bytes=0-9', 'bytes=400-499', 'bytes=-10']) {
      const response = await worker.fetch(new Request(host + published.audioUrl, { headers: { ...headers, Range: range } }), env);
      assert.equal(response.status, 206);
      assert.equal((await response.arrayBuffer()).byteLength, Number(response.headers.get('Content-Length')));
    }
    const preflight = await worker.fetch(new Request(host + '/api/contact', { method: 'OPTIONS', headers: {
      Origin: env.PUBLIC_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
    } }), env);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), env.PUBLIC_ORIGIN);
    assert.equal((await worker.fetch(new Request(host + '/api/projects', { headers: { ...headers, Origin: host } }), env)).status, 403);
  }
});
