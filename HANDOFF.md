# HANDOFF — Хаб (18.10.2026)

## Версии
- `main` = `055de2e` (PR #2 влит), repo публичный, Pages из `main` / root, run 39083716699 success.
- Сайт: https://maverlix777.github.io/hub/. Этот PR — только доки (CLAUDE.md, PROGRESS.md, HANDOFF.md), код не менялся.

## Проверки на 055de2e (облако, мок API, реальный ключ не нужен)
- `node tests/check-csp.cjs` → `3 из 3 страниц и 3 скриптов ок`
- `node tests/check-downloads.cjs` → `ok manifest: 1 запис.`; sha256 записи = digest артефакта CI (сверено через API)
- `NODE_PATH=/opt/node-tools/node_modules node tests/e2e.cjs` → `71 прошло, 0 упало`
- Подпуть `/hub/` (сервер с симлинком `hub`, 390 и 1280 px): `34 прошло, 0 упало` — manifest, start_url/scope, иконки, плитки, Загрузки, Чат, «← Хаб», ни одного ответа ≥400, CSP-нарушений нет. Скрипт одноразовый, в repo не добавлен.
- Не проверено: живой сайт из облака (прокси режет github.io, 200 — по отчёту Mac-сессии), реальный api.anthropic.com, iPhone.

## Owner gates (решает только владелец)
1. Ключ Claude: ввести внутри значка «Домой» и проверить чат на iPhone; хранилище значка и Safari, вероятно, раздельны.
2. Общий origin `maverlix777.github.io`: сейчас Pages только у hub (has_pages по API 18.10: 1 из 12 repo аккаунта). Не включать Pages в других repo без своего домена.
3. Загрузки: Nebula Pop — артефакт CI в приватном repo (вход в GitHub, срок до 2027-01-15). Постоянная ссылка = GitHub Release, публикацию сборок подтверждает владелец.
4. Плитка Location Fusion и запись Nebula Pop ведут в приватные repo (чужим — 404): оставить, заменить или убрать.
5. Ссылки на сессии Claude и имя автора в истории (ниже): очистка истории и закрытие — только владелец.

## Публичные ссылки на приватное (найдено, ничего не удалено)
- `index.html` (строка Location Fusion): ссылка на приватный repo; описание раскрывает статус подписи.
- `apps/downloads.html:19`: ссылка на запуск CI в приватном repo Nebula Pop; имя файла и note.
- `CLAUDE.md` (строки про плитки и Pages): имена других repo аккаунта, заметка про CNAME.
- Сессии Claude: `Claude-Session` в коммитах `055de2e`, `a093dc9`; ссылка на сессию в телах PR #1 и #2; те же коммиты в ветках `stage1-hub-chat`, `claude/downloads-section`.
- Автор коммитов — имя из профиля GitHub (noreply-почта).
- Pages раздаёт всё дерево, включая `tests/`, `tools/` и эти .md.
