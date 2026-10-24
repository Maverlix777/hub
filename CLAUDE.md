# Хаб — CLAUDE.md

Правила работы: скилл `/start-project` (глобальные агенты scout/builder/architect, `/cost-check`). Здесь они не копируются.

## Что за проект
Личный лаунчер приложений владельца: одна страница с плитками, мобильная в первую очередь, тема по системе.
Фронтенд: чистые HTML, CSS, JS без сборки и сторонних скриптов. С #5/#6 рядом Cloudflare Worker (`src/worker.js`, вход по passkey, D1) — см. `CLOUDFLARE.md`, `README.md`. Repo `maverlix777/hub`.

## Актуально на 23.10.2026 (`main` = `804df43`)
- Источник фронтенда — `public/` (его раздаёт Worker, его читают тесты и `tools/build-site.py`). Старые корневые копии удалены 23.10; пути ниже — внутри `public/`.
- Прод `kolobovdjp.org/hub/` — ПРИВАТНАЯ сборка владельца, её в repo нет. `deploy-worker.yml` из `main` её затирает (так было 21.10, откатывали вручную): не запускать без «да» владельца на конкретный запуск.
- Pages (`maverlix777.github.io/hub/`) отдают только редиректы на `kolobovdjp.org/hub/` + политику Krenkballs + `/doktor/`.
- `/doktor/*` — побайтовая копия `site/doktor` из repo doktor, здесь не править.
- Задачи идут как SITE-N (ветки `zhanna/SITE-*`); политика регистрации — А (открытая + доступ по entitlement, решение владельца 23.10): матрица `APP_ACCESS` в `src/worker.js`; новое приложение в `public/apps/` без записи в матрице отдаёт 403. Платные (только `paid`, решение 23.10): Location Fusion — внешняя плитка, хаб её только скрывает (`locked` в `/hub/api/session`), сам `kolobovdjp.org/locationfusion/` Worker хаба не защищает; Job Forge — пока только план (`agent-handoffs`, 20.10), id `job-forge` заранее в матрице как `paid`.
- Проверки: `npm ci && npm test` (Worker), `npm run check` (CSP, реестр, artifact, редиректы), браузерные — `tests/*.cjs` с `NODE_PATH`.

## Структура
- `public/index.html` — хаб. Массив APPS — JSON-блок `<script type="application/json" id="apps">` в начале файла
  (inline-JS запрещён CSP). Поля: id, title, desc, status ("ready" | "soon"), href. Новое приложение = один объект.
- `public/hub.js` — рисует плитки из APPS (только textContent). `style.css` — общие стили и темы.
- `public/apps/chat.html`, `chat.js`, `chat.css` — чат с Claude API напрямую из браузера.
- `public/apps/downloads.html`, `downloads.js`, `downloads.css` — раздел «Загрузки». Реестр сборок — JSON-блок `<script type="application/json" id="manifest">` в html (fetch под CSP заблокирован). Поля: project, platform, kind, version, file, size, sha256, date, url (https), note.
- `tests/check-csp.cjs` — статическая проверка CSP, внешних/inline-скриптов во всех страницах (apps/ рекурсивно) и опасных приёмников HTML в .js (innerHTML, eval и т.п.).
- `tests/check-downloads.cjs` — проверка реестра сборок, публичного build 9 metadata и скрытия ссылок для недоступных сборок.
- `tools/build-site.py` — собирает allowlisted Pages artifact только из публичных HTML/CSS/JS/иконок. Не копирует `CLAUDE.md`, `HANDOFF.md`, `PROGRESS.md`, `tests/`, `tools/`.
- `static/games/krenkballs/privacy.html` — политика конфиденциальности игры Krenkballs. Попадает в Pages artifact рядом с редиректами (`STATIC_PAGES` в `tools/build-site.py`), адрес `https://maverlix777.github.io/hub/games/krenkballs/privacy.html`. Источник: `docs/site/krenkballs/privacy.html` в `nebula-pop`; менять в обоих местах.
- `.github/workflows/ci.yml` — запускает проверки и браузерные тесты на собранном artifact; после проверки main собирает и публикует Pages artifact из того же allowlist.
- `tests/e2e.cjs` — Playwright: 390/1280 px, плитки, тёмная тема, чат с локальным HTTPS-моком API.
- `public/manifest.webmanifest`, `public/icons/` (180/192/512, без альфы), `tools/make-icons.py` — значок на экран телефона (PWA, без service worker).
- Плитка Location Fusion ведёт на публичную страницу текущей unsigned SideStore preview-сборки (внешний LocalDevVPN), не на приватный исходный repo;
  Доктор (`doktor`, iOS через SideStore) — ссылка на релизы публичного `doktor-sidestore`. URL-схемы у Доктора нет.

## Запуск и проверка
```sh
python3 -m http.server 8765          # открыть http://127.0.0.1:8765/
node tests/check-csp.cjs             # CSP всех страниц
node tests/check-downloads.cjs       # реестр «Загрузок»
python3 tests/check-site-artifact.py # содержимое Pages artifact
NODE_PATH=/opt/node-tools/node_modules node tests/check-subpath.cjs # базовый путь /hub/
NODE_PATH=/opt/node-tools/node_modules node tests/e2e.cjs   # нужен openssl, python3, порт 443
```
e2e подменяет api.anthropic.com через `--host-resolver-rules` на локальный мок: код не трогается, реальный ключ не нужен. CI grants the test Node process permission to bind port 443; it does not call Anthropic.

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
- Хостинг: приложение — Worker на `https://kolobovdjp.org/hub/` (приватная сборка, см. «Актуально»); GitHub Pages из artifact workflow отдаёт только редиректы и статические страницы.
  Artifact allowlist содержит только приложение; координационные документы и тесты в Pages не включать. Сам GitHub repository публичный, поэтому не хранить секреты или private credentials в любом коммите.
- `maverlix777.github.io` — один origin на все project-сайты аккаунта: localStorage (ключ) виден их скриптам.
  Не включать Pages в других repo аккаунта без своего домена (у mukha-v-storonu CNAME есть, он отдельный).
- Ключ вводить внутри значка «Домой» и проверить на телефоне: хранилище значка и вкладки Safari, вероятно, раздельны (не проверено).
