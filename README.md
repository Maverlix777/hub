# Хаб

Личный лаунчер приложений. См. CLAUDE.md.

Cloudflare Worker authentication and deployment gates are documented in [CLOUDFLARE.md](CLOUDFLARE.md). The checked-in D1 ID is a placeholder, and production deployment still requires account-owner configuration and verification.

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
