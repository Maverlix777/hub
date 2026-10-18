# HANDOFF — Хаб (18.10.2026, после #4)

## Версии
- `main` = `7cf24af`, repo публичный. CI-прогон 39136009596 на нём: `checks` и `deploy` — success (по API, 14:28Z).
- Рядом с приложением в repo есть Cloudflare Worker (`src/worker.js`, passkey-вход, D1, `public/`): добавлен в #5 и #6, описан в `CLOUDFLARE.md`.

## Проверки (облако, мок API, реальный ключ не нужен)
- Дерево `176d06a` (= `main` без двух строк доков), шаги как в `ci.yml`: `npm ci && npm test` 10/10; `check-site-artifact` 13 файлов, без docs/tests/tools; `check-pages-redirect` ok; `check-csp` 3 из 3 страниц; `check-downloads` 2 записи; `check-subpath` 35/35; `e2e` 75/75.
- Не проверено: живые `github.io/hub/` и `kolobovdjp.org/hub/` (прокси даёт 403 на оба), реальный api.anthropic.com, iPhone, Worker на Cloudflare (D1 ID в repo — заглушка из нулей).

## Что изменилось с `055de2e`
- Job `deploy` публикует в Pages только редиректы `index`, `apps/chat`, `apps/downloads` на `https://kolobovdjp.org/hub/` (`--redirect-to`, `tests/check-pages-redirect.py`). `github.io/hub/` — уже не само приложение; `CLAUDE.md:53` описывает старое состояние.
- `CLOUDFLARE.md`: DNS не менялся, `/hub` на домене пока не доходит до Worker; нужен шлюз Sites → Worker. Отвечает ли `kolobovdjp.org/hub/` приложением — неизвестно.
- Вывод, не проверено: origin сменился, localStorage не переносится — ключ чата придётся ввести заново.
- Плитка Location Fusion ведёт на публичную страницу `kolobovdjp.org/locationfusion/install/` (сборка 3.1.14 (9)); Nebula Pop в «Загрузках» без ссылки, `available:false`. Установка по ссылке не проверена (так сказано и в записи).

## Owner gates (решает только владелец)
1. Cloudflare: реальный D1 ID в локальном конфиге, секреты `RATE_LIMIT_HMAC_KEY` и `HUB_GATEWAY_SECRET`, `HUB_GATEWAY_ORIGIN`, маршруты `/hub`, `/hub/*`, smoke-тест регистрации и входа. Восстановления при потере всех passkey нет.
2. Подтвердить, что редирект с github.io на `kolobovdjp.org/hub/` задуман и когда `/hub` там заработает.
3. Ключ Claude: ввести внутри значка «Домой» и проверить чат на iPhone; хранилища значка и Safari, вероятно, раздельны.
4. Загрузки: постоянная ссылка = GitHub Release; публикацию сборок подтверждает владелец.
5. Ссылки на сессии Claude и имя автора в истории (ниже): очистка только владельцем.

## Публичное и приватное (перепроверено на `main`)
- В отслеживаемых файлах нет ссылок на приватные repo (`git grep`); `CLAUDE.md` называет другие repo аккаунта.
- `Claude-Session` в коммитах `055de2e`, `a093dc9` (в `main`) и `889c09d`, `91db768`, `4dd438d`, `f1e5304` (ветка `stage1-hub-chat`); ссылка на сессию в телах PR #1 и #2.
- В теле PR #4 ссылка была 01:30–02:01Z 18.10, убрана; из чужих кэшей и копий её не вернуть.
- Автор коммитов — имя из профиля GitHub (noreply-почта).
