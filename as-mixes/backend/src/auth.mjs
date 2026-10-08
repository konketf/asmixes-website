import { createRemoteJWKSet, jwtVerify } from 'jose';

const keySets = new Map();
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function verifyAdmin(request, env, testKeySet) {
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN || '') ||
      !env.ACCESS_AUD || env.ACCESS_AUD.startsWith('REPLACE-') || !env.ADMIN_EMAIL) {
    throw new HttpError(503, 'Admin access is not configured.');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16384) throw new HttpError(401, 'Sign in through Cloudflare Access.');
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let keys = testKeySet || keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
    keySets.set(issuer, keys);
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email'], clockTolerance: 5,
    }));
  } catch { throw new HttpError(401, 'Sign in again through Cloudflare Access.'); }
  if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) {
    throw new HttpError(403, 'This account cannot manage the portfolio.');
  }
  return payload.email;
}

export function requireSameOrigin(request, env) {
  const origin = request.headers.get('Origin');
  // A custom header forces cross-origin requests to preflight, which admin refuses.
  if (origin !== env.ADMIN_ORIGIN || request.headers.get('X-AS-Mixes-Request') !== '1') {
    throw new HttpError(403, 'Request origin is not allowed.');
  }
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') throw new HttpError(403, 'Request origin is not allowed.');
}
