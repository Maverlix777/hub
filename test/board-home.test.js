import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../src/worker.js';

const origin = 'https://hub.kolobovdjp.org';
async function fixture(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8'));
  const prepare = (sql, args = []) => ({
    bind(...values) { return prepare(sql, values); },
    first() { return sqlite.prepare(sql).get(...args) || null; },
  });
  const assets = [];
  const env = { HUB_DB: { prepare }, RP_ID: 'kolobovdjp.org', CANONICAL_ORIGIN: origin,
    BOARD_OWNER_USERNAME: 'owner', ASSETS: { async fetch(request) {
      const path = new URL(request.url).pathname; assets.push({ path, method: request.method });
      return new Response(request.method === 'HEAD' ? null : path, { headers: { 'content-type': 'text/html' } });
    } } };
  const cookies = {};
  for (const [username, tier] of [['owner', 'free'], ['colleague', 'free'], ['ordinary', 'paid']]) {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
    const id = `synthetic-${username}-id`;
    sqlite.prepare('INSERT INTO users (id,username,created_at) VALUES(?,?,1)').run(id, username);
    sqlite.prepare('INSERT INTO entitlements(user_id,tier,created_at) VALUES(?,?,1)').run(id, tier);
    sqlite.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,1,?)').run(hash, id, Date.now() + 3600000);
    cookies[username] = `__Host-hub_session=${token}`;
  }
  const authors = [{ hubUserId: 'synthetic-owner-id', hubUsername: 'owner', githubLogin: 'synthetic-owner' },
    { hubUserId: 'synthetic-colleague-id', hubUsername: 'colleague', githubLogin: 'synthetic-colleague' }];
  const request = (path, username, method = 'GET', overrides = {}) => worker.fetch(new Request(origin + path, {
    method, headers: username ? { cookie: cookies[username] } : {},
  }), { ...env, ...overrides });
  return { assets, authors, request };
}

test('GET/HEAD home serves the board for existing owner and explicitly verified colleague, catalog for ordinary user', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'HEAD']) {
    for (const [username, expectedPath] of [['owner', '/apps/board.html'], ['colleague', '/apps/board.html'], ['ordinary', '/index.html']]) {
      const response = await f.request('/hub/', username, method, { BOARD_AUTHORS_JSON: JSON.stringify(f.authors) });
      assert.equal(response.status, 200);
      assert.deepEqual(f.assets.at(-1), { path: expectedPath, method });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(await response.text(), method === 'HEAD' ? '' : expectedPath);
    }
  }
});

test('home retains existing legacy owner gate and does not grant board access from username or entitlement', async t => {
  const f = await fixture(t);
  assert.equal(await (await f.request('/hub/', 'owner')).text(), '/apps/board.html');
  assert.equal(await (await f.request('/hub/', 'colleague')).text(), '/index.html');
  assert.equal(await (await f.request('/hub/', 'ordinary')).text(), '/index.html');
  assert.equal(await (await f.request('/hub/', 'owner', 'GET', { BOARD_OWNER_USERNAME: '' })).text(), '/index.html');
  const badMapping = { BOARD_AUTHORS_JSON: JSON.stringify([{ ...f.authors[0], hubUserId: 'wrong-stable-id' }]) };
  assert.equal(await (await f.request('/hub/', 'owner', 'GET', badMapping)).text(), '/index.html');
  assert.equal((await f.request('/hub/apps/board.html', 'owner', 'GET', badMapping)).status, 403);
});

test('explicit catalog and legacy board URLs keep their meaning for GET and HEAD', async t => {
  const f = await fixture(t), mapping = { BOARD_AUTHORS_JSON: JSON.stringify(f.authors) };
  for (const method of ['GET', 'HEAD']) {
    for (const username of ['owner', 'colleague', 'ordinary']) {
      assert.equal((await f.request('/hub/index.html', username, method, mapping)).status, 200);
      assert.deepEqual(f.assets.at(-1), { path: '/index.html', method });
    }
    for (const username of ['owner', 'colleague']) {
      assert.equal((await f.request('/hub/apps/board.html', username, method, mapping)).status, 200);
      assert.deepEqual(f.assets.at(-1), { path: '/apps/board.html', method });
    }
    const calls = f.assets.length;
    assert.equal((await f.request('/hub/apps/board.html', 'ordinary', method, mapping)).status, 403);
    assert.equal(f.assets.length, calls);
  }
});

test('anonymous homepage still redirects before asset reads; slash and unsupported method behavior remain unchanged', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/hub/', '/hub/index.html', '/hub/apps/board.html']) {
      const response = await f.request(path, null, method);
      assert.equal(response.status, 302); assert.equal(response.headers.get('location'), `${origin}/hub/login/`);
    }
    const slash = await f.request('/hub', 'owner', method);
    assert.equal(slash.status, 308); assert.equal(slash.headers.get('location'), `${origin}/hub/`);
  }
  assert.equal((await f.request('/hub/', 'owner', 'POST')).status, 405);
  assert.equal(f.assets.length, 0);
});
