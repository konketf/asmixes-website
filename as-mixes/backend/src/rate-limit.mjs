import { HttpError } from './auth.mjs';

// Cloudflare supplies this header. Never use a client-selected forwarding header.
// Bindings are edge-local and approximate; durable email caps remain in D1.
export async function requireEdgeLimit(request, env, group) {
  const ip = request.headers.get('CF-Connecting-IP');
  const perIP = env[`${group}_IP_RATE`], aggregate = env[`${group}_TOTAL_RATE`];
  if (!ip || ip.length > 64 || !/^[0-9a-f:.]+$/i.test(ip) || !perIP?.limit || !aggregate?.limit) {
    throw new HttpError(503, 'Request protection is unavailable. Please try again later.');
  }
  try {
    if (!(await perIP.limit({ key: ip })).success || !(await aggregate.limit({ key: 'all' })).success) {
      const error = new HttpError(429, 'Too many requests. Please wait a minute before trying again.');
      error.retryAfter = '60';
      throw error;
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'Request protection is unavailable. Please try again later.');
  }
}
