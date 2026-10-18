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

Before considering the route ready, run `npm ci && npm test`, `wrangler deploy --dry-run`, apply the D1 migration, then perform an owner-approved registration, session, logout, and login smoke test on the deployed route. Do not use real account details in test evidence.
