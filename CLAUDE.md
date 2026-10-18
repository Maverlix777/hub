# Хаб — CLAUDE.md

Правила работы: скилл `/start-project` (глобальные агенты scout/builder/architect, `/cost-check`). Здесь они не копируются.

## Что за проект
Личный лаунчер приложений владельца: одна страница с плитками, мобильная в первую очередь, тема по системе.
Без бэкенда, без сборки, без зависимостей и сторонних скриптов: чистые HTML, CSS, JS. Repo `maverlix777/hub`.

## Структура
- `index.html` — хаб. Массив APPS — JSON-блок `<script type="application/json" id="apps">` в начале файла
  (inline-JS запрещён CSP). Поля: id, title, desc, status ("ready" | "soon"), href. Новое приложение = один объект.
- `hub.js` — рисует плитки из APPS (только textContent). `style.css` — общие стили и темы.
- `apps/chat.html`, `chat.js`, `chat.css` — чат с Claude API напрямую из браузера.
- `apps/downloads.html`, `downloads.js`, `downloads.css` — раздел «Загрузки». Реестр сборок — JSON-блок `<script type="application/json" id="manifest">` в html (fetch под CSP заблокирован). Поля: project, platform, kind, version, file, size, sha256, date, url (https), note.
- `tests/check-csp.cjs` — статическая проверка CSP, внешних/inline-скриптов во всех страницах (apps/ рекурсивно) и опасных приёмников HTML в .js (innerHTML, eval и т.п.).
- `tests/check-downloads.cjs` — проверка реестра сборок (обязательные поля, sha256, дата, https).
- `tests/e2e.cjs` — Playwright: 390/1280 px, плитки, тёмная тема, чат с локальным HTTPS-моком API.
- `manifest.webmanifest`, `icons/` (180/192/512, без альфы), `tools/make-icons.py` — значок на экран телефона (PWA, без service worker).
- Плитки по данным репо: Location Fusion (`location-fusion-ios`, iOS) — ссылка на приватный repo, на телефоне не установлено: нет подписи Network Extension;
  Доктор (`doktor`, iOS через SideStore) — ссылка на релизы публичного `doktor-sidestore`. URL-схемы у Доктора нет.

## Запуск и проверка
```sh
python3 -m http.server 8765          # открыть http://127.0.0.1:8765/
node tests/check-csp.cjs             # CSP всех страниц
node tests/check-downloads.cjs       # реестр «Загрузок»
NODE_PATH=/opt/node-tools/node_modules node tests/e2e.cjs   # нужен openssl, python3, порт 443 (root)
```
e2e подменяет api.anthropic.com через `--host-resolver-rules` на локальный мок: код не трогается, реальный ключ не нужен.

## Чат: формат API (сверено с platform.claude.com 17.10.2026)
POST https://api.anthropic.com/v1/messages; заголовки x-api-key, anthropic-version: 2023-06-01,
content-type: application/json, anthropic-dangerous-direct-browser-access: true (последний в справке
не нашёл, взят из ТЗ владельца). stream: true, SSE: из `content_block_delta` берём только `text_delta`,
`event: error` показываем как есть. Ключи localStorage: `hub.chat.key|model|system|history`.

## Загрузки
Каждая собранная сборка (APK, AAB, IPA, MP4, ZIP и т.п.) регистрируется в реестре `apps/downloads.html`: один объект на файл.
Бинарники в git не класть; url ведёт на GitHub Release или артефакт CI (артефакты CI живут ограниченное время и требуют входа в GitHub).
Ключи, keystore и подписанные релизные сборки без «да» владельца не публиковать.

## Красная зона
- Всё на одном origin: любой скрипт на нём видит ключ. Никаких CDN и сторонних скриптов.
- CSP meta на каждой странице, ровно: `default-src 'self'; connect-src https://api.anthropic.com; style-src 'self' 'unsafe-inline'`.
  Новое приложение в `apps/` обязано пройти `tests/check-csp.cjs`.
- Ключ: только localStorage браузера. Не в коде, URL, логах, консоли, тексте ошибок, git.
- Ответ модели — только textContent (или безопасный markdown без innerHTML с непроверенным текстом).
- Пуш, публикация, хостинг — только после «да» владельца.
- Хостинг: GitHub Pages из `main` / root, repo публичный (с 18.10.2026), сайт `https://maverlix777.github.io/hub/`.
  Pages раздаёт всё дерево, включая CLAUDE.md, PROGRESS.md, HANDOFF.md и tests/: приватные сведения в repo не класть.
- `maverlix777.github.io` — один origin на все project-сайты аккаунта: localStorage (ключ) виден их скриптам.
  Не включать Pages в других repo аккаунта без своего домена (у mukha-v-storonu CNAME есть, он отдельный).
- Ключ вводить внутри значка «Домой» и проверить на телефоне: хранилище значка и вкладки Safari, вероятно, раздельны (не проверено).
