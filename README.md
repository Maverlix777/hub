# Хаб

Личный лаунчер приложений. См. CLAUDE.md.

Cloudflare Worker authentication and deployment gates are documented in [CLOUDFLARE.md](CLOUDFLARE.md). The checked-in D1 ID is a placeholder, and production deployment still requires account-owner configuration and verification.

The existing owner-only board can optionally read a private local-agent telemetry artifact. The [telemetry contract](docs/telemetry.md) describes the disabled-by-default reader, privacy boundaries and synthetic tests. No uploader or live data source is configured by this repository.

## Локальная разработка

Аккаунт Cloudflare и `wrangler login` не нужны: Worker, локальная D1 и ассеты из `public/` работают в workerd через `wrangler dev --local`.

Требования: Node 22 (`.nvmrc`), npm, python3 (для `npm run check`), openssl и свободный порт 443 (для `tests/e2e.cjs`).

```sh
npm ci
cp .dev.vars.example .dev.vars   # и впишите в RATE_LIMIT_HMAC_KEY любую строку от 32 символов
npm run db:migrate:local         # миграции в .wrangler/state (в .gitignore)
npm run dev                      # http://127.0.0.1:8787/hub/
npm test                         # тесты Worker (node --test)
npm run check                    # CSP, реестр загрузок, Pages artifact, редиректы
```

Открывать нужно именно `http://127.0.0.1:8787/hub/`, не `localhost`: Worker сверяет origin с `CANONICAL_ORIGIN` из `.dev.vars` и на любой другой хост отвечает 404.

Ожидаемый результат (проверено на wrangler 4.151.3):

- `GET /hub/` без сессии: `302` на `http://127.0.0.1:8787/hub/login/`;
- `GET /hub/login/`: `200`, `text/html`;
- `POST /hub/api/login/options` с `Origin: http://127.0.0.1:8787` и несуществующим пользователем: `401 {"error":"login_unavailable"}`.

Ограничения локального запуска:

- Сессионный cookie называется `__Host-hub_session` и ставится с `Secure`. На `http://127.0.0.1` браузеры (Chrome, Firefox) обычно принимают Secure-cookie для loopback, Safari нет; полный вход по passkey локально не проверялся.
- WebAuthn с `RP_ID=127.0.0.1` не проверялся: спецификация требует RP ID как домен, и браузер может отказать для IP-адреса. Регистрация и вход покрыты тестами `npm test` с подменой WebAuthn.
- Без `RATE_LIMIT_HMAC_KEY` (32+ символов) регистрация и вход отвечают `503 auth_unavailable`.
- Прод-шлюз (`HUB_GATEWAY_ORIGIN`, `HUB_GATEWAY_SECRET`) локально не используется.

Деплой и прод-настройки: [CLOUDFLARE.md](CLOUDFLARE.md).

## Owner board operations

The owner-only `GET /hub/api/board` also returns an `operations` snapshot from open GitHub Issues, separate from Markdown column counts. The existing server-only binding `BOARD_GITHUB_TOKEN` and optional `BOARD_REPO` (default `Maverlix777/agent-handoffs`) supply this read. The token never goes to the browser. No census is added to outbox POST validation.

Only a complete bounded read returns `status: "ok"`, `as_of`, an open Issue total, exact `worker:*` counts and exact `blocked:human` entries. PRs and closed Issues are excluded; multiple worker labels can make worker totals exceed unique Issues. The completion time is not an atomic GitHub snapshot. Failed, incomplete or unconfigured reads return `unavailable` with null totals and empty lists while preserving available Markdown cards. Reads use one 10-second deadline, at most 20 sequential 100-row pages, 1MiB per page and 8MiB total; they do not retry or follow redirects.

The optional server binding `BOARD_PRAXIS_URL` provides a separate navigation link. It must be an absolute HTTPS URL without userinfo or controls; both the raw binding string and the normalized serialized HTTPS URL must be at most 2048 UTF-16 code units. Invalid, blank or oversized values hide it. This code never fetches or embeds Praxis. A valid link can remain configured when Issue counts are unavailable; this is not evidence Praxis is reachable. No deployed binding or live queue is verified by these source tests. The source PR remains open for review; no public main merge, Pages/Worker deploy or production configuration change is part of this feature.
