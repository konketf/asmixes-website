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

`dist/sitemap.xml` lists the canonical homepage, currently the only indexable page. Homepage section fragments, API/media URLs, and the admin page are excluded; the admin page retains its `noindex, nofollow` meta tag. `lastmod` is omitted because portfolio content can change independently of Git deployments. When adding a public indexable page, add its canonical URL to the sitemap. `dist/robots.txt` allows crawling and advertises `https://asmixes.com/sitemap.xml`. Both files are uploaded directly by the normal Pages workflow and copied unchanged by `backend/scripts/prepare-fallback.mjs` for fallback publication. After publication, optionally submit the sitemap in Google Search Console's Sitemaps report to monitor processing; it is also discoverable through robots.txt.

## Customize before client use

The site uses the AS Mixes identity and fixed service prices. Publish your credited artwork and audio using the private dashboard. The public portfolio shows a loading message until the API responds, an empty state when no projects are published, and a retry option on failure (including a 15-second timeout). The contact form submits to the public Worker's `/api/contact` after mandatory Turnstile verification. It stays disabled until a real public Turnstile site key is configured. Resend domain verification, Worker secrets, and the counter migration are also required; see [contact setup](backend/DEPLOYMENT.md#contact-form-email-delivery). The private recipient and API key are never stored in the frontend or tracked configuration.

Accessibility includes semantic landmarks, labelled controls, a skip link, visible keyboard focus, reduced-motion support, and an accessible mobile menu.

Frontend portfolio regression tests use synthetic responses and run with `cd backend && node --test test/portfolio-ui.test.mjs`, or as part of `npm test`.

Artwork failures get one automatic retry after 1.5 seconds, then an accessible per-cover retry control. Retrying an image keeps the current audio player and playback position. Images retain lazy loading; recovery uses the same publication-checked URL without cache-busting or metadata requests. Missing or corrupt images stop retrying automatically.

Optional offline browser checks run with `node backend/scripts/browser-smoke.mjs` using an installed Chrome/Edge/Chromium (or set `BROWSER_PATH`). They intercept all page requests with local files and synthetic API, artwork, audio, and Turnstile responses; no real email is sent. The checks cover image failure/recovery, playback and seeking, contact responses, themes, and desktop/mobile layouts. Screenshots are saved under ignored `backend/build/browser-smoke/`. Before editing, `--baseline` captures the tracked HEAD's portfolio script/base stylesheet for comparison with the working tree; normal runs compare layout geometry when that baseline exists. Real Cloudflare/Turnstile availability and production delivery still require separate operational checks.
