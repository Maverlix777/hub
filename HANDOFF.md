# HANDOFF — Хаб (23.10.2026)

## Версии
- `main` = `804df43` (#29). CI «Hub checks and Pages» на нём — success (run 39626905912). Открытых PR нет.
- С 18.10 влиты #7–#29: задачи SITE-1…17 (ветки `zhanna/SITE-*`), каталог игр, страницы Доктора, ручной деплой Worker.

## Проверки в облаке на `804df43` (23.10)
- `npm ci && npm test` → 102 из 102 (Worker: WebAuthn, сессии, hardening, покрытие, `/doktor/`).
- `npm run check` → CSP 4 из 4 страниц и 4 скриптов; реестр 31 запись; artifact 24 файла без docs/tests/tools; редиректы + Krenkballs + `/doktor/` ок.
- Не проверено: живые `kolobovdjp.org/hub/` и `github.io/hub/` (прокси облака 403), реальный api.anthropic.com, iPhone. Браузерные `tests/*.cjs` в этот раз не гонял (в CI зелёные).

## Как устроено сейчас
- Фронтенд — `public/` (раздаёт Worker). Корневые `index.html`, `hub.js`, `apps/` — старые копии вне тестов.
- Прод `kolobovdjp.org/hub/` — приватная сборка владельца (owner-download, уведомления, auth шлюза), в repo её нет.
- `deploy-worker.yml` — только вручную, с вводом `OVERWRITE PRIVATE PRODUCTION BUILD`; 21.10 13:53–14:12Z он затёр прод, откатили руками.
- `/hub` и `/doktor` до Worker доходят через шлюз Sites (`corporate-hub-gateway`), zone routes на домене не срабатывают.
- Pages на github.io — только редиректы, политика Krenkballs, `/doktor/`.

## Owner gates
1. Политика регистрации: А открытая + права / Б приглашения / В owner + одобрение (`reports/2026-10-21-registration-policy.md`). До решения — открытая.
2. Любой запуск `deploy-worker.yml` и сведение приватной сборки с `main`.
3. Ключ Claude на iPhone внутри значка «Домой» (новый origin — ключ вводить заново).
4. Публикация сборок в GitHub Releases; подписанные сборки и ключи — только с «да».
5. `Claude-Session` в старой истории (`055de2e`, `a093dc9`, ветка `stage1-hub-chat`): чистка только владельцем.

## Дальше (предложения, без «да» не делаю)
- Удалить или пометить корневые копии фронтенда, чтобы не правили не то.
- Перенести приватные части прод-сборки в repo (без секретов), чтобы `main` = прод.
- Гонять `check-subpath`/`e2e` по `public/` локально перед каждым PR.
