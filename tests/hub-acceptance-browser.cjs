// Genuine Chromium UI -> actual Worker -> native SQLite. GitHub is synthetic, not live delivery.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const { createIssueApi } = require('./hub-acceptance-issues-fixture.cjs');
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
  const { flushIssueDelivery } = await import(pathToFileURL(path.join(ROOT, 'src/issues-delivery.js')));
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
  const issues = createIssueApi();
  const background = [];
  const ctx = { waitUntil(promise) { background.push(promise); } };
  const drain = async () => { while (background.length) await Promise.all(background.splice(0)); };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).hostname, 'api.github.com', 'server fetch must stay on GitHub API');
    const issuesResponse = await issues.fetch(url, init);
    if (issuesResponse) return issuesResponse;
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
  const env = { HUB_DB: d1, CANONICAL_ORIGIN: ORIGIN, RP_ID: 'hub.test', BOARD_OWNER_USERNAME: 'owner,other,guest',
    BOARD_AUTHORS_JSON: JSON.stringify([{ hubUserId: 'owner', hubUsername: 'owner', githubLogin: 'synthetic-owner' },
      { hubUserId: 'other', hubUsername: 'other', githubLogin: 'synthetic-other' }]),
    HUB_ISSUES_TASK_ROUTES: JSON.stringify([{ sourcePath: BOARD_PATH, taskId: 'QA-1', issueNumber: 777 }]),
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
  }), env, ctx);
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
    assert.deepEqual(saved.author, { hubUserId: 'owner', hubUsername: 'owner', githubLogin: 'synthetic-owner' });
    const otherSavedResponse = await request('/hub/api/outbox', { who: 'other', method: 'POST', data: { ...payload, text: 'Synthetic second author idea' } });
    assert.equal(otherSavedResponse.status, 201);
    const otherSaved = (await otherSavedResponse.json()).item;
    assert.deepEqual(otherSaved.author, { hubUserId: 'other', hubUsername: 'other', githubLogin: 'synthetic-other' });
    assert.equal((await request('/hub/api/outbox', { method: 'POST', data: { ...payload, author: otherSaved.author } })).status, 400);
    const originalMappings = env.BOARD_AUTHORS_JSON;
    env.BOARD_AUTHORS_JSON = JSON.stringify([{ hubUserId: 'wrong-stable-id', hubUsername: 'owner', githubLogin: 'synthetic-owner' }]);
    assert.equal((await request('/hub/api/outbox')).status, 403);
    env.BOARD_AUTHORS_JSON = originalMappings;
    pass('two explicit stable-ID authors are attributed immutably; legacy third user and forged author denied');
    const executablePath = process.env.HUB_BROWSER || ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(fs.existsSync);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: '__Host-hub_session', value: tokens.owner, domain: 'hub.test', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    const browserErrors = []; const browserPosts = []; let boardRequests = 0; let dropSavedReply = false;
    let holdNextBoard = false; let releaseHeldBoard; let markBoardHeld;
    const boardHeld = new Promise((resolve) => { markBoardHeld = resolve; });
    const routeThroughWorker = async (route) => {
      const req = route.request(); const headers = await req.allHeaders(); headers['CF-Connecting-IP'] = '192.0.2.2';
      if (new URL(req.url()).pathname === '/hub/api/board') boardRequests++;
      const body = req.postDataBuffer();
      if (req.method() === 'POST' && new URL(req.url()).pathname === '/hub/api/outbox') browserPosts.push(JSON.parse(body.toString('utf8')));
      const response = await worker.fetch(new Request(req.url(), { method: req.method(), headers, ...(body ? { body } : {}) }), env, ctx);
      if (holdNextBoard && new URL(req.url()).pathname === '/hub/api/board') {
        holdNextBoard = false;
        await new Promise((resolve) => { releaseHeldBoard = resolve; markBoardHeld(); });
      }
      if (dropSavedReply && req.method() === 'POST' && new URL(req.url()).pathname === '/hub/api/outbox') {
        dropSavedReply = false; assert.equal(response.status, 201); return route.abort('connectionreset');
      }
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    };
    await context.route(`${ORIGIN}/**`, routeThroughWorker);
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
    const legacyReceipt = { url: `https://github.com/Maverlix777/agent-handoffs/blob/${commit}/qa/receipt.md`, commit, deliveredAt: Date.now() };
    assert.equal((await applyDeliveryResult(d1, { id: answer.id, expectedVersion: answer.version, status: 'synced', receipt: legacyReceipt, error: null })).applied, false);
    assert.equal((await applyDeliveryResult(d1, { id: saved.id, expectedVersion: saved.version, status: 'synced', receipt: legacyReceipt, error: null })).applied, true);
    await page.locator('#refresh').click();
    await page.locator('#refresh:not(:disabled)').waitFor();
    assert.equal(await page.locator(`[data-receipt-id="${saved.id}"] .delivery-stages dd`).nth(1).innerText(), 'Не подтверждено');
    assert.equal(await page.locator(`[data-receipt-id="${saved.id}"] a`).count(), 0);
    env.HUB_ISSUES_ENABLED = 'true'; env.HUB_ISSUES_GITHUB_TOKEN = 'synthetic-issues-token-never-production';
    const answerRetry = { idempotencyKey: answer.idempotencyKey, kind: answer.kind, text: answer.text, target: answer.target };
    const postsBeforeAnswer = issues.postCount();
    assert.equal((await request('/hub/api/outbox', { method: 'POST', data: answerRetry })).status, 200);
    await drain();
    const deliveredAnswer = (await (await request('/hub/api/outbox')).json()).items.find((item) => item.id === answer.id);
    assert.equal(deliveredAnswer.status, 'synced'); assert.equal(deliveredAnswer.receipt.kind, 'comment');
    assert.equal(deliveredAnswer.receipt.issueNumber, 777); assert.equal(issues.postCount(), postsBeforeAnswer + 1);
    assert.deepEqual(issues.issues.get(777).labels.map((entry) => entry.name), ['worker:codex', 'cloud:in-progress']);
    await page.locator('#refresh').click();
    await page.locator(`[data-receipt-id="${answer.id}"]`).getByText('Доставка подтверждена', { exact: true }).waitFor();
    assert.equal(await page.locator(`[data-receipt-id="${answer.id}"] a`).getAttribute('href'), deliveredAnswer.receipt.url);
    assert.deepEqual(await page.locator(`[data-receipt-id="${answer.id}"] .delivery-stages dd`).allInnerTexts(), ['Сохранено на сервере', 'Доставка подтверждена', 'Не подтверждён', 'Не подтверждён']);
    pass('actual Worker waitUntil delivers synthetic Issue comment; stale CAS and legacy blob cannot claim Issues delivery or ACK');
    let releaseFast; let markFastHeld;
    const fastHeld = new Promise((resolve) => { markFastHeld = resolve; });
    issues.beforeRequest = async ({ pathname }) => { if (pathname === '') { issues.beforeRequest = null; await new Promise((resolve) => { releaseFast = resolve; markFastHeld(); }); } };
    const fastText = 'Synthetic idea — save only, no execution'; const fastStarted = performance.now(); const postsBeforeFast = issues.postCount();
    await page.locator('#message-text').fill(fastText);
    await page.locator('#message-form button[type=submit]').click();
    await page.locator('#message-form .success').waitFor(); await fastHeld;
    const fastItem = (await (await request('/hub/api/outbox')).json()).items.find((item) => item.text === fastText);
    assert.equal(fastItem.status, 'pending');
    assert.equal(await page.locator(`[data-receipt-id="${fastItem.id}"] .delivery-stages dd`).nth(0).innerText(), 'Сохранено на сервере');
    releaseFast(); await drain(); await page.clock.fastForward(1100);
    await page.locator(`[data-receipt-id="${fastItem.id}"]`).getByText('Доставка подтверждена', { exact: true }).waitFor();
    const localLatency = Math.round(performance.now() - fastStarted);
    assert.equal(issues.postCount(), postsBeforeFast + 1);
    const fastResult = (await (await request('/hub/api/outbox')).json()).items.find((item) => item.id === fastItem.id);
    assert.deepEqual(issues.issues.get(fastResult.receipt.issueNumber).labels, [{ name: 'idea' }]);
    assert.match(await page.locator(`[data-receipt-id="${fastItem.id}"] .author`).innerText(), /owner.*synthetic-owner/);
    assert.equal(fastResult.agentAck, null); assert.equal(fastResult.agentResult, null);
    console.log(`DIAGNOSTIC mixed-clock receipt scenario ${localLatency}ms wall execution plus 1100ms simulated browser clock; NOT user-perceived or live latency`);
    pass('saved state appears before background flush; bounded GET polling displays idea-only delivery without execution or ACK');
    const naturalContext = await browser.newContext({ viewport: { width: 900, height: 900 } });
    await naturalContext.addCookies([{ name: '__Host-hub_session', value: tokens.other, domain: 'hub.test', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    await naturalContext.route(`${ORIGIN}/**`, routeThroughWorker);
    const naturalPage = await naturalContext.newPage(); naturalPage.on('pageerror', (error) => browserErrors.push(error.message));
    await naturalPage.goto(`${ORIGIN}/hub/apps/board.html`);
    await naturalPage.locator('#outbox-list .outbox-entry').first().waitFor();
    const naturalText = 'Synthetic natural-clock delivery measurement';
    await naturalPage.locator('#message-text').fill(naturalText);
    const naturalStart = performance.now(); const naturalPosts = issues.postCount();
    await naturalPage.locator('#message-form button[type=submit]').click();
    await naturalPage.locator('#message-form .success').waitFor();
    const naturalRow = naturalPage.locator('#outbox-list .outbox-entry').filter({ hasText: naturalText });
    await naturalRow.getByText('Доставка подтверждена', { exact: true }).waitFor({ timeout: 10000 });
    const naturalLatencyMs = Math.round(performance.now() - naturalStart);
    assert.equal(issues.postCount(), naturalPosts + 1);
    assert.match(await naturalRow.locator('.author').innerText(), /other.*synthetic-other/);
    assert.deepEqual(await naturalRow.locator('.delivery-stages dd').allInnerTexts(), ['Сохранено на сервере', 'Доставка подтверждена', 'Не подтверждён', 'Не подтверждён']);
    await naturalRow.screenshot({ path: path.join(SHOTS, 'issues-receipt.png') });
    console.log(`MEASURE natural-clock local synthetic click-to-visible-Issues-receipt ${naturalLatencyMs}ms; no browser clock installed/advanced; NOT live GitHub latency`);
    await naturalContext.close();
    pass('natural browser timer shows receipt within 10s with one POST and unknown ACK/result');
    await flushIssueDelivery(d1, env, otherSaved.id);
    const deliveredOther = (await (await request('/hub/api/outbox', { who: 'other' })).json()).items.find((item) => item.id === otherSaved.id);
    assert.equal(deliveredOther.status, 'synced'); assert.equal(deliveredOther.author.githubLogin, 'synthetic-other');
    assert.match(issues.issues.get(deliveredOther.receipt.issueNumber).body, /Hub author: other\nGitHub attribution: synthetic-other/);
    assert.ok(!(await (await request('/hub/api/outbox')).json()).items.some((item) => item.id === otherSaved.id));
    pass('second mapped author delivers under stored attribution and cannot read the first author queue');
    const getItem = async (id) => (await (await request('/hub/api/outbox')).json()).items.find((item) => item.id === id);
    const failPayload = { idempotencyKey: randomUUID(), kind: 'message', text: 'Synthetic offline-before-write message' };
    issues.metadataUnavailable = true; const beforeUnavailable = issues.postCount();
    const unavailableResponse = await request('/hub/api/outbox', { method: 'POST', data: failPayload });
    assert.equal(unavailableResponse.status, 201); const unavailableItem = (await unavailableResponse.json()).item;
    await drain(); assert.equal((await getItem(unavailableItem.id)).status, 'error'); assert.equal(issues.postCount(), beforeUnavailable);
    await page.locator('#refresh').click();
    await page.locator(`[data-receipt-id="${unavailableItem.id}"] .retry-delivery`).waitFor();
    issues.metadataUnavailable = false;
    const retryResponse = page.waitForResponse((response) => response.url().endsWith('/hub/api/outbox') && response.request().method() === 'POST');
    await page.locator(`[data-receipt-id="${unavailableItem.id}"] .retry-delivery`).click();
    assert.equal((await retryResponse).status(), 200);
    await drain(); await page.clock.fastForward(1100);
    await page.locator(`[data-receipt-id="${unavailableItem.id}"]`).getByText('Доставка подтверждена', { exact: true }).waitFor();
    assert.deepEqual(browserPosts.at(-1), failPayload);
    assert.equal((await getItem(unavailableItem.id)).status, 'synced'); assert.equal(issues.postCount(), beforeUnavailable + 1);
    assert.equal(await page.locator(`[data-receipt-id="${unavailableItem.id}"] .retry-delivery`).count(), 0);
    pass('failure before GitHub write stays durable; visible Retry preserves original key and delivers once');
    issues.failNextPost = 'accepted'; const acceptedTimeoutPosts = issues.postCount();
    const uncertainPayload = { idempotencyKey: randomUUID(), kind: 'message', text: 'Synthetic GitHub accepted but response lost' };
    const uncertainResponse = await request('/hub/api/outbox', { method: 'POST', data: uncertainPayload });
    assert.equal(uncertainResponse.status, 201); const uncertainItem = (await uncertainResponse.json()).item;
    await drain(); assert.equal((await getItem(uncertainItem.id)).error, 'delivery_uncertain');
    assert.equal((await flushIssueDelivery(d1, env, uncertainItem.id)).status, 'not_claimed');
    const later = Date.now() + 61000;
    const reconciled = await Promise.all(Array.from({ length: 4 }, () => flushIssueDelivery(d1, env, uncertainItem.id, { now: () => later })));
    assert.equal(reconciled.filter((result) => result.status === 'synced').length, 1);
    assert.equal((await getItem(uncertainItem.id)).status, 'synced'); assert.equal(issues.postCount(), acceptedTimeoutPosts + 1);
    pass('expired durable intent reconciles accepted timeout under four concurrent leases without second GitHub POST');
    issues.failNextPost = 'not_sent'; const absentPosts = issues.postCount();
    const absentResponse = await request('/hub/api/outbox', { method: 'POST', data: { idempotencyKey: randomUUID(), kind: 'message', text: 'Synthetic ambiguous absent issue' } });
    assert.equal(absentResponse.status, 201); const absentItem = (await absentResponse.json()).item;
    await drain();
    await flushIssueDelivery(d1, env, absentItem.id, { now: () => Date.now() + 61000 });
    await flushIssueDelivery(d1, env, absentItem.id, { now: () => Date.now() + 122000 });
    assert.equal((await getItem(absentItem.id)).error, 'delivery_uncertain'); assert.equal(issues.postCount(), absentPosts + 1);
    assert.ok(![...issues.issues.values()].some((issue) => issue.body.includes(absentItem.id)));
    pass('negative reconciliation is not proof of failed create: absent ambiguous issue stays durable with no repeat POST');
    issues.failNextPost = 'accepted'; const conflictPosts = issues.postCount();
    const changedResponse = await request('/hub/api/outbox', { method: 'POST', data: { idempotencyKey: randomUUID(), kind: 'message', text: 'Synthetic remote edit conflict' } });
    assert.equal(changedResponse.status, 201); const changedItem = (await changedResponse.json()).item;
    await drain();
    const changedRemote = [...issues.issues.values()].find((issue) => issue.body.includes(changedItem.id));
    changedRemote.body += '\nSynthetic independent remote edit.\n';
    const retainedBody = changedRemote.body;
    const conflictResult = await flushIssueDelivery(d1, env, changedItem.id, { now: () => Date.now() + 61000 });
    assert.equal(conflictResult.status, 'conflict');
    assert.equal((await getItem(changedItem.id)).status, 'conflict');
    assert.equal((await getItem(changedItem.id)).error, 'delivery_conflict');
    assert.equal((await flushIssueDelivery(d1, env, changedItem.id, { now: () => Date.now() + 122000 })).status, 'not_claimed');
    assert.equal(changedRemote.body, retainedBody); assert.equal(issues.postCount(), conflictPosts + 1);
    pass('definite remote conflict is persisted as conflict and never overwrites another edit or repeats POST');
    assert.ok(issues.requests.every((entry) => entry.method === 'GET' || entry.method === 'POST'));
    assert.ok(!JSON.stringify(await (await request('/hub/api/outbox')).json()).includes(env.HUB_ISSUES_GITHUB_TOKEN));
    ideaFailure = true; telemetryStale = true;
    const beforePeriodic = boardRequests;
    await page.clock.fastForward(61000);
    await page.waitForFunction(() => document.querySelector('#sources').textContent.includes('ошибка загрузки'));
    assert.ok(boardRequests > beforePeriodic);
    assert.match(await page.locator('#telemetry').innerText(), /устарели/);
    assert.match(await page.locator('#ideas').innerText(), /не прочитаны полностью/);
    assert.equal(await page.locator(`[data-receipt-id="${changedItem.id}"] .retry-delivery`).count(), 0);
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


