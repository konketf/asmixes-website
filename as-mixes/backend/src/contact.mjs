import { HttpError } from './auth.mjs';
import { readLimited } from './validation.mjs';

const encoder = new TextEncoder();
const invalid = () => { throw new HttpError(400, 'Check the form fields and try again.'); };
const unavailable = () => { throw new HttpError(503, 'Messages cannot be sent right now. Please try again later or email contact@asmixes.com.'); };
const day = 86400000;

function validMailbox(email) {
  return typeof email === 'string' && email.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(email) && email.split('@')[0].length <= 64 && !email.startsWith('.') && !email.includes('..') && !email.split('@')[0].endsWith('.');
}

export function contactOrigins(env) {
  try {
    const origins = JSON.parse(env.CONTACT_ALLOWED_ORIGINS || JSON.stringify([env.PUBLIC_ORIGIN]));
    if (!Array.isArray(origins) || !origins.length || origins.length > 5 || origins.some(origin => typeof origin !== 'string' || new URL(origin).origin !== origin || new URL(origin).protocol !== 'https:')) unavailable();
    return origins;
  } catch { unavailable(); }
}

export function contactFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  if (Object.keys(input).some(key => !['name', 'email', 'service', 'trackCount', 'message', 'token'].includes(key))) invalid();
  const text = (key, limit, multiline = false) => {
    if (typeof input[key] !== 'string') invalid();
    const value = input[key].trim().normalize('NFC');
    if (!value || value.length > limit || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) invalid();
    return value;
  };
  const name = text('name', 100), email = text('email', 254), service = text('service', 40);
  // Deliberately accept ordinary single mailbox addresses, never address lists or display-name syntax.
  if (!validMailbox(email)) invalid();
  if (!['Mixing', 'Mix + master', 'Mastering', 'Let’s figure it out'].includes(service)) invalid();
  const trackCount = input.trackCount;
  if (trackCount !== undefined && trackCount !== null && (!Number.isSafeInteger(trackCount) || trackCount < 1 || trackCount > 60)) invalid();
  const token = text('token', 2048);
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) invalid();
  return { name, email, service, trackCount, message: text('message', 5000, true), token };
}

function limitValue(value, fallback, max) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) unavailable();
  return n;
}

export async function cleanupContact(env) {
  // Indexed, bounded cleanup; repeat hourly and on contact requests. Expired rows never apply.
  await env.DB.prepare('DELETE FROM contact_limits WHERE key IN (SELECT key FROM contact_limits WHERE expires_at <= ? LIMIT 500)').bind(Date.now()).run();
}

async function reserve(env, key, expires, limit) {
  const result = await env.DB.prepare(`INSERT INTO contact_limits (key, count, expires_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=contact_limits.count+1 WHERE contact_limits.count < ?`).bind(key, expires, limit).run();
  return result.meta?.changes === 1;
}

async function ipLimit(request, env, now) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || ip.length > 64 || !/^[0-9a-f:.]+$/i.test(ip)) unavailable();
  // Daily rotation limits linkability. The HMAC key never leaves Worker secrets.
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.CONTACT_RATE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${Math.floor(now / day)}:${ip}`));
  const hash = [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const window = Math.floor(now / 600000);
  if (!await reserve(env, `ip:${window}:${hash}`, (window + 1) * 600000, limitValue(env.CONTACT_IP_LIMIT, 5, 50))) throw new HttpError(429, 'Too many attempts. Please wait 10 minutes before trying again.');
}

export function createContactHandler(outboundFetch = fetch) {
  return async function contact(request, env) {
    let allowedOrigin;
    const respond = (body, status = 200) => {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'X-Frame-Options': 'DENY', 'Strict-Transport-Security': 'max-age=31536000', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
      if (allowedOrigin) Object.assign(headers, { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      if (status === 429) headers['Retry-After'] = '600';
      return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
    };
    try {
      const origin = request.headers.get('Origin');
      if (!contactOrigins(env).includes(origin)) throw new HttpError(403, 'This request is not allowed.');
      allowedOrigin = origin;
      if (request.method === 'OPTIONS') {
        if (request.headers.get('Access-Control-Request-Method') !== 'POST' || (request.headers.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean).some(x => x !== 'content-type')) throw new HttpError(403, 'This request is not allowed.');
        return respond(null, 204);
      }
      if (request.method !== 'POST') throw new HttpError(405, 'This request is not allowed.');
      if (typeof env.RESEND_API_KEY !== 'string' || !/^[A-Za-z0-9_-]{10,256}$/.test(env.RESEND_API_KEY) || !validMailbox(env.CONTACT_RECIPIENT) || !env.TURNSTILE_SECRET || !env.CONTACT_RATE_SECRET || env.CONTACT_RATE_SECRET.length < 32 || !env.DB) unavailable();
      if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || request.headers.has('Content-Encoding')) throw new HttpError(415, 'This request is not allowed.');
      const now = Date.now();
      await cleanupContact(env);
      await ipLimit(request, env, now);
      let input;
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readLimited(request, 24 * 1024))); }
      catch (error) { if (error instanceof HttpError) throw error; invalid(); }
      const data = contactFields(input);
      let verification;
      try {
        const response = await outboundFetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: data.token }), signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) unavailable();
        verification = await response.json();
      } catch { unavailable(); }
      if (verification?.success !== true || verification.hostname !== new URL(origin).hostname || verification.action !== 'contact') throw new HttpError(400, 'Verification failed or expired. Please complete the verification again.');
      const bucket = Math.floor(Date.now() / day);
      if (!await reserve(env, `global:${bucket}`, (bucket + 1) * day, limitValue(env.CONTACT_DAILY_LIMIT, 100, 1000))) throw new HttpError(503, 'The contact form has reached its daily sending limit. Please try again tomorrow or email contact@asmixes.com directly.');
      // Recipient comes exclusively from a Worker secret, never submitted form fields.
      // Plain text only; customer-controlled content never becomes a MIME header.
      try {
        const response = await outboundFetch('https://api.resend.com/emails', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'contact@asmixes.com', to: [env.CONTACT_RECIPIENT], subject: 'AS Mixes — Project enquiry', reply_to: data.email,
            text: [`Name / band: ${data.name}`, `Email: ${data.email}`, `Service: ${data.service}`, ...(data.trackCount ? [`Audio tracks per mix: ${data.trackCount}`] : []), '', data.message].join('\n') }),
        });
        if (!response.ok) unavailable();
        const sent = await response.json();
        if (!sent || sent.error || typeof sent.id !== 'string' || !sent.id.trim()) unavailable();
      } catch { unavailable(); }
      return respond({ accepted: true, message: "Thanks — your message has been accepted. I'll get back to you by email." });
    } catch (error) {
      // Never log request bodies, tokens, provider errors or personal information.
      return respond({ error: error instanceof HttpError ? error.message : 'Messages cannot be sent right now. Please try again later or email contact@asmixes.com.' }, error instanceof HttpError ? error.status : 503);
    }
  };
}
export const handleContact = createContactHandler();
