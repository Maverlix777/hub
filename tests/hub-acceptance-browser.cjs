// Genuine Chromium UI -> actual Worker -> native SQLite. GitHub is synthetic, not live delivery.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'artifacts', 'hub');
const ORIGIN = 'https://hub.test';
const BOARD_PATH = 'qa/BOARD.md';
const IDEA_PATH = 'qa/IDEAS.md';
const BOARD = `# Synthetic acceptance board
| ID | Task | Owner | State | Evidence | Blockers |
|---|---|---|---|---|---|
| QA-1 | Synthetic owner question | QA owner | Needs-owner | [Evidence](https://example.com/evidence) | Waiting for decision |
| QA-2 | Synthetic review task | QA reviewer | Review | | |
| QA-3 | Synthetic planned task | QA planner | Ready | | |
| QA-4 | Synthetic active task | QA builder | Claimed | | |
| QA-5 | Synthetic completed task | QA builder | Done | | |
`;
const IDEAS = '# Synthetic ideas\n| # | Идея | Описание |\n|---|---|---|\n| 1 | Synthetic saved idea | A preserved historical format |\n';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let passed = 0;
const pass = (name) => { passed++; console.log(`PASS ${name}`); };

(async () => {
  const { default: worker } = await import(pathToFileURL(path.join(ROOT, 'src/worker.js')));
  const { applyDeliveryResult } = await import(pathToFileURL(path.join(ROOT, 'src/outbox.js')));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of fs.readdirSync(path.join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(ROOT, 'migrations', file), 'utf8'));
  function statement(sql, values = []) {
    return { bind(...args) { return statement(sql, args); },
      first() { return db.prepare(sql).get(...values) || null; },
      all() { return { results: db.prepare(sql).all(...values) }; },
      run() { return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; } };
  }
  const d1 = { prepare: statement };
  const tokens = { owner: 'o'.repeat(43), guest: 'g'.repeat(43), other: 'x'.repeat(43) };
  for (const [name, token] of Object.entries(tokens)) {
    db.prepare('INSERT INTO users VALUES(?,?,?)').run(name, name, Date.now());
    db.prepare('INSERT INTO entitlements(user_id,tier,created_at) VALUES(?,?,?)').run(name, 'paid', Date.now());
    db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('base64url'), name, Date.now(), Date.now() + 3600000);
  }
  let ideaFailure = false; let telemetryStale = false; let githubReads = 0; let boardSuffix = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).hostname, 'api.github.com', 'server fetch must stay on GitHub API');
    githubReads++;
    if (String(url).endsWith('/qa/telemetry.json')) {
      const at = new Date(Date.now() - (telemetryStale ? 3600000 : 1000)).toISOString();
      return Response.json({ telemetry: { schema_version: 1, producer: 'local-manager-telemetry', as_of: at,
        events: [{ id: 'qa-event', stage: 'ack', facts: { task_id: 'QA-4', turn_id: 'qa-agent', at_utc: at } }], gemma: { results: [] }, gpu: { samples: [] } } });
    }
    if (String(url).endsWith(`/${IDEA_PATH}`) && ideaFailure) return new Response('unavailable', { status: 503 });
    const content = String(url).endsWith(`/${IDEA_PATH}`) ? IDEAS : BOARD + boardSuffix;
    const sha = createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
    return Response.json({ type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64'), sha });
  };
  const env = { HUB_DB: d1, CANONICAL_ORIGIN: ORIGIN, RP_ID: 'hub.test', BOARD_OWNER_USERNAME: 'owner,other',
    BOARD_GITHUB_TOKEN: 'synthetic-token-never-production', RATE_LIMIT_HMAC_KEY: 'synthetic-rate-limit-key-32-characters',
    BOARD_PATHS: BOARD_PATH, BOARD_IDEA_PATHS: IDEA_PATH, BOARD_TELEMETRY_PATH: 'qa/telemetry.json',
    ASSETS: { async fetch(request) {
      const asset = path.resolve(ROOT, 'public', '.' + new URL(request.url).pathname);
      if (!asset.startsWith(path.join(ROOT, 'public') + path.sep) || !fs.existsSync(asset)) return new Response('Not found', { status: 404 });
      return new Response(fs.readFileSync(asset), { headers: { 'content-type': MIME[path.extname(asset)] || 'application/octet-stream' } });
    } } };
  const request = async (pathname, { who = 'owner', method = 'GET', data, headers = {} } = {}) => worker.fetch(new Request(ORIGIN + pathname, {
    method, headers: { ...(who ? { cookie: `__Host-hub_session=${tokens[who]}` } : {}), 'CF-Connecting-IP': '192.0.2.1',
      ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json', 'X-Hub-Request': '1' } : {}), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), env);
  let browser;
  try {
    for (const pathname of ['/hub/api/board', '/hub/api/outbox']) {
      assert.equal((await request(pathname, { who: null })).status, 401);
      assert.equal((await request(pathname, { who: 'guest' })).status, 403);
    }
    assert.equal((await request('/hub/apps/board.js', { who: 'guest' })).status, 403);
    assert.equal((await request('/hub/apps/board.html', { who: null })).status, 302);
    assert.equal(githubReads, 0);
    pass('owner privacy before any source read');
    const payload = { idempotencyKey: randomUUID(), kind: 'message', text: 'Synthetic API message', target: null };
    assert.equal((await request('/hub/api/outbox', { method: 'POST', data: payload, headers: { origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request('/hub/api/outbox', { method: 'POST', data: payload, headers: { 'X-Hub-Request': '' } })).status, 403);
    assert.equal((await request('/hub/api/outbox', { method: 'POST', data: { ...payload, text: 'x'.repeat(8001) } })).status, 400);
    pass('CSRF and payload validation');
    const accepted = await request('/hub/api/outbox', { method: 'POST', data: payload });
    assert.equal(accepted.status, 201); const saved = (await accepted.json()).item;
    const repeated = await request('/hub/api/outbox', { method: 'POST', data: payload });
    assert.equal(repeated.status, 200); assert.equal((await repeated.json()).item.id, saved.id);
    assert.equal((await request('/hub/api/outbox', { method: 'POST', data: { ...payload, text: 'different' } })).status, 409);
    assert.equal((await (await request('/hub/api/outbox', { who: 'other' })).json()).items.length, 0);
    pass('durable idempotency, conflict and owner isolation');
    const executablePath = process.env.HUB_BROWSER || ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(fs.existsSync);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: '__Host-hub_session', value: tokens.owner, domain: 'hub.test', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    const browserErrors = []; let boardRequests = 0; let dropSavedReply = false;
    let holdNextBoard = false; let releaseHeldBoard; let markBoardHeld;
    const boardHeld = new Promise((resolve) => { markBoardHeld = resolve; });
    await context.route(`${ORIGIN}/**`, async (route) => {
      const req = route.request(); const headers = await req.allHeaders(); headers['CF-Connecting-IP'] = '192.0.2.2';
      if (new URL(req.url()).pathname === '/hub/api/board') boardRequests++;
      const body = req.postDataBuffer();
      const response = await worker.fetch(new Request(req.url(), { method: req.method(), headers, ...(body ? { body } : {}) }), env);
      if (holdNextBoard && new URL(req.url()).pathname === '/hub/api/board') {
        holdNextBoard = false;
        await new Promise((resolve) => { releaseHeldBoard = resolve; markBoardHeld(); });
      }
      if (dropSavedReply && req.method() === 'POST' && new URL(req.url()).pathname === '/hub/api/outbox') {
        dropSavedReply = false; assert.equal(response.status, 201); return route.abort('connectionreset');
      }
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    const page = await context.newPage(); page.on('pageerror', (error) => browserErrors.push(error.message));
    await page.clock.install({ time: Date.now() });
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.goto(`${ORIGIN}/hub/apps/board.html`);
    // UI interactions below intentionally use public selectors/accessible labels rather than internals.
    await page.locator('#questions').getByText('Synthetic owner question', { exact: true }).waitFor();
    assert.equal(await page.getByText('Synthetic review task', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Synthetic saved idea', { exact: true }).count(), 1);
    pass('actual Worker ingestion renders board, review and historical ideas');
    await page.screenshot({ path: path.join(SHOTS, 'desktop.png'), fullPage: true });
    await page.locator('#questions').getByText('Synthetic owner question', { exact: true }).click();
    await page.locator('#task-dialog[open]').waitFor();
    assert.ok(await page.locator('#task-dialog').evaluate((node) => node.contains(document.activeElement)));
    await page.keyboard.press('Shift+Tab');
    assert.ok(await page.locator('#task-dialog').evaluate((node) => node.contains(document.activeElement)));
    await page.screenshot({ path: path.join(SHOTS, 'task-modal.png'), fullPage: false });
    await page.keyboard.press('Escape');
    await page.locator('#task-dialog:not([open])').waitFor({ state: 'attached' });
    await page.locator('#questions').getByText('Synthetic owner question', { exact: true }).click();
    await page.goBack(); await page.locator('#task-dialog:not([open])').waitFor({ state: 'attached' });
    pass('modal focus, Escape and browser back');
    await page.locator('#questions').getByText('Synthetic owner question', { exact: true }).click();
    await page.locator('#answer-text').fill('Synthetic owner answer — approved fixture only');
    await page.locator('#answer-form button[type=submit]').click();
    await page.locator('#answer-form .success').waitFor();
    await page.keyboard.press('Escape'); await page.locator('#task-dialog:not([open])').waitFor({ state: 'attached' });
    await page.reload();
    await page.locator('#outbox-list').getByText('Synthetic owner answer — approved fixture only', { exact: true }).waitFor();
    const answer = (await (await request('/hub/api/outbox')).json()).items.find((item) => item.kind === 'answer');
    assert.equal(answer.target.taskId, 'QA-1'); assert.equal(answer.target.sourcePath, BOARD_PATH); assert.equal(answer.status, 'pending');
    pass('owner answer persisted in actual SQLite and shown after browser reload');
    const message = 'Synthetic chat <img src=x onerror=alert(1)> remains inert text';
    await page.locator('#message-text').fill(message);
    await page.locator('#message-form button[type=submit]').click();
    await page.locator('#message-form .success').waitFor();
    await page.reload(); await page.locator('#outbox-list').getByText(message, { exact: true }).waitFor();
    assert.equal(await page.locator('#outbox-list img').count(), 0);
    assert.equal(await page.locator('#outbox-list script').count(), 0);
    pass('mini-chat persistence/reload and owner text XSS safety');
    dropSavedReply = true;
    await page.locator('#message-text').fill('Synthetic uncertain delivery retry');
    await page.locator('#message-form button[type=submit]').click();
    await page.locator('#message-form .error').waitFor();
    assert.equal(await page.locator('#message-text').getAttribute('readonly'), '');
    await page.locator('#message-form button[type=submit]').click();
    await page.locator('#message-form .success').waitFor();
    const afterRetry = (await (await request('/hub/api/outbox')).json()).items;
    assert.equal(afterRetry.filter((item) => item.text === 'Synthetic uncertain delivery retry').length, 1);
    pass('lost POST response retries same immutable id without duplicate SQL record');
    const wrongRevision = { idempotencyKey: randomUUID(), kind: 'answer', text: 'Synthetic conflicting context', target: { ...answer.target, revision: '0'.repeat(40) } };
    assert.equal((await request('/hub/api/outbox', { method: 'POST', data: wrongRevision })).status, 409);
    assert.equal((await (await request('/hub/api/outbox')).json()).items.length, afterRetry.length);
    pass('source version conflict does not overwrite or enqueue stale answer');
    await page.locator('#questions').getByText('Synthetic owner question', { exact: true }).click();
    await page.locator('#answer-text').fill('Synthetic answer after reviewing newer context');
    boardSuffix = '\n<!-- Synthetic source revision change -->\n';
    await page.locator('#answer-form button[type=submit]').click();
    await page.locator('#answer-form .error').waitFor();
    assert.match(await page.locator('#answer-form .error').innerText(), /Источник изменился/);
    await page.keyboard.press('Escape'); await page.locator('#task-dialog:not([open])').waitFor({ state: 'attached' });
    await page.locator('#refresh').click(); await page.locator('#refresh:not(:disabled)').waitFor();
    await page.locator('#questions').getByText('Synthetic owner question', { exact: true }).click();
    assert.equal(await page.locator('#answer-text').inputValue(), 'Synthetic answer after reviewing newer context');
    assert.equal(await page.locator('#answer-form button[type=submit]').isDisabled(), false);
    await page.locator('#answer-form button[type=submit]').click();
    await page.locator('#answer-form .success').waitFor();
    assert.equal(await page.locator('#answer-form button[type=submit]').isDisabled(), false);
    await page.keyboard.press('Escape'); await page.locator('#task-dialog:not([open])').waitFor({ state: 'attached' });
    pass('UI keeps conflicting draft and accepts it only after fresh context reopening');
    assert.equal((await applyDeliveryResult(d1, { id: answer.id, expectedVersion: answer.version, status: 'error', receipt: null, error: 'delivery_unavailable' })).applied, true);
    await page.locator('#refresh').click();
    await page.locator(`[data-receipt-id="${answer.id}"]`).getByText('Ошибка доставки', { exact: true }).waitFor();
    const commit = '1'.repeat(40);
    const receipt = { url: `https://github.com/Maverlix777/agent-handoffs/blob/${commit}/qa/receipt.md`, commit, deliveredAt: Date.now() };
    assert.equal((await applyDeliveryResult(d1, { id: answer.id, expectedVersion: answer.version, status: 'synced', receipt, error: null })).applied, false);
    assert.equal((await applyDeliveryResult(d1, { id: answer.id, expectedVersion: answer.version + 1, status: 'synced', receipt, error: null })).applied, true);
    await page.locator('#refresh').click();
    await page.locator(`[data-receipt-id="${answer.id}"]`).getByText('Доставлено в GitHub', { exact: true }).waitFor();
    assert.equal(await page.locator(`[data-receipt-id="${answer.id}"] a`).getAttribute('href'), receipt.url);
    pass('simulated trusted receipt import uses CAS and renders persisted error/synced evidence (NOT live GitHub)');
    ideaFailure = true; telemetryStale = true;
    const beforePeriodic = boardRequests;
    await page.clock.fastForward(61000);
    await page.waitForFunction(() => document.querySelector('#sources').textContent.includes('ошибка загрузки'));
    assert.ok(boardRequests > beforePeriodic);
    assert.match(await page.locator('#telemetry').innerText(), /устарели/);
    assert.match(await page.locator('#ideas').innerText(), /не прочитаны полностью/);
    pass('visible-tab periodic update and honest source-error/stale-telemetry states');
    ideaFailure = false; telemetryStale = false;
    await page.locator('#refresh').click();
    await page.getByText('Synthetic saved idea', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.screenshot({ path: path.join(SHOTS, 'mobile.png'), fullPage: true });
    await page.locator('#questions').getByText('Synthetic owner question', { exact: true }).click();
    assert.ok(await page.locator('#task-dialog').evaluate((node) => node.getBoundingClientRect().width <= window.innerWidth));
    assert.ok(await page.locator('#detail-title').evaluate((node) => node.getBoundingClientRect().top >= 0));
    await page.screenshot({ path: path.join(SHOTS, 'mobile-modal.png'), fullPage: false });
    await page.keyboard.press('Escape'); await page.locator('#task-dialog:not([open])').waitFor({ state: 'attached' });
    pass('390px mobile layout and modal fit without horizontal overflow');
    holdNextBoard = true;
    await page.locator('#refresh').click();
    await boardHeld;
    await context.clearCookies();
    await context.addCookies([{ name: '__Host-hub_session', value: tokens.guest, domain: 'hub.test', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    await page.locator('#message-text').fill('Synthetic must never save under guest session');
    await page.locator('#message-form button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#outbox-list').textContent.includes('Synthetic'));
    releaseHeldBoard();
    await page.locator('#columns[aria-busy="false"]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#refresh').isDisabled(), true);
    assert.equal(await page.locator('#message-text').inputValue(), '');
    assert.equal(await page.locator('#columns').getByText('Synthetic planned task', { exact: true }).count(), 0);
    assert.doesNotMatch(await page.locator('#telemetry').innerText(), /QA-4|qa-agent/);
    pass('authorization loss clears board/outbox/telemetry and rejects delayed private response');
    assert.deepEqual(browserErrors, []);
    console.log(`RESULT ${passed} passed; synthetic GitHub only; browser board requests ${boardRequests}`);
  } finally {
    if (browser) await browser.close();
    globalThis.fetch = originalFetch;
    db.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });


