# AS Mixes

A buildless, responsive portfolio for a rock and metal mixing/mastering engineer. Plain HTML, CSS, and JavaScript; no frontend framework or UI libraries. The contact form uses Cloudflare Turnstile and sends through Resend from a Cloudflare Worker.

## Files

- `dist/index.html` — content and page structure
- `dist/assets/styles.css` — styling and responsive layouts
- `dist/assets/site.js` — navigation and service selection
- `dist/assets/contact.js` — verified contact submissions and retry handling

Open `dist/index.html` directly or serve `dist/` with any static web server. Deploy `dist/` to a static host; no build step is needed.

## Portfolio admin

A Cloudflare Workers backend, private R2 media storage, D1 metadata, and a Cloudflare Access-protected admin dashboard are in `backend/`. GitHub Pages remains the public frontend. See [deployment instructions](backend/DEPLOYMENT.md) and [security boundaries](backend/SECURITY.md). Cloudflare resources, owner credentials, and Access policies are managed separately from Pages.

After one-time setup, manage projects at the admin Worker's `/admin/`: upload audio/artwork, edit details, reorder, publish/unpublish, and delete. Published projects load automatically through `dist/assets/portfolio.js`. The deployed Worker URLs are configured in `dist/assets/portfolio-config.js`.

## GitHub Pages

The repository-root `.github/workflows/pages.yml` uploads only `as-mixes/dist` by default. Its optional `fallback` input publishes a generated copy with the form disabled and direct email contact available; backend files are never website assets. It runs manually on `main`; pushing does not deploy automatically. The canonical website is `https://asmixes.com`, with the existing www redirect retained. See the [deployment instructions](backend/DEPLOYMENT.md#5-connect-github-pages-once) and the reviewed fallback/release procedure there. This workflow never deploys Cloudflare and needs no Cloudflare secrets.

## Customize before client use

The site uses the AS Mixes identity and fixed service prices. Replace the illustrative portfolio entries with your own credited artwork and audio using the private dashboard. The contact form submits to the public Worker's `/api/contact` after mandatory Turnstile verification. It stays disabled until a real public Turnstile site key is configured. Resend domain verification, Worker secrets, and the counter migration are also required; see [contact setup](backend/DEPLOYMENT.md#contact-form-email-delivery). The private recipient and API key are never stored in the frontend or tracked configuration.

Accessibility includes semantic landmarks, labelled controls, a skip link, visible keyboard focus, reduced-motion support, and an accessible mobile menu.
