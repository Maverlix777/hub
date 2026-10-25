// Проверка работы под подпутём /hub/ (как на GitHub Pages): локальный сервер отдаёт дерево repo ТОЛЬКО по /hub/,
// всё остальное (в т.ч. корень /) отвечает 404 — абсолютный путь в страницах сразу даст ответ ≥400.
// Реальный ключ и сеть не нужны. Запуск: NODE_PATH=/opt/node-tools/node_modules node tests/check-subpath.cjs
'use strict';
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SITE_ROOT = process.env.HUB_SITE_ROOT ? path.resolve(process.env.HUB_SITE_ROOT) : path.join(ROOT, 'public');
const PREFIX = '/hub/';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

// frame-ancestors в <meta> браузер игнорирует и пишет предупреждение: это не нарушение политики (заголовок ставит Worker)
const FRAME_ANCESTORS_META = /'frame-ancestors' is ignored when delivered via a <meta>/;
let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ' :: ' + extra : ''}`);
}

function jsonBlock(file, id) {
  const html = fs.readFileSync(path.join(SITE_ROOT, file), 'utf8');
  const m = html.match(new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`));
  return JSON.parse(m[1]);
}

let sessionOk = true; // login.js при живой сессии уводит на /hub/, поэтому для страницы входа мок переключается на «аноним»
function createServer() { return http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (!url.startsWith(PREFIX)) { res.writeHead(404); res.end('not found'); return; }
  // мок Worker API: сессия есть, выход даёт 204
  if (req.method === 'GET' && url === PREFIX + 'api/session') {
    if (!sessionOk) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"username":"test","entitlement":"free","apps":["board","chat","downloads"],"locked":[]}'); return;
  }
  if (req.method === 'POST' && url === PREFIX + 'api/logout') { res.writeHead(204); res.end(); return; }
  // Synthetic owner response for the board page visited by the traversal below.
  // This static fixture is not an authentication test; Worker tests cover that gate.
  if (req.method === 'GET' && url === PREFIX + 'api/board') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      cards: [{ id: 'SYNTHETIC-1', title: 'Synthetic board task', who: 'test', state: 'Review',
        ref: '', source: 'synthetic', column: 'review' }],
      counts: { ideas: 0, planned: 0, progress: 0, review: 1, done: 0, questions: 0 }, unmappedCount: 0,
      telemetry: { status: 'unknown', reason: 'not_configured', events: [], runs: [], gpu: { status: 'unknown', samples: [] } },
    }));
    return;
  }
  if (req.method === 'GET' && url === PREFIX + 'api/outbox') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ items: [], nextCursor: null, delivery: { status: 'not_configured' } }));
    return;
  }
  let rel = url.slice(PREFIX.length);
  // Model only the authorized-owner page route; real Worker tests own ACL checks.
  if (rel === '') rel = 'apps/board.html';
  if (rel === 'login/') rel = 'login.html';
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(SITE_ROOT, rel);
  if (!file.startsWith(SITE_ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}); }

async function main() {
  const server = createServer();
  try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const apps = jsonBlock('index.html', 'apps');
  const registry = jsonBlock('apps/downloads.html', 'manifest');
  const local = apps.filter((a) => !/^https:\/\//i.test(a.href));

  const browser = await chromium.launch(process.env.HUB_BROWSER ? { executablePath: process.env.HUB_BROWSER } : {});
  for (const [w, h] of [[390, 844], [1280, 800]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const p = await ctx.newPage();
    const bad = [], csp = [], errs = [];
    p.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url()); });
    p.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text()) && !FRAME_ANCESTORS_META.test(m.text())) csp.push(m.text().slice(0, 120)); });
    p.on('pageerror', (e) => errs.push(String(e)));

    await p.goto(BASE + PREFIX + 'index.html');
    await p.waitForSelector('a.tile');
    const hrefs = await p.$$eval('a.tile', (n) => n.map((a) => a.getAttribute('href')));
    check(`[${w}] плитки = APPS (${apps.length})`, hrefs.length === apps.length && apps.every((a, i) => hrefs[i] === a.href), hrefs.join(' | '));

    const mUrl = await p.$eval('link[rel=manifest]', (l) => l.href);
    check(`[${w}] manifest под ${PREFIX}`, mUrl === BASE + PREFIX + 'manifest.webmanifest', mUrl);
    const man = await (await ctx.request.get(mUrl)).json();
    const start = new URL(man.start_url, mUrl).href, scope = new URL(man.scope, mUrl).href;
    check(`[${w}] start_url и scope = ${PREFIX}`, start === BASE + PREFIX && scope === BASE + PREFIX, start + ' ' + scope);
    for (const ic of man.icons) {
      const r = await ctx.request.get(new URL(ic.src, mUrl).href);
      check(`[${w}] иконка ${ic.src} ${ic.sizes}`, r.status() === 200 && /png/.test(r.headers()['content-type'] || ''), r.status());
    }
    const touch = await p.$eval('link[rel=apple-touch-icon]', (l) => l.href);
    check(`[${w}] apple-touch-icon`, (await ctx.request.get(touch)).status() === 200, touch);

    for (const a of local) {
      await p.click(`a.tile[href="${a.href}"]`);
      await p.waitForLoadState('domcontentloaded');
      check(`[${w}] «${a.title}» открылся под ${PREFIX}`, p.url() === new URL(a.href, BASE + PREFIX).href, p.url());
      if (a.id === 'downloads') {
        await p.waitForSelector('li.dl, li.empty');
        const rows = await p.$$eval('li.dl h2', (n) => n.map((e) => e.textContent));
        check(`[${w}] Загрузки: записей ${registry.length}`, rows.length === registry.length && registry.every((r, i) => rows[i] === `${r.project} ${r.version}`), rows.join('|'));
        const btns = await p.$$eval('li.dl a.btn', (n) => n.map((x) => ({ href: x.href, rel: x.rel })));
        check(`[${w}] Загрузки: «Скачать» только https + noopener`, btns.every((x) => /^https:\/\//.test(x.href) && /noopener/.test(x.rel)), btns.map((x) => x.href).join(' ; '));
        await p.fill('#q', 'zzz-нет-такого');
        check(`[${w}] Загрузки: поиск без совпадений`, (await p.textContent('li.empty')) === 'Ничего не найдено.');
        check(`[${w}] Загрузки: нет горизонтального скролла`, await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      }
      if (a.id === 'board') {
        await p.waitForSelector('#columns .card');
        check(`[${w}] board renders synthetic API card`, (await p.textContent('#columns')).includes('Synthetic board task'));
        const telemetry = await p.textContent('#telemetry');
        check(`[${w}] board renders unavailable telemetry explicitly`, telemetry.includes('Свежесть неизвестна') && telemetry.includes('Нет доступных событий'));
        await p.waitForFunction(() => document.getElementById('delivery-status').textContent.includes('Канал GitHub Issues ещё не подключён'));
        check(`[${w}] board distinguishes persisted queue from unconfigured delivery`, (await p.textContent('#delivery-status')).includes('Канал GitHub Issues ещё не подключён'));
      }
      await p.click('#hub');
      await p.waitForSelector('#columns .card');
      check(`[${w}] brand returns to authorized root board from ${a.id}`, p.url() === BASE + PREFIX, p.url());
      check(`[${w}] root board still renders fixture after brand navigation`, (await p.textContent('#columns')).includes('Synthetic board task'));
      await p.click('#nav-apps');
      await p.waitForSelector('a.tile');
      check(`[${w}] explicit catalog navigation retained`, p.url() === BASE + PREFIX + 'index.html', p.url());
    }

    check(`[${w}] нет ответов ≥400 при обходе`, bad.length === 0, bad.join(' ; '));
    check(`[${w}] нет CSP-нарушений и pageerror`, csp.length === 0 && errs.length === 0, csp.concat(errs).join(' ; '));
    await ctx.close();
  }

  for (const colorScheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme });
    const p = await ctx.newPage();
    const bad = [], csp = [], errs = [];
    p.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url()); });
    p.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text()) && !FRAME_ANCESTORS_META.test(m.text())) csp.push(m.text().slice(0, 120)); });
    p.on('pageerror', (e) => errs.push(String(e)));
    sessionOk = false;
    await p.goto(BASE + PREFIX + 'login/');
    await p.waitForLoadState('networkidle');
    check(`login.html открылся под ${PREFIX}login/`, p.url() === BASE + PREFIX + 'login/' && (await p.title()) === 'Вход в Хаб', p.url());
    const styled = await p.evaluate(() => [...document.styleSheets].length >= 2);
    check('login: стили подключены под /hub/', styled);
    // единственный ожидаемый 401 — анонимная проверка сессии (мок), всё остальное не должно быть ≥400
    check('login: нет ответов ≥400 (кроме 401 анонимной сессии)', bad.filter((x) => !/^401 .*\/hub\/api\/session$/.test(x)).length === 0, bad.join(' ; '));
    const theme = await p.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const rgb = (token) => {
        const probe = document.createElement('span');
        probe.style.color = root.getPropertyValue(token).trim();
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      };
      const card = getComputedStyle(document.querySelector('.auth-card'));
      const button = getComputedStyle(document.querySelector('.auth-actions .primary'));
      const selected = [...document.querySelectorAll('meta[name="theme-color"]')].filter((m) => matchMedia(m.media).matches);
      return { card: card.backgroundColor, cardExpected: rgb('--card'), fg: card.color, fgExpected: rgb('--fg'),
        button: button.backgroundColor, buttonExpected: rgb('--accent'), buttonFg: button.color, buttonFgExpected: rgb('--accent-fg'),
        theme: selected.map((m) => m.content), bg: root.getPropertyValue('--bg').trim(),
        fits: document.documentElement.scrollWidth <= innerWidth };
    });
    check(`login ${colorScheme}: card использует тему`, theme.card === theme.cardExpected && theme.fg === theme.fgExpected, JSON.stringify(theme));
    check(`login ${colorScheme}: button использует тему`, theme.button === theme.buttonExpected && theme.buttonFg === theme.buttonFgExpected, JSON.stringify(theme));
    check(`login ${colorScheme}: нет горизонтального скролла`, theme.fits);
    check(`login ${colorScheme}: выбран theme-color`, theme.theme.length === 1 && theme.theme[0] === theme.bg, JSON.stringify(theme.theme));
    const loginTouch = await p.$eval('link[rel=apple-touch-icon]', (l) => l.href);
    check(`login ${colorScheme}: apple-touch-icon 200`, (await ctx.request.get(loginTouch)).status() === 200, loginTouch);
    fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
    await p.screenshot({ path: path.join(__dirname, 'shots', `login-390-${colorScheme}.png`), fullPage: true });
    sessionOk = true;
    check('login: нет CSP-нарушений и pageerror', csp.length === 0 && errs.length === 0, csp.concat(errs).join(' ; '));
    await ctx.close();
  }

  const rootProbe = await (await fetch(BASE + '/')).status;
  check('сервер-ловушка: корень / даёт 404 (проверка действительно ловит абсолютные пути)', rootProbe === 404, rootProbe);

  await browser.close();
  server.close();
  console.log(`\nИтог: ${passed} прошло, ${failed} упало`);
  process.exit(failed ? 1 : 0);
  } catch (e) { console.error(e); server.close(); process.exit(1); }
}

if (require.main === module) main();

module.exports = { createServer };
