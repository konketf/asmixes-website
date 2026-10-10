// Reviewed fallback: preserve portfolio/media and reject contact without sending.
import worker from './worker.mjs';

export default {
  fetch(request, env, ctx) {
    if (env.APP_MODE === 'public' && new URL(request.url).pathname === '/api/contact') {
      return Response.json({ error: 'Please email contact@asmixes.com directly.' }, { status: 503,
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    return worker.fetch(request, env, ctx);
  },
  scheduled: worker.scheduled,
};
