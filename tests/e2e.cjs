// E2E в headless Chromium. api.anthropic.com подменяется локальным HTTPS-моком
// через --host-resolver-rules, код приложения не меняется. Реальный ключ не используется.
// Запуск: NODE_PATH=/opt/node-tools/node_modules node tests/e2e.cjs  (нужны openssl и python3, порт 443)
'use strict';
const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8765;
const ORIGIN = `http://127.0.0.1:${PORT}`;
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

(async () => {
  await new Promise((r) => api.listen(443, '127.0.0.1', r));
  const web = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await sleep(700);
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
      await page.goto(`${ORIGIN}/index.html`);
      const tiles = await page.locator('.tile').count();
      check(`${width}px: 4 плитки`, tiles === 4, tiles);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${width}px: нет горизонтального скролла`, overflow <= 0, overflow);
      const cols = await page.evaluate(() => getComputedStyle(document.getElementById('grid')).gridTemplateColumns.split(' ').length);
      console.log(`info ${width}px: колонок сетки = ${cols}`);
      await page.screenshot({ path: path.join(SHOTS, `hub-${width}.png`), fullPage: true });

      const dok = await page.locator('.tile[data-id="doktor"]').evaluate((e) => e.tagName + '|' + e.getAttribute('href') + '|' + e.rel);
      check(`${width}px: «Доктор» ссылка на релизы SideStore`, dok === 'A|https://github.com/Maverlix777/doktor-sidestore/releases/latest|noopener noreferrer', dok);
      const lf = await page.locator('.tile[data-id="location-fusion"]').evaluate((e) => e.tagName + '|' + e.getAttribute('href') + '|' + e.rel);
      check(`${width}px: «Location Fusion» ссылка на репо`, lf === 'A|https://github.com/Maverlix777/location-fusion-ios|noopener noreferrer', lf);
      await page.locator('.tile[data-id="chat"]').click();
      await page.waitForURL('**/apps/chat.html');
      check(`${width}px: плитка «Чат» открывает apps/chat.html`, page.url() === `${ORIGIN}/apps/chat.html`, page.url());
      const ov2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${width}px: чат без горизонтального скролла`, ov2 <= 0, ov2);
      await page.screenshot({ path: path.join(SHOTS, `chat-${width}.png`), fullPage: true });
      await page.locator('#hub').click();
      await page.waitForURL('**/index.html');
      check(`${width}px: кнопка «Хаб» возвращает на главную`, page.url() === `${ORIGIN}/index.html`, page.url());
      // раздел «Загрузки»: реестр встроен в страницу (fetch под CSP заблокирован)
      await page.locator('.tile[data-id="downloads"]').click();
      await page.waitForURL('**/apps/downloads.html');
      const cards = await page.locator('.dl').count();
      check(`${width}px: «Загрузки» показывают запись из реестра`, cards === 1, cards);
      const dl = await page.locator('.dl a.btn').evaluate((e) => e.getAttribute('href') + '|' + e.rel);
      check(`${width}px: «Загрузки» ссылка https и noopener`, /^https:\/\/github\.com\/.+\|noopener noreferrer$/.test(dl), dl);
      await page.fill('#q', 'ios');
      const none = await page.locator('.dl').count();
      check(`${width}px: «Загрузки» поиск отсекает лишнее`, none === 0, none);
      const ov3 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${width}px: «Загрузки» без горизонтального скролла`, ov3 <= 0, ov3);
      await page.locator('#hub').click();
      await page.waitForURL('**/index.html');
      await ctx.close();
    }

    // --- PWA: манифест, значки, устанавливаемость по мнению Chromium ---
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage(); watch(page);
      for (const p of ['/index.html', '/apps/chat.html']) {
        await page.goto(ORIGIN + p);
        const cdp = await ctx.newCDPSession(page);
        const man = await cdp.send('Page.getAppManifest');
        const parsed = man.errors.length === 0 && JSON.parse(man.data || '{}').name === 'Хаб';
        check(`PWA ${p}: манифест найден и разобран`, parsed && man.url === `${ORIGIN}/manifest.webmanifest`, `${man.url} ошибок ${man.errors.length}`);
        // Page.getInstallabilityErrors в headless отдаёт [] даже без манифеста, поэтому проверяем поля сами
        const m = JSON.parse(man.data || '{}');
        const sizes = (m.icons || []).map((i) => i.sizes);
        const okFields = m.name && m.start_url && ['standalone', 'fullscreen', 'minimal-ui'].includes(m.display) && sizes.includes('192x192') && sizes.includes('512x512');
        check(`PWA ${p}: обязательные поля манифеста (name, start_url, display, значки 192/512)`, !!okFields, `${m.display} ${sizes.join(',')}`);
        const apple = await page.evaluate(() => { const l = document.querySelector('link[rel="apple-touch-icon"]'); return l && l.href; });
        check(`PWA ${p}: apple-touch-icon`, apple === `${ORIGIN}/icons/icon-180.png`, apple);
      }
      for (const s of [180, 192, 512]) {
        const r = await page.request.get(`${ORIGIN}/icons/icon-${s}.png`);
        const b = await r.body();
        const w = b.readUInt32BE(16), h = b.readUInt32BE(20), colorType = b[25];
        check(`значок ${s}: 200, PNG ${s}x${s}, без альфы`, r.status() === 200 && w === s && h === s && colorType === 2, `${r.status()} ${w}x${h} ct=${colorType}`);
      }
      const mr = await page.request.get(`${ORIGIN}/manifest.webmanifest`);
      console.log('info manifest content-type: ' + mr.headers()['content-type']);
      await ctx.close();
    }

    // --- тёмная тема ---
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
      const page = await ctx.newPage(); watch(page);
      await page.goto(`${ORIGIN}/index.html`);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      check('тёмная тема: фон хаба', bg === 'rgb(20, 20, 19)', bg);
      await page.screenshot({ path: path.join(SHOTS, 'hub-390-dark.png'), fullPage: true });
      await page.goto(`${ORIGIN}/apps/chat.html`);
      const bg2 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      check('тёмная тема: фон чата', bg2 === 'rgb(20, 20, 19)', bg2);
      await ctx.close();
    }

    // --- чат ---
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', ignoreHTTPSErrors: true });
    const page = await ctx.newPage(); watch(page);
    await page.goto(`${ORIGIN}/apps/chat.html`);
    check('без ключа настройки раскрыты', await page.locator('#settings').evaluate((e) => e.open));
    await page.fill('#key', KEY_OK);
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

    // история переживает перезагрузку
    await page.reload();
    const msgs = await page.locator('.msg').count();
    check('история в localStorage после перезагрузки', msgs === 2, msgs);

    // второй ход идёт с историей, доигрываем до конца
    check('с ключом настройки свёрнуты', !(await page.locator('#settings').evaluate((e) => e.open)));
    await page.click('#settings summary');
    await page.selectOption('#model', 'claude-haiku-5-5');
    await page.fill('#input', 'ещё');
    await page.click('#send');
    await page.waitForSelector('#send:not([hidden])', { timeout: 15000 });
    const full = await page.locator('.msg.assistant .body').last().textContent();
    const post2 = apiLog.filter((e) => e.method === 'POST')[1];
    const b2 = JSON.parse(post2.body);
    check('поток до конца (60 кусков)', full.includes('часть59'), full.length);
    check('второй ход: модель haiku, история user/assistant/user', b2.model === 'claude-haiku-5-5' &&
      b2.messages.map((m) => m.role).join(',') === 'user,assistant,user', b2.messages.map((m) => m.role).join(','));

    // ошибка в середине потока
    await page.click('#forgetKey');
    await page.fill('#key', KEY_MIDERR); await page.click('#saveKey');
    await page.fill('#input', 'сбой'); await page.click('#send');
    await page.waitForSelector('#send:not([hidden])', { timeout: 10000 });
    const midErr = await page.locator('.msg.error .body').last().textContent();
    check('ошибка в потоке показана как есть', midErr.includes('"overloaded_error"') && midErr.includes('Overloaded'), midErr.replace(/\n/g, ' | '));

    // 401
    await page.click('#forgetKey');
    check('«Забыть ключ» удаляет ключ', (await page.evaluate(() => localStorage.getItem('hub.chat.key'))) === null);
    await page.fill('#key', KEY_401); await page.click('#saveKey');
    await page.fill('#input', 'проверка 401'); await page.click('#send');
    await page.waitForSelector('#send:not([hidden])', { timeout: 10000 });
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
    const setKey = async (k) => { await page.click('#forgetKey'); await page.fill('#key', k); await page.click('#saveKey'); };
    const done = () => page.waitForSelector('#send:not([hidden])', { timeout: 10000 });
    const lastBody = () => page.locator('.msg.assistant .body').last();
    const histNow = () => page.evaluate(() => JSON.parse(localStorage.getItem('hub.chat.history') || '[]'));

    // пустой ответ с причиной
    await setKey(KEY_REFUSAL);
    const userBefore = await page.locator('.msg.user').count();
    await page.fill('#input', 'вопрос без ответа'); await page.click('#send'); await done();
    const emptyMsg = await page.locator('.msg.error .body').last().textContent();
    check('пустой ответ: причина stop_reason показана', emptyMsg.includes('refusal'), emptyMsg);
    check('пустой ответ: вопрос вернулся в поле, пузырь вопроса убран',
      (await page.inputValue('#input')) === 'вопрос без ответа' && (await page.locator('.msg.user').count()) === userBefore);
    const h1 = await histNow();
    check('пустой ответ: вопрос не остался в истории', !h1.some((m) => m.content === 'вопрос без ответа'), JSON.stringify(h1));

    // 401 тоже не оставляет вопрос в истории без ответа
    await setKey(KEY_401);
    await page.fill('#input', 'ещё раз 401'); await page.click('#send'); await done();
    const h2 = await histNow();
    check('ошибка HTTP: история не кончается на user', h2.length === 0 || h2[h2.length - 1].role !== 'user', JSON.stringify(h2));

    // обрезанный ответ помечен
    await setKey(KEY_MAXTOK);
    await page.fill('#input', 'длинный'); await page.click('#send'); await done();
    const mtNote = await page.locator('.msg.assistant .note').last().textContent();
    check('max_tokens: ответ сохранён и помечен stop_reason', mtNote === 'stop_reason: max_tokens' && (await lastBody().textContent()).includes('часть1'), mtNote);

    await setKey(KEY_NOSTOP);
    await page.fill('#input', 'обрыв'); await page.click('#send'); await done();
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
    await page.fill('#input', 'после очистки'); await page.click('#send');
    await page.waitForFunction(() => { const b = [...document.querySelectorAll('.msg.assistant .body')].pop(); return b && b.textContent.length > 0; });
    await page.click('#stop'); await done();
    const afterClear = JSON.parse(apiLog.filter((e) => e.method === 'POST').pop().body).messages;
    check('после «Очистить» запрос начинается с чистой истории', afterClear.length === 1 && afterClear[0].role === 'user' && afterClear[0].content === 'после очистки', JSON.stringify(afterClear));
    await ctx.close();

    // --- битая история в localStorage не ломает страницу ---
    {
      const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
      const p2 = await ctx2.newPage(); watch(p2);
      await p2.goto(`${ORIGIN}/apps/chat.html`);
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
    const unexpectedCsp = cspViolations.filter((l) => !l.includes('example.com'));
    check('нет CSP-нарушений кроме проверочного', unexpectedCsp.length === 0, unexpectedCsp.join(' | '));
  } catch (e) {
    failed++;
    console.log('FAIL исключение: ' + (e && e.stack));
  } finally {
    await browser.close();
    web.kill();
    api.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\nИтог: ${passed} прошло, ${failed} упало`);
    process.exit(failed ? 1 : 0);
  }
})();
