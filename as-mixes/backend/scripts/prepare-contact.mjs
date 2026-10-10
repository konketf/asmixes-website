// Offline setup reminder only. Never reads secrets, creates files, or contacts providers.
console.log('Contact delivery uses Resend. See DEPLOYMENT.md: Contact form email delivery.');
console.log('Required public Worker secrets: RESEND_API_KEY, CONTACT_RECIPIENT, TURNSTILE_SECRET, CONTACT_RATE_SECRET.');
console.log('Configure only the public Turnstile site key in dist/assets/portfolio-config.js.');
console.log('Use wrangler.public.jsonc; no Cloudflare email binding or private deployment config is required.');
console.log('Wait for Resend sender-domain verification. No resources or settings were changed.');
