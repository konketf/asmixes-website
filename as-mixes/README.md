# AS Mixes

A buildless, responsive portfolio template for a rock and metal mixing/mastering engineer. Plain HTML, CSS, and JavaScript; no packages, fonts, libraries, analytics, or remote assets.

## Files

- `dist/index.html` — content and page structure
- `dist/assets/styles.css` — styling and responsive layouts
- `dist/assets/site.js` — navigation, service selection, and email draft

Open `dist/index.html` directly or serve `dist/` with any static web server. Deploy `dist/` to a static host; no build step is needed.

## Portfolio admin

A Cloudflare Workers backend, private R2 media storage, D1 metadata, and a Cloudflare Access-protected admin dashboard are in `backend/`. GitHub Pages remains the public frontend. See [deployment instructions](backend/DEPLOYMENT.md) and [security boundaries](backend/SECURITY.md). No cloud resources have been deployed or credentials configured yet.

After one-time setup, manage projects at the admin Worker's `/admin/`: upload audio/artwork, edit details, reorder, publish/unpublish, and delete. Published projects load automatically through `dist/assets/portfolio.js`; set the public Worker URLs in `dist/assets/portfolio-config.js` once. Until configured, the existing static portfolio stays unchanged.

## Customize before client use

The site uses the AS Mixes identity. Replace the illustrative portfolio entries and indicative euro prices. Replace `hello@example.com` in both HTML and JavaScript. Portfolio graphics are CSS placeholders; add your actual credited artwork and audio when available. The contact form creates a mailto draft and does not send or store messages. For server-side submissions, connect your chosen form endpoint and update the explanatory copy.

Accessibility includes semantic landmarks, labelled controls, a skip link, visible keyboard focus, reduced-motion support, and an accessible mobile menu.
