# AS Mixes portfolio management

The public website remains plain HTML/CSS/JavaScript on GitHub Pages. There is no framework or public portfolio write API. The public contact-only POST endpoint sends email after verification and rate limiting. Two small Cloudflare Workers share one private R2 bucket and one D1 database:

- **as-mixes-portfolio**: public, read-only `/api/projects` and `/media/<asset-id>`, plus verified `/api/contact` submissions.
- **as-mixes-admin**: private `/admin/`, administrative APIs, and authenticated draft previews. Protect this entire Worker with Cloudflare Access. The Worker independently verifies Access JWTs using `jose` and allows only the configured owner email.

The `/admin/` page on GitHub Pages is only a link to the private dashboard. GitHub Pages cannot protect static files with Cloudflare Access. No private dashboard data, tokens, or storage credentials are stored on GitHub Pages.

The Pages workflow in `.github/workflows/pages.yml` publishes only `as-mixes/dist` (or its generated, contact-disabled fallback copy) when manually triggered on `main`. It does not deploy Cloudflare or create cloud resources. Complete the Cloudflare steps below yourself after reviewing the configuration. No Cloudflare credentials are stored in the repository. `.openai/hosting.json` belongs to the earlier Sites experiment and is not used by this architecture.

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

Migrations create the portfolio tables/indexes and the separate contact-limit table/index. Do not point them at another application's database. The owner confirmed that 0002_contact_limits.sql was applied to production; do not recreate resources or reapply SQL manually. Wrangler tracks migration application.

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

The canonical website origin is `https://asmixes.com`. `PUBLIC_ORIGIN` is set to that exact HTTPS origin. Preserve the existing `https://www.asmixes.com` redirect to the apex domain; this local configuration does not configure DNS, certificates or redirects. Portfolio/audio requests are intended to originate from the canonical page.

```powershell
npm run deploy:public
```

Do not enable Access on this public Worker. It has no admin routes or static admin assets. Portfolio/media routes refuse all write methods; only `/api/contact` permits POST. Portfolio/media CORS uses `PUBLIC_ORIGIN`, while contact CORS uses `CONTACT_ALLOWED_ORIGINS`, never with credentials. CORS is not authentication: anyone can fetch deliberately published previews. Unpublished previews remain private even to callers without an Origin header because publication is checked in the database.

## 5. Connect GitHub Pages once

Edit only `dist/assets/portfolio-config.js`, setting:

```javascript
window.AS_MIXES_PORTFOLIO = Object.freeze({
  apiOrigin: 'https://as-mixes-portfolio.YOUR-SUBDOMAIN.workers.dev',
  adminOrigin: 'https://as-mixes-admin.YOUR-SUBDOMAIN.workers.dev',
});
```

These are public URLs, not secrets. The frontend configuration now contains the deployed Worker origins. Do not publish `backend/`, `.dev.vars`, or `.env` files.

After reviewing and approving the commit and push, set **Settings > Pages > Build and deployment > Source** to **GitHub Actions** yourself (or authorize that settings change separately). Then open **Actions > Publish AS Mixes to GitHub Pages > Run workflow**, selecting `main`. This manual workflow uploads only the public site directory or its fallback copy; the private backend source and generated backend bundles are never included in its artifact. No Cloudflare credentials are needed by Actions, and pushes alone do not trigger publication. The primary website URL is `https://asmixes.com/`; preserve the existing www-to-apex redirect. GitHub Pages remains the hosting provider.

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

## Contact form email delivery

The public Worker sends plain-text enquiries through Resend's HTTPS API. Cloudflare still provides Turnstile verification, secrets and D1 rate-limit counters. No Cloudflare Email Sending binding, SMTP credentials, Resend SDK or additional runtime dependency is needed. Existing Cloudflare Email Routing continues forwarding direct email to `contact@asmixes.com` independently.

Current status, as confirmed by the owner: Resend has verified asmixes.com; RESEND_API_KEY, CONTACT_RECIPIENT, TURNSTILE_SECRET and CONTACT_RATE_SECRET are configured on the production public Worker; migration 0002_contact_limits.sql is applied. The following setup instructions are for reference or recovery, not a request to repeat completed steps. Local tests have not sent real email or independently inspected secret values. Deployment and live email verification still require separate approval. [Domain verification](https://resend.com/docs/dashboard/domains/introduction).

### Setup reference (already completed where noted above)

1. For initial setup or recovery, finish Resend's verification of `asmixes.com` using the DNS records Resend supplies. Preserve the MX records and working Cloudflare Email Routing. Do not replace incoming mail routing merely to enable sending. Wait until the sending domain shows verified before live testing. This implementation uses the fixed From address `contact@asmixes.com`; it does not fall back to an unrelated sender while verification is pending.
2. In Resend, create a dedicated API key with **Sending access**, restricted to **asmixes.com**, rather than full-account access. Save it securely. Do not paste the key into chat, command arguments, Git, Wrangler `vars`, public CI logs or frontend files. [API key permissions](https://resend.com/docs/dashboard/api-keys/introduction).
3. Use your existing Managed Turnstile widget. Confirm it authorizes `asmixes.com`. The GitHub hostname is deliberately excluded from contact origins. Supporting it later requires a separately reviewed origin and widget configuration change. The frontend supplies action `contact`; Siteverify must return that exact action and the actual page's hostname. The apex Turnstile hostname registration also covers subdomains, including www; the server independently checks the actual hostname and contact action. Keep the widget secret private. [Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
4. From `as-mixes/backend`, set these four **secrets on the public Worker**, entering each value only at Wrangler's interactive prompt. These commands change Cloudflare settings and must not be run without setup approval:

```powershell
npx wrangler secret put RESEND_API_KEY --config wrangler.public.jsonc
npx wrangler secret put CONTACT_RECIPIENT --config wrangler.public.jsonc
npx wrangler secret put TURNSTILE_SECRET --config wrangler.public.jsonc
npx wrangler secret put CONTACT_RATE_SECRET --config wrangler.public.jsonc
```

Use these values:

| Secret | Value to enter privately |
| --- | --- |
| `RESEND_API_KEY` | The dedicated sending-only Resend key |
| `CONTACT_RECIPIENT` | One mailbox only: `contact@asmixes.com` to use your working forwarding route, or your personal destination directly |
| `TURNSTILE_SECRET` | The secret key from the existing Turnstile widget |
| `CONTACT_RATE_SECRET` | A fresh cryptographically random value of at least 32 characters, generated with a password manager or equivalent secure generator |

The recipient is validated as one ordinary mailbox; no display names, comma-separated lists or header characters. It is never supplied by a visitor. Do not configure secrets with `wrangler secret bulk` against a tracked file, in `wrangler.public.jsonc` or in `portfolio-config.js`. The admin Worker needs none of these values. `npm run prepare:contact` now only prints a local setup reminder; it creates no files or resources and never reads credentials.

5. Set the **public Turnstile site key only** in `dist/assets/portfolio-config.js`:

```javascript
turnstileSiteKey: '0x4AAAAAAFTIxAyb1vI8nf5M',
```

Keep `apiOrigin` pointing to the existing public Worker and `adminOrigin` to the existing admin Worker. Never put the Turnstile secret, Resend key, HMAC key or private inbox into this file. With `turnstileSiteKey: null`, the form intentionally stays disabled and directs visitors to the public email address. If only the backend is misconfigured, submission fails closed and retains the visitor's message.

6. For a new environment only, after approval apply the migrations to its D1 database. Production 0002 is already applied; do not repeat this step for the current release. The new migration adds only a separate counter table/index:

```powershell
npx wrangler d1 migrations apply DB --remote --config wrangler.public.jsonc
```

7. Run local validation before requesting deployment approval:

```powershell
npm test
npm run check
npm run build
npm run test:runtime
```

`build` uses `--dry-run`; it does not deploy. Automated tests mock Resend and Siteverify, require no real credentials and send no email. Do not put real provider keys into automated tests. If you later use local development secrets, place them in the already ignored `backend/.dev.vars` and never commit that file; live local testing can send email and requires separate approval.

8. Only after explicit deployment approval, deploy using the normal public config:

```powershell
npm run deploy:public
```

No private deployment config or `send_email` binding is used anymore. Any old `wrangler.contact.local.jsonc` is still ignored to protect a pre-existing private destination, but must not be used for the Resend deployment. It has not been deleted or changed. Worker secrets configured on this same named Worker remain outside source control. Admin deployment and Access policies stay independent.

9. Publish the frontend through the existing manual Pages workflow only after approval. Perform one approved real enquiry after domain verification. Check the final inbox and spam folder, Reply-To, retry behavior and Turnstile failures. Success means Resend accepted the request and returned an email ID; it does not guarantee inbox delivery. Provider errors, including unverified-domain rejection, invalid API keys, quota exhaustion, timeouts and malformed responses never report success or reveal provider diagnostics.

### Canonical domain and origins

PUBLIC_ORIGIN is https://asmixes.com. CONTACT_ALLOWED_ORIGINS contains only https://asmixes.com and https://www.asmixes.com. Keep the existing www-to-apex redirect. GitHub-hostname contact submissions are deliberately excluded. The public frontend now targets https://api.asmixes.com; the admin hostname is unchanged. The workers.dev public endpoint remains enabled for migration fallback. These repository changes take effect only after the appropriate approved deployment.

### Limits, privacy and provider behavior

- The request schema, mandatory Turnstile verification, hostname/action checks, origin restrictions and safe response headers remain in place. Body limit: 24 KiB. Message limit: 5,000 UTF-16 code units. Optional tracks per mix: integer 1–60. No attachments, HTML bodies, arbitrary headers, client-selected senders or client-selected recipients.
- Resend receives a fixed sender and subject, one recipient from `CONTACT_RECIPIENT`, plain-text content, and validated customer email in `reply_to`. The API key is used only in the outbound Authorization header to the hardcoded `https://api.resend.com/emails` endpoint. Redirects are refused; requests have an eight-second timeout. No API key, recipient or acceptance ID is returned to the browser or logged by the application. [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email).
- Unlike the former Cloudflare email binding, Resend does not supply a recipient restriction for this application: the server enforces the fixed recipient. Protect and restrict the API key; a stolen key could be used outside the application's limits and recipient checks. Rotate it immediately if exposed. Sending-only and domain-scoped access limit its permissions but do not impose this form's recipient or rate limits.
- Default IP limit: 5 attempts per fixed 10-minute window (`CONTACT_IP_LIMIT`, configurable 1–50). Source IP comes from Cloudflare's trusted `CF-Connecting-IP`; missing values fail closed. Invalid submissions count too; shared networks share this limit.
- Default global limit: 100 verified send attempts per UTC day (`CONTACT_DAILY_LIMIT`, configurable 1–1,000). Reservations are atomic across clients. Provider failures consume a slot to prevent retry storms. Excess returns a clear daily-limit error directing the visitor to retry tomorrow or email the public address, without exposing counters, SQL or private addresses.
- Expired counter windows never block a new window. Indexed cleanup deletes up to 500 expired rows on requests and hourly public cron; backlogs clear in repeated batches. No raw IP, submitted email, name, message or token is stored in D1. Daily-rotated HMAC IP identifiers are pseudonymous; outages can delay physical deletion.
- Application logs contain no submitted personal information, tokens, provider responses or credentials. Resend and Cloudflare still process data and may retain provider-side metadata/content according to their policies; review those account settings separately. No settings were altered by this implementation.
- The UI clears fields only after explicit acceptance. Failures retain the message, refresh Turnstile and permit a retry. A lost response can leave delivery uncertain and retries may duplicate email; no exactly-once delivery guarantee or automatic provider retry is implemented.
- Resend quotas and pricing now apply; the earlier Cloudflare verified-destination free-send allowance is irrelevant. Review your current [Resend plan and limits](https://resend.com/pricing). Workers/D1 still consume account quotas, and rate limits cannot guarantee zero account cost or eliminate distributed DoS. No paid plan was selected or created here.

### Reviewed fallback and release order

`npm run prepare:fallback` runs offline and creates ignored `build/fallback/site` and `build/fallback/wrangler.json`. The site is copied from the current public website, with its Turnstile key set to null and a direct-email notice. Its real `mailto:contact@asmixes.com` link, styling, portfolio configuration and playback code remain. The fallback Worker delegates portfolio/media and cleanup to the same reviewed implementation, but always rejects contact submissions before touching secrets, counters or email providers. It uses the same Worker name, canonical origin, D1 and private R2 bindings. No admin deployment is involved. `npm run build` dry-runs this fallback too.

All commands below that deploy or run workflows require separate approval. First commit/push the reviewed changes after approval; pushing alone does not publish. Use that same reviewed release commit throughout these steps, without unrelated changes to main. Establish the fallback baseline before enabling contact:

1. From `as-mixes/backend`, prepare and deploy the fallback Worker:

   ```powershell
   npm.cmd run prepare:fallback
   npx.cmd wrangler deploy --config build/fallback/wrangler.json
   npx.cmd wrangler deployments list --config wrangler.public.jsonc
   ```

   Record the resulting **Worker version ID**, not its deployment ID, as FALLBACK_VERSION_ID. Confirm portfolio GET from Origin https://asmixes.com returns 200 with that exact CORS origin, published audio seeking returns 206, drafts stay private, and contact returns 503. Do not rerun migrations or change secrets.

2. Publish the fallback site using **Actions > Publish AS Mixes to GitHub Pages > Run workflow**, main, with **fallback checked**. If GitHub CLI is installed and authenticated, the equivalent is:

   ```powershell
   gh workflow run pages.yml --repo konketf/asmixes-website --ref main -F fallback=true
   ```

   Record the successful fallback run ID and commit SHA. Verify apex HTTPS, existing www redirect, portfolio/playback, direct email link and disabled form on desktop/mobile. This establishes a useful rollback target instead of the old demo-address website.

3. Deploy the normal public Worker with `npm.cmd run deploy:public`. Verify contact OPTIONS from both configured HTTPS origins returns 204 and allows the requesting origin; disallowed origins are rejected. Confirm canonical portfolio/audio access remains working.
4. Publish the normal frontend using the same workflow with fallback unchecked, or:

   ```powershell
   gh workflow run pages.yml --repo konketf/asmixes-website --ref main -F fallback=false
   ```

5. Perform one approved real enquiry; confirm Resend acceptance, arrival/spam folder and Reply-To. Verify provider/challenge failures retain the message. Do not deliberately exhaust production rate limits. Admin protection and published playback must remain working. Production email delivery and hosted-browser behavior are not established by local tests.

For rollback, rerun the recorded **successful fallback** Pages run, then restore its recorded compatible Worker version (replace angle-bracket placeholders with the recorded IDs):

```powershell
gh run rerun <FALLBACK_PAGES_RUN_ID> --repo konketf/asmixes-website
npx.cmd wrangler rollback <FALLBACK_VERSION_ID> --config wrangler.public.jsonc
```

The Wrangler command runs from `as-mixes/backend`. It prompts for confirmation and changes production. Rerunning the fallback Pages workflow rebuilds its original commit and original fallback input. GitHub permits reruns for 30 days; if the run is older, dispatch fallback=true only from reviewed main containing the tested fallback implementation. Do not use the unrelated old demo run. GitHub CLI is not installed in the current local environment; the Actions UI is the available alternative. These CLI forms were checked against official documentation; Wrangler rollback/deployments help and fallback dry-run are checked locally. No real rollback was executed. See [GitHub workflow inputs](https://cli.github.com/manual/gh_workflow_run), [reruns](https://cli.github.com/manual/gh_run_rerun), and [Cloudflare rollback behavior](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

Worker rollback restores the selected code/configuration version, not D1/R2 contents. Keep the contact migration/table and portfolio/audio data; do not restore an old database or delete secrets. Both fallback and normal versions share the same cron configuration and storage bindings. If version rollback is unavailable, regenerate and dry-run the fallback from the recorded release checkout, then deploy `build/fallback/wrangler.json` after approval. Verify canonical CORS, playback, draft privacy, direct contact and admin protection again. Fallback run/version IDs cannot exist until the separately approved baseline deployment.

### Local verification

Run `npm test`, `npm run check`, `npm run build`, `npm run test:runtime`, `npm run check:artifacts` and `npm audit`. The artifact scanner is heuristic; it checks normal/fallback frontend and generated Worker bundles for credential patterns, unexpected email addresses, links, audio and environment files without printing matched values. It does not read real secret values or guarantee the absence of arbitrary encoded secrets. Contact tests use in-memory SQLite, mocked HTTP responses for Resend/Siteverify, and a simulated browser form. They cover fixed recipient/sender, REST Authorization and `reply_to`, invalid/header-injection/relay inputs, body size, Turnstile failures and hostname/action mismatches, Resend authorization/domain/quota/server failures, malformed responses, timeouts/network exceptions, atomic concurrent limits, expiry cleanup, daily-cap messaging, message retention and retry/duplicate-click handling. Deployment tests check actual production origins, fallback contact rejection, published audio byte ranges, draft privacy and public artifact configuration. Existing admin, portfolio, audio ranges/privacy and local Workers runtime tests remain. Runtime smoke checks contact preflight and fail-closed missing secrets. Actual DNS, sender verification, widget rendering, provider acceptance and inbox placement require separately approved live verification.


### Public rate limits and CSP rollout (requires separate deployment approval)

No dashboard change is needed to declare Workers rate-limit bindings: the public Wrangler config and generated fallback config carry them. Before an approved deployment, verify namespace IDs 1001?1004 are unused by unrelated Workers in this account, or choose four unused positive integers. Namespace counters are account-shared when IDs match.

| Traffic | Per IP / minute | All clients per Cloudflare location / minute |
| --- | ---: | ---: |
| Contact POST | 10 | 120 |
| Portfolio and media GET/HEAD combined | 240 | 3000 |

Read limits leave room for the 100-artwork portfolio, audio range requests, repeated seeking and shared networks. Contact has separate capacity, so browsing cannot spend the contact budget. IP limits can affect shared proxies/NATs; adjust only after observing legitimate traffic. Rejections return 429, no-store and Retry-After; missing protection returns 503. These edge counters are approximate and location-local, not a worldwide request or billing cap. They execute inside the Worker, so rejected requests still invoke it. The existing D1 limits (5 attempts/IP/10 minutes, 100 verified sends/UTC day) remain unchanged.

The [Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) is configured in code and applies to both api.asmixes.com and the retained workers.dev endpoint. Account entitlement and availability must still be verified during an approved rollout; local builds do not establish production entitlement. The user has already attached api.asmixes.com to the public Worker. For protection before Worker invocation, separately approve zone WAF rate-limit rules matching hostname api.asmixes.com with POST /api/contact and GET/HEAD /media/* (plus /api/projects). Zone rules do not cover the retained workers.dev fallback; Worker binding limits still apply on both hosts. Keep that fallback available during migration. Do not use interactive challenges on audio/API responses. [WAF rule availability and features](https://developers.cloudflare.com/waf/rate-limiting-rules/) depend on the plan; the Free plan has one rate-limit rule, so independent contact/media zone rules may require a higher plan. No zone/plan/DNS changes have been made.

The GitHub Pages frontend applies CSP via early HTML meta tags, included by the existing dist-only workflow; it does not rely on unsupported _headers files or Worker API headers. It uses Cloudflare's documented [Turnstile script/frame allowlist](https://developers.cloudflare.com/turnstile/reference/content-security-policy/). No GitHub setting change is required. A CSP response header including frame-ancestors would require a separately approved hosting/proxy change; [frame-ancestors cannot be set in meta](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors).

Before release, verify in a real desktop/mobile browser: no CSP console violations; navigation, styling and animated/reduced-motion waveform; portfolio images; audio start/pause and seeks near the middle/end; Turnstile rendering, expiry/retry and a separately approved real contact submission. Local tests cover mocked contact/Turnstile responses, real local Worker bindings, range transport and static CSP/dependency compatibility. They do not establish actual widget rendering, codec playback, live edge accuracy, sender delivery or production account limits. Do not deliberately exhaust production limits to test them.


### Migrate the public frontend to api.asmixes.com

The custom domain is already attached and responding, as confirmed by the user. The repository now targets `https://api.asmixes.com` for POST `/api/contact`, GET `/api/projects`, and GET/HEAD `/media/<asset-id>`. CSP permits only this new API/media origin. The public Wrangler configuration records `{ "pattern": "api.asmixes.com", "custom_domain": true }` and explicitly retains `workers_dev: true`. Generated fallback configuration inherits both settings. See [Cloudflare Custom Domains configuration](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

CORS remains `PUBLIC_ORIGIN=https://asmixes.com`, with contact origins `https://asmixes.com` and `https://www.asmixes.com`. These identify the requesting website, not the API host. Do not add api.asmixes.com as a caller origin or broaden the allowlist. Turnstile continues to validate the website's hostname/action; no new Turnstile allowed hostname or secret is required for this API-host migration. Admin origin, Access policy, D1, R2, Resend secrets and rate-limit namespaces are unchanged.

Deployment steps (instructions only; none executed):

1. Review these local changes together with the existing uncommitted security changes. After separately approving and placing the reviewed release on `main`, use the existing GitHub Actions **Publish AS Mixes to GitHub Pages** workflow with **fallback unchecked**. It publishes `as-mixes/dist`. Equivalent command, when GitHub CLI is available: `gh workflow run pages.yml --repo konketf/asmixes-website --ref main -F fallback=false`. Running it before the release reaches main would publish the previous code.
2. No Worker deployment is required solely to switch frontend traffic, since the custom domain is attached to the same live Worker. If the reviewed backend/security changes also need rollout, separately approve and run `npm.cmd run deploy:public` from `as-mixes/backend`. Wrangler will reconcile the declared custom domain while preserving workers.dev. Do not deploy the admin Worker for this migration.
3. Verify the live page loads portfolio/artwork/audio from api.asmixes.com with no CSP/CORS errors; test playback and seeking, contact preflight and an approved real enquiry with Turnstile. Verify the original `https://as-mixes-portfolio.aleksandr-sinitson.workers.dev` remains reachable. No new DNS, GitHub, storage, Access or email setting is required based on the already attached domain; live settings were not independently inspected.
4. Any approved WAF rule must match hostname `api.asmixes.com`, URI path `/api/contact`, method `POST`. Review any existing API hostname matchers. Keep workers.dev enabled during migration; it bypasses zone WAF rules but retains application protections. No WAF settings were changed.

For frontend rollback, restore the previous public API origin in **both** `dist/assets/portfolio-config.js` and the CSP in `dist/index.html`, then publish that reviewed frontend. The old endpoint remains enabled; automatic retry to it is intentionally not added, avoiding duplicate contact messages. The generated direct-email fallback is a separate recovery mode and also uses the new API origin for portfolio/media.

Migration validation uses both hostnames against the local Worker for CORS, published media and byte ranges, and uses api.asmixes.com in local workerd contact/media requests with mocked outbound services. Real browser widget rendering, codec playback, WAF behavior, DNS/TLS and inbox delivery remain live release checks.
