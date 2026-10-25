import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../src/worker.js';
import { validatePayload, enqueue, existingSubmission, listSubmissions, applyDeliveryResult,
  claimDelivery, beginDeliveryAttempt, markDeliveryUncertain, finishDelivery } from '../src/outbox.js';

const origin = 'https://hub.kolobovdjp.org';
const message = (overrides = {}) => ({ idempotencyKey: crypto.randomUUID(), kind: 'message', text: 'Synthetic safe message', ...overrides });
function fixture(migrate = true) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8'));
  if (migrate) {
    sqlite.exec(readFileSync(new URL('../migrations/0002_owner_outbox.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('../migrations/0003_owner_issues.sql', import.meta.url), 'utf8'));
  }
  const statement = (sql, values = []) => ({
    bind(...args) { return statement(sql, args); },
    first() { return sqlite.prepare(sql).get(...values) || null; },
    all() { return { results: sqlite.prepare(sql).all(...values) }; },
    run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
  });
  const env = { HUB_DB: { prepare: statement }, ASSETS: { fetch: async () => new Response('asset') },
    CANONICAL_ORIGIN: origin, RP_ID: 'kolobovdjp.org', BOARD_OWNER_USERNAME: 'owner,other', RATE_LIMIT_HMAC_KEY: 'synthetic-key-'.repeat(4) };
  async function session(name) {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
    sqlite.prepare('INSERT INTO users(id,username,created_at) VALUES(?,?,1)').run(name, name);
    sqlite.prepare('INSERT INTO entitlements(user_id,tier,created_at) VALUES(?,?,1)').run(name, 'paid');
    sqlite.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,1,?)').run(hash, name, Date.now() + 3600000);
    return `__Host-hub_session=${token}`;
  }
  const request = (method, body, cookie, headers = {}, path = '/hub/api/outbox', override = {}) => worker.fetch(new Request(origin + path, {
    method, headers: { ...(cookie ? { cookie } : {}), origin, 'content-type': 'application/json', 'X-Hub-Request': '1', 'CF-Connecting-IP': '192.0.2.1', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), { ...env, ...override });
  return { sqlite, env, session, request };
}

test('payload rejects unknown keys, invalid identity, controls, paths and overlong text', () => {
  for (const p of [message({ idempotencyKey: 'x' }), message({ text: ' ' }), message({ text: '\0' }), message({ text: 'a'.repeat(8001) }), message({ execute: 'command' }), message({ kind: 'answer' }), message({ target: { sourcePath: '../BOARD.md', taskId: 'X-1', revision: 'a'.repeat(40) } })]) assert.equal(validatePayload(p), null);
  assert.ok(validatePayload(message({ text: '<img src=x onerror=alert(1)>\nplain text' })));
  assert.ok(validatePayload(message({ kind: 'answer', target: { sourcePath: 'proposals/project/BOARD.md', taskId: 'X-1', revision: 'a'.repeat(40) } })));
});

test('persistence grammar matches delivery routes: messages cannot carry targets', () => {
  const target = { sourcePath: 'proposals/project/BOARD.md', taskId: 'X-1', revision: 'a'.repeat(40) };
  assert.equal(validatePayload(message({ target })), null);
  assert.ok(validatePayload(message({ target: null })));
  assert.ok(validatePayload(message()));
  for (const invalid of [{ ...target, revision: 'a'.repeat(64) }, { ...target, taskId: 'lower-1' },
    { ...target, sourcePath: '_private/BOARD.md' }, { ...target, sourcePath: 'path//BOARD.md' }]) {
    assert.equal(validatePayload(message({ kind: 'answer', target: invalid })), null);
  }
});

test('API protects anonymous, non-owner, CSRF, methods, content type and invalid JSON', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const owner = await f.session('owner'), guest = await f.session('guest');
  assert.equal((await f.request('GET')).status, 401);
  assert.equal((await f.request('POST', message())).status, 401);
  assert.equal((await f.request('GET', undefined, guest)).status, 403);
  assert.equal((await f.request('POST', message(), guest)).status, 403);
  assert.equal((await f.request('POST', message(), owner, { origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await f.request('POST', message(), owner, { 'X-Hub-Request': '' })).status, 403);
  assert.equal((await f.request('POST', message(), owner, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.request('POST', message(), owner, { 'content-type': 'text/plain' })).status, 400);
  assert.equal((await f.request('POST', '{bad', owner)).status, 400);
  assert.equal((await f.request('DELETE', undefined, owner)).status, 405);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM owner_outbox').get().n, 0);
});

test('API persists pending plaintext, reload returns same receipt and no secrets', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close()); const owner = await f.session('owner');
  const payload = message({ text: '<script>not executed</script>' });
  const response = await f.request('POST', payload, owner);
  assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
  const { item } = await response.json();
  assert.equal(item.status, 'pending'); assert.equal(item.text, payload.text); assert.equal(item.receipt, null);
  const loaded = await (await f.request('GET', undefined, owner)).json();
  assert.deepEqual(loaded.items, [item]); assert.equal(loaded.delivery.status, 'not_configured');
  assert.ok(!JSON.stringify(loaded).includes('synthetic-key')); assert.ok(!('owner_id' in item));
});

test('duplicates return one existing row; changed payload never overwrites', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close()); const owner = await f.session('owner'); const payload = message();
  const first = await (await f.request('POST', payload, owner)).json();
  const duplicate = await f.request('POST', payload, owner);
  assert.equal(duplicate.status, 200); assert.deepEqual((await duplicate.json()).item, first.item);
  const conflict = await f.request('POST', { ...payload, text: 'changed' }, owner);
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error, 'idempotency_conflict');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM owner_outbox').get().n, 1);
});

test('simultaneous duplicate insert is atomic and isolated between owners', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close()); await f.session('owner'); await f.session('other');
  const payload = validatePayload(message());
  const results = await Promise.all(Array.from({ length: 8 }, () => enqueue(f.env.HUB_DB, 'owner', payload, 100)));
  assert.equal(new Set(results.map((r) => r.item.id)).size, 1);
  const other = await enqueue(f.env.HUB_DB, 'other', payload, 101);
  assert.notEqual(other.item.id, results[0].item.id);
  assert.equal((await listSubmissions(f.env.HUB_DB, 'owner')).items.length, 1);
  assert.equal((await listSubmissions(f.env.HUB_DB, 'other')).items[0].id, other.item.id);
});

test('storage failure and missing rate-limit config fail closed, not as empty queue', async (t) => {
  const f = fixture(false); t.after(() => f.sqlite.close()); const owner = await f.session('owner');
  assert.equal((await f.request('GET', undefined, owner)).status, 503);
  assert.equal((await f.request('POST', message(), owner)).status, 503);
  assert.equal((await f.request('POST', message(), owner, {}, undefined, { RATE_LIMIT_HMAC_KEY: '' })).status, 503);
});

test('rate-limit bounds writes and retries', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close()); const owner = await f.session('owner');
  for (let i = 0; i < 20; i++) assert.equal((await f.request('POST', message(), owner)).status, 201);
  const limited = await f.request('POST', message(), owner);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM owner_outbox').get().n, 20);
});

test('delivery receipt CAS persists, refuses stale writes, and cannot downgrade synced', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close()); await f.session('owner');
  const payload = validatePayload(message()); const { item } = await enqueue(f.env.HUB_DB, 'owner', payload, 100);
  const failure = { id: item.id, expectedVersion: 1, status: 'error', receipt: null, error: 'delivery_uncertain' };
  assert.deepEqual(await applyDeliveryResult(f.env.HUB_DB, failure, 101), { applied: true });
  assert.deepEqual(await applyDeliveryResult(f.env.HUB_DB, failure, 102), { applied: false });
  const commit = 'a'.repeat(40), receipt = { url: `https://github.com/Maverlix777/agent-handoffs/blob/${commit}/reports/test.md`, commit, deliveredAt: 103 };
  assert.deepEqual(await applyDeliveryResult(f.env.HUB_DB, { id: item.id, expectedVersion: 2, status: 'synced', receipt, error: null }, 103), { applied: true });
  assert.deepEqual(await applyDeliveryResult(f.env.HUB_DB, { ...failure, expectedVersion: 3 }, 104), { applied: false });
  const reloaded = await existingSubmission(f.env.HUB_DB, 'owner', payload);
  assert.equal(reloaded.item.status, 'synced'); assert.equal(reloaded.item.version, 3); assert.deepEqual(reloaded.item.receipt, receipt);
});

test('delivery rejects arbitrary URLs, invalid evidence and unapproved error prose', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const result = { id: crypto.randomUUID(), expectedVersion: 1, status: 'synced', receipt: { url: 'javascript:alert(1)', commit: 'a'.repeat(40), deliveredAt: 1 }, error: null };
  await assert.rejects(applyDeliveryResult(f.env.HUB_DB, result), /invalid_delivery_result/);
  await assert.rejects(applyDeliveryResult(f.env.HUB_DB, { ...result, status: 'error', receipt: null, error: 'secret or prose' }), /invalid_delivery_result/);
});

test('pagination is deterministic, owner scoped, and does not hide older records', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close()); await f.session('owner');
  for (let i = 0; i < 105; i++) await enqueue(f.env.HUB_DB, 'owner', validatePayload(message()), 100);
  const first = await listSubmissions(f.env.HUB_DB, 'owner');
  const second = await listSubmissions(f.env.HUB_DB, 'owner', first.nextCursor);
  assert.equal(first.items.length, 100); assert.equal(second.items.length, 5); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 105);
});

test('answers bind to a real source revision; drift fails while persisted retries remain safe', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close()); const owner = await f.session('owner');
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  const source = '| ID | Task | State | Owner |\n|---|---|---|---|\n| EX-1 | Synthetic question | Needs-owner | Example |\n';
  const bytes = new TextEncoder().encode(source);
  const hashInput = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]);
  const revision = Buffer.from(await crypto.subtle.digest('SHA-1', hashInput)).toString('hex');
  globalThis.fetch = async () => new Response(source);
  const cfg = { BOARD_GITHUB_TOKEN: 'synthetic-only', BOARD_PATHS: 'proposals/example/BOARD.md', BOARD_IDEA_PATHS: '' };
  const payload = message({ kind: 'answer', target: { sourcePath: cfg.BOARD_PATHS, taskId: 'EX-1', revision } });
  const post = (body) => f.request('POST', body, owner, {}, undefined, cfg);
  assert.equal((await post({ ...payload, target: { ...payload.target, revision: 'b'.repeat(40) } })).status, 409);
  assert.equal((await post({ ...payload, target: { ...payload.target, taskId: 'EX-2' } })).status, 400);
  const saved = await post(payload); assert.equal(saved.status, 201);
  globalThis.fetch = async () => new Response('upstream down', { status: 503 });
  const retry = await post(payload); assert.equal(retry.status, 200); assert.equal((await retry.json()).duplicate, true);
  const unavailable = await post({ ...payload, idempotencyKey: crypto.randomUUID() });
  assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).error, 'board_unavailable');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM owner_outbox').get().n, 1);
});

test('two explicitly mapped authors can submit; username-only impersonation and strangers cannot', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const owner = await f.session('owner'), danya = await f.session('danya'), stranger = await f.session('stranger');
  const authors = [{ hubUserId: 'owner', hubUsername: 'owner', githubLogin: 'synthetic-owner' },
    { hubUserId: 'danya', hubUsername: 'danya', githubLogin: 'synthetic-colleague' }];
  const cfg = { BOARD_AUTHORS_JSON: JSON.stringify(authors) };
  const post = (cookie, payload = message(), config = cfg) => f.request('POST', payload, cookie, {}, undefined, config);
  const payload = message();
  const saved = await post(owner, payload); assert.equal(saved.status, 201);
  assert.deepEqual((await saved.json()).item.author, authors[0]);
  const second = await post(danya); assert.equal(second.status, 201);
  assert.deepEqual((await second.json()).item.author, authors[1]);
  assert.equal((await post(stranger)).status, 403);
  assert.equal((await post(stranger, message(), { ...cfg, BOARD_OWNER_USERNAME: 'owner,danya,stranger' })).status, 403);
  assert.equal((await post(danya, message(), {})).status, 403);
  assert.equal((await post(owner, message(), { BOARD_AUTHORS_JSON: JSON.stringify([{ ...authors[0], hubUserId: 'different-id' }]) })).status, 403);
  assert.equal((await post(owner, message(), { BOARD_AUTHORS_JSON: 'invalid' })).status, 403);
  assert.equal((await post(owner, message({ author: authors[1] }))).status, 400);
  // Changing administrator mapping later cannot rewrite attribution on an existing submission.
  const changed = { BOARD_AUTHORS_JSON: JSON.stringify([{ ...authors[0], githubLogin: 'new-synthetic-login' }, authors[1]]) };
  const duplicate = await post(owner, payload, changed); assert.equal(duplicate.status, 200);
  assert.deepEqual((await duplicate.json()).item.author, authors[0]);
  const ownerPage = await (await f.request('GET', undefined, owner, {}, undefined, cfg)).json();
  assert.equal(ownerPage.items.length, 1); assert.equal(ownerPage.items[0].agentAck, null); assert.equal(ownerPage.items[0].agentResult, null);
});

const intentFor = (item, kind = 'issue') => {
  const payloadHash = 'a'.repeat(64), marker = `<!-- hub-outbox:${item.id}:${payloadHash} -->`;
  return { schemaVersion: 1, kind, issueNumber: kind === 'issue' ? null : 7, marker, payloadHash,
    title: `Hub message ${item.id.slice(0, 8)}`, body: `${marker}\nSynthetic issue body` };
};
const issueReceipt = (kind = 'issue') => ({ kind, url: 'https://github.com/Maverlix777/agent-handoffs/issues/7'
  + (kind === 'comment' ? '#issuecomment-19' : ''), issueNumber: 7, commentId: kind === 'comment' ? 19 : null, deliveredAt: 3000 });

test('atomic delivery claim admits one attempt; expiry before intent permits takeover only', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close()); await f.session('owner');
  const { item } = await enqueue(f.env.HUB_DB, 'owner', validatePayload(message()), 1000);
  const claims = await Promise.all(Array.from({ length: 8 }, () => claimDelivery(f.env.HUB_DB, item.id, 1000, 1000)));
  const active = claims.filter(Boolean); assert.equal(active.length, 1); assert.equal(active[0].mode, 'deliver');
  assert.equal(await claimDelivery(f.env.HUB_DB, item.id, 1999, 1000), null);
  const newer = await claimDelivery(f.env.HUB_DB, item.id, 2000, 1000); assert.equal(newer.mode, 'deliver');
  assert.deepEqual(await beginDeliveryAttempt(f.env.HUB_DB, item.id, active[0].attempt, intentFor(item), 2001), { applied: false });
  assert.deepEqual(await beginDeliveryAttempt(f.env.HUB_DB, item.id, newer.attempt, intentFor(item), 2001), { applied: true });
});

test('durable intent forces reconciliation after timeout or crash, never a second create', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close()); await f.session('owner');
  const { item } = await enqueue(f.env.HUB_DB, 'owner', validatePayload(message()), 1000);
  const first = await claimDelivery(f.env.HUB_DB, item.id, 1000, 1000);
  const intent = intentFor(item);
  await beginDeliveryAttempt(f.env.HUB_DB, item.id, first.attempt, intent, 1001);
  const takeover = await claimDelivery(f.env.HUB_DB, item.id, 2000, 1000);
  assert.equal(takeover.mode, 'reconcile'); assert.deepEqual(takeover.intent, intent);
  assert.deepEqual(await beginDeliveryAttempt(f.env.HUB_DB, item.id, takeover.attempt, intent, 2001), { applied: false });
  assert.deepEqual(await markDeliveryUncertain(f.env.HUB_DB, item.id, first.attempt, 2002), { applied: false });
  assert.deepEqual(await markDeliveryUncertain(f.env.HUB_DB, item.id, takeover.attempt, 2002), { applied: true });
  assert.equal(await claimDelivery(f.env.HUB_DB, item.id, 3000), null);
  const reconcile = await claimDelivery(f.env.HUB_DB, item.id, 62002);
  assert.equal(reconcile.mode, 'reconcile'); assert.deepEqual(reconcile.item.deliveryIntent, intent);
  assert.deepEqual(await finishDelivery(f.env.HUB_DB, item.id, reconcile.attempt,
    { status: 'synced', receipt: issueReceipt(), error: null }, 62003), { applied: true });
  assert.equal(await claimDelivery(f.env.HUB_DB, item.id, 999999), null);
  const stored = (await listSubmissions(f.env.HUB_DB, 'owner')).items[0];
  assert.equal(stored.status, 'synced'); assert.equal(stored.agentAck, null); assert.equal(stored.agentResult, null);
  assert.equal(stored.receipt.kind, 'issue');
});

test('Issues receipt requires durable intent and exact issue/comment identity; preflight failure is safely retryable', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close()); await f.session('owner');
  const { item } = await enqueue(f.env.HUB_DB, 'owner', validatePayload(message({ kind: 'answer',
    target: { sourcePath: 'proposals/example/BOARD.md', taskId: 'EX-1', revision: 'a'.repeat(40) } })), 1000);
  const first = await claimDelivery(f.env.HUB_DB, item.id, 1000);
  assert.deepEqual(await finishDelivery(f.env.HUB_DB, item.id, first.attempt,
    { status: 'synced', receipt: issueReceipt(), error: null }, 1001), { applied: false });
  await finishDelivery(f.env.HUB_DB, item.id, first.attempt, { status: 'error', receipt: null, error: 'delivery_unavailable' }, 1001);
  const retry = await claimDelivery(f.env.HUB_DB, item.id, 1002); assert.equal(retry.mode, 'deliver');
  await beginDeliveryAttempt(f.env.HUB_DB, item.id, retry.attempt, intentFor(item, 'comment'), 1003);
  assert.deepEqual(await finishDelivery(f.env.HUB_DB, item.id, retry.attempt,
    { status: 'synced', receipt: issueReceipt(), error: null }, 1004), { applied: false });
  await assert.rejects(finishDelivery(f.env.HUB_DB, item.id, retry.attempt,
    { status: 'synced', receipt: { ...issueReceipt('comment'), url: 'https://attacker.invalid/issues/7' }, error: null }, 1004));
  assert.deepEqual(await finishDelivery(f.env.HUB_DB, item.id, retry.attempt,
    { status: 'synced', receipt: issueReceipt('comment'), error: null }, 1004), { applied: true });
});

test('actual Worker schedules Issues flush only after persistence; reload exposes GitHub receipt but not ACK', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close()); const owner = await f.session('owner');
  const savedFetch = globalThis.fetch; t.after(() => { globalThis.fetch = savedFetch; });
  const api = 'https://api.github.com/repos/Maverlix777/agent-handoffs';
  let remote = null, posts = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM owner_outbox').get().n, 1);
    assert.ok(String(url).startsWith(api));
    if (url === api) return Response.json({ full_name: 'Maverlix777/agent-handoffs', private: true, visibility: 'private', has_issues: true });
    if (url === `${api}/labels/idea`) return Response.json({ name: 'idea' });
    if (init.method === 'POST') {
      posts++;
      assert.ok(f.sqlite.prepare('SELECT delivery_intent_json intent FROM owner_outbox').get().intent);
      const body = JSON.parse(init.body); assert.deepEqual(body.labels, ['idea']);
      remote = { number: 7, body: body.body, repository_url: api, html_url: 'https://github.com/Maverlix777/agent-handoffs/issues/7' };
      return Response.json(remote);
    }
    assert.equal(url, `${api}/issues/7`); return Response.json(remote);
  };
  const pending = [], ctx = { waitUntil(promise) { pending.push(promise); } };
  const request = (payload) => new Request(`${origin}/hub/api/outbox`, { method: 'POST', headers: {
    cookie: owner, origin, 'content-type': 'application/json', 'X-Hub-Request': '1', 'CF-Connecting-IP': '192.0.2.1',
  }, body: JSON.stringify(payload) });
  const payload = message(), enabled = { ...f.env, HUB_ISSUES_ENABLED: 'true', HUB_ISSUES_GITHUB_TOKEN: 'synthetic-issues-token-not-real' };
  const response = await worker.fetch(request(payload), enabled, ctx);
  assert.equal(response.status, 201); assert.equal((await response.json()).item.status, 'pending');
  assert.equal(pending.length, 1); await Promise.all(pending);
  const reloaded = await (await f.request('GET', undefined, owner, {}, undefined, enabled)).json();
  assert.equal(reloaded.items[0].status, 'synced'); assert.equal(reloaded.items[0].receipt.kind, 'issue');
  assert.equal(reloaded.items[0].agentAck, null); assert.equal(reloaded.items[0].agentResult, null);
  assert.equal(reloaded.delivery.status, 'enabled');
  const duplicate = await worker.fetch(request(payload), enabled, ctx);
  assert.equal(duplicate.status, 200); assert.equal(pending.length, 1); assert.equal(posts, 1);
  assert.ok(!JSON.stringify(reloaded).includes(enabled.HUB_ISSUES_GITHUB_TOKEN));
});

test('missing flag or separate Issues token never starts background delivery', async (t) => {
  const f = fixture(); t.after(() => f.sqlite.close()); const owner = await f.session('owner');
  const ctx = { waitUntil() { assert.fail('disabled transport scheduled'); } };
  for (const config of [{ HUB_ISSUES_ENABLED: 'true' }, { HUB_ISSUES_GITHUB_TOKEN: 'synthetic-issues-token-not-real' }]) {
    const response = await worker.fetch(new Request(`${origin}/hub/api/outbox`, { method: 'POST', headers: {
      cookie: owner, origin, 'content-type': 'application/json', 'X-Hub-Request': '1', 'CF-Connecting-IP': '192.0.2.1',
    }, body: JSON.stringify(message()) }), { ...f.env, ...config }, ctx);
    assert.equal(response.status, 201); assert.equal((await response.json()).item.status, 'pending');
  }
});
