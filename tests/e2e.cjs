// E2E в headless Chromium. api.anthropic.com подменяется локальным HTTPS-моком
// через --host-resolver-rules, код приложения не меняется. Реальный ключ не используется.
// Запуск: NODE_PATH=/opt/node-tools/node_modules node tests/e2e.cjs  (нужны openssl и python3, порт 443)
'use strict';
const { chromium } = require('playwright');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WEB_ROOT = process.env.HUB_SITE_ROOT ? path.resolve(process.env.HUB_SITE_ROOT) : path.join(ROOT, 'public');
const PORT = 8765;
const PREFIX = '/hub/';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SITE = ORIGIN + PREFIX;
const KEY_OK = 'sk-ant-TEST-stream-0000';
const KEY_401 = 'sk-ant-TEST-bad-1111';
const KEY_MIDERR = 'sk-ant-TEST-miderr-2222';
const KEY_REFUSAL = 'sk-ant-TEST-refusal-3333';
const KEY_MAXTOK = 'sk-ant-TEST-maxtok-4444';
const KEY_NOSTOP = 'sk-ant-TEST-nostop-5555';
const ALL_KEYS = [KEY_OK, KEY_401, KEY_MIDERR, KEY_REFUSAL, KEY_MAXTOK, KEY_NOSTOP];
const SHOTS = path.join(ROOT, 'tests', 'shots');

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ' :: ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- мок API ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-e2e-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=api.anthropic.com',
  '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem')], { stdio: 'ignore' });
const apiLog = []; // { method, headers, body, aborted }
const sse = (ev, obj) => `event: ${ev}\ndata: ${JSON.stringify(obj)}\n\n`;
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'x-api-key, anthropic-version, content-type, anthropic-dangerous-direct-browser-access',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const api = https.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) }, (req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const entry = { method: req.method, url: req.url, headers: req.headers, body, aborted: false };
    apiLog.push(entry);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const key = req.headers['x-api-key'];
    if (key === KEY_401) {
      res.writeHead(401, { ...cors, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' }, request_id: 'req_mock401' }));
    }
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.on('close', () => { if (!res.writableEnded) entry.aborted = true; });
    res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', content: [], model: 'mock' } }));
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    res.write(sse('ping', { type: 'ping' }));
    // REFUSAL: ни одного куска текста; MAXTOK/NOSTOP: два куска; NOSTOP: поток обрывается без message_delta
    const n = key === KEY_MIDERR ? 3 : key === KEY_MAXTOK || key === KEY_NOSTOP ? 2 : key === KEY_REFUSAL ? 0 : 60;
    for (let i = 0; i < n; i++) {
      if (res.destroyed) return;
      // <b> проверяет, что ответ не попадает в innerHTML
      res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: i === 0 ? '<b>x</b> часть0 ' : `часть${i} ` } }));
      await sleep(100);
    }
    if (key === KEY_MIDERR) {
      res.write(sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
      return res.end();
    }
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
    if (key === KEY_NOSTOP) return res.end();
    const stopReason = key === KEY_MAXTOK ? 'max_tokens' : key === KEY_REFUSAL ? 'refusal' : 'end_turn';
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 60 } }));
    res.write(sse('message_stop', { type: 'message_stop' }));
    res.end();
  });
});

// --- статика под /hub/ и мок API Worker (сессия, выход, страница входа) ---
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
let sessionOk = true; // false = «аноним»: /hub/api/session отвечает 401
const web = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (!url.startsWith(PREFIX)) { res.writeHead(404); return res.end('not found'); }
  if (req.method === 'GET' && url === PREFIX + 'api/session') {
    if (!sessionOk) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"username":"test","entitlement":"free"}');
  }
  // Synthetic public configuration only. No push subscription is created by traversal.
  if (req.method === 'GET' && url === PREFIX + 'api/push/config') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ publicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url') }));
    return;
  }
  if (req.method === 'POST' && url === PREFIX + 'api/logout') { res.writeHead(204); return res.end(); }
  let rel = url.slice(PREFIX.length);
  if (rel === 'login/') rel = 'login.html';
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((r) => api.listen(443, '127.0.0.1', r));
  await new Promise((r) => web.listen(PORT, '127.0.0.1', r));
  fs.mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({
    args: ['--host-resolver-rules=MAP api.anthropic.com 127.0.0.1'],
  });

  const consoleLines = [];
  const requests = []; // { url, headers, postData }
  const cspViolations = [];
  const pageErrors = [];
  function watch(page) {
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message)));
    page.on('console', (m) => {
      consoleLines.push(m.text());
      if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text());
    });
    page.on('request', (r) => requests.push({ url: r.url(), headers: r.headers(), postData: r.postData() || '' }));
  }

  try {
    // --- хаб на 390 и 1280 ---
    for (const width of [390, 1280]) {
      const ctx = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: 'light', ignoreHTTPSErrors: true });
      const page = await ctx.newPage(); watch(page);
      await page.goto(`${SITE}index.html`);
      await page.waitForFunction(() => document.getElementById('push-status').textContent === 'Получай уведомления, когда агенты отправляют изменения.');
      check(`${width}px: push fixture enables explicit subscription action`,
        await page.$eval('#push-toggle', button => !button.disabled && button.textContent === 'Включить уведомления'));
      // The synthetic session has no app restrictions; require the exact catalog,
      // including order and count, rather than a stale hardcoded tile total.
      const expectedTiles = await page.evaluate(() => JSON.parse(document.getElementById('apps').textContent).map((app) => app.id));
      const actualTiles = await page.locator('.tile').evaluateAll((nodes) => nodes.map((node) => node.dataset.id));
      check(`${width}px: плитки точно соответствуют каталогу (${expectedTiles.length})`,
        JSON.stringify(actualTiles) === JSON.stringify(expectedTiles), actualTiles.join(' | '));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${width}px: нет горизонтального скролла`, overflow <= 0, overflow);
      const cols = await page.evaluate(() => getComputedStyle(document.getElementById('grid')).gridTemplateColumns.split(' ').length);
      console.log(`info ${width}px: колонок сетки = ${cols}`);
      await page.screenshot({ path: path.join(SHOTS, `hub-${width}.png`), fullPage: true });

      check(`${width}px: Doktor and Claude API removed from catalog`, await page.locator('.tile[data-id="doktor"], .tile[data-id="chat"]').count() === 0);
      const lf = await page.locator('.tile[data-id="location-fusion"]').evaluate((e) => e.tagName + '|' + e.getAttribute('href') + '|' + e.rel);
      check(`${width}px: «Location Fusion» ведёт на страницу публичной сборки`, lf === 'A|https://kolobovdjp.org/locationfusion/install/|noopener noreferrer', lf);
      check(`${width}px: no Claude API or Doktor menu links`, await page.locator('.hub-nav a').filter({ hasText: /Claude API|\u0414\u043e\u043a\u0442\u043e\u0440/ }).count() === 0);
      // The legacy direct route remains supported after its menu entry is removed.
      await page.goto(`${SITE}apps/chat.html`);
      const ov2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${width}px: legacy chat has no horizontal overflow`, ov2 <= 0, ov2);
      await page.screenshot({ path: path.join(SHOTS, `chat-${width}.png`), fullPage: true });
      await page.locator('#hub').click();
      await page.waitForURL((u) => u.href === SITE || u.href === `${SITE}index.html`);
      check(`${width}px: Hub brand returns to homepage`, [SITE, `${SITE}index.html`].includes(page.url()), page.url());
      await page.locator('.tile[data-id="downloads"]').click();
      await page.waitForURL('**/apps/downloads.html');
      const reg = await page.evaluate(() => JSON.parse(document.getElementById('manifest').textContent));
      const cards = await page.locator('.dl').count();
      check(`${width}px: Doktor available in downloads`, await page.locator('.dl[data-project="\u0414\u043e\u043a\u0442\u043e\u0440"] a.btn[href^="https://"]').count() > 0);
      check(`${width}px: «Загрузки» показывают доступные и ожидающие записи из реестра`, cards === reg.length && cards >= 3, cards);
      const nebulaAndroid = reg.findIndex((item) => item.project === 'Nebula Pop' && item.platform.toLowerCase() === 'android');
      const unavailableLinks = nebulaAndroid < 0 ? -1 : await page.locator('.dl').nth(nebulaAndroid).locator('a.btn').count();
      check(`${width}px: недоступная Nebula Pop Android не показывает «Скачать»`,
        nebulaAndroid >= 0 && reg[nebulaAndroid].available === false && unavailableLinks === 0, unavailableLinks);
      const nebulaIOS = reg.findIndex((item) => item.project === 'Nebula Pop' && item.platform.toLowerCase() === 'ios');
      const iosLinks = nebulaIOS < 0 ? [] : await page.locator('.dl').nth(nebulaIOS).locator('a.btn').evaluateAll((links) => links.map((link) => link.href));
      check(`${width}px: доступная Nebula Pop iOS показывает точную ссылку из реестра`,
        nebulaIOS >= 0 && reg[nebulaIOS].available !== false && iosLinks.length === 1 && iosLinks[0] === reg[nebulaIOS].url, iosLinks.join(' | '));
      const lfDownload = await page.locator('.dl').filter({ hasText: 'Location Fusion 3.1.14 (build 1, main 9037cb0, без встроенного VPN)' }).locator('a.btn').evaluate((e) => e.href + '|' + e.rel);
      check(`${width}px: build 1 ведёт на публичный IPA с noopener`,
        lfDownload === 'https://github.com/Maverlix777/hub/releases/download/lf-ios-3.1.14-build1/LocationFusion-ios-3.1.14-build1-unsigned.ipa|noopener noreferrer', lfDownload);
      const kbDownload = await page.locator('.dl').filter({ hasText: 'Krenkballs 75 (7340a86)' }).locator('a.btn').evaluate((e) => e.href + '|' + e.rel);
      check(`${width}px: Krenkballs 75 ведёт на публичный APK из релиза хаба с noopener`,
        kbDownload === 'https://github.com/Maverlix777/hub/releases/download/krenkballs-android-75-debug/Krenkballs-android-75-debug.apk|noopener noreferrer', kbDownload);
      const dlAll = await page.locator('.dl a.btn').evaluateAll((els) => els.map((e) => e.getAttribute('href') + '|' + e.rel));
      const regLinks = reg.filter((i) => i.available !== false).length;
      check(`${width}px: «Загрузки» все ссылки https и noopener (кнопок: ${regLinks})`,
        dlAll.length === regLinks && dlAll.every((d) => /^https:\/\/[^|]+\|noopener noreferrer$/.test(d)), dlAll.join(' ; '));
      await page.fill('#q', 'nebula');
      const expectedSearch = reg.filter((item) => [item.project, item.platform, item.kind, item.version, item.note].join(' ').toLowerCase().includes('nebula'));
      const searchHeadings = await page.locator('.dl h2').allTextContents();
      const expectedHeadings = expectedSearch.map((item) => item.project + ' ' + item.version);
      check(`${width}px: «Загрузки» поиск показывает ровно совпавшие записи реестра`,
        JSON.stringify(searchHeadings) === JSON.stringify(expectedHeadings), searchHeadings.join(' | '));
      const ov3 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${width}px: «Загрузки» без горизонтального скролла`, ov3 <= 0, ov3);
      await page.locator('#hub').click();
      await page.waitForURL((u) => u.href === SITE || u.href === `${SITE}index.html`);
      await ctx.close();
    }

    // --- сессия: аноним уходит на вход, вошедший видит имя аккаунта ---
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
      const page = await ctx.newPage(); watch(page);
      sessionOk = true;
      await page.goto(`${SITE}index.html`);
      await page.waitForFunction(() => document.getElementById('account-name').textContent.length > 0);
      const acc = await page.textContent('#account-name');
      check('сессия 200: в #account-name показано имя «test»', acc.includes('test'), acc);
      sessionOk = false;
      await page.goto(`${SITE}index.html`);
      await page.waitForURL('**/hub/login/');
      check('сессия 401: /hub/index.html редиректит на /hub/login/', page.url() === `${SITE}login/`, page.url());
      sessionOk = true;
      await ctx.close();
    }

    // --- PWA: манифест, значки, устанавливаемость по мнению Chromium ---
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage(); watch(page);
      for (const p of ['index.html', 'apps/chat.html']) {
        await page.goto(SITE + p);
        const cdp = await ctx.newCDPSession(page);
        const man = await cdp.send('Page.getAppManifest');
        const parsed = man.errors.length === 0 && JSON.parse(man.data || '{}').name === 'Хаб';
        check(`PWA ${p}: манифест найден и разобран`, parsed && man.url === `${SITE}manifest.webmanifest`, `${man.url} ошибок ${man.errors.length}`);
        // Page.getInstallabilityErrors в headless отдаёт [] даже без манифеста, поэтому проверяем поля сами
        const m = JSON.parse(man.data || '{}');
        const sizes = (m.icons || []).map((i) => i.sizes);
        const okFields = m.name && m.start_url && ['standalone', 'fullscreen', 'minimal-ui'].includes(m.display) && sizes.includes('192x192') && sizes.includes('512x512');
        check(`PWA ${p}: обязательные поля манифеста (name, start_url, display, значки 192/512)`, !!okFields, `${m.display} ${sizes.join(',')}`);
        const apple = await page.evaluate(() => { const l = document.querySelector('link[rel="apple-touch-icon"]'); return l && l.href; });
        check(`PWA ${p}: apple-touch-icon`, apple === `${SITE}icons/icon-180.png`, apple);
      }
      for (const s of [180, 192, 512]) {
        const r = await page.request.get(`${SITE}icons/icon-${s}.png`);
        const b = await r.body();
        const w = b.readUInt32BE(16), h = b.readUInt32BE(20), colorType = b[25];
        check(`значок ${s}: 200, PNG ${s}x${s}, без альфы`, r.status() === 200 && w === s && h === s && colorType === 2, `${r.status()} ${w}x${h} ct=${colorType}`);
      }
      const mr = await page.request.get(`${SITE}manifest.webmanifest`);
      console.log('info manifest content-type: ' + mr.headers()['content-type']);
      await ctx.close();
    }

    // --- тёмная тема ---
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
      const page = await ctx.newPage(); watch(page);
      await page.goto(`${SITE}index.html`);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      check('системная тёмная тема: хаб сохраняет согласованный светлый фон', bg === 'rgb(243, 245, 249)', bg);
      await page.screenshot({ path: path.join(SHOTS, 'hub-390-dark.png'), fullPage: true });
      await page.goto(`${SITE}apps/chat.html`);
      const bg2 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      check('системная тёмная тема: чат сохраняет согласованный светлый фон', bg2 === 'rgb(243, 245, 249)', bg2);
      await ctx.close();
    }

    // --- чат ---
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', ignoreHTTPSErrors: true });
    const page = await ctx.newPage(); watch(page);
    // «Отправить» отправляет запрос не сразу (сначала проверка сессии), поэтому конец хода = запрос дошёл до мока И кнопка вернулась
    const postCount = () => apiLog.filter((e) => e.method === 'POST').length;
    let sentAt = 0;
    const clickSend = async () => { sentAt = postCount(); await page.click('#send'); };
    const done = async () => {
      for (let i = 0; i < 200 && postCount() <= sentAt; i++) await sleep(50);
      await page.waitForSelector('#send:not([hidden])', { timeout: 15000 });
    };
    // «Забыть ключ» только если он есть и настройки раскрыты (после «Очистить» или перезагрузки ключа может уже не быть)
    const openSettings = async () => { if (!(await page.locator('#settings').evaluate((e) => e.open))) await page.click('#settings summary'); };
    const forget = async () => { await openSettings(); if (!(await page.locator('#forgetKey').isDisabled())) await page.click('#forgetKey'); };
    await page.goto(`${SITE}apps/chat.html`);
    check('без ключа настройки раскрыты', await page.locator('#settings').evaluate((e) => e.open));
    await openSettings(); await page.fill('#key', KEY_OK);
    await page.click('#saveKey');
    check('поле ключа очищено после сохранения', (await page.inputValue('#key')) === '');
    await page.fill('#system', 'Отвечай коротко.');
    await page.fill('#input', 'привет');
    await page.click('#send');
    const last = page.locator('.msg.assistant .body').last();
    await page.waitForFunction(() => { const b = [...document.querySelectorAll('.msg.assistant .body')].pop(); return b && b.textContent.length > 0; });
    const len1 = (await last.textContent()).length;
    await sleep(600);
    const len2 = (await last.textContent()).length;
    check('поток: текст растёт по мере прихода', len2 > len1 && len1 > 0, `${len1} -> ${len2}`);
    check('кнопка «Стоп» видна во время потока', await page.locator('#stop').isVisible());
    await page.click('#stop');
    await sleep(500);
    const stoppedText = await last.textContent();
    await sleep(500);
    const after = await last.textContent();
    const note = await page.locator('.msg.assistant .note').last().textContent().catch(() => '');
    check('стоп: текст больше не растёт', after === stoppedText && !after.includes('часть59'), `${after.length} симв.`);
    check('стоп: пометка «остановлено», кнопка «Отправить» вернулась', note === 'остановлено' && await page.locator('#send').isVisible(), note);
    const post = apiLog.filter((e) => e.method === 'POST');
    check('стоп: соединение с API оборвано', post.length === 1 && post[0].aborted, JSON.stringify(post.map((e) => e.aborted)));
    const h = post[0].headers; const b = JSON.parse(post[0].body);
    check('запрос: заголовки по справке', h['anthropic-version'] === '2023-06-01' && h['content-type'] === 'application/json' &&
      h['anthropic-dangerous-direct-browser-access'] === 'true' && h['x-api-key'] === KEY_OK && post[0].url === '/v1/messages',
      `${post[0].url} ${h['anthropic-version']} ${h['content-type']}`);
    check('запрос: тело model/max_tokens/stream/system/messages', b.model === 'claude-sonnet-5-5' && b.stream === true &&
      b.max_tokens > 0 && b.system === 'Отвечай коротко.' && b.messages.length === 1 && b.messages[0].content === 'привет', JSON.stringify(b));
    const bHtml = await last.evaluate((e) => e.innerHTML);
    check('ответ как текст: <b> экранирован, не тег', bHtml.startsWith('&lt;b&gt;x&lt;/b&gt;') && (await page.locator('.msg b').count()) === 0, bHtml.slice(0, 30));

    // ключ никогда не лежит в localStorage (ни под каким именем); допустимо: память вкладки или sessionStorage этой вкладки (SITE-11)
    const localStore = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
    check('ключ не в localStorage (ни под каким ключом)', !ALL_KEYS.some((k) => localStore.includes(k)) && !localStore.includes('hub.chat.key'), localStore.slice(0, 120));
    const keyInSession = await page.evaluate((k) => Object.values(sessionStorage).includes(k), KEY_OK);
    console.log('info ключ в sessionStorage вкладки: ' + keyInSession);

    // история переживает перезагрузку; ключ переживает только если страница держит его в sessionStorage
    await page.reload();
    const msgs = await page.locator('.msg').count();
    check('история в localStorage после перезагрузки', msgs === 2, msgs);
    if (keyInSession) {
      check('после перезагрузки ключ из sessionStorage на месте', !(await page.locator('#forgetKey').isDisabled()) && (await page.textContent('#keyState')) !== 'Ключ не задан.');
      await forget();
      check('«Забыть ключ» чистит sessionStorage', !(await page.evaluate((k) => Object.values(sessionStorage).includes(k), KEY_OK)));
    } else {
      check('после перезагрузки ключ надо вводить заново', (await page.textContent('#keyState')) === 'Ключ не задан.' && await page.locator('#forgetKey').isDisabled() &&
        await page.locator('#settings').evaluate((e) => e.open));
    }

    // второй ход идёт с историей, доигрываем до конца
    await openSettings(); await page.fill('#key', KEY_OK); await page.click('#saveKey');
    await page.selectOption('#model', 'claude-haiku-5-5');
    await page.fill('#input', 'ещё');
    await clickSend();
    await done();
    const full = await page.locator('.msg.assistant .body').last().textContent();
    const post2 = apiLog.filter((e) => e.method === 'POST')[1];
    const b2 = JSON.parse(post2.body);
    check('поток до конца (60 кусков)', full.includes('часть59'), full.length);
    check('второй ход: модель haiku, история user/assistant/user', b2.model === 'claude-haiku-5-5' &&
      b2.messages.map((m) => m.role).join(',') === 'user,assistant,user', b2.messages.map((m) => m.role).join(','));

    // ошибка в середине потока
    await forget();
    await openSettings(); await page.fill('#key', KEY_MIDERR); await page.click('#saveKey');
    await page.fill('#input', 'сбой'); await clickSend();
    await done();
    const midErr = await page.locator('.msg.error .body').last().textContent();
    check('ошибка в потоке показана как есть', midErr.includes('"overloaded_error"') && midErr.includes('Overloaded'), midErr.replace(/\n/g, ' | '));

    // 401
    await forget();
    check('«Забыть ключ» сбрасывает состояние и блокируется', (await page.textContent('#keyState')) === 'Ключ не задан.' && await page.locator('#forgetKey').isDisabled());
    await openSettings(); await page.fill('#key', KEY_OK); await page.click('#saveKey');
    await openSettings(); await page.fill('#key', KEY_OK); await forget();
    check('«Забыть ключ» очищает поле ввода и состояние', (await page.inputValue('#key')) === '' &&
      (await page.textContent('#keyState')) === 'Ключ не задан.' && await page.locator('#forgetKey').isDisabled());
    await openSettings(); await page.fill('#key', KEY_401); await page.click('#saveKey');
    await page.fill('#input', 'проверка 401'); await clickSend();
    await done();
    const err = await page.locator('.msg.error .body').last().textContent();
    console.log('raw 401 в UI:\n' + err);
    check('401 выводится как есть', err.startsWith('HTTP 401\n') && err.includes('"authentication_error"') && err.includes('invalid x-api-key'));
    check('ключ не в тексте ошибки', !ALL_KEYS.some((k) => err.includes(k)));
    check('текст 401-запроса вернулся в поле ввода', (await page.inputValue('#input')) === 'проверка 401');
    await page.screenshot({ path: path.join(SHOTS, 'chat-390-states.png'), fullPage: true });

    // CSP реально действует: запрос не на api.anthropic.com блокируется
    const blocked = await page.evaluate(() => fetch('https://example.com/').then(() => 'прошёл', (e) => 'blocked: ' + e.message));
    check('CSP блокирует connect не на api.anthropic.com', blocked.startsWith('blocked'), blocked);

    // очистка
    await page.click('#clear');
    check('«Очистить» стирает историю', (await page.locator('.msg').count()) === 0 &&
      (await page.evaluate(() => localStorage.getItem('hub.chat.history'))) === null);

    // --- исходы без нормального ответа ---
    const setKey = async (k) => { await forget(); await openSettings(); await page.fill('#key', k); await page.click('#saveKey'); };
    const lastBody = () => page.locator('.msg.assistant .body').last();
    const histNow = () => page.evaluate(() => JSON.parse(localStorage.getItem('hub.chat.history') || '[]'));

    // пустой ответ с причиной
    await setKey(KEY_REFUSAL);
    const userBefore = await page.locator('.msg.user').count();
    await page.fill('#input', 'вопрос без ответа'); await clickSend(); await done();
    const emptyMsg = await page.locator('.msg.error .body').last().textContent();
    check('пустой ответ: причина stop_reason показана', emptyMsg.includes('refusal'), emptyMsg);
    check('пустой ответ: вопрос вернулся в поле, пузырь вопроса убран',
      (await page.inputValue('#input')) === 'вопрос без ответа' && (await page.locator('.msg.user').count()) === userBefore);
    const h1 = await histNow();
    check('пустой ответ: вопрос не остался в истории', !h1.some((m) => m.content === 'вопрос без ответа'), JSON.stringify(h1));

    // 401 тоже не оставляет вопрос в истории без ответа
    await setKey(KEY_401);
    await page.fill('#input', 'ещё раз 401'); await clickSend(); await done();
    const h2 = await histNow();
    check('ошибка HTTP: история не кончается на user', h2.length === 0 || h2[h2.length - 1].role !== 'user', JSON.stringify(h2));

    // обрезанный ответ помечен
    await setKey(KEY_MAXTOK);
    await page.fill('#input', 'длинный'); await clickSend(); await done();
    const mtNote = await page.locator('.msg.assistant .note').last().textContent();
    check('max_tokens: ответ сохранён и помечен stop_reason', mtNote === 'stop_reason: max_tokens' && (await lastBody().textContent()).includes('часть1'), mtNote);

    await setKey(KEY_NOSTOP);
    await page.fill('#input', 'обрыв'); await clickSend(); await done();
    const nsNote = await page.locator('.msg.assistant .note').last().textContent();
    check('поток без stop_reason: ответ помечен как возможно оборванный', nsNote.includes('без stop_reason'), nsNote);

    // «Очистить» посреди ответа: ничего из старого хода не попадает в новую историю
    await setKey(KEY_OK);
    await page.click('#clear');
    await page.fill('#input', 'до очистки'); await page.click('#send');
    await page.waitForFunction(() => { const b = [...document.querySelectorAll('.msg.assistant .body')].pop(); return b && b.textContent.length > 0; });
    await page.click('#clear');
    await sleep(800);
    check('«Очистить» посреди ответа: лог и история пусты, ввод разблокирован',
      (await page.locator('.msg').count()) === 0 && (await page.evaluate(() => localStorage.getItem('hub.chat.history'))) === null &&
      await page.locator('#send').isVisible() && !(await page.locator('#input').isDisabled()));
    const aborted = apiLog.filter((e) => e.method === 'POST').pop().aborted;
    check('«Очистить» посреди ответа: соединение оборвано', aborted === true, aborted);
    await page.fill('#input', 'после очистки'); await clickSend();
    await page.waitForFunction(() => { const b = [...document.querySelectorAll('.msg.assistant .body')].pop(); return b && b.textContent.length > 0; });
    await page.click('#stop'); await done();
    const afterClear = JSON.parse(apiLog.filter((e) => e.method === 'POST').pop().body).messages;
    check('после «Очистить» запрос начинается с чистой истории', afterClear.length === 1 && afterClear[0].role === 'user' && afterClear[0].content === 'после очистки', JSON.stringify(afterClear));
    await ctx.close();

    // --- битая история в localStorage не ломает страницу ---
    {
      const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
      const p2 = await ctx2.newPage(); watch(p2);
      await p2.goto(`${SITE}apps/chat.html`);
      await p2.evaluate(() => localStorage.setItem('hub.chat.history', '[null,{"role":"user","content":5},{"role":"user","content":"a"},{"role":"assistant","content":"b"},{"role":"user","content":"c"}]'));
      await p2.reload();
      check('битая история: валидные реплики на месте, хвостовой вопрос — в поле ввода',
        (await p2.locator('.msg').count()) === 2 && (await p2.inputValue('#input')) === 'c');
      await p2.evaluate(() => localStorage.setItem('hub.chat.history', '[null]'));
      await p2.reload();
      check('битая история [null]: страница живая', (await p2.locator('.msg').count()) === 0 && await p2.locator('#send').isVisible());
      await ctx2.close();
    }
    check('нет необработанных ошибок страниц', pageErrors.length === 0, pageErrors.join(' | '));

    // --- утечки ключа ---
    const inConsole = consoleLines.filter((l) => ALL_KEYS.some((k) => l.includes(k)));
    check('ключ не в консоли', inConsole.length === 0, `${consoleLines.length} строк консоли, с ключом: ${inConsole.length}`);
    const inUrl = requests.filter((r) => ALL_KEYS.some((k) => r.url.includes(k)));
    check('ключ не в URL запросов и страниц', inUrl.length === 0, `${requests.length} запросов`);
    const leaks = requests.filter((r) => {
      const isApi = r.url === 'https://api.anthropic.com/v1/messages';
      const hdrs = Object.entries(r.headers).filter(([n]) => !(isApi && n === 'x-api-key')).map(([, v]) => v).join('\n');
      return ALL_KEYS.some((k) => hdrs.includes(k) || r.postData.includes(k));
    });
    check('ключ только в x-api-key к api.anthropic.com', leaks.length === 0, leaks.map((r) => r.url).join(', '));
    const keyHosts = [...new Set(requests.filter((r) => r.headers['x-api-key']).map((r) => new URL(r.url).host))];
    check('x-api-key уходил только на api.anthropic.com', keyHosts.join() === 'api.anthropic.com', keyHosts.join());
    // frame-ancestors в <meta> браузер игнорирует и пишет предупреждение: это не нарушение (заголовок ставит Worker)
    const unexpectedCsp = cspViolations.filter((l) => !l.includes('example.com') && !/'frame-ancestors' is ignored when delivered via a <meta>/.test(l));
    check('нет CSP-нарушений кроме проверочного', unexpectedCsp.length === 0, unexpectedCsp.join(' | '));
  } catch (e) {
    failed++;
    console.log('FAIL исключение: ' + (e && e.stack));
  } finally {
    await browser.close();
    web.close();
    api.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\nИтог: ${passed} прошло, ${failed} упало`);
    process.exit(failed ? 1 : 0);
  }
})();
