# AS Mixes portfolio management

The public website remains plain HTML/CSS/JavaScript on GitHub Pages. There is no framework or public write API. Two small Cloudflare Workers share one private R2 bucket and one D1 database:

- **as-mixes-portfolio**: public, read-only `/api/projects` and `/media/<asset-id>`.
- **as-mixes-admin**: private `/admin/`, administrative APIs, and authenticated draft previews. Protect this entire Worker with Cloudflare Access. The Worker independently verifies Access JWTs using `jose` and allows only the configured owner email.

The `/admin/` page on GitHub Pages is only a link to the private dashboard. GitHub Pages cannot protect static files with Cloudflare Access. No private dashboard data, tokens, or storage credentials are stored on GitHub Pages.

Nothing in this repository creates cloud resources or deploys automatically. Complete the steps below yourself after reviewing the configuration. No Cloudflare credentials were added or infrastructure deployed during implementation. `.openai/hosting.json` belongs to the earlier Sites experiment and is not used by this architecture.

## 1. Requirements and cost checks

Install Node.js 22 or later and use a Cloudflare account. From `as-mixes/backend`:

```powershell
npm ci
npm test
npm run check
npm run build
npm run test:runtime
npx wrangler login
```

`build` is a local dry run, not a deployment. It copies the existing public stylesheet into the admin assets directory so the dashboard matches the site. `npm ci` installs the locked versions. A patched `sharp` override addresses an advisory in Wrangler's local tooling; do not remove it without rechecking `npm audit` and the build.

Select **Workers Free**, **Zero Trust Free**, and **R2 Standard**. No custom domain is required. Workers get a `workers.dev` hostname. Cloudflare documents [Access support for workers.dev and entire Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/). Access's [Free plan](https://www.cloudflare.com/sase/products/access/) supports a small team (under 50 users); this system needs only one.

As checked on 8 October 2026:

- [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/): 100,000 requests/day and 10 ms CPU per invocation. Audio range requests count as requests. Free-tier CPU suitability still needs a real deployed upload test; no automatic paid upgrade is configured.
- [D1 Free](https://developers.cloudflare.com/d1/platform/pricing/): 5 million rows read/day, 100,000 rows written/day, 5 GB total storage. Limit exhaustion causes requests to fail.
- [R2 Standard](https://developers.cloudflare.com/r2/pricing/): 10 GB-month storage, 1 million Class A operations/month, 10 million Class B operations/month, free egress. R2 is usage-billed above the allowance; it is not a guaranteed zero-cost service. [R2 activation](https://developers.cloudflare.com/r2/get-started/) requires a subscription/payment setup. Review the terms in your account before enabling it.

The application caps tracked storage at **1 GiB** and active projects at **100**, well below the R2 storage allowance. This does not cap read-operation charges, traffic from bots, storage used by other apps, or manual uploads to the bucket. Both public metadata and media use `no-store` so unpublishing blocks new requests immediately; this trades lower caching efficiency for privacy. Set Cloudflare usage/billing notifications and monitor R2 operations. No paid services are necessary for the intended small portfolio, but unusually high traffic or oversized CPU work can exceed free limits.

## 2. Create private storage and database

Create dedicated resources, not an existing bucket/database containing unrelated files:

```powershell
npx wrangler r2 bucket create as-mixes-media
npx wrangler d1 create as-mixes-portfolio
```

Copy the returned **database ID** into both `wrangler.admin.jsonc` and `wrangler.public.jsonc`. Confirm the bucket names match. Leave **r2.dev public access disabled**, add no public custom domain to R2, and create no public bucket URLs or presigned URLs. The Worker binding handles storage authentication without an R2 API key in your frontend.

Apply the included migration once:

```powershell
npx wrangler d1 migrations apply DB --remote --config wrangler.admin.jsonc
```

The migration only creates the portfolio tables/indexes. Do not point it at another application's database. No migrations were applied to a cloud account during implementation.

## 3. Bootstrap the admin Worker and configure Access

1. Enable Cloudflare Zero Trust, choose its **Free** plan, and choose a team domain such as `your-team.cloudflareaccess.com`.
2. Choose the admin Worker name/subdomain. Update `ADMIN_ORIGIN` in `wrangler.admin.jsonc` to its exact HTTPS origin, without a trailing slash. Update `ACCESS_TEAM_DOMAIN` to your team hostname only.
3. Deploy the initial admin Worker with `npm run deploy:admin`. With no valid `ACCESS_AUD` or `ADMIN_EMAIL`, every page/API fails closed; there is no temporary unauthenticated upload mode.
4. In **Workers & Pages → as-mixes-admin → Access**, choose **Protect this Worker behind Access → All traffic**. This is the **admin Worker only**, not the public portfolio Worker. Alternatively create a self-hosted Access application protecting its entire `workers.dev` hostname, including every path. Do not protect only the HTML path and forget the APIs.
5. Add an **Allow** policy for your exact email address only. No `Everyone`, email-domain-wide, public bypass, or service-token write policies. Use a maintained identity provider with MFA when available. Email one-time PIN is another supported sign-in option; secure the mailbox with MFA. Keep the session duration short, for example 1 hour.
6. Copy that Access application's **Application Audience (AUD) Tag** to `ACCESS_AUD` in `wrangler.admin.jsonc`. If there is already an account-wide Workers Access policy, ensure the public portfolio Worker is deliberately exempted while the admin Worker remains protected.
7. Set the owner email through Cloudflare secret management (the CLI prompts for the value; don't put it in command arguments or Git):

```powershell
npx wrangler secret put ADMIN_EMAIL --config wrangler.admin.jsonc
```

8. Run `npm run deploy:admin` again after updating the Access settings. Keep `preview_urls` disabled. The Worker rejects requests on any hostname other than `ADMIN_ORIGIN`, and rejects missing/invalid JWTs even if an Access application is accidentally removed.
9. Visit `https://<admin-worker-host>/admin/`. Access should show its login page. Sign in with the exact allowed email. An unauthorized email must be blocked.

Token validation checks signature, RS256 algorithm, configured issuer and audience, expiration, required subject/issued-at/email claims, and owner email. The implementation follows Cloudflare's [JWT validation guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) using the maintained `jose` library. It does not implement passwords, sessions, or an OAuth provider.

## 4. Deploy the read-only Worker

Set `PUBLIC_ORIGIN` in `wrangler.public.jsonc` to your exact GitHub Pages origin, currently expected to be `https://konketf.github.io` (no path or trailing slash). GitHub project Pages URLs may contain `/asmixes-website/`; that path is **not** part of an origin. If you later use a custom Pages domain, update this value.

```powershell
npm run deploy:public
```

Do not enable Access on this public Worker. It has no admin routes or static admin assets and refuses all write methods. It grants CORS only to the configured GitHub Pages origin, never with credentials. CORS is not authentication: anyone can fetch deliberately published previews. Unpublished previews remain private even to callers without an Origin header because publication is checked in the database.

## 5. Connect GitHub Pages once

Edit only `dist/assets/portfolio-config.js`, setting:

```javascript
window.AS_MIXES_PORTFOLIO = Object.freeze({
  apiOrigin: 'https://as-mixes-portfolio.YOUR-SUBDOMAIN.workers.dev',
  adminOrigin: 'https://as-mixes-admin.YOUR-SUBDOMAIN.workers.dev',
});
```

These are public URLs, not secrets. Publish the `dist/` directory using your existing GitHub Pages process. Do not publish `backend/`, `.dev.vars`, or `.env` files. If Pages currently serves the repository root, make sure your existing Pages build/deployment actually uses `as-mixes/dist` as its web root; this task does not change your GitHub repository or Pages settings.

After this one configuration deployment, uploading/editing/publishing/reordering through the dashboard updates the portfolio on the next page load without a GitHub Pages redeploy. Visit the public site's `/admin/` to find the login link, or bookmark the Worker dashboard directly.

With the URLs unset, the site continues showing its current labelled static examples. With the API configured but unavailable, a plain notice explains the outage and preserves the labelled examples. With no published projects, it shows an empty-portfolio notice. The backend's admin assets include the current stylesheet; rerun the admin build/deployment if that stylesheet changes.

## Daily use

- Add a title and artist, choose a credit, and optionally add a description.
- Upload MP3/WAV audio up to **30 MiB** and JPEG/PNG/non-animated WebP artwork up to **5 MiB**, no dimension over 6,000 pixels and no more than 20 megapixels.
- Use normal PCM WAV exports for browser compatibility. MP3 is the recommended streaming format. This system does not transcode audio or resize artwork.
- Save as a draft first, preview it, then publish. Audio and artwork are required to publish.
- Edit keeps existing media unless you select replacement files. Replacing media on an already published project temporarily unpublishes it while the replacements are uploaded, then restores the chosen publish setting after success. If upload fails, the private draft remains for retry.
- Move up/down changes public ordering. Unpublish removes metadata and denies new media requests. Delete hides the project immediately and queues its associated files for cleanup.
- Keep your own original masters/artwork. Back up D1 and R2 separately; deleting through the dashboard has no undo.

## Verify before launch

Run local checks/tests/builds, then verify all of these against your actual Cloudflare deployment:

1. In a signed-out/private window the admin dashboard and admin APIs require Access. A different email cannot log in. Direct requests without an Access JWT cannot upload, edit, delete, or fetch drafts.
2. Upload one real MP3, one PCM WAV, and your JPEG/PNG/WebP artwork. Confirm content rejection for an HTML/SVG file renamed as an allowed format, and rejection for files over the size limits.
3. Publish a draft; check the real GitHub Pages Work section, artwork and audio playback on desktop and mobile, including seeking. Edit/reorder without redeploying Pages and refresh to confirm changes.
4. Unpublish, then request its old media URL from a new session: it must return 404. An already downloaded file or active response cannot be revoked.
5. Delete a test project; confirm its files are removed from R2. If cleanup fails, the hourly cron retries it. Failed uploads are tracked, and abandoned pending uploads are reclaimed after a one-hour grace period.
6. Inspect the public API's CORS/header responses. Do not use R2 public URLs or enable public bucket access.
7. Monitor CPU, storage and operations in Cloudflare. The real Free-plan upload CPU limit has not been proven by offline tests.

## Testing scope and remaining limits

`npm test` tests real RSA-signed JWT validation and rejection cases, authorization of admin endpoints/assets, CORS/CSRF origin checks, metadata validation, upload content/size checks, publishing privacy, audio ranges, optimistic edit conflicts, quota reservations, replacing/deleting media, cleanup retries and deletion during an in-flight upload. It executes the actual migration and SQL against Node's in-memory SQLite, and models R2 failures; these are not live Cloudflare account tests. No test disables authentication in production or trusts a frontend email header.

`npm run test:runtime`, after `npm run build`, additionally executes the bundled production Worker in the locally installed Cloudflare workerd/Miniflare runtime with real local D1 and R2 bindings. It verifies JWT/JWKS authentication, protected asset routing, uploads, draft-media privacy, publish/unpublish, byte-range playback, and deletion. It uses a test-only JWKS service and temporary local storage, never a Cloudflare account. It is still not a test of your live Access policy, browser rendering or free-tier CPU enforcement. Miniflare is supplied by the locked Wrangler installation; the smoke script uses its compatibility adapter.

File signatures/structure/dimensions are checked, not just MIME or extensions, but this is not antivirus scanning or complete media decoding. Only the authenticated owner can upload; upload trusted exports and keep browsers updated. Rich HTML, SVG artwork, arbitrary URLs, and arbitrary object keys are not accepted. The server provides controlled content types, `nosniff`, framing/CSP protections, HTTPS-only handling, no-store privacy, and generic internal-error responses. Client rendering uses `textContent`, not HTML interpolation.

This is a single-owner portfolio, not a multi-tenant CMS. It has no application audit-history UI, antivirus service, image transcoder, or guaranteed zero-cost abuse protection. Add Cloudflare rate rules if your account supports them, monitor account limits, and use MFA for Cloudflare, GitHub and your sign-in identity. Protect account access and backups. There is no SOC 2 certification or compliance claim.
