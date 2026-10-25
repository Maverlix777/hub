import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../src/worker.js';
import { validatePayload, enqueue, existingSubmission, listSubmissions, applyDeliveryResult } from '../src/outbox.js';

const origin = 'https://hub.kolobovdjp.org';
const message = (overrides = {}) => ({ idempotencyKey: crypto.randomUUID(), kind: 'message', text: 'Synthetic safe message', ...overrides });
function fixture(migrate = true) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8'));
  if (migrate) sqlite.exec(readFileSync(new URL('../migrations/0002_owner_outbox.sql', import.meta.url), 'utf8'));
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
