import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { fixture, edgeBindings } from './helpers.mjs';
import { createContactHandler } from '../src/contact.mjs';

const deniedDB = { prepare() { throw new Error('Unexpected D1 access'); } };
const deniedR2 = { head() { throw new Error('Unexpected R2 access'); }, get() { throw new Error('Unexpected R2 access'); } };
const config = JSON.parse(readFileSync(new URL('../wrangler.public.jsonc', import.meta.url), 'utf8'));

test('contact edge denial and limiter failures precede D1, body reading and verification', async () => {
  const handler = createContactHandler(() => { throw new Error('Unexpected outbound call'); });
  for (const binding of ['CONTACT_IP_RATE', 'CONTACT_TOTAL_RATE']) {
    for (const failure of ['deny', 'missing', 'unavailable']) {
      const env = { ...config.vars, ...edgeBindings(), DB: deniedDB, RESEND_API_KEY: 'test-only-key',
        CONTACT_RECIPIENT: 'owner@example.com', TURNSTILE_SECRET: 'test', CONTACT_RATE_SECRET: 'x'.repeat(32) };
      env[binding] = failure === 'missing' ? undefined : { async limit() {
        if (failure === 'unavailable') throw new Error('private binding error');
        return { success: false };
      } };
      const response = await handler(new Request('https://api.example/api/contact', { method: 'POST',
        headers: { Origin: config.vars.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' }, body: 'invalid JSON' }), env);
      assert.equal(response.status, failure === 'deny' ? 429 : 503);
      if (failure === 'deny') assert.equal(response.headers.get('Retry-After'), '60');
      assert.doesNotMatch(await response.text(), /Unexpected|private/);
    }
  }
});

test('public read denial, missing IP and unavailable protection never access D1/R2', async t => {
  const f = await fixture(t);
  f.env.DB = { ...deniedDB, db: f.env.DB.db }; f.env.MEDIA = deniedR2;
  for (const binding of ['READ_IP_RATE', 'READ_TOTAL_RATE']) {
    f.env[binding] = { async limit() { return { success: false }; } };
    for (const [path, method, headers] of [['/api/projects', 'GET', {}], ['/media/00000000-0000-4000-8000-000000000000', 'GET', { Range: 'bytes=0-9' }], ['/media/00000000-0000-4000-8000-000000000000', 'HEAD', {}]]) {
      const response = await f.call(path, { mode: 'public', method, headers });
      assert.equal(response.status, 429); assert.equal(response.headers.get('Retry-After'), '60');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    f.env[binding] = edgeBindings()[binding];
  }
  assert.equal((await f.call('/api/projects', { mode: 'public', headers: { 'CF-Connecting-IP': '' } })).status, 503);
  delete f.env.READ_IP_RATE;
  assert.equal((await f.call('/api/projects', { mode: 'public' })).status, 503);
});

test('contact requests do not clean expired counters', async t => {
  const f = await fixture(t);
  f.env.DB.db.exec(readFileSync(new URL('../migrations/0002_contact_limits.sql', import.meta.url), 'utf8'));
  f.env.DB.db.prepare('INSERT INTO contact_limits VALUES (?,1,0)').run('expired');
  Object.assign(f.env, { ...config.vars, RESEND_API_KEY: 'test-only-key', CONTACT_RECIPIENT: 'owner@example.com', TURNSTILE_SECRET: 'test', CONTACT_RATE_SECRET: 'x'.repeat(32) });
  const handler = createContactHandler(async () => Response.json({ success: false }));
  await handler(new Request('https://api.example/api/contact', { method: 'POST', headers: { Origin: config.vars.PUBLIC_ORIGIN,
    'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' }, body: '{}' }), f.env);
  assert.equal(f.env.DB.db.prepare("SELECT count FROM contact_limits WHERE key='expired'").get().count, 1);
});

test('allowed seeks use one R2 get and no R2 head; HEAD and invalid ranges keep their semantics', async t => {
  const f = await fixture(t); let p = await f.complete(); p = await (await f.update(p, { published: true })).json();
  let heads = 0, gets = 0;
  const originalHead = f.env.MEDIA.head.bind(f.env.MEDIA), originalGet = f.env.MEDIA.get.bind(f.env.MEDIA);
  f.env.MEDIA.head = (...args) => { heads++; return originalHead(...args); };
  f.env.MEDIA.get = (...args) => { gets++; return originalGet(...args); };
  for (const [range, expected] of [['bytes=0-9', 'bytes 0-9/834'], ['bytes=400-499', 'bytes 400-499/834'], ['bytes=-10', 'bytes 824-833/834'], ['bytes=800-', 'bytes 800-833/834']]) {
    const response = await f.call(p.audioUrl, { mode: 'public', headers: { Range: range } });
    assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), expected);
    assert.equal((await response.arrayBuffer()).byteLength, Number(response.headers.get('Content-Length')));
  }
  assert.equal(heads, 0); assert.equal(gets, 4);
  assert.equal((await f.call(p.audioUrl, { mode: 'public', method: 'HEAD', headers: { Range: 'bytes=0-9' } })).status, 206);
  assert.equal(heads, 1); assert.equal(gets, 4);
  assert.equal((await f.call(p.audioUrl, { mode: 'public', headers: { Range: 'bytes=9999-' } })).status, 416);
  assert.equal(heads, 1); assert.equal(gets, 4);
});

test('GitHub Pages CSP precedes assets and permits exactly the actual external dependencies', () => {
  const root = new URL('../../dist/', import.meta.url), window = {};
  vm.runInNewContext(readFileSync(new URL('assets/portfolio-config.js', root), 'utf8'), { window });
  const api = window.AS_MIXES_PORTFOLIO.apiOrigin;
  for (const filename of ['index.html', 'admin/index.html']) {
    const html = readFileSync(new URL(filename, root), 'utf8');
    const tag = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
    assert.ok(tag); assert.ok(tag.index < html.indexOf('<link')); assert.ok(tag.index < html.indexOf('<script'));
    const directives = Object.fromEntries(tag[1].split(';').map(s => s.trim().split(/\s+/)).map(([key, ...values]) => [key, values]));
    assert.deepEqual(directives['default-src'], ["'none'"]);
    assert.deepEqual(directives['style-src'], ["'self'"]);
    assert.doesNotMatch(tag[1], /unsafe-inline|unsafe-eval|\*|data:|blob:|frame-ancestors/);
    assert.doesNotMatch(html, /\s(?:style|on\w+)\s*=|<script\b[^>]*>\s*[^<\s]/i);
    if (filename === 'index.html') {
      assert.deepEqual(directives['script-src'], ["'self'", 'https://challenges.cloudflare.com']);
      assert.deepEqual(directives['frame-src'], ['https://challenges.cloudflare.com']);
      for (const directive of ['connect-src', 'media-src']) assert.deepEqual(directives[directive], [api]);
      assert.deepEqual(directives['img-src'], ["'self'", api]);
    }
  }
  for (const name of readdirSync(new URL('assets/', root)).filter(name => /\.(css|js)$/.test(name))) {
    const source = readFileSync(new URL(`assets/${name}`, root), 'utf8');
    assert.doesNotMatch(source, /@import|url\(|\beval\s*\(|new Function|\.innerHTML\s*=|setAttribute\(['"]style/);
  }
});

test('production edge namespaces and thresholds are separate', () => {
  assert.equal(new Set(config.ratelimits.map(value => value.namespace_id)).size, 4);
  assert.deepEqual(config.ratelimits.map(value => value.simple), [
    { limit: 10, period: 60 }, { limit: 120, period: 60 }, { limit: 240, period: 60 }, { limit: 3000, period: 60 },
  ]);
});
