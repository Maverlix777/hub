import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
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
const env = {
  HUB_DB: db,
  ASSETS: { async fetch(request) { return new Response(`asset:${new URL(request.url).pathname}`, { headers: { 'content-type': 'text/plain', etag: 'x' } }); } },
  CANONICAL_ORIGIN: origin,
  RP_ID: rpID,
  RP_NAME: 'Hub Test',
  RATE_LIMIT_HMAC_KEY: 'test-only-secret-not-logged-test-only',
};

function req(path, { method = 'GET', body, cookie, headers = {}, ip = '192.0.2.80' } = {}) {
  const values = new Headers(headers);
  if (ip) values.set('CF-Connecting-IP', ip);
  if (body !== undefined) values.set('content-type', 'application/json');
  if (cookie) values.set('cookie', cookie);
  if (method === 'POST' && !values.has('origin')) values.set('origin', origin);
  return new Request(`${origin}${path}`, { method, headers: values, body: body === undefined ? undefined : JSON.stringify(body) });
}

const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
function assertSecurityHeaders(response, cacheControl = 'no-store') {
  assert.equal(response.headers.get('cache-control'), cacheControl);
  for (const [name, value] of Object.entries(securityHeaders)) assert.equal(response.headers.get(name), value, name);
  assert.equal(response.headers.has('strict-transport-security'), false);
}

let auth;
let sessionCookie;
let username = 'harden.user';

before(async () => {
  const start = await worker.fetch(req('/hub/api/register/options', { method: 'POST', body: { username } }), env);
  assert.equal(start.status, 200);
  const options = await start.json();
  auth = createVirtualAuthenticator(rpID, origin);
  const finish = await worker.fetch(req('/hub/api/register/verify', {
    method: 'POST', body: { challengeId: options.challengeId, response: await auth.registrationResponse(options.options) },
  }), env);
  assert.equal(finish.status, 200);
  sessionCookie = finish.headers.get('set-cookie').split(';', 1)[0];
});

after(() => sqlite.close());

test('exception in D1 yields generic 500 internal_error with no-store and no error text', async () => {
  const secretText = 'SECRET-DB-DETAIL-xyz';
  const broken = { ...env, HUB_DB: { prepare() { throw new Error(secretText); }, batch() { throw new Error(secretText); } } };
  const cookie = `__Host-hub_session=${'a'.repeat(43)}`;
  const response = await worker.fetch(req('/hub/api/session', { cookie }), broken);
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: 'internal_error' });
  assert.equal(text.includes(secretText), false);
  assert.equal(text.includes('at '), false);
  assertSecurityHeaders(response);
});

test('redirects carry the common security headers', async () => {
  const redirect = await worker.fetch(req('/hub'), env);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), `${origin}/hub/`);
  assertSecurityHeaders(redirect);
  const alias = await worker.fetch(req('/хаб/'), env);
  assert.equal(alias.status, 308);
  assertSecurityHeaders(alias);
  const toLogin = await worker.fetch(req('/hub/apps/chat.html'), env);
  assert.equal(toLogin.status, 302);
  assertSecurityHeaders(toLogin);
});

test('static assets are privately cacheable for an hour; HTML and JS stay no-store', async () => {
  for (const path of ['/hub/icons/icon-192.png', '/hub/style.css', '/hub/login.css', '/hub/manifest.webmanifest', '/hub/apps/chat.css']) {
    const response = await worker.fetch(req(path, { cookie: sessionCookie }), env);
    assert.equal(response.status, 200, path);
    assertSecurityHeaders(response, 'private, max-age=3600');
  }
  for (const path of ['/hub/index.html', '/hub/', '/hub/hub.js', '/hub/apps/chat.html', '/hub/apps/chat.js', '/hub/login/', '/hub/login.js']) {
    const response = await worker.fetch(req(path, { cookie: sessionCookie }), env);
    assert.equal(path === '/hub/login/' ? response.status === 303 : response.status === 200, true, path);
    assertSecurityHeaders(response);
  }
  const json = await worker.fetch(req('/hub/api/session', { cookie: sessionCookie }), env);
  assertSecurityHeaders(json);
  const failed = { ...env, ASSETS: { async fetch() { return new Response('nope', { status: 404 }); } } };
  assertSecurityHeaders(await worker.fetch(req('/hub/icons/missing.png', { cookie: sessionCookie }), failed));
});

test('with rate-limit key but no client IP the canonical path answers 503 service_unavailable, not 429', async () => {
  const response = await worker.fetch(req('/hub/api/login/options', { method: 'POST', body: { username }, ip: null }), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  assertSecurityHeaders(response);
  const register = await worker.fetch(req('/hub/api/register/options', { method: 'POST', body: { username: 'someone.new' }, ip: null }), env);
  assert.equal(register.status, 503);
  assert.deepEqual(await register.json(), { error: 'service_unavailable' });
});

test('without rate-limit key the existing fail-closed 503 auth_unavailable is unchanged (with or without IP)', async () => {
  for (const ip of ['192.0.2.81', null]) {
    const response = await worker.fetch(req('/hub/api/login/options', { method: 'POST', body: { username }, ip }), { ...env, RATE_LIMIT_HMAC_KEY: '' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'auth_unavailable' });
  }
});

test('real rate limiting still answers 429 rate_limited', async () => {
  let last;
  for (let i = 0; i < 9; i += 1) {
    last = await worker.fetch(req('/hub/api/login/options', { method: 'POST', body: { username }, ip: '192.0.2.99' }), env);
  }
  assert.equal(last.status, 429);
  assert.deepEqual(await last.json(), { error: 'rate_limited' });
});

test('malformed transports_json does not break login', async () => {
  sqlite.prepare("UPDATE credentials SET transports_json = 'not json'").run();
  const start = await worker.fetch(req('/hub/api/login/options', { method: 'POST', body: { username }, ip: '192.0.2.82' }), env);
  assert.equal(start.status, 200);
  const options = await start.json();
  assert.equal(options.options.allowCredentials.length, 1);
  assert.deepEqual(options.options.allowCredentials[0].transports ?? [], []);
  const finish = await worker.fetch(req('/hub/api/login/verify', {
    method: 'POST', body: { challengeId: options.challengeId, response: await auth.authenticationResponse(options.options, 1) }, ip: '192.0.2.82',
  }), env);
  assert.equal(finish.status, 200);
  sqlite.prepare("UPDATE credentials SET transports_json = '{\"a\":1}'").run();
  assert.equal((await worker.fetch(req('/hub/api/login/options', { method: 'POST', body: { username }, ip: '192.0.2.83' }), env)).status, 200);
});

function seedExpired() {
  const now = Date.now();
  sqlite.prepare("INSERT INTO challenges (id, user_id, operation, username, challenge, expires_at) VALUES ('old-c', 'u', 'login', 'x', 'c', ?)").run(now - 1000);
  sqlite.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) SELECT 'old-s', id, ?, ? FROM users LIMIT 1").run(now - 5000, now - 1000);
  sqlite.prepare("INSERT INTO rate_limits (key_hash, window_started_at, count) VALUES ('old-r', ?, 1)").run(now - 10 * 60 * 1000);
}
const count = (table, key) => sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${key} LIKE 'old-%'`).get().n;

test('login/options prunes expired challenges, sessions and rate limits', async () => {
  seedExpired();
  assert.deepEqual([count('challenges', 'id'), count('sessions', 'token_hash'), count('rate_limits', 'key_hash')], [1, 1, 1]);
  const response = await worker.fetch(req('/hub/api/login/options', { method: 'POST', body: { username }, ip: '192.0.2.84' }), env);
  assert.equal(response.status, 200);
  assert.deepEqual([count('challenges', 'id'), count('sessions', 'token_hash'), count('rate_limits', 'key_hash')], [0, 0, 0]);
});

test('register/options prunes too, but asset requests do not touch expired rows', async () => {
  seedExpired();
  const asset = await worker.fetch(req('/hub/index.html', { cookie: sessionCookie }), env);
  assert.equal(asset.status, 200);
  await worker.fetch(req('/hub/style.css'), env);
  await worker.fetch(req('/hub/api/session', { cookie: sessionCookie }), env);
  assert.deepEqual([count('challenges', 'id'), count('sessions', 'token_hash'), count('rate_limits', 'key_hash')], [1, 1, 1]);
  const response = await worker.fetch(req('/hub/api/register/options', { method: 'POST', body: { username: 'prune.check' }, ip: '192.0.2.85' }), env);
  assert.equal(response.status, 200);
  assert.deepEqual([count('challenges', 'id'), count('sessions', 'token_hash'), count('rate_limits', 'key_hash')], [0, 0, 0]);
});

test('a pruning failure does not block login/options', async () => {
  const tagged = (query) => {
    const inner = db.prepare(query);
    return { ...inner, query, bind(...args) { return { ...inner.bind(...args), query }; } };
  };
  const flaky = { ...env, HUB_DB: {
    prepare: tagged,
    batch(items) {
      if (items.some((item) => item.query.startsWith('DELETE'))) throw new Error('prune failed');
      return db.batch(items);
    },
  } };
  const response = await worker.fetch(req('/hub/api/login/options', { method: 'POST', body: { username }, ip: '192.0.2.86' }), flaky);
  assert.equal(response.status, 200);
});
