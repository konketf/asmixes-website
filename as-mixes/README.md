# AS Mixes

A buildless, responsive portfolio template for a rock and metal mixing/mastering engineer. Plain HTML, CSS, and JavaScript; no packages, fonts, libraries, analytics, or remote assets.

## Files

- `dist/index.html` — content and page structure
- `dist/assets/styles.css` — styling and responsive layouts
- `dist/assets/site.js` — navigation, service selection, and email draft

Open `dist/index.html` directly or serve `dist/` with any static web server. Deploy `dist/` to a static host; no build step is needed.

## Portfolio admin

A Cloudflare Workers backend, private R2 media storage, D1 metadata, and a Cloudflare Access-protected admin dashboard are in `backend/`. GitHub Pages remains the public frontend. See [deployment instructions](backend/DEPLOYMENT.md) and [security boundaries](backend/SECURITY.md). Cloudflare resources, owner credentials, and Access policies are managed separately from Pages.

After one-time setup, manage projects at the admin Worker's `/admin/`: upload audio/artwork, edit details, reorder, publish/unpublish, and delete. Published projects load automatically through `dist/assets/portfolio.js`. The deployed Worker URLs are configured in `dist/assets/portfolio-config.js`.

## GitHub Pages

The repository-root `.github/workflows/pages.yml` uploads only `as-mixes/dist`, with no frontend build step. It runs manually on `main`; pushing does not deploy automatically. After an approved commit/push, choose **GitHub Actions** as the Pages source and manually run **Publish AS Mixes to GitHub Pages**. See the [deployment instructions](backend/DEPLOYMENT.md#5-connect-github-pages-once). This workflow never deploys the Cloudflare backend and needs no Cloudflare secrets.

## Customize before client use

The site uses the AS Mixes identity. Replace the illustrative portfolio entries and indicative euro prices. Replace `hello@example.com` in both HTML and JavaScript. Portfolio graphics are CSS placeholders; add your actual credited artwork and audio when available. The contact form creates a mailto draft and does not send or store messages. For server-side submissions, connect your chosen form endpoint and update the explanatory copy.

Accessibility includes semantic landmarks, labelled controls, a skip link, visible keyboard focus, reduced-motion support, and an accessible mobile menu.
