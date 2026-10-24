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
