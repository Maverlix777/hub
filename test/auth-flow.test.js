import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import worker from '../src/worker.js';
import { createVirtualAuthenticator } from './helpers/virtual-authenticator.js';

const origin = 'https://kolobovdjp.org';
const rpID = 'kolobovdjp.org';
const sql = await readFile(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');
const indexHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec(sql);

function statement(query, values = []) {
  return {
    bind(...args) { return statement(query, args); },
    first() { return sqlite.prepare(query).get(...values) || null; },
    all() { return { results: sqlite.prepare(query).all(...values) }; },
    run() {
      const result = sqlite.prepare(query).run(...values);
      return { meta: { changes: Number(result.changes) } };
    },
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
  ASSETS: { async fetch(request) { return new Response(`asset:${new URL(request.url).pathname}`); } },
  CANONICAL_ORIGIN: origin,
  RP_ID: rpID,
  RP_NAME: 'Hub Test',
  RATE_LIMIT_HMAC_KEY: 'test-only-secret-not-logged-test-only',
};

function req(path, { method = 'GET', body, cookie, headers = {}, base = origin } = {}) {
  const values = new Headers(headers);
  values.set('CF-Connecting-IP', '192.0.2.44');
  if (body !== undefined) values.set('content-type', 'application/json');
  if (cookie) values.set('cookie', cookie);
  if (method === 'POST' && !Object.hasOwn(headers, 'origin')) values.set('origin', origin);
  return new Request(`${base}${path}`, { method, headers: values, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function jsonResponse(response) { return response.json(); }
function cookieFrom(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(value, 'expected Set-Cookie');
  return value.split(';', 1)[0];
}

let registerOptions;
let registerResponse;
let auth;
let sessionCookie;
let loginOptions;

before(async () => {
  const response = await worker.fetch(req('/hub/api/register/options', { method: 'POST', body: { username: 'test.user' } }), env);
  assert.equal(response.status, 200);
  registerOptions = await jsonResponse(response);
  auth = createVirtualAuthenticator(rpID, origin);
  registerResponse = await auth.registrationResponse(registerOptions.options);
});

after(() => sqlite.close());

test('registration verifies a real WebAuthn response and starts a free session', async () => {
  const response = await worker.fetch(req('/hub/api/register/verify', {
    method: 'POST', body: { challengeId: registerOptions.challengeId, response: registerResponse },
  }), env);
  assert.equal(response.status, 200);
  sessionCookie = cookieFrom(response);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /Secure/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
  assert.match(response.headers.get('set-cookie'), /__Host-hub_session=/);
  assert.match(response.headers.get('set-cookie'), /Path=\//);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM entitlements WHERE tier = \'free\'').get().n, 1);
  const session = await worker.fetch(req('/hub/api/session', { cookie: sessionCookie }), env);
  assert.deepEqual(await jsonResponse(session), { username: 'test.user', entitlement: 'free' });
});

test('a registered user can log in with a cryptographically signed assertion', async () => {
  const start = await worker.fetch(req('/hub/api/login/options', { method: 'POST', body: { username: 'test.user' } }), env);
  assert.equal(start.status, 200);
  loginOptions = await jsonResponse(start);
  const assertion = await auth.authenticationResponse(loginOptions.options, 1);
  const finish = await worker.fetch(req('/hub/api/login/verify', {
    method: 'POST', body: { challengeId: loginOptions.challengeId, response: assertion },
  }), env);
  assert.equal(finish.status, 200);
  const loggedInCookie = cookieFrom(finish);
  const protectedPage = await worker.fetch(req('/hub/', { cookie: loggedInCookie }), env);
  assert.equal(protectedPage.status, 200);
  assert.equal(await protectedPage.text(), 'asset:/index.html');
});

test('challenge replay and tampered signatures are rejected', async () => {
  const replay = await worker.fetch(req('/hub/api/register/verify', {
    method: 'POST', body: { challengeId: registerOptions.challengeId, response: registerResponse },
  }), env);
  assert.equal(replay.status, 400);

  const start = await worker.fetch(req('/hub/api/login/options', { method: 'POST', body: { username: 'test.user' } }), env);
  const options = await jsonResponse(start);
  const assertion = await auth.authenticationResponse(options.options, 2);
  assertion.response.signature = Buffer.from('not a valid assertion signature').toString('base64url');
  const invalid = await worker.fetch(req('/hub/api/login/verify', {
    method: 'POST', body: { challengeId: options.challengeId, response: assertion },
  }), env);
  assert.equal(invalid.status, 401);
  const replayedInvalid = await worker.fetch(req('/hub/api/login/verify', {
    method: 'POST', body: { challengeId: options.challengeId, response: assertion },
  }), env);
  assert.equal(replayedInvalid.status, 401);
});

test('CSRF, unknown origin, traversal, and missing rate-limit secret fail closed', async () => {
  const noOrigin = req('/hub/api/login/options', { method: 'POST', body: { username: 'test.user' }, headers: { origin: 'https://evil.example' } });
  assert.equal((await worker.fetch(noOrigin, env)).status, 403);
  assert.equal((await worker.fetch(req('/hub/', { base: 'https://worker-name.workers.dev' }), env)).status, 404);
  assert.equal((await worker.fetch(req('/hub/%252e%252e/index.html', { cookie: sessionCookie }), env)).status, 400);
  assert.equal((await worker.fetch(req('/hub/%25252e%25252e/index.html', { cookie: sessionCookie }), env)).status, 400);
  assert.equal((await worker.fetch(req('/hub/', { cookie: sessionCookie }), { ...env, RATE_LIMIT_HMAC_KEY: '' })).status, 200);
  const unavailable = await worker.fetch(req('/hub/api/login/options', { method: 'POST', body: { username: 'test.user' } }), { ...env, RATE_LIMIT_HMAC_KEY: '' });
  assert.equal(unavailable.status, 503);
});

test('public auth UI, aliases, protected assets, and logout have expected routing', async () => {
  const loginPage = await worker.fetch(req('/hub/login/'), env);
  assert.equal(loginPage.status, 200);
  assert.equal(loginPage.headers.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(await loginPage.text(), 'asset:/login.html');
  assert.match(indexHtml, /connect-src 'self' https:\/\/api\.anthropic\.com/);
  assert.equal((await worker.fetch(req('/хаб/'), env)).status, 308);
  const headLogin = await worker.fetch(req('/hub/login', { method: 'HEAD' }), env);
  assert.equal(headLogin.status, 308);
  assert.equal(headLogin.headers.get('location'), `${origin}/hub/login/`);
  const aliasApp = await worker.fetch(req('/хаб/apps/chat.html', { cookie: sessionCookie }), env);
  assert.equal(aliasApp.status, 308);
  assert.equal(aliasApp.headers.get('location'), `${origin}/hub/apps/chat.html`);
  assert.equal((await worker.fetch(req('/hub/apps/chat.html'), env)).status, 302);
  const logout = await worker.fetch(req('/hub/api/logout', { method: 'POST', cookie: sessionCookie }), env);
  assert.equal(logout.status, 204);
  const afterLogout = await worker.fetch(req('/hub/api/session', { cookie: sessionCookie }), env);
  assert.equal(afterLogout.status, 401);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});

test('request bodies are bounded and malformed UTF-8 is rejected without throwing', async () => {
  const large = new Request(`${origin}/hub/api/register/options`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.50' },
    body: JSON.stringify({ username: 'x'.repeat(140_000) }),
  });
  assert.equal((await worker.fetch(large, env)).status, 400);
  const malformed = new Request(`${origin}/hub/api/register/options`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.51' },
    body: new Uint8Array([0xff, 0xfe]),
  });
  assert.equal((await worker.fetch(malformed, env)).status, 400);
});
