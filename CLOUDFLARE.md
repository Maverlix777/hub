# Cloudflare Worker setup

The checked-in `wrangler.jsonc` is a configuration template only. Its all-zero D1 ID is a deliberate placeholder, not a deployable database binding; create `wrangler.production.local.jsonc` locally, replace the D1 ID there, and keep the file out of Git. Do not add account IDs, route data, secrets, or test-account data to this repository.

The Worker requires a D1 binding named `HUB_DB`, an asset binding named `ASSETS`, Node compatibility, and the `0001_auth.sql` migration. Before deployment, configure the real database ID in the ignored local config and apply migrations explicitly:

```sh
npx wrangler d1 migrations apply hub-auth --remote --config wrangler.production.local.jsonc
npx wrangler secret put RATE_LIMIT_HMAC_KEY --config wrangler.production.local.jsonc
npx wrangler deploy --config wrangler.production.local.jsonc
```

Supply the rate-limit secret through Wrangler's interactive prompt; use at least 32 random bytes and never pass its value as a command argument. The Worker fails closed for registration and login until that secret is present. In the owning Cloudflare zone, configure only the intended `kolobovdjp.org` routes `/hub` and `/hub/*`; avoid a `/hub*` prefix that could also match unrelated paths such as `/hubble`. Add exact Cyrillic alias routes only after Cloudflare route matching is verified; otherwise let those alias paths remain on Sites. The checked-in template keeps `workers_dev: false` and preview URLs disabled. Root may enable `workers_dev` only in the ignored production config when configuring the authenticated Sites gateway below; never enable preview URLs.

## Sites-to-Worker gateway fallback

The owner chose to leave DNS unchanged. The custom-domain `/hub` path currently does not reach this Worker. A Sites Worker may proxy that path to this Worker over its exact HTTPS `workers.dev` origin, but this is a private server-to-server gateway, not a public login URL.

The Hub Worker accepts a noncanonical request only when its origin exactly matches runtime `HUB_GATEWAY_ORIGIN` and `X-Hub-Gateway-Token` matches the `HUB_GATEWAY_SECRET` secret (at least 32 UTF-8 bytes). It rejects missing/incorrect gateway configuration or token before reading the body or touching D1/Assets. All other noncanonical origins are rejected. A direct browser request to the `workers.dev` origin without the gateway secret is denied; never expose the secret to browser code or responses.

The Sites proxy keeps `HUB_BACKEND_ORIGIN` and the matching `HUB_GATEWAY_SECRET` only in server-side runtime configuration. It must remove any client-supplied `X-Hub-Gateway-Token` and `X-Hub-Client-IP`, then add its own gateway token and copy the visitor IP from Cloudflare's incoming `CF-Connecting-IP` into `X-Hub-Client-IP`. If that trusted source IP is absent, the proxy must fail closed with 503. Do not trust unrelated identity headers. Do not log gateway tokens, forwarded IPs, cookies, request bodies, or passkey data, and do not cache gateway responses.

After validating the gateway token, the Hub Worker rewrites only the internal request URL to `CANONICAL_ORIGIN`, preserves the browser's `Origin`, cookie, method, path, query, and body, then strips the gateway headers. WebAuthn origin/RP ID checks remain bound to the canonical public origin. Rate limiting uses `X-Hub-Client-IP` only on successfully authenticated gateway requests; canonical-origin requests ignore forwarded-IP headers and continue using Cloudflare's `CF-Connecting-IP`. Test both paths before deployment: direct `workers.dev` without a token must be denied before D1/Assets; a valid proxy request must reach login/assets/session paths while preserving canonical Origin and cookie behavior.

Root owns setting runtime `HUB_GATEWAY_ORIGIN`, the `HUB_GATEWAY_SECRET`, and enabling the Worker development origin in the ignored production config. Do not add real origin/account details or secrets to the checked-in template. The DNS records remain unchanged; confirm the exact Sites proxy path and end-to-end behavior before calling `/hub` migrated.

Users register with a lowercase username and a device passkey. There is no email or password registration. New accounts receive only the `free` entitlement; no purchase, payment, or paid feature flow is implemented. Recovery is not available yet, so a user who loses all passkeys cannot recover the account through this Worker.

Username enumeration: `register/options` answers 409 `registration_unavailable` for a taken name, so names can be probed through that endpoint (rate-limited to 5 per name and 20 per IP per minute). The alternative, answering a taken name like a free one, would make the browser create a passkey on the device before the registration fails, which is worse for the user. The risk is accepted for a personal hub; revisit if registration is ever opened to a wider audience.

Session cookie scope: `__Host-hub_session` must use `Path=/` (a requirement of the `__Host-` prefix), so the browser sends it to every path on `kolobovdjp.org`, including Sites pages outside `/hub/`. The risk is accepted: Sites scripts cannot read an HttpOnly cookie. Revisit this if third-party code ever appears on the domain.

Before considering the route ready, run `npm ci && npm test`, `wrangler deploy --dry-run`, apply the D1 migration, then perform an owner-approved registration, session, logout, and login smoke test on the deployed route. Do not use real account details in test evidence.

## Deploying from GitHub Actions

`.github/workflows/deploy-worker.yml` is a manual (`workflow_dispatch`) production deploy. It needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and resolves the `hub-auth` D1 id with `wrangler d1 list` (or takes it from the optional variable `HUB_D1_DATABASE_ID`); it generates the gitignored `wrangler.production.local.jsonc` on the runner from the template, applies migrations, deploys, and checks `referrer-policy` on the live `/hub/style.css`. Routes are left untouched unless the `routes` run input or the optional variable `HUB_WORKER_ROUTES` lists them (comma-separated, e.g. `kolobovdjp.org/hub,kolobovdjp.org/hub/*,kolobovdjp.org/doktor/*`). It deploys exactly what is in `main`: anything that exists only in the owner's local build is not part of it.

## Doktor public pages

`/doktor/*` is served publicly, without a session, from `public/doktor/` (GET/HEAD only; `/doktor` redirects to `/doktor/`, directories resolve to their `index.html`, `cache-control: public, max-age=300`, no cookie is read or set). To make this work on kolobovdjp.org the owner must add a zone route `kolobovdjp.org/doktor/*` to this Worker (currently only `/hub` and `/hub/*` exist). Until then the pages are available on GitHub Pages at `https://maverlix777.github.io/hub/doktor/`. The source of truth for the text is `site/doktor/` in the doktor repo; copy it byte for byte and never edit the pages here.
