# Cloudflare Worker setup

The checked-in `wrangler.jsonc` is a deployable configuration template. Its all-zero D1 ID is intentionally invalid; create `wrangler.production.local.jsonc` locally, replace the D1 ID there, and keep the file out of Git. Do not add account IDs, route data, secrets, or test-account data to this repository.

The Worker requires a D1 binding named `HUB_DB`, an asset binding named `ASSETS`, Node compatibility, and the `0001_auth.sql` migration. Before deployment, configure the real database ID in the ignored local config and apply migrations explicitly:

```sh
npx wrangler d1 migrations apply hub-auth --remote --config wrangler.production.local.jsonc
npx wrangler secret put RATE_LIMIT_HMAC_KEY --config wrangler.production.local.jsonc
npx wrangler deploy --config wrangler.production.local.jsonc
```

Supply the rate-limit secret through Wrangler's interactive prompt; use at least 32 random bytes and never pass its value as a command argument. The Worker fails closed for registration and login until that secret is present. Configure the intended `kolobovdjp.org` routes in the owning Cloudflare zone for `/hub*` and `/хаб*`; keep `workers.dev` and preview URLs disabled. Root/account owner should verify route scope does not intercept corporate site paths.

Users register with a lowercase username and a device passkey. There is no email or password registration. New accounts receive only the `free` entitlement; no purchase, payment, or paid feature flow is implemented. Recovery is not available yet, so a user who loses all passkeys cannot recover the account through this Worker.

Before considering the route ready, run `npm ci && npm test`, `wrangler deploy --dry-run`, apply the D1 migration, then perform an owner-approved registration, session, logout, and login smoke test on the deployed route. Do not use real account details in test evidence.
