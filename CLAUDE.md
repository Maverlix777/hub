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
- `tests/check-csp.cjs` — статическая проверка CSP и отсутствия внешних/inline-скриптов во всех страницах.
- `tests/e2e.cjs` — Playwright: 390/1280 px, плитки, тёмная тема, чат с локальным HTTPS-моком API.
- `manifest.webmanifest`, `icons/` (180/192/512, без альфы), `tools/make-icons.py` — значок на экран телефона (PWA, без service worker).
- Плитки по данным репо: Location Fusion (`location-fusion-ios`, iOS, "soon": нет подписи Network Extension);
  Доктор (`doktor`, iOS через SideStore) — ссылка на релизы публичного `doktor-sidestore`. URL-схемы у Доктора нет.

## Запуск и проверка
```sh
python3 -m http.server 8765          # открыть http://127.0.0.1:8765/
node tests/check-csp.cjs             # CSP всех страниц
NODE_PATH=/opt/node-tools/node_modules node tests/e2e.cjs   # нужен openssl, python3, порт 443 (root)
```
e2e подменяет api.anthropic.com через `--host-resolver-rules` на локальный мок: код не трогается, реальный ключ не нужен.

## Чат: формат API (сверено с platform.claude.com 17.10.2026)
POST https://api.anthropic.com/v1/messages; заголовки x-api-key, anthropic-version: 2023-06-01,
content-type: application/json, anthropic-dangerous-direct-browser-access: true (последний в справке
не нашёл, взят из ТЗ владельца). stream: true, SSE: из `content_block_delta` берём только `text_delta`,
`event: error` показываем как есть. Ключи localStorage: `hub.chat.key|model|system|history`.

## Красная зона
- Всё на одном origin: любой скрипт на нём видит ключ. Никаких CDN и сторонних скриптов.
- CSP meta на каждой странице, ровно: `default-src 'self'; connect-src https://api.anthropic.com; style-src 'self' 'unsafe-inline'`.
  Новое приложение в `apps/` обязано пройти `tests/check-csp.cjs`.
- Ключ: только localStorage браузера. Не в коде, URL, логах, консоли, тексте ошибок, git.
- Ответ модели — только textContent (или безопасный markdown без innerHTML с непроверенным текстом).
- Пуш, публикация, хостинг — только после «да» владельца.
- Хостинг: GitHub Pages. На бесплатном плане только для публичного repo; repo сейчас приватный.
