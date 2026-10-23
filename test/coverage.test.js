import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import worker from '../src/worker.js';
import { createVirtualAuthenticator } from './helpers/virtual-authenticator.js';

const origin = 'https://kolobovdjp.org';
const rpID = 'kolobovdjp.org';
const sql = await readFile(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec(sql);

function statement(query, values = []) {
  return {
    bind(...args) { return statement(query, args); },
    first() { return sqlite.prepare(query).get(...values) || null; },
    all() { return { results: sqlite.prepare(query).all(...values) }; },
    run() { return { meta: { changes: Number(sqlite.prepare(query).run(...values).changes) } }; },
  };
}
const db = {
  prepare: statement,
  batch(items) {
    sqlite.exec('BEGIN');
    try {
      const results = items.map((item) => item.run());
      sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  },
};
const assetRequests = [];
const env = {
  HUB_DB: db,
  ASSETS: { async fetch(request) {
    assetRequests.push(request);
    // Like the real ASSETS binding: HEAD gets headers only.
    return new Response(request.method === 'HEAD' ? null : `asset:${new URL(request.url).pathname}`,
      { headers: { 'content-type': 'text/plain' } });
  } },
  CANONICAL_ORIGIN: origin,
  RP_ID: rpID,
  RP_NAME: 'Hub Test',
  RATE_LIMIT_HMAC_KEY: 'test-only-secret-not-logged-test-only',
};

after(() => sqlite.close());

const commonHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
function assertCommonHeaders(response, label = '') {
  for (const [name, value] of Object.entries(commonHeaders)) assert.equal(response.headers.get(name), value, `${label} ${name}`);
}

// Every response obtained through send() is checked for the common security headers (item 8).
async function send(request, bindings = env) {
  const response = await worker.fetch(request, bindings);
  assertCommonHeaders(response, `${request.method} ${new URL(request.url).pathname} -> ${response.status}:`);
  return response;
}

function req(path, { method = 'GET', body, rawBody, cookie, headers = {}, ip = '192.0.2.10' } = {}) {
  const values = new Headers(headers);
  if (ip) values.set('CF-Connecting-IP', ip);
  if (body !== undefined) values.set('content-type', 'application/json');
  if (cookie) values.set('cookie', cookie);
  if (method === 'POST' && !values.has('origin')) values.set('origin', origin);
  const init = { method, headers: values };
  if (rawBody !== undefined) init.body = rawBody;
  else if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`${origin}${path}`, init);
}
const post = (path, body, opts = {}) => req(path, { method: 'POST', body, ...opts });

let seq = 0;
const nextName = (prefix = 'cov') => `${prefix}.${(seq += 1)}`;

async function register(name = nextName(), ip = '192.0.2.10') {
  const start = await send(post('/hub/api/register/options', { username: name }, { ip }));
  assert.equal(start.status, 200);
  const options = await start.json();
  const auth = createVirtualAuthenticator(rpID, origin);
  const finish = await send(post('/hub/api/register/verify', {
    challengeId: options.challengeId, response: await auth.registrationResponse(options.options),
  }, { ip }));
  assert.equal(finish.status, 200);
  const cookie = finish.headers.get('set-cookie').split(';', 1)[0];
  const user = sqlite.prepare('SELECT id FROM users WHERE username = ?').get(name);
  return { name, auth, cookie, id: user.id };
}

async function login(user, count, ip) {
  const start = await send(post('/hub/api/login/options', { username: user.name }, { ip }));
  assert.equal(start.status, 200);
  const options = await start.json();
  return send(post('/hub/api/login/verify', {
    challengeId: options.challengeId, response: await user.auth.authenticationResponse(options.options, count),
  }, { ip }));
}

// Rate-limit windows are one minute; freeze the clock inside a window so a minute rollover cannot reset counters mid-test.
async function frozenWindow(fn) {
  const realNow = Date.now;
  const frozen = Math.floor(realNow() / 60_000) * 60_000 + 1000;
  Date.now = () => frozen;
  try { return await fn(); } finally { Date.now = realNow; }
}

// ---------- 1. readJson ----------

test('readJson: register/options without a body is 400 invalid_username', async () => {
  const response = await send(req('/hub/api/register/options', { method: 'POST', ip: '192.0.2.101' }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_username' });
});

test('readJson: login/options without a body is 401 login_unavailable', async () => {
  const response = await send(req('/hub/api/login/options', { method: 'POST', ip: '192.0.2.102' }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'login_unavailable' });
});

test('readJson: a valid JSON body with a non-JSON content-type is rejected (400, no 415 in the implementation)', async () => {
  const name = nextName('ctype');
  const text = req('/hub/api/register/options', {
    method: 'POST', rawBody: JSON.stringify({ username: name }), headers: { 'content-type': 'text/plain' }, ip: '192.0.2.103',
  });
  const response = await send(text);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_username' });
  // The same body with the right content-type is accepted, so the type check is what rejected it.
  const ok = await send(post('/hub/api/register/options', { username: name }, { ip: '192.0.2.103' }));
  assert.equal(ok.status, 200);
});

test('readJson: a declared Content-Length above 128 KiB is rejected (400, no 413 in the implementation)', async () => {
  const name = nextName('declared');
  const request = req('/hub/api/register/options', {
    method: 'POST', rawBody: JSON.stringify({ username: name }), headers: { 'content-type': 'application/json', 'content-length': String(128 * 1024 + 1) },
    ip: '192.0.2.104',
  });
  assert.equal(request.headers.get('content-length'), String(128 * 1024 + 1), 'Request must keep the declared length');
  const response = await send(request);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_username' });
});

test('readJson: a streamed body above 128 KiB without Content-Length is cut off and rejected', async () => {
  const name = nextName('stream');
  const encoder = new TextEncoder();
  const chunks = [encoder.encode(`{"username":"${name}","pad":"`)];
  for (let i = 0; i < 20; i += 1) chunks.push(encoder.encode('x'.repeat(8 * 1024)));
  chunks.push(encoder.encode('"}'));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  assert.ok(total > 128 * 1024);
  const stream = () => new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  });
  const make = (body, ip) => new Request(`${origin}/hub/api/register/options`, {
    method: 'POST', body, duplex: 'half', headers: { origin, 'content-type': 'application/json', 'CF-Connecting-IP': ip },
  });
  const request = make(stream(), '192.0.2.105');
  assert.equal(request.headers.has('content-length'), false);
  const response = await send(request);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_username' });
  // A streamed body under the limit is accepted, so the size cap is what rejected the big one.
  const small = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(`{"username":"${name}"}`)); controller.close(); } });
  assert.equal((await send(make(small, '192.0.2.105'))).status, 200);
});

test('readJson: JSON arrays, scalars and broken JSON are rejected', async () => {
  for (const rawBody of ['[1,2]', '"text"', '42', '{broken', 'null']) {
    const response = await send(req('/hub/api/register/options', {
      method: 'POST', rawBody, headers: { 'content-type': 'application/json' }, ip: '192.0.2.106',
    }));
    assert.equal(response.status, 400, rawBody);
  }
});

// ---------- 2. register/verify race ----------

test('register/verify race: two challenges for one name, the second INSERT is 409 and only one user exists', async () => {
  const name = nextName('race');
  const ip = '192.0.2.110';
  const first = await (await send(post('/hub/api/register/options', { username: name }, { ip }))).json();
  const second = await (await send(post('/hub/api/register/options', { username: name }, { ip }))).json();
  assert.notEqual(first.challengeId, second.challengeId);
  const authA = createVirtualAuthenticator(rpID, origin);
  const authB = createVirtualAuthenticator(rpID, origin);
  const [a, b] = await Promise.all([
    send(post('/hub/api/register/verify', { challengeId: first.challengeId, response: await authA.registrationResponse(first.options) }, { ip })),
    send(post('/hub/api/register/verify', { challengeId: second.challengeId, response: await authB.registrationResponse(second.options) }, { ip })),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.deepEqual(await loser.json(), { error: 'registration_unavailable' });
  assert.equal(loser.headers.has('set-cookie'), false);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM users WHERE username = ?').get(name).n, 1);
  const id = sqlite.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM credentials WHERE user_id = ?').get(id).n, 1);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM entitlements WHERE user_id = ?').get(id).n, 1);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?').get(id).n, 1);
  // No orphan rows from the rolled-back batch.
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM sessions WHERE user_id NOT IN (SELECT id FROM users)').get().n, 0);
});

test('register/options for an already registered name is 409 registration_unavailable', async () => {
  const user = await register(nextName('taken'), '192.0.2.111');
  const response = await send(post('/hub/api/register/options', { username: user.name.toUpperCase() }, { ip: '192.0.2.111' }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'registration_unavailable' });
});

// ---------- 3. 429 ----------

test('rate limit: 6th register/options for one name from one IP is 429, the first five are not', async () => {
  await frozenWindow(async () => {
    const name = nextName('rl-reg');
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await send(post('/hub/api/register/options', { username: name }, { ip: '192.0.2.120' }))).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
    const other = await send(post('/hub/api/register/options', { username: nextName('rl-reg') }, { ip: '192.0.2.120' }));
    assert.equal(other.status, 200, 'another name from the same IP is still allowed');
    const sixth = await send(post('/hub/api/register/options', { username: name }, { ip: '192.0.2.121' }));
    assert.equal(sixth.status, 200, 'the same name from another IP is still allowed');
  });
});

test('rate limit: 9th login/options for one name from one IP is 429, the first eight are not', async () => {
  await frozenWindow(async () => {
    const user = await register(nextName('rl-login'), '192.0.2.129');
    const statuses = [];
    let last;
    for (let i = 0; i < 9; i += 1) { last = await send(post('/hub/api/login/options', { username: user.name }, { ip: '192.0.2.130' })); statuses.push(last.status); }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 429]);
    assert.deepEqual(await last.json(), { error: 'rate_limited' });
  });
});

test('rate limit: the shared per-IP auth budget of 20 makes the 21st request 429 even with fresh names', async () => {
  await frozenWindow(async () => {
    const statuses = [];
    for (let i = 0; i < 21; i += 1) statuses.push((await send(post('/hub/api/register/options', { username: nextName('rl-ip') }, { ip: '192.0.2.140' }))).status);
    assert.deepEqual(statuses, [...Array(20).fill(200), 429]);
  });
});

test('rate limit: the shared per-IP budget also counts login/options for unknown users', async () => {
  await frozenWindow(async () => {
    const statuses = [];
    for (let i = 0; i < 21; i += 1) statuses.push((await send(post('/hub/api/login/options', { username: nextName('ghost') }, { ip: '192.0.2.141' }))).status);
    assert.deepEqual(statuses, [...Array(20).fill(401), 429]);
  });
});

test('rate limit: the window resets after a minute', async () => {
  const realNow = Date.now;
  const base = Math.floor(realNow() / 60_000) * 60_000 + 1000;
  try {
    const name = nextName('rl-reset');
    Date.now = () => base;
    for (let i = 0; i < 5; i += 1) assert.equal((await send(post('/hub/api/register/options', { username: name }, { ip: '192.0.2.142' }))).status, 200);
    assert.equal((await send(post('/hub/api/register/options', { username: name }, { ip: '192.0.2.142' }))).status, 429);
    Date.now = () => base + 60_000;
    assert.equal((await send(post('/hub/api/register/options', { username: name }, { ip: '192.0.2.142' }))).status, 200);
  } finally { Date.now = realNow; }
});

// ---------- 4. login/options for unknown users ----------

test('login/options: unknown user and user without a credential get identical 401 login_unavailable', async () => {
  sqlite.prepare("INSERT INTO users (id, username, created_at) VALUES ('no-cred-id', 'no.credential', ?)").run(Date.now());
  const unknown = await send(post('/hub/api/login/options', { username: 'nobody.here' }, { ip: '192.0.2.150' }));
  const empty = await send(post('/hub/api/login/options', { username: 'no.credential' }, { ip: '192.0.2.151' }));
  assert.equal(unknown.status, 401);
  assert.equal(empty.status, 401);
  assert.equal(await unknown.text(), await empty.text());
  assert.deepEqual(Object.fromEntries(unknown.headers), Object.fromEntries(empty.headers));
  assert.deepEqual(JSON.parse(await (await send(post('/hub/api/login/options', { username: 'nobody.here' }, { ip: '192.0.2.152' }))).text()), { error: 'login_unavailable' });
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM challenges WHERE username IN ('nobody.here', 'no.credential')").get().n, 0);
});

test('login/options: an invalid username is also 401 login_unavailable', async () => {
  for (const username of [undefined, 42, '', 'a', 'bad name!', 'x'.repeat(40)]) {
    const response = await send(post('/hub/api/login/options', { username }, { ip: '192.0.2.153' }));
    assert.equal(response.status, 401, String(username));
    assert.deepEqual(await response.json(), { error: 'login_unavailable' });
  }
});

// ---------- 5. login/verify ----------

test("login/verify: another user's credential id is 401 and changes neither user's counter nor creates a session", async () => {
  const alice = await register(nextName('alice'), '192.0.2.160');
  const bob = await register(nextName('bob'), '192.0.2.160');
  const sessionsBefore = sqlite.prepare('SELECT count(*) AS n FROM sessions').get().n;
  const countersBefore = sqlite.prepare('SELECT id, counter FROM credentials ORDER BY id').all();
  const start = await (await send(post('/hub/api/login/options', { username: alice.name }, { ip: '192.0.2.161' }))).json();
  const forged = await bob.auth.authenticationResponse(start.options, 7);
  const response = await send(post('/hub/api/login/verify', { challengeId: start.challengeId, response: forged }, { ip: '192.0.2.161' }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'login_unavailable' });
  assert.equal(response.headers.has('set-cookie'), false);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM sessions').get().n, sessionsBefore);
  assert.deepEqual(sqlite.prepare('SELECT id, counter FROM credentials ORDER BY id').all(), countersBefore);
  // The challenge was consumed by the failed attempt.
  const replay = await send(post('/hub/api/login/verify', { challengeId: start.challengeId, response: await alice.auth.authenticationResponse(start.options, 7) }, { ip: '192.0.2.161' }));
  assert.equal(replay.status, 401);
});

test('login/verify: a counter rollback is 401 and the stored counter is unchanged', async () => {
  const user = await register(nextName('counter'), '192.0.2.170');
  const ok = await login(user, 5, '192.0.2.171');
  assert.equal(ok.status, 200);
  const readCounter = () => sqlite.prepare('SELECT counter FROM credentials WHERE user_id = ?').get(user.id).counter;
  assert.equal(readCounter(), 5);
  const sessionsBefore = sqlite.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?').get(user.id).n;
  const rolledBack = await login(user, 3, '192.0.2.172');
  assert.equal(rolledBack.status, 401);
  assert.deepEqual(await rolledBack.json(), { error: 'login_unavailable' });
  assert.equal(rolledBack.headers.has('set-cookie'), false);
  assert.equal(readCounter(), 5);
  const same = await login(user, 5, '192.0.2.173');
  assert.equal(same.status, 401, 'a repeated counter is also a clone signal');
  assert.equal(readCounter(), 5);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?').get(user.id).n, sessionsBefore);
  assert.equal((await login(user, 6, '192.0.2.174')).status, 200);
  assert.equal(readCounter(), 6);
});

test('login/verify: unknown challenge, missing response and non-string credential id are 401', async () => {
  const user = await register(nextName('badverify'), '192.0.2.175');
  const start = await (await send(post('/hub/api/login/options', { username: user.name }, { ip: '192.0.2.176' }))).json();
  for (const body of [
    { challengeId: 'does-not-exist', response: { id: 'x' } },
    { challengeId: start.challengeId },
    { challengeId: start.challengeId, response: { id: 5 } },
    { response: { id: 'x' } },
  ]) {
    const response = await send(post('/hub/api/login/verify', body, { ip: '192.0.2.176' }));
    assert.equal(response.status, 401, JSON.stringify(body));
  }
});

test('login/verify: an expired challenge is 401', async () => {
  const user = await register(nextName('expired-ch'), '192.0.2.177');
  const start = await (await send(post('/hub/api/login/options', { username: user.name }, { ip: '192.0.2.178' }))).json();
  sqlite.prepare('UPDATE challenges SET expires_at = ? WHERE id = ?').run(Date.now() - 1, start.challengeId);
  const response = await send(post('/hub/api/login/verify', {
    challengeId: start.challengeId, response: await user.auth.authenticationResponse(start.options, 1),
  }, { ip: '192.0.2.178' }));
  assert.equal(response.status, 401);
});

// ---------- 6. sessions ----------

test('session: an expired session redirects /hub/ to login (302) and /hub/api/session is 401', async () => {
  const user = await register(nextName('expired'), '192.0.2.180');
  assert.equal((await send(req('/hub/api/session', { cookie: user.cookie }))).status, 200);
  assert.equal((await send(req('/hub/', { cookie: user.cookie }))).status, 200);
  sqlite.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, user.id);
  const page = await send(req('/hub/', { cookie: user.cookie }));
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), `${origin}/hub/login/`);
  const api = await send(req('/hub/api/session', { cookie: user.cookie }));
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { error: 'unauthorized' });
});

test('session: a revoked session redirects /hub/ to login (302) and /hub/api/session is 401', async () => {
  const user = await register(nextName('revoked'), '192.0.2.181');
  sqlite.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ?').run(Date.now(), user.id);
  const page = await send(req('/hub/', { cookie: user.cookie }));
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), `${origin}/hub/login/`);
  assert.equal((await send(req('/hub/api/session', { cookie: user.cookie }))).status, 401);
});

test('session: malformed cookie values are treated as no session without an exception', async () => {
  const name = '__Host-hub_session';
  const values = ['', 'abc', 'a'.repeat(39), 'a'.repeat(49), '!'.repeat(43), `${'a'.repeat(42)}=`, `${'a'.repeat(43)}%20`, 'a'.repeat(43)];
  for (const value of values) {
    const api = await send(req('/hub/api/session', { cookie: `${name}=${value}` }));
    assert.equal(api.status, 401, `api ${value}`);
    const page = await send(req('/hub/', { cookie: `${name}=${value}` }));
    assert.equal(page.status, 302, `page ${value}`);
  }
  assert.equal((await send(req('/hub/api/session', { cookie: 'other=1; ' }))).status, 401);
  assert.equal((await send(req('/hub/api/session', { cookie: `${name}` }))).status, 401);
});

test('session: logout without a session is 401 unauthorized (not 204) and still clears the cookie', async () => {
  const response = await send(post('/hub/api/logout', undefined, { ip: '192.0.2.182' }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
  assert.match(response.headers.get('set-cookie'), /^__Host-hub_session=; Path=\/; Max-Age=0; Secure; HttpOnly; SameSite=Strict$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('session: logout with a stale cookie is also 401 with Max-Age=0', async () => {
  const user = await register(nextName('stale-logout'), '192.0.2.183');
  sqlite.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ?').run(Date.now(), user.id);
  const response = await send(post('/hub/api/logout', undefined, { cookie: user.cookie, ip: '192.0.2.183' }));
  assert.equal(response.status, 401);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
});

test('session: logout with a live session is 204, revokes it and clears the cookie', async () => {
  const user = await register(nextName('logout'), '192.0.2.184');
  const response = await send(post('/hub/api/logout', undefined, { cookie: user.cookie, ip: '192.0.2.184' }));
  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL').get(user.id).n, 0);
  assert.equal((await send(req('/hub/api/session', { cookie: user.cookie }))).status, 401);
});

// ---------- 7. routes ----------

test('routes: PUT and DELETE on /hub/api/session are 404 not_found (the implementation has no 405 and no Allow there)', async () => {
  const user = await register(nextName('methods'), '192.0.2.190');
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const response = await send(req('/hub/api/session', { method, cookie: user.cookie }));
    assert.equal(response.status, 404, method);
    assert.deepEqual(await response.json(), { error: 'not_found' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.has('allow'), false, method);
  }
});

test('routes: unknown API paths are 404 and GET on a POST-only API path is 404', async () => {
  const user = await register(nextName('apinf'), '192.0.2.191');
  assert.equal((await send(req('/hub/api/nothing', { cookie: user.cookie }))).status, 404);
  assert.equal((await send(req('/hub/api/login/options', { cookie: user.cookie }))).status, 404);
});

test('routes: POST on /hub/index.html is 405 with Allow: GET, HEAD', async () => {
  const user = await register(nextName('post-index'), '192.0.2.192');
  const response = await send(req('/hub/index.html', { method: 'POST', cookie: user.cookie }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('routes: POST on /hub/index.html without a session is the login redirect, not 405', async () => {
  const response = await send(req('/hub/index.html', { method: 'POST' }));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `${origin}/hub/login/`);
});

test('routes: HEAD /hub/index.html with a session is 200 with an empty body and reaches ASSETS as HEAD', async () => {
  const user = await register(nextName('head'), '192.0.2.193');
  assetRequests.length = 0;
  const response = await send(req('/hub/index.html', { method: 'HEAD', cookie: user.cookie }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.equal(assetRequests.length, 1);
  assert.equal(assetRequests[0].method, 'HEAD');
  assert.equal(new URL(assetRequests[0].url).pathname, '/index.html');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('routes: ASSETS 404 for /hub/nope.css with a session stays 404 and no-store', async () => {
  const user = await register(nextName('nope'), '192.0.2.194');
  const missing = { ...env, ASSETS: { async fetch() { return new Response('missing', { status: 404, headers: { 'cache-control': 'public, max-age=999' } }); } } };
  const response = await send(req('/hub/nope.css', { cookie: user.cookie }), missing);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'missing');
});

test('routes: /hub without a trailing slash is a 308 to /hub/ on the canonical origin', async () => {
  const response = await send(req('/hub'));
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), `${origin}/hub/`);
  const withQuery = await send(req('/hub?x=1'));
  assert.equal(withQuery.status, 308);
  assert.equal(withQuery.headers.get('location'), `${origin}/hub/`);
});

test('routes: /хаб/../x and /хаб/./x never redirect to another origin', async () => {
  // The URL parser collapses dot segments before the Worker runs: /хаб/../x -> /x, /хаб/./x -> /хаб/x.
  const up = await send(req('/хаб/../x'));
  assert.equal(up.status, 400);
  assert.equal(up.headers.has('location'), false);
  const dot = await send(req('/хаб/./x'));
  assert.equal(dot.status, 308);
  assert.equal(dot.headers.get('location'), `${origin}/hub/x`);
  // Percent-encoded forms that survive URL parsing reach the Worker's own segment check and the safePublicPath guard.
  for (const path of ['/хаб/%252e%252e/x', '/хаб/%252e/x', '/хаб/a%5Cb', '/%D1%85%D0%B0%D0%B1/%5C..%5Cx']) {
    const response = await send(req(path));
    const location = response.headers.get('location');
    assert.ok([308, 400].includes(response.status), `${path} -> ${response.status}`);
    if (location) assert.ok(location.startsWith(`${origin}/hub/`), `${path} -> ${location}`);
    if (location) {
      const followed = await send(req(new URL(location).pathname + new URL(location).search));
      assert.equal(followed.status, 400, `follow-up of ${path}`);
    }
  }
});

test('routes: a malformed percent escape is 400', async () => {
  const response = await send(req('/hub/%E0%A4%A'));
  assert.equal(response.status, 400);
});

// ---------- 8. security headers on every response class ----------

test('headers: every response class carries the four security headers plus nosniff/frame headers', async () => {
  const user = await register(nextName('hdr'), '192.0.2.200');
  const cases = [
    req('/hub/api/session', { cookie: user.cookie }),
    req('/hub/api/session'),
    req('/hub/api/session', { method: 'PUT' }),
    post('/hub/api/register/options', undefined, { ip: '192.0.2.201' }),
    post('/hub/api/login/verify', { challengeId: 'x' }, { ip: '192.0.2.201' }),
    post('/hub/api/logout', undefined, { ip: '192.0.2.201' }),
    post('/hub/api/login/options', { username: 'x' }, { ip: '192.0.2.201', headers: { origin: 'https://evil.example' } }),
    req('/hub/index.html', { method: 'POST', cookie: user.cookie }),
    req('/hub/index.html', { method: 'HEAD', cookie: user.cookie }),
    req('/hub/nope.css', { cookie: user.cookie }),
    req('/hub/style.css', { cookie: user.cookie }),
    req('/hub/login', {}),
    req('/hub/login/', { cookie: user.cookie }),
    req('/hub'),
    req('/хаб/../x'),
    req('/hub/%252e%252e/x'),
    req('/hub/', {}),
  ];
  for (const request of cases) {
    const response = await worker.fetch(request, env);
    assertCommonHeaders(response, `${request.method} ${new URL(request.url).pathname} -> ${response.status}:`);
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
    assert.ok(response.headers.get('cache-control'));
  }
});

test('headers: early exits (foreign host 404, missing bindings 503, thrown exception 500) are finalized too', async () => {
  const foreign = new Request('https://stranger.example/hub/', { headers: { 'CF-Connecting-IP': '192.0.2.210' } });
  const notFound = await worker.fetch(foreign, env);
  assert.equal(notFound.status, 404);
  assertCommonHeaders(notFound, '404');
  const unavailable = await worker.fetch(req('/hub/'), { ...env, RP_ID: '' });
  assert.equal(unavailable.status, 503);
  assertCommonHeaders(unavailable, '503');
  const broken = await worker.fetch(req('/hub/api/session', { cookie: `__Host-hub_session=${'a'.repeat(43)}` }), {
    ...env, HUB_DB: { prepare() { throw new Error('boom'); } },
  });
  assert.equal(broken.status, 500);
  assertCommonHeaders(broken, '500');
});

// ---------- registration policy A: app access matrix ----------

test('access: a free session opens the apps in the matrix and gets them listed in /hub/api/session', async () => {
  const user = await register(nextName('access'), '192.0.2.190');
  const session = await send(req('/hub/api/session', { cookie: user.cookie }));
  assert.deepEqual((await session.json()).apps, ['chat', 'downloads']);
  for (const path of ['/hub/apps/chat.html', '/hub/apps/chat.js', '/hub/apps/downloads.html', '/hub/apps/downloads.css']) {
    assert.equal((await send(req(path, { cookie: user.cookie }))).status, 200, path);
  }
});

test('access: an app missing from the matrix and odd paths under /hub/apps/ are 403 for a valid session', async () => {
  const user = await register(nextName('access'), '192.0.2.191');
  const before = assetRequests.length;
  for (const path of ['/hub/apps/secret.html', '/hub/apps/constructor.js', '/hub/apps/sub/chat.html', '/hub/apps/chat', '/hub/apps/', '/hub/apps', '/hub//apps/secret.html', '/hub/APPS/secret.html', '/hub/apps%2Fsecret.html', '/hub/%61pps/secret.html', '/hub/apps/%E0.html']) {
    const response = await send(req(path, { cookie: user.cookie }));
    // Encoded separators and bad encodings are already rejected as 400 by safePublicPath.
    assert.ok([400, 403].includes(response.status), `${path}: ${response.status}`);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
  }
  assert.equal(assetRequests.length, before, 'denied paths never reach ASSETS');
});
