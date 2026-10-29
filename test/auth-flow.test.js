import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import worker from '../src/worker.js';
import { createVirtualAuthenticator } from './helpers/virtual-authenticator.js';

const origin = 'https://kolobovdjp.org';
const gatewayOrigin = 'https://kolobovdjp-hub.workers.dev';
const gatewaySecret = 'test-gateway-secret-with-at-least-32-bytes';
const rpID = 'kolobovdjp.org';
const sql = await readFile(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');
const indexHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const loginHtml = await readFile(new URL('../public/login.html', import.meta.url), 'utf8');
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
  ASSETS: { async fetch(request) {
    assetCalls += 1;
    lastAssetRequest = request;
    const url = new URL(request.url);
    return new Response(`asset:${url.pathname}${url.search}`);
  } },
  CANONICAL_ORIGIN: origin,
  HUB_GATEWAY_ORIGIN: gatewayOrigin,
  HUB_GATEWAY_SECRET: gatewaySecret,
  RP_ID: rpID,
  RP_NAME: 'Hub Test',
  RATE_LIMIT_HMAC_KEY: 'test-only-secret-not-logged-test-only',
};

function req(path, { method = 'GET', body, cookie, headers = {}, base = origin, ip = '192.0.2.44' } = {}) {
  const values = new Headers(headers);
  values.set('CF-Connecting-IP', ip);
  if (body !== undefined) values.set('content-type', 'application/json');
  if (cookie) values.set('cookie', cookie);
  if (method === 'POST' && !Object.hasOwn(headers, 'origin')) values.set('origin', origin);
  return new Request(`${base}${path}`, { method, headers: values, body: body === undefined ? undefined : JSON.stringify(body) });
}

function gatewayReq(path, { method = 'GET', body, cookie, headers = {}, token = gatewaySecret, clientIP = '198.51.100.44' } = {}) {
  const values = new Headers(headers);
  values.set('CF-Connecting-IP', '192.0.2.44');
  if (token !== null) values.set('X-Hub-Gateway-Token', token);
  values.set('X-Hub-Client-IP', clientIP);
  if (body !== undefined) values.set('content-type', 'application/json');
  if (cookie) values.set('cookie', cookie);
  if (method === 'POST' && !values.has('origin')) values.set('origin', origin);
  return new Request(`${gatewayOrigin}${path}`, { method, headers: values, body: body === undefined ? undefined : JSON.stringify(body) });
}

function countingBindings(source = env) {
  const calls = { db: 0, assets: 0 };
  const countedDb = {
    prepare(...args) { calls.db += 1; return source.HUB_DB.prepare(...args); },
    batch(...args) { calls.db += 1; return source.HUB_DB.batch(...args); },
  };
  const countedAssets = {
    async fetch(...args) { calls.assets += 1; return source.ASSETS.fetch(...args); },
  };
  return { env: { ...source, HUB_DB: countedDb, ASSETS: countedAssets }, calls };
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
let lastAssetRequest;
let assetCalls = 0;

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
  assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
  assert.match(response.headers.get('set-cookie'), /__Host-hub_session=/);
  assert.match(response.headers.get('set-cookie'), /Path=\//);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM entitlements WHERE tier = \'free\'').get().n, 1);
  const session = await worker.fetch(req('/hub/api/session', { cookie: sessionCookie }), env);
  assert.deepEqual(await jsonResponse(session), { username: 'test.user', entitlement: 'free', apps: ['chat', 'downloads'], locked: ['location-fusion', 'job-forge'] });
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

test('gateway rejects missing, bad, short-secret, and non-allowlisted origins before D1 or Assets', async () => {
  const cases = [
    { request: gatewayReq('/hub/api/login/options', { method: 'POST', body: { username: 'test.user' }, token: null }), bindings: env },
    { request: gatewayReq('/hub/', { token: 'wrong-gateway-token' }), bindings: env },
    { request: gatewayReq('/hub/', { token: gatewaySecret }), bindings: { ...env, HUB_GATEWAY_SECRET: undefined } },
    { request: gatewayReq('/hub/', { token: gatewaySecret }), bindings: { ...env, HUB_GATEWAY_SECRET: 'too-short' } },
    { request: gatewayReq('/hub/', { token: gatewaySecret }), bindings: { ...env, HUB_GATEWAY_ORIGIN: 'http://kolobovdjp-hub.workers.dev' } },
    { request: req('/hub/', { base: 'https://not-the-gateway.workers.dev', headers: { 'X-Hub-Gateway-Token': gatewaySecret, 'X-Hub-Client-IP': '198.51.100.44' } }), bindings: env },
  ];
  for (const item of cases) {
    const counted = countingBindings(item.bindings);
    const response = await worker.fetch(item.request, counted.env);
    assert.equal(response.status, 404);
    assert.deepEqual(counted.calls, { db: 0, assets: 0 });
  }

  const missingRequest = gatewayReq('/hub/api/login/options', { method: 'POST', body: { username: 'test.user' }, token: null });
  const counted = countingBindings();
  assert.equal((await worker.fetch(missingRequest, counted.env)).status, 404);
  assert.equal(missingRequest.bodyUsed, false);
  assert.deepEqual(counted.calls, { db: 0, assets: 0 });

  const noClientIP = countingBindings();
  const noIPRequest = gatewayReq('/hub/', { clientIP: '' });
  assert.equal((await worker.fetch(noIPRequest, noClientIP.env)).status, 503);
  assert.deepEqual(noClientIP.calls, { db: 0, assets: 0 });
});

test('gateway preserves canonical Origin, Cookie, query, and signed login while stripping transport headers', async () => {
  const beforeAssets = assetCalls;
  const loginPage = await worker.fetch(gatewayReq('/hub/login/?source=site'), env);
  assert.equal(loginPage.status, 200);
  assert.equal(await loginPage.text(), 'asset:/login.html?source=site');
  assert.equal(new URL(lastAssetRequest.url).origin, origin);
  assert.equal(lastAssetRequest.headers.has('X-Hub-Gateway-Token'), false);
  assert.equal(lastAssetRequest.headers.has('X-Hub-Client-IP'), false);

  const session = await worker.fetch(gatewayReq('/hub/api/session', { cookie: sessionCookie }), env);
  assert.deepEqual(await jsonResponse(session), { username: 'test.user', entitlement: 'free', apps: ['chat', 'downloads'], locked: ['location-fusion', 'job-forge'] });

  const start = await worker.fetch(gatewayReq('/hub/api/login/options', {
    method: 'POST', body: { username: 'test.user' }, clientIP: '198.51.100.61',
  }), env);
  assert.equal(start.status, 200);
  loginOptions = await jsonResponse(start);
  const assertion = await auth.authenticationResponse(loginOptions.options, 3);
  const finish = await worker.fetch(gatewayReq('/hub/api/login/verify', {
    method: 'POST', body: { challengeId: loginOptions.challengeId, response: assertion }, clientIP: '198.51.100.61',
  }), env);
  assert.equal(finish.status, 200);
  const gatewayCookie = cookieFrom(finish);
  assert.match(finish.headers.get('set-cookie'), /__Host-hub_session=/);
  assert.equal(finish.headers.has('X-Hub-Gateway-Token'), false);
  assert.equal(finish.headers.has('X-Hub-Client-IP'), false);

  const app = await worker.fetch(gatewayReq('/hub/?view=home', { cookie: gatewayCookie }), env);
  assert.equal(app.status, 200);
  assert.equal(await app.text(), 'asset:/index.html?view=home');
  assert.equal(new URL(lastAssetRequest.url).origin, origin);
  assert.equal(assetCalls, beforeAssets + 2);
  assert.equal(lastAssetRequest.headers.has('X-Hub-Gateway-Token'), false);
  assert.equal(lastAssetRequest.headers.has('X-Hub-Client-IP'), false);
});

test('gateway Origin failures reject before database access', async () => {
  const counted = countingBindings();
  const badOrigin = gatewayReq('/hub/api/login/options', {
    method: 'POST', body: { username: 'test.user' }, headers: { origin: 'https://attacker.example' },
  });
  const response = await worker.fetch(badOrigin, counted.env);
  assert.equal(response.status, 403);
  assert.deepEqual(counted.calls, { db: 0, assets: 0 });
});

test('only validated gateway traffic uses forwarded client IP; canonical requests ignore spoofed forwarding headers', async () => {
  sqlite.exec('DELETE FROM rate_limits');
  await worker.fetch(req('/hub/api/login/options', {
    method: 'POST', body: { username: 'test.user' }, ip: '192.0.2.60',
    headers: { 'X-Hub-Client-IP': '203.0.113.9', 'X-Hub-Gateway-Token': gatewaySecret },
  }), env);
  await worker.fetch(req('/hub/api/login/options', {
    method: 'POST', body: { username: 'test.user' }, ip: '192.0.2.61',
    headers: { 'X-Hub-Client-IP': '203.0.113.9', 'X-Hub-Gateway-Token': gatewaySecret },
  }), env);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM rate_limits').get().n, 4);

  sqlite.exec('DELETE FROM rate_limits');
  await worker.fetch(gatewayReq('/hub/api/login/options', {
    method: 'POST', body: { username: 'test.user' }, clientIP: '198.51.100.71',
  }), env);
  await worker.fetch(gatewayReq('/hub/api/login/options', {
    method: 'POST', body: { username: 'test.user' }, clientIP: '198.51.100.72',
  }), env);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM rate_limits').get().n, 4);
});

test('public auth UI, aliases, protected assets, and logout have expected routing', async () => {
  const loginPage = await worker.fetch(req('/hub/login/'), env);
  assert.equal(loginPage.status, 200);
  assert.equal(loginPage.headers.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(await loginPage.text(), 'asset:/login.html');
  assert.equal(lastAssetRequest.headers.has('X-Hub-Gateway-Token'), false);
  assert.equal(lastAssetRequest.headers.has('X-Hub-Client-IP'), false);
  assert.match(indexHtml, /connect-src 'self' https:\/\/api\.anthropic\.com/);
  assert.match(loginHtml, /<a href="https:\/\/kolobovdjp\.org\/privacy\/">Конфиденциальность<\/a>/);
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
