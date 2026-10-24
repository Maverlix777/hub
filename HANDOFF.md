# HANDOFF — Хаб (24.10.2026), обновление: поддомен

## Что в проде сейчас (24.10, после PR #36 и #37)
- `hub.kolobovdjp.org` обслуживает НОВЫЙ Worker `kolobovdjp-hub-next`, собран из `main` этого repo (версия `cb3349ce-dab0-4c5a-83cf-de15bf5b679c`), custom domain из `wrangler.jsonc`, тот же D1 `hub-auth`, `RP_ID=kolobovdjp.org` (passkeys работают). Секрет `RATE_LIMIT_HMAC_KEY` для него сгенерирован заново.
- Приватный Worker `kolobovdjp-hub` (версия `cf0752a8-c0b1-40e9-a0ef-f49ac8902b79`, owner-download, push, шлюз) НЕ тронут и продолжает отдавать `kolobovdjp.org/hub/*` через шлюз. Исходник приватной сборки в доступных репо не найден (локально только старая `~/.codex/hub-private-download-deploy-2026-10-18/`, не равна живой). Поэтому поверх него не деплоили.
- 301 с `kolobovdjp.org/hub/` на поддомен НЕ работает: `/hub/*` на апексе отдаёт приватный Worker через шлюз (там сейчас 302 на `/hub/login/`). Нужна правка на стороне шлюза/приватной сборки, решение владельца.
- `BOARD_OWNER_USERNAME` = `maverlix,maverlixwin` (список через запятую). Секрет `BOARD_GITHUB_TOKEN` не задан: без него `/hub/api/board` отвечает 503 владельцу.

## Деплой
- Локальный конфиг (в .gitignore): копия `wrangler.jsonc` с реальным D1 id (`npx wrangler d1 list`) и `"name": "kolobovdjp-hub-next"` → `npx wrangler deploy --config wrangler.production.local.jsonc`. Не деплоить под именем `kolobovdjp-hub`: затрёт приватный Worker.
- Секреты нового Worker: `npx wrangler secret put RATE_LIMIT_HMAC_KEY --name kolobovdjp-hub-next`, `... BOARD_GITHUB_TOKEN --name kolobovdjp-hub-next` (fine-grained PAT, только чтение Contents в Maverlix777/agent-handoffs).

## Откат
- `npx wrangler delete --name kolobovdjp-hub-next` (снимает и custom domain); прод `kolobovdjp-hub` не менялся. Версии: `npx wrangler rollback --name kolobovdjp-hub-next`.

## Проверки 24.10 (curl)
- `hub.kolobovdjp.org/hub/login/` 200; `/hub/login` 308 на слэш; `/hub/api/board` и `/hub/api/session` без сессии 401; `kolobovdjp.org/doktor/` 200; `kolobovdjp.org/hub/` 302 (не 301, см. выше). `npm test` 116 из 116.
- Не проверено: вход passkey на новом хосте, owner-доступ к доске (нет токена).

# HANDOFF — Хаб (24.10.2026)

## Версии
- `main` = `7e1c443` (#32). CI `checks` на голове PR #32 (`33f1d23`) — success (run 40047008873).
- 23–24.10 влиты #31 (удалены корневые копии) и #32 (матрица доступа А, платные Location Fusion и `job-forge`, override `undici` 7.30.1).
- С 18.10 влиты #7–#29: задачи SITE-1…17 (ветки `zhanna/SITE-*`), каталог игр, страницы Доктора, ручной деплой Worker.

## Проверки в облаке на голове #32 (24.10)
- `npm ci && npm test` → 108 из 108; `npm audit --audit-level=high` → 0; site4 21/21, check-subpath 53/53, e2e 82/82.

## Проверки в облаке на `804df43` (23.10)
- `npm ci && npm test` → 102 из 102 (Worker: WebAuthn, сессии, hardening, покрытие, `/doktor/`).
- `npm run check` → CSP 4 из 4 страниц и 4 скриптов; реестр 31 запись; artifact 24 файла без docs/tests/tools; редиректы + Krenkballs + `/doktor/` ок.
- Не проверено: живые `kolobovdjp.org/hub/` и `github.io/hub/` (прокси облака 403), реальный api.anthropic.com, iPhone. Браузерные `tests/*.cjs` в этот раз не гонял (в CI зелёные).

## Как устроено сейчас
- Фронтенд — `public/` (раздаёт Worker). Корневые копии удалены 23.10 (решение владельца).
- Прод `kolobovdjp.org/hub/` — приватная сборка владельца (owner-download, уведомления, auth шлюза), в repo её нет.
- `deploy-worker.yml` — только вручную, с вводом `OVERWRITE PRIVATE PRODUCTION BUILD`; 21.10 13:53–14:12Z он затёр прод, откатили руками.
- `/hub` и `/doktor` до Worker доходят через шлюз Sites (`corporate-hub-gateway`), zone routes на домене не срабатывают.
- Pages на github.io — только редиректы, политика Krenkballs, `/doktor/`.

## Owner gates
1. Политика регистрации: выбран вариант А (23.10). Матрица `APP_ACCESS` в `src/worker.js`, free и paid видят chat и downloads; только paid — Location Fusion (плитка скрыта, внешний URL не защищён) и `job-forge` (зарезервирован, приложения ещё нет), решение 23.10.
   Закрыть сам `kolobovdjp.org/locationfusion/` из этого repo нельзя: Worker хаба этот путь не получает (в `wrangler.jsonc` и `src/` маршрута нет, раздаёт его шлюз/приватная часть). Нужна проверка tier на стороне, которая отдаёт `/locationfusion/`, — решение и доступ владельца.
2. Любой запуск `deploy-worker.yml` и сведение приватной сборки с `main`.
3. Ключ Claude на iPhone внутри значка «Домой» (новый origin — ключ вводить заново).
4. Публикация сборок в GitHub Releases; подписанные сборки и ключи — только с «да».
5. `Claude-Session` в старой истории (`055de2e`, `a093dc9`, ветка `stage1-hub-chat`): чистка только владельцем.

## Дальше (предложения, без «да» не делаю)
- Перенести приватные части прод-сборки в repo (без секретов), чтобы `main` = прод.
- Гонять `check-subpath`/`e2e` по `public/` локально перед каждым PR.
