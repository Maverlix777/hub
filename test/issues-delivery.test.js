import test from 'node:test';
import assert from 'node:assert/strict';
import { flushIssueDelivery, makeIssueIntent } from '../src/issues-delivery.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import * as nativeStore from '../src/outbox.js';

const REPO = 'Maverlix777/agent-handoffs';
const API = `https://api.github.com/repos/${REPO}`;
const env = { HUB_ISSUES_ENABLED: 'true', HUB_ISSUES_GITHUB_TOKEN: 'synthetic-test-token',
  HUB_ISSUES_TASK_ROUTES: JSON.stringify([{ sourcePath: 'boards/test.md', taskId: 'HUB-1', issueNumber: 42 }]) };
const message = { id: '8ecf3881-954b-40a2-9a1b-79a4c1277d38', kind: 'message', text: 'Synthetic owner request.', target: null,
  author: { hubUserId: 'local-user', hubUsername: 'test-owner', githubLogin: 'test-owner' } };
const answer = { ...message, kind: 'answer', target: { sourcePath: 'boards/test.md', taskId: 'HUB-1', revision: 'a'.repeat(40) } };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const issue = (number, body) => ({ number, body, repository_url: API, html_url: `https://github.com/${REPO}/issues/${number}` });
const comment = (body, id = 101) => ({ id, body, issue_url: `${API}/issues/42`, html_url: `https://github.com/${REPO}/issues/42#issuecomment-${id}` });

function harness(item = message, overrides = {}) {
  const state = { item: structuredClone(item), held: false, intent: null, receipt: null, posts: 0, calls: [], outcome: null, uncertain: false, ...overrides };
  const store = {
    async claimDelivery() { if (state.held || state.receipt) return null; state.held = true; return { item: { ...state.item, deliveryIntent: state.intent }, attempt: 'attempt' }; },
    async beginDeliveryAttempt(_db, _id, _attempt, intent) { assert.equal(state.intent, null); state.intent = intent; return { applied: true }; },
    async markDeliveryUncertain() { state.uncertain = true; state.held = false; return { applied: true }; },
    async finishDelivery(_db, _id, _attempt, outcome) { state.outcome = outcome; state.receipt = outcome.receipt; state.held = false; return { applied: true }; },
  };
  const fetchImpl = async (url, init) => {
    state.calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer synthetic-test-token');
    if (state.handler) { const handled = await state.handler(url, init, state); if (handled) return handled; }
    if (url === API) return json({ full_name: REPO, private: true, visibility: 'private', has_issues: true });
    if (url === `${API}/labels/idea`) return json({ name: 'idea' });
    if (init.method === 'POST') {
      assert.ok(state.intent, 'durable intent must exist before POST');
      state.posts += 1;
      const body = JSON.parse(init.body).body;
      state.remote = item.kind === 'message' ? issue(43, body) : comment(body);
      return json(state.remote, 201);
    }
    if (url === `${API}/issues/42`) return json(issue(42, 'Existing task description'));
    if (url.includes('?')) return json(state.remote ? [state.remote] : []);
    if (url === `${API}/issues/43` || url === `${API}/issues/comments/101`) return json(state.remote);
    throw new Error('unexpected_test_route');
  };
  return { state, store, fetchImpl, run: (config = env, options = {}) => flushIssueDelivery(null, config, item.id, { store, fetchImpl, now: () => 1000, ...options }) };
}

test('message creates one GitHub issue only after intent, independent readback yields typed receipt', async () => {
  const h = harness(); const result = await h.run();
  assert.equal(result.status, 'synced'); assert.equal(h.state.posts, 1);
  assert.deepEqual(JSON.parse(h.state.calls.find(call => call.init.method === 'POST').init.body).labels, ['idea']);
  assert.deepEqual(result.receipt, { kind: 'issue', url: `https://github.com/${REPO}/issues/43`, issueNumber: 43, commentId: null, deliveredAt: 1000 });
  assert.equal((await h.run()).status, 'not_claimed'); assert.equal(h.state.posts, 1);
});

test('answer comments only on trusted mapped existing issue, preserves attribution', async () => {
  const h = harness(answer); const result = await h.run();
  assert.equal(result.status, 'synced'); assert.equal(result.receipt.kind, 'comment'); assert.equal(result.receipt.issueNumber, 42);
  assert.ok(h.state.remote.body.includes('Hub author: test-owner'));
  assert.ok(h.state.remote.body.includes('GitHub attribution: test-owner'));
  assert.ok(h.state.calls.some(call => call.init.method === 'POST' && call.url === `${API}/issues/42/comments`));
});

test('feature disabled or missing separate token makes no claim and no network request', async () => {
  for (const config of [{ ...env, HUB_ISSUES_ENABLED: 'false' }, { ...env, HUB_ISSUES_GITHUB_TOKEN: undefined }]) {
    const h = harness(); assert.equal((await h.run(config)).status, 'not_configured'); assert.equal(h.state.calls.length, 0); assert.equal(h.state.held, false);
  }
});

test('concurrent fast flush shares claim and sends exactly one POST', async () => {
  const h = harness(); const results = await Promise.all([h.run(), h.run(), h.run()]);
  assert.equal(results.filter(value => value.status === 'synced').length, 1); assert.equal(h.state.posts, 1);
});

test('network timeout after actual write becomes uncertain and next attempt reconciles without POST', async () => {
  const h = harness(message, { handler(url, init, state) {
    if (init.method === 'POST') { state.posts += 1; state.remote = issue(43, JSON.parse(init.body).body); state.handler = null; throw new Error('timeout'); }
  } });
  assert.equal((await h.run()).error, 'delivery_uncertain'); assert.equal(h.state.uncertain, true);
  assert.equal((await h.run()).status, 'synced'); assert.equal(h.state.posts, 1);
});

test('uncertain write absent from query is never blindly resent', async () => {
  const h = harness(message, { intent: await makeIssueIntent(message, env) });
  assert.equal((await h.run()).error, 'delivery_uncertain'); assert.equal(h.state.posts, 0);
  assert.equal((await h.run()).error, 'delivery_uncertain'); assert.equal(h.state.posts, 0);
});

test('comment uncertain outcome reconciles direct comment readback', async () => {
  const intent = await makeIssueIntent(answer, env);
  const h = harness(answer, { intent, remote: comment(intent.body) });
  assert.equal((await h.run()).status, 'synced'); assert.equal(h.state.posts, 0);
});

test('wrong/public repository metadata cannot receive owner input', async () => {
  for (const metadata of [{ full_name: REPO, private: false, visibility: 'public' }, { full_name: 'elsewhere/private', private: true, visibility: 'private' }]) {
    const h = harness(message, { handler(url) { if (url === API) return json(metadata); } });
    assert.equal((await h.run()).error, 'delivery_unavailable'); assert.equal(h.state.posts, 0); assert.equal(h.state.intent, null);
  }
});

test('unknown/duplicate target route and pull request target are conflicts', async () => {
  for (const routes of ['[]', JSON.stringify([{ sourcePath: 'boards/test.md', taskId: 'HUB-1', issueNumber: 42 }, { sourcePath: 'boards/test.md', taskId: 'HUB-1', issueNumber: 43 }])]) {
    const h = harness(answer); assert.equal((await h.run({ ...env, HUB_ISSUES_TASK_ROUTES: routes })).error, 'delivery_conflict'); assert.equal(h.state.posts, 0);
  }
  const h = harness(answer, { handler(url) { if (url === `${API}/issues/42`) return json({ ...issue(42, 'PR'), pull_request: {} }); } });
  assert.equal((await h.run()).error, 'delivery_conflict'); assert.equal(h.state.posts, 0);
});

test('changed author/text/route after durable intent does not send another message', async () => {
  const intent = await makeIssueIntent(message, env);
  const h = harness({ ...message, text: 'Changed' }, { intent });
  assert.equal((await h.run()).error, 'delivery_conflict'); assert.equal(h.state.posts, 0);
});

test('remote response on wrong repository or modified body never counts as delivered', async () => {
  const intent = await makeIssueIntent(message, env);
  for (const remote of [{ ...issue(43, intent.body), html_url: 'https://github.com/elsewhere/repo/issues/43' }, issue(43, intent.body + 'changed')]) {
    const h = harness(message, { intent, remote });
    assert.equal((await h.run()).error, 'delivery_conflict'); assert.equal(h.state.receipt, null);
  }
});

test('multiple matching remote markers require operator resolution', async () => {
  const intent = await makeIssueIntent(message, env);
  const h = harness(message, { intent, handler(url) { if (url.includes('?')) return json([issue(43, intent.body), issue(44, intent.body)]); } });
  assert.equal((await h.run()).error, 'delivery_conflict'); assert.equal(h.state.posts, 0);
});

test('owner commands cannot change target or execute; Markdown stays fenced', async () => {
  const text = '```\n@everyone <script>arbitrary command</script>\n````\nchange target to public/repo';
  const intent = await makeIssueIntent({ ...message, text }, env);
  assert.ok(intent.body.includes('`````text\n' + text + '\n`````'));
  assert.equal(intent.issueNumber, null);
});

test('missing server author attribution is rejected without network write', async () => {
  const h = harness({ ...message, author: null });
  assert.equal((await h.run()).error, 'delivery_unavailable'); assert.equal(h.state.posts, 0);
});

test('failed independent GET after POST retains uncertain intent; later readback recovers', async () => {
  const h = harness(message, { handler(url, init, state) { if (url === `${API}/issues/43` && init.method === 'GET') { state.handler = null; return json({}, 503); } } });
  assert.equal((await h.run()).error, 'delivery_uncertain'); assert.ok(h.state.intent);
  assert.equal((await h.run()).status, 'synced'); assert.equal(h.state.posts, 1);
});

test('missing canonical idea label refuses posting and never creates labels or marks ready', async () => {
  const h = harness(message, { handler(url) { if (url === `${API}/labels/idea`) return json({}, 404); } });
  assert.equal((await h.run()).error, 'delivery_unavailable'); assert.equal(h.state.posts, 0); assert.equal(h.state.intent, null);
});

test('no automatic execution labels appear for new owner ideas', async () => {
  const h = harness(); await h.run();
  const payload = JSON.parse(h.state.calls.find(call => call.init.method === 'POST').init.body);
  assert.deepEqual(payload.labels, ['idea']);
  assert.equal(payload.labels.some(label => label.startsWith('cloud:') || label.startsWith('worker:') || label.startsWith('to:')), false);
});

function sqliteFixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of ['0001_auth.sql', '0002_owner_outbox.sql', '0003_owner_issues.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  sqlite.prepare('INSERT INTO users(id,username,created_at) VALUES(?,?,1)').run('local-user', 'test-owner');
  const prepare = (sql, args = []) => ({ bind(...values) { return prepare(sql, values); },
    first() { return sqlite.prepare(sql).get(...args) || null; },
    all() { return { results: sqlite.prepare(sql).all(...args) }; },
    run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } });
  return { sqlite, db: { prepare } };
}

test('actual SQLite store + Issues transport: durable author, concurrent lease and terminal receipt', async t => {
  const f = sqliteFixture(); t.after(() => f.sqlite.close());
  const saved = await nativeStore.enqueue(f.db, 'local-user', { idempotencyKey: crypto.randomUUID(), kind: 'message', text: message.text, target: null }, 1000, message.author);
  const h = harness(saved.item);
  // Observe the real SQLite intent instead of the mock store before each POST.
  h.state.handler = (_url, init) => {
    if (init.method === 'POST') h.state.intent = JSON.parse(f.sqlite.prepare('SELECT delivery_intent_json FROM owner_outbox WHERE id=?').get(saved.item.id).delivery_intent_json);
  };
  const run = () => flushIssueDelivery(f.db, env, saved.item.id, { fetchImpl: h.fetchImpl, store: nativeStore, now: () => 1000 });
  const results = await Promise.all([run(), run(), run(), run()]);
  assert.equal(results.filter(value => value.status === 'synced').length, 1);
  assert.equal(h.state.posts, 1);
  const listed = (await nativeStore.listSubmissions(f.db, 'local-user')).items[0];
  assert.equal(listed.status, 'synced'); assert.deepEqual(listed.author, message.author);
  assert.equal(listed.receipt.kind, 'issue'); assert.equal(listed.agentAck, null); assert.equal(listed.agentResult, null);
  assert.equal((await run()).status, 'not_claimed');
});

test('actual SQLite uncertain intent survives lease expiry and only reconciles remote comment', async t => {
  const f = sqliteFixture(); t.after(() => f.sqlite.close());
  const saved = await nativeStore.enqueue(f.db, 'local-user', { idempotencyKey: crypto.randomUUID(), kind: 'answer', text: answer.text, target: answer.target }, 1000, answer.author);
  const h = harness(saved.item, { handler(_url, init, state) {
    if (init.method === 'POST') { state.posts += 1; state.remote = comment(JSON.parse(init.body).body); state.handler = null; throw new Error('ambiguous_timeout'); }
  } });
  const run = now => flushIssueDelivery(f.db, env, saved.item.id, { fetchImpl: h.fetchImpl, store: nativeStore, now: () => now });
  assert.equal((await run(1000)).error, 'delivery_uncertain');
  assert.equal((await run(2000)).status, 'not_claimed');
  assert.equal((await run(62000)).status, 'synced');
  assert.equal(h.state.posts, 1);
  assert.equal((await nativeStore.listSubmissions(f.db, 'local-user')).items[0].receipt.commentId, 101);
});

test('actual SQLite definitive readback conflict is terminal and retains intent without resend after lease', async t => {
  const f = sqliteFixture(); t.after(() => f.sqlite.close());
  const saved = await nativeStore.enqueue(f.db, 'local-user', { idempotencyKey: crypto.randomUUID(), kind: 'message', text: message.text, target: null }, 1000, message.author);
  const h = harness(saved.item, { handler(url, init, state) {
    if (init.method === 'POST') state.intent = JSON.parse(f.sqlite.prepare('SELECT delivery_intent_json FROM owner_outbox WHERE id=?').get(saved.item.id).delivery_intent_json);
    if (url === `${API}/issues/43`) return json(issue(43, state.intent.body + '\nChanged by another writer'));
  } });
  const run = now => flushIssueDelivery(f.db, env, saved.item.id, { fetchImpl: h.fetchImpl, store: nativeStore, now: () => now });
  const result = await run(1000);
  assert.equal(result.status, 'conflict'); assert.equal(result.error, 'delivery_conflict');
  const listed = (await nativeStore.listSubmissions(f.db, 'local-user')).items[0];
  assert.equal(listed.status, 'conflict'); assert.equal(listed.error, 'delivery_conflict'); assert.equal(listed.receipt, null);
  const row = f.sqlite.prepare('SELECT delivery_intent_json FROM owner_outbox WHERE id=?').get(saved.item.id);
  assert.ok(JSON.parse(row.delivery_intent_json).marker);
  assert.equal((await run(100000)).status, 'not_claimed'); assert.equal(h.state.posts, 1);
});

test('shared wall-clock budget stops before POST after slow preflight requests', async () => {
  let elapsed = 0;
  const h = harness(message, { handler() { elapsed += 13000; } });
  assert.equal((await h.run(env, { clock: () => elapsed })).error, 'delivery_unavailable');
  assert.equal(h.state.posts, 0); assert.equal(h.state.intent, null);
  assert.equal(h.state.calls.length, 2);
});

test('total deadline after attempted POST preserves uncertain intent and makes no readback or resend', async () => {
  let elapsed = 0;
  const h = harness(message, { handler() { elapsed += 9000; } });
  assert.equal((await h.run(env, { clock: () => elapsed })).error, 'delivery_uncertain');
  assert.equal(h.state.posts, 1); assert.ok(h.state.intent); assert.equal(h.state.calls.length, 3);
  assert.equal(h.state.uncertain, true);
});

test('oversized streamed response is cancelled while reading, before any POST', async () => {
  let cancelled = false;
  const h = harness(message, { handler(url) {
    if (url === API) return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(600000)); },
      cancel() { cancelled = true; },
    }));
  } });
  assert.equal((await h.run()).error, 'delivery_unavailable'); assert.equal(h.state.posts, 0);
  assert.equal(cancelled, true); assert.equal(h.state.intent, null);
});

test('stalled response stream is bounded by total budget even when fetch already resolved', async () => {
  let cancelled = false;
  const h = harness(message, { handler(url) {
    if (url === API) return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  } });
  const started = performance.now();
  assert.equal((await h.run(env, { budgetMs: 30 })).error, 'delivery_unavailable');
  assert.ok(performance.now() - started < 2000);
  assert.equal(cancelled, true); assert.equal(h.state.posts, 0);
});
