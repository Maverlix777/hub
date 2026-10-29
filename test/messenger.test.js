import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../src/worker.js';
import { validatePayload, enqueue } from '../src/outbox.js';
import { issueLabels } from '../src/issues-delivery.js';

const origin = 'https://hub.kolobovdjp.org';
const DAY = 24 * 60 * 60 * 1000;
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of ['0001_auth', '0002_owner_outbox', '0003_owner_issues']) sqlite.exec(readFileSync(new URL(`../migrations/${f}.sql`, import.meta.url), 'utf8'));
  const statement = (sql, values = []) => ({
    bind(...args) { return statement(sql, args); },
    first() { return sqlite.prepare(sql).get(...values) || null; },
    all() { return { results: sqlite.prepare(sql).all(...values) }; },
    run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
  });
  const env = { HUB_DB: { prepare: statement }, ASSETS: { fetch: async (r) => new Response(new URL(r.url).pathname) }, CANONICAL_ORIGIN: origin,
    RP_ID: 'kolobovdjp.org', BOARD_OWNER_USERNAME: 'owner', RATE_LIMIT_HMAC_KEY: 'synthetic-key-'.repeat(4),
    HUB_ISSUES_ENABLED: 'true', HUB_ISSUES_GITHUB_TOKEN: 'synthetic-token-not-a-secret' };
  async function session(name, expiresAt = Date.now() + 3600000) {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
    sqlite.prepare('INSERT INTO users(id,username,created_at) VALUES(?,?,1)').run(name, name);
    sqlite.prepare('INSERT INTO entitlements(user_id,tier,created_at) VALUES(?,?,1)').run(name, 'paid');
    sqlite.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,1,?)').run(hash, name, expiresAt);
    return { cookie: `__Host-hub_session=${token}`, hash };
  }
  const request = (method, path, cookie, body, headers = {}) => worker.fetch(new Request(origin + path, {
    method, headers: { ...(cookie ? { cookie } : {}), origin, 'content-type': 'application/json', 'X-Hub-Request': '1', 'CF-Connecting-IP': '192.0.2.1', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  async function syncedThread(owner, issue, mode) {
    const { item } = await enqueue(env.HUB_DB, owner, { idempotencyKey: crypto.randomUUID(), kind: 'message', text: 'привет <b>', target: null, addressee: 'codex', ...(mode ? { mode } : {}) });
    sqlite.prepare('UPDATE owner_outbox SET status=?,receipt_json=? WHERE id=?').run('synced', JSON.stringify({ kind: 'issue', issueNumber: issue, commentId: null,
      url: `https://github.com/Maverlix777/agent-handoffs/issues/${issue}` }), item.id);
    return item;
  }
  return { sqlite, env, session, request, syncedThread };
}

test('session cookie is persistent, SameSite=Lax, 90 days', async () => {
  const f = fixture();
  const s = await f.session('owner', Date.now() + 80 * DAY); // older than one hour of slide
  const response = await f.request('GET', '/hub/', s.cookie);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^__Host-hub_session=[A-Za-z0-9_-]+; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Lax$/);
  const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)[1]);
  assert.ok(maxAge > 89 * 86400 && maxAge <= 90 * 86400, `Max-Age=${maxAge}`);
});

test('live session is extended in D1 (sliding), but not rewritten within the hour', async () => {
  const f = fixture();
  const s = await f.session('owner', Date.now() + 10 * DAY);
  const r = await f.request('GET', '/hub/', s.cookie);
  assert.ok(r.headers.get('set-cookie'));
  const row = f.sqlite.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(s.hash);
  assert.ok(row.expires_at > Date.now() + 89 * DAY);
  const again = await f.request('GET', '/hub/', s.cookie);
  assert.equal(again.headers.get('set-cookie'), null);
});

test('mode chat needs an addressee and maps to the chat label, task keeps cloud:ready', () => {
  const base = { idempotencyKey: crypto.randomUUID(), kind: 'message', text: 'x', target: null };
  assert.equal(validatePayload({ ...base, addressee: 'pedro', mode: 'chat' }).mode, 'chat');
  assert.equal('mode' in validatePayload({ ...base, addressee: 'pedro', mode: 'task' }), false);
  assert.equal(validatePayload({ ...base, mode: 'chat' }), null);
  assert.equal(validatePayload({ ...base, addressee: 'pedro', mode: 'root' }), null);
  assert.deepEqual(issueLabels({ kind: 'message', addressee: 'claude', mode: 'chat' }), ['worker:claude', 'chat']);
  assert.deepEqual(issueLabels({ kind: 'message', addressee: 'claude' }), ['worker:claude', 'cloud:ready']);
});

test('chat endpoints: auth, owner only, owned threads only, token never leaves, reply posts a comment', async (t) => {
  const f = fixture();
  const owner = await f.session('owner'); const guest = await f.session('guest');
  await f.syncedThread('owner', 21, 'chat'); await f.syncedThread('guest', 22);
  assert.equal((await f.request('GET', '/hub/api/chat/threads')).status, 401);
  assert.equal((await f.request('GET', '/hub/api/chat/threads', guest.cookie)).status, 403);
  const list = await (await f.request('GET', '/hub/api/chat/threads', owner.cookie)).json();
  assert.deepEqual(list.threads.map((x) => [x.issue, x.mode, x.addressee]), [[21, 'chat', 'codex']]);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    if (url.endsWith('/issues/21')) return new Response(JSON.stringify({ number: 21, state: 'open', created_at: '2026-10-28T00:00:00Z',
      body: '<!-- hub-outbox:x:y -->\nHub author: owner\n\n```text\nпривет <b>\n```\n' }));
    if (url.includes('/issues/21/comments') && options.method === 'GET') return new Response(JSON.stringify([
      { id: 5, body: 'ответ агента', user: { login: 'codex-bot' }, created_at: '2026-10-28T00:01:00Z' }]));
    if (url.endsWith('/issues/21/comments') && options.method === 'POST') return new Response(JSON.stringify({ id: 6 }), { status: 201 });
    return new Response('{}', { status: 404 });
  });
  const thread = await f.request('GET', '/hub/api/chat/thread?issue=21', owner.cookie);
  const raw = await thread.text();
  assert.doesNotMatch(raw, /synthetic-token/);
  const data = JSON.parse(raw);
  assert.deepEqual(data.messages.map((m) => [m.mine, m.author, m.text]), [[true, 'Максим', 'привет <b>'], [false, 'codex-bot', 'ответ агента']]);
  const before = calls.length;
  assert.equal((await f.request('GET', '/hub/api/chat/thread?issue=22', owner.cookie)).status, 404, 'foreign issue');
  assert.equal((await f.request('GET', '/hub/api/chat/thread?issue=999', owner.cookie)).status, 404, 'unknown issue');
  assert.equal(calls.length, before, 'no GitHub call for issues the owner did not create');
  assert.equal((await f.request('POST', '/hub/api/chat/reply', owner.cookie, { issue: 21, text: 'ok' }, { 'X-Hub-Request': '0' })).status, 403);
  assert.equal((await f.request('POST', '/hub/api/chat/reply', owner.cookie, { issue: 21, text: '  ' })).status, 400);
  assert.equal((await f.request('POST', '/hub/api/chat/reply', owner.cookie, { issue: 22, text: 'hi' })).status, 404);
  const ok = await f.request('POST', '/hub/api/chat/reply', owner.cookie, { issue: 21, text: 'ответ ``` с кодом' });
  assert.equal(ok.status, 201);
  const post = calls.at(-1); assert.equal(post.method, 'POST'); assert.match(post.url, /\/issues\/21\/comments$/);
});
