import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import worker from '../src/worker.js';

// Synthetic data only: this repo is public.
const origin = 'https://kolobovdjp.org';
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
for (const name of ['0001_auth.sql', '0006_agent_presence.sql']) {
  sqlite.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
}
function statement(query, values = []) {
  return {
    bind(...args) { return statement(query, args); },
    first() { return sqlite.prepare(query).get(...values) || null; },
    all() { return { results: sqlite.prepare(query).all(...values) }; },
    run() { return { meta: { changes: Number(sqlite.prepare(query).run(...values).changes) } }; },
  };
}
const SECRET = 'test-presence-secret-0123456789abcdef-xyz';
const env = {
  HUB_DB: { prepare: statement },
  ASSETS: { async fetch() { return new Response('asset'); } },
  CANONICAL_ORIGIN: origin,
  RP_ID: 'kolobovdjp.org',
  BOARD_OWNER_USERNAME: 'boss',
  PRESENCE_TOKEN: SECRET,
};
after(() => sqlite.close());

async function login(username, token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = Buffer.from(digest).toString('base64url');
  sqlite.prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, 1)').run(`id-${username}`, username);
  sqlite.prepare('INSERT INTO entitlements (user_id, tier, created_at) VALUES (?, ?, 1)').run(`id-${username}`, 'free');
  sqlite.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 1, ?)')
    .run(hash, `id-${username}`, Date.now() + 3600_000);
  return { cookie: `__Host-hub_session=${token}` };
}
const owner = await login('boss', 'o'.repeat(43));
const guest = await login('guest', 'g'.repeat(43));

const valid = { owner: 'max', agent: 'claude', machine: 'mac-16.local', state: 'working', card: 'T-1', note: 'doing it' };
function post(body, { token = SECRET, raw, e = env, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token !== null) h.authorization = `Bearer ${token}`;
  return worker.fetch(new Request(`${origin}/hub/api/presence`, { method: 'POST', headers: h, body: raw ?? JSON.stringify(body) }), e);
}
const get = (who, e = env) => worker.fetch(new Request(`${origin}/hub/api/presence`, { headers: who ? { cookie: who.cookie } : {} }), e);
const count = () => sqlite.prepare('SELECT COUNT(*) AS n FROM agent_presence').get().n;
const clear = () => sqlite.exec('DELETE FROM agent_presence');

test('presence: migration has primary key (owner, agent, machine)', () => {
  const pk = sqlite.prepare("SELECT name FROM pragma_table_info('agent_presence') WHERE pk > 0 ORDER BY pk").all().map((r) => r.name);
  assert.deepEqual(pk, ['owner', 'agent', 'machine']);
});

test('presence POST: 503 when secret missing or shorter than 32', async () => {
  const { PRESENCE_TOKEN, ...none } = env;
  let r = await post(valid, { e: none });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'not_configured' });
  r = await post(valid, { e: { ...env, PRESENCE_TOKEN: 'short'.repeat(6) }, token: 'short'.repeat(6) });
  assert.equal(r.status, 503);
});

test('presence POST: 401 without or with wrong token, nothing stored', async () => {
  assert.equal((await post(valid, { token: null })).status, 401);
  assert.equal((await post(valid, { token: 'x'.repeat(40) })).status, 401);
  assert.equal((await post(valid, { token: SECRET.slice(0, -1) })).status, 401);
  const basic = await post(valid, { token: null, headers: { authorization: `Basic ${SECRET}` } });
  assert.equal(basic.status, 401);
  assert.equal(count(), 0);
});

test('presence POST: 400 on each field violation, extra field, size and non-JSON', async () => {
  const bad = [
    { ...valid, owner: 'Max' }, { ...valid, owner: '' }, { ...valid, owner: 'a'.repeat(33) }, { ...valid, owner: undefined },
    { ...valid, agent: 'bad agent' }, { ...valid, agent: 'a'.repeat(33) }, { ...valid, agent: 5 },
    { ...valid, machine: 'bad/machine' }, { ...valid, machine: 'm'.repeat(65) }, { ...valid, machine: '' },
    { ...valid, state: 'sleeping' }, { ...valid, state: undefined },
    { ...valid, card: 'c'.repeat(81) }, { ...valid, card: 'a\nb' }, { ...valid, card: 7 },
    { ...valid, note: 'n'.repeat(201) }, { ...valid, note: 'a\u0000b' }, { ...valid, note: 'a\u007fb' }, { ...valid, note: 'a\u009fb' },
    { ...valid, extra: 1 },
  ];
  for (const body of bad) assert.equal((await post(body)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal((await post(null, { raw: 'not json' })).status, 400);
  assert.equal((await post(null, { raw: '[1]' })).status, 400);
  assert.equal((await post(null, { raw: 'null' })).status, 400);
  assert.equal((await post(null, { raw: '' })).status, 400);
  assert.equal((await post({ ...valid, note: 'x'.repeat(2100) }, {})).status, 400);
  assert.equal(count(), 0);
});

test('presence POST: boundary lengths are accepted; optional fields may be absent', async () => {
  const r = await post({ owner: 'o'.repeat(32), agent: 'a'.repeat(32), machine: 'M'.repeat(64), state: 'done', card: 'c'.repeat(80), note: 'n'.repeat(200) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal((await post({ owner: 'max', agent: 'x', machine: 'h', state: 'idle' })).status, 200);
  clear();
});

test('presence POST: upsert does not multiply rows and updates fields', async () => {
  clear();
  assert.equal((await post(valid)).status, 200);
  assert.equal((await post({ ...valid, state: 'blocked', note: 'waiting' })).status, 200);
  assert.equal(count(), 1);
  const row = sqlite.prepare('SELECT * FROM agent_presence').get();
  assert.equal(row.state, 'blocked');
  assert.equal(row.note, 'waiting');
  assert.ok(Math.abs(row.updated_at - Date.now()) < 5000);
  assert.equal((await post({ ...valid, machine: 'other' })).status, 200);
  assert.equal(count(), 2);
});

test('presence POST: server ignores client time and rows older than 7 days are purged on write', async () => {
  clear();
  const day = 86400_000;
  const ins = sqlite.prepare('INSERT INTO agent_presence (owner, agent, machine, state, card, note, updated_at) VALUES (?,?,?,?,?,?,?)');
  ins.run('old', 'a', 'm', 'idle', null, null, Date.now() - 8 * day);
  ins.run('mid', 'a', 'm', 'idle', null, null, Date.now() - 6 * day);
  assert.equal((await post({ ...valid, updated_at: 1 })).status, 400);
  assert.equal((await post(valid)).status, 200);
  const owners = sqlite.prepare('SELECT owner FROM agent_presence ORDER BY owner').all().map((r) => r.owner);
  assert.deepEqual(owners, ['max', 'mid']);
});

test('presence POST: 201st new key is 409, existing key still updates', async () => {
  clear();
  const ins = sqlite.prepare('INSERT INTO agent_presence (owner, agent, machine, state, card, note, updated_at) VALUES (?,?,?,?,?,?,?)');
  for (let i = 0; i < 199; i++) ins.run('bulk', `a${i}`, 'm', 'idle', null, null, Date.now());
  assert.equal((await post(valid)).status, 200);
  assert.equal(count(), 200);
  const over = await post({ ...valid, agent: 'newcomer' });
  assert.equal(over.status, 409);
  assert.deepEqual(await over.json(), { error: 'too_many_agents' });
  assert.equal(count(), 200);
  assert.equal((await post({ ...valid, state: 'done' })).status, 200);
  assert.equal(count(), 200);
});

test('presence GET: 401 anonymous, 403 non-owner, 200 owner; bearer is not accepted', async () => {
  clear();
  assert.equal((await get(null)).status, 401);
  assert.equal((await get(guest)).status, 403);
  const viaBearer = await worker.fetch(new Request(`${origin}/hub/api/presence`, { headers: { authorization: `Bearer ${SECRET}` } }), env);
  assert.equal(viaBearer.status, 401);
  const r = await get(owner);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), []);
});

test('presence GET: sorted, stale flag at 15 minutes, rows older than 24h hidden, token not leaked', async () => {
  clear();
  const ins = sqlite.prepare('INSERT INTO agent_presence (owner, agent, machine, state, card, note, updated_at) VALUES (?,?,?,?,?,?,?)');
  const now = Date.now();
  ins.run('zed', 'a', 'm', 'working', 'T-9', 'n', now - 60_000);
  ins.run('max', 'b', 'm2', 'idle', null, null, now - 16 * 60_000);
  ins.run('max', 'b', 'm1', 'idle', null, null, now - 14 * 60_000);
  ins.run('max', 'a', 'm1', 'done', null, null, now - 23 * 3600_000);
  ins.run('gone', 'a', 'm', 'idle', null, null, now - 25 * 3600_000);
  const body = await (await get(owner)).json();
  assert.deepEqual(body.map((r) => `${r.owner}/${r.agent}/${r.machine}`), ['max/a/m1', 'max/b/m1', 'max/b/m2', 'zed/a/m']);
  assert.deepEqual(body.map((r) => r.stale), [true, false, true, false]);
  assert.equal(body[3].card, 'T-9');
  assert.ok(!JSON.stringify(body).includes(SECRET));
});

test('presence: other methods get 405 with allow header', async () => {
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const r = await worker.fetch(new Request(`${origin}/hub/api/presence`, { method, headers: { cookie: owner.cookie, authorization: `Bearer ${SECRET}` } }), env);
    assert.equal(r.status, 405, method);
    assert.match(r.headers.get('allow'), /GET/);
    assert.match(r.headers.get('allow'), /POST/);
  }
});
