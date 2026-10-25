'use strict';
// P2: persisted pending recovery. Actual Worker + SQLite + browser, synthetic GitHub only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const { createIssueApi } = require('./hub-acceptance-issues-fixture.cjs');
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://hub.test';
const assetRef = process.env.HUB_RESUME_ASSET_REF;
if (assetRef && !/^[0-9a-f]{7,40}$/.test(assetRef)) throw new Error('Asset comparison ref must be a Git SHA');
(async () => {
  const { default: worker } = await import(pathToFileURL(path.join(ROOT, 'src/worker.js')));
  const store = await import(pathToFileURL(path.join(ROOT, 'src/outbox.js')));
  const { makeIssueIntent } = await import(pathToFileURL(path.join(ROOT, 'src/issues-delivery.js')));
  const sqlite = new DatabaseSync(':memory:');
  for (const file of fs.readdirSync(path.join(ROOT, 'migrations')).filter((file) => file.endsWith('.sql')).sort()) sqlite.exec(fs.readFileSync(path.join(ROOT, 'migrations', file), 'utf8'));
  const statement = (sql, args = []) => ({ bind(...values) { return statement(sql, values); },
    first() { return sqlite.prepare(sql).get(...args) || null; }, all() { return { results: sqlite.prepare(sql).all(...args) }; },
    run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } });
  const db = { prepare: statement }; const token = 'p'.repeat(43);
  sqlite.prepare('INSERT INTO users VALUES(?,?,?)').run('owner-id', 'owner', Date.now());
  sqlite.prepare('INSERT INTO entitlements(user_id,tier,created_at) VALUES(?,?,?)').run('owner-id', 'free', Date.now());
  sqlite.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('base64url'), 'owner-id', Date.now(), Date.now() + 3600000);
  const issues = createIssueApi(); const realFetch = globalThis.fetch; const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.github.com');
    const issueResponse = await issues.fetch(url, options); if (issueResponse) return issueResponse;
    assert.ok(String(url).includes('/contents/'));
    return new Response('', { headers: { 'content-type': 'text/plain' } });
  };
  const env = { HUB_DB: db, CANONICAL_ORIGIN: ORIGIN, RP_ID: 'hub.test', BOARD_OWNER_USERNAME: 'owner',
    BOARD_AUTHORS_JSON: JSON.stringify([{ hubUserId: 'owner-id', hubUsername: 'owner', githubLogin: 'synthetic-owner' }]),
    BOARD_GITHUB_TOKEN: 'synthetic-read-token', RATE_LIMIT_HMAC_KEY: 'synthetic-rate-key-at-least-32-characters',
    BOARD_PATHS: 'qa/BOARD.md', BOARD_IDEA_PATHS: '', HUB_ISSUES_ENABLED: 'false', HUB_ISSUES_GITHUB_TOKEN: 'synthetic-write-token-never-real',
    ASSETS: { async fetch(request) {
      const file = path.resolve(ROOT, 'public', '.' + new URL(request.url).pathname);
      assert.ok(file.startsWith(path.join(ROOT, 'public') + path.sep));
      if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
      const assetPath = new URL(request.url).pathname;
      const bytes = assetRef && /^\/apps\/board\.(?:html|css|js)$/.test(assetPath)
        ? execFileSync('git', ['show', `${assetRef}:public${assetPath}`], { cwd: ROOT, maxBuffer: 1024 * 1024 }) : fs.readFileSync(file);
      return new Response(bytes, { headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html' } });
    } } };
  const post = async (payload, background = true) => worker.fetch(new Request(ORIGIN + '/hub/api/outbox', { method: 'POST', headers: {
    cookie: `__Host-hub_session=${token}`, origin: ORIGIN, 'content-type': 'application/json', 'X-Hub-Request': '1', 'CF-Connecting-IP': '192.0.2.4',
  }, body: JSON.stringify(payload) }), env, background ? ctx : undefined);
  const payload = (text) => ({ idempotencyKey: randomUUID(), kind: 'message', text });
  const firstPayload = payload('Synthetic P2 saved with delivery disabled');
  let browser;
  try {
    if (assetRef) console.log(`BASELINE board assets from exact Git ref ${assetRef}; no shared checkout edits`);
    const saved = await post(firstPayload); assert.equal(saved.status, 201); const first = (await saved.json()).item;
    await drain(); assert.equal(first.status, 'pending'); assert.equal(issues.postCount(), 0);
    env.HUB_ISSUES_ENABLED = 'true';
    const executablePath = process.env.HUB_BROWSER || ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(fs.existsSync);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const context = await browser.newContext();
    await context.addCookies([{ name: '__Host-hub_session', value: token, domain: 'hub.test', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    const posted = []; const errors = [];
    await context.route(ORIGIN + '/**', async (route) => {
      const request = route.request(); const body = request.postDataBuffer(); const headers = await request.allHeaders(); headers['CF-Connecting-IP'] = '192.0.2.5';
      if (request.method() === 'POST') posted.push(JSON.parse(body.toString('utf8')));
      const response = await worker.fetch(new Request(request.url(), { method: request.method(), headers, ...(body ? { body } : {}) }), env, ctx);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    const page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(ORIGIN + '/hub/apps/board.html');
    const firstRow = page.locator(`[data-receipt-id="${first.id}"]`); await firstRow.waitFor();
    assert.equal(await firstRow.locator('.retry-delivery').count(), 1,
      'P2 pending saved with delivery disabled has no UI resume action after enabling delivery and reload');
    const resume = async (item, expectedPayload) => {
      const row = page.locator(`[data-receipt-id="${item.id}"]`); await row.waitFor();
      const response = page.waitForResponse((entry) => entry.url().endsWith('/hub/api/outbox') && entry.request().method() === 'POST');
      await row.locator('.retry-delivery').evaluate((button) => { button.click(); button.click(); });
      assert.equal((await response).status(), 200); await drain();
      await row.getByText('Доставка подтверждена', { exact: true }).waitFor({ timeout: 10000 });
      assert.deepEqual(posted.at(-1), expectedPayload);
      assert.equal(await row.locator('.retry-delivery').count(), 0);
    };
    await resume(first, firstPayload); assert.equal(issues.postCount(), 1); assert.equal(posted.length, 1);
    console.log('PASS P2 disabled-to-enabled persisted pending resumes from UI with original key and one Issue POST');
    const crashPayload = payload('Synthetic P2 crash after claim before remote POST');
    const crash = (await (await post(crashPayload, false)).json()).item;
    const claim = await store.claimDelivery(db, crash.id, Date.now() - 61000); assert.ok(claim); assert.equal(claim.mode, 'deliver');
    const beforeCrashPosts = issues.postCount();
    await page.reload(); await resume(crash, crashPayload);
    assert.equal(issues.postCount(), beforeCrashPosts + 1);
    console.log('PASS P2 expired claim without intent resumes safely and creates exactly one Issue');
    const acceptedPayload = payload('Synthetic P2 crash after accepted POST before receipt');
    const accepted = (await (await post(acceptedPayload, false)).json()).item;
    const crashedAt = Date.now() - 61000;
    const acceptedClaim = await store.claimDelivery(db, accepted.id, crashedAt);
    const intent = await makeIssueIntent(acceptedClaim.item, env);
    assert.equal((await store.beginDeliveryAttempt(db, accepted.id, acceptedClaim.attempt, intent, crashedAt + 1)).applied, true);
    await issues.fetch('https://api.github.com/repos/Maverlix777/agent-handoffs/issues', { method: 'POST', body: JSON.stringify({ title: intent.title, body: intent.body, labels: ['idea'] }) });
    const beforeReconciliation = issues.postCount();
    await page.reload(); await resume(accepted, acceptedPayload);
    assert.equal(issues.postCount(), beforeReconciliation);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM owner_outbox').get().n, 3);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM owner_outbox WHERE status='synced'").get().n, 3);
    assert.equal(posted.length, 3); assert.deepEqual(errors, []);
    console.log('PASS P2 expired durable intent reconciles accepted Issue through UI without another POST');
    console.log('RESULT P2 3 passed; synthetic GitHub only; no timer or policy change');
  } finally { if (browser) await browser.close(); await drain(); globalThis.fetch = realFetch; sqlite.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
