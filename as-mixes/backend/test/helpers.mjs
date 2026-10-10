import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { verifyAdmin } from '../src/auth.mjs';
import { createWorker } from '../src/worker.mjs';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey); jwk.kid = 'test-key';
const keys = createLocalJWKSet({ keys: [jwk] });
export async function token(overrides = {}, key = privateKey, omit = []) {
  const payload = { email: 'owner@example.com', sub: 'owner-id', iss: 'https://test-team.cloudflareaccess.com', aud: 'test-audience', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...overrides };
  for (const field of omit) delete payload[field];
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(key);
}
export const edgeBindings = () => Object.fromEntries(
  ['CONTACT_IP_RATE', 'CONTACT_TOTAL_RATE', 'READ_IP_RATE', 'READ_TOTAL_RATE']
    .map(name => [name, { async limit() { return { success: true }; } }])
);

export class D1SQLite {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(new URL('../migrations/0001_portfolio.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const db = this.db;
    let params = [];
    const statement = {
      bind(...values) { params = values; return statement; },
      async first() { return db.prepare(sql).get(...params) ?? null; },
      async all() { return { results: db.prepare(sql).all(...params) }; },
      async run() { const result = db.prepare(sql).run(...params); return { meta: { changes: Number(result.changes) } }; },
    };
    return statement;
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.db.exec('COMMIT'); return results; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
export class MemoryR2 {
  objects = new Map(); deletions = []; failPut = false; failDelete = false; beforePut = null;
  async put(key, bytes, options) {
    if (this.beforePut) await this.beforePut();
    if (this.failPut) throw new Error('Simulated storage failure.');
    this.objects.set(key, { bytes: bytes.slice(), options });
  }
  async head(key) { const item = this.objects.get(key); return item ? { size: item.bytes.length } : null; }
  async get(key, options) {
    const item = this.objects.get(key); if (!item) return null;
    const range = options?.range;
    const bytes = range ? item.bytes.slice(range.offset, range.offset + range.length) : item.bytes;
    return { body: new Blob([bytes]).stream(), size: item.bytes.length };
  }
  async delete(key) { if (this.failDelete) throw new Error('Simulated deletion failure.'); this.deletions.push(key); this.objects.delete(key); }
}
export async function fixture(t) {
  const env = { ...edgeBindings(), APP_MODE: 'admin', DB: new D1SQLite(), MEDIA: new MemoryR2(), ADMIN_ORIGIN: 'https://admin.example.workers.dev', PUBLIC_ORIGIN: 'https://konketf.github.io', ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', ACCESS_AUD: 'test-audience', ADMIN_EMAIL: 'owner@example.com', STORAGE_QUOTA_BYTES: '1073741824' };
  const jwt = await token();
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const worker = createWorker((request, values) => verifyAdmin(request, values, keys));
  const call = async (path, { method = 'GET', body, headers = {}, anonymous = false, mode = 'admin', flush = true } = {}) => {
    const origin = mode === 'admin' ? env.ADMIN_ORIGIN : 'https://public.example.workers.dev';
    const requestHeaders = new Headers({ 'CF-Connecting-IP': '192.0.2.1', ...headers });
    if (mode === 'admin' && !anonymous) requestHeaders.set('Cf-Access-Jwt-Assertion', jwt);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (!requestHeaders.has('Origin')) requestHeaders.set('Origin', env.ADMIN_ORIGIN);
      if (!requestHeaders.has('X-AS-Mixes-Request')) requestHeaders.set('X-AS-Mixes-Request', '1');
    }
    if (body !== undefined && !(body instanceof Uint8Array)) { requestHeaders.set('Content-Type', 'application/json'); body = JSON.stringify(body); }
    const response = await worker.fetch(new Request(origin + path, { method, headers: requestHeaders, body }), { ...env, APP_MODE: mode }, ctx);
    if (flush) await Promise.all(pending.splice(0));
    return response;
  };
  t.after(() => env.DB.db.close());
  const create = async (title = 'Example song') => { const r = await call('/api/admin/projects', { method: 'POST', body: { title, artist: 'Example band' } }); if (r.status !== 201) throw new Error(await r.text()); return r.json(); };
  const update = async (p, overrides = {}) => { const response = await call('/api/admin/projects/' + p.id, { method: 'PATCH', body: { title: p.title, artist: p.artist, description: p.description, credit: p.credit, published: p.published, revision: p.revision, ...overrides } }); return response; };
  const upload = async (p, kind, bytes = kind === 'audio' ? mp3() : png(), options = {}) => call(`/api/admin/projects/${p.id}/${kind}`, { ...options, method: 'PUT', body: bytes, headers: { 'X-Project-Revision': String(p.revision), ...options.headers } });
  const complete = async title => { let p = await create(title); p = await (await upload(p, 'audio')).json(); p = await (await upload(p, 'artwork')).json(); return p; };
  return { env, worker, ctx, pending, call, create, update, upload, complete, jwt, keys };
}
export function mp3() {
  const bytes = new Uint8Array(834);
  bytes.set([255,251,144,0], 0); bytes.set([255,251,144,0], 417);
  return bytes;
}
export function wav() {
  const bytes = new Uint8Array(46), view = new DataView(bytes.buffer), text = new TextEncoder();
  bytes.set(text.encode('RIFF')); view.setUint32(4, 38, true); bytes.set(text.encode('WAVEfmt '), 8); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 44100, true); view.setUint32(28, 88200, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set(text.encode('data'), 36); view.setUint32(40, 2, true); return bytes;
}
export function png() { return new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCuoAAAAASUVORK5CYII=', 'base64')); }
