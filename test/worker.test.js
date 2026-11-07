import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/worker.js';

const origin = 'https://hub.test';
const cookie = `__Host-hub_session=${'a'.repeat(43)}`;
const serviceToken = 'synthetic-service-token-at-least-32-characters';

function fixture({ session = undefined } = {}) {
  const calls = { db: 0, vapid: 0, assets: 0 };
  const env = {
    CANONICAL_ORIGIN: origin,
    RP_ID: 'hub.test',
    PUSH_DELIVERY_TOKEN: serviceToken,
    HUB_DB: { prepare() {
      calls.db++;
      if (session === undefined) throw new Error('synthetic storage unavailable');
      return { bind() { return { first() { return session; } }; } };
    } },
    ASSETS: { fetch() { calls.assets++; throw new Error('unexpected asset read'); } },
  };
  for (const name of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) {
    Object.defineProperty(env, name, { get() { calls.vapid++; throw new Error('unexpected VAPID read'); } });
  }
  const call = (path, { method = 'GET', bearer, headers = {} } = {}) => worker.fetch(new Request(origin + path, {
    method,
    headers: { cookie, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
  }), env);
  return { call, calls };
}

for (const bearer of [undefined, 'synthetic-wrong-token']) {
  for (const [path, method] of [
    ['/hub/api/push/delivery', 'GET'],
    ['/hub/api/push/delivery/vapid', 'POST'],
  ]) {
    test(`token service ${path} rejects ${bearer ? 'wrong' : 'missing'} bearer before cookie DB/VAPID`, async () => {
      const { call, calls } = fixture();
      // Server-to-server POST intentionally has no browser Origin header.
      const response = await call(path, { method, bearer });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
      assert.deepEqual(calls, { db: 0, vapid: 0, assets: 0 });
      assert.equal(response.headers.has('set-cookie'), false);
    });
  }
}

test('nonservice and trailing-lookalike POSTs retain browser Origin guard', async () => {
  for (const path of ['/hub/api/session', '/hub/api/push/delivery/', '/hub/api/push/delivery/vapid/', '/hub/api/push/delivery/vapid-extra']) {
    const { call, calls } = fixture();
    const response = await call(path, { method: 'POST', bearer: serviceToken });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'forbidden_origin' });
    assert.deepEqual(calls, { db: 0, vapid: 0, assets: 0 });
  }
});

test('unknown push GET paths retain session lookup and ordinary404', async () => {
  for (const path of ['/hub/api/push/delivery/', '/hub/api/push/delivery/vapid/', '/hub/api/push/delivery/vapid-extra', '/hub/api/push/delivery/vapid/extra']) {
    const { call, calls } = fixture({ session: null });
    const response = await call(path);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
    assert.deepEqual(calls, { db: 1, vapid: 0, assets: 0 });
  }
});

test('encoded path separator is rejected before token-service exemption', async () => {
  const { call, calls } = fixture();
  const response = await call('/hub/api/push/delivery%2fvapid', { method: 'POST' });
  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'Bad request');
  assert.deepEqual(calls, { db: 0, vapid: 0, assets: 0 });
});

test('ordinary session API still loads and returns its authenticated user', async () => {
  const session = { id: 'synthetic-user', username: 'synthetic', tier: 'free', tokenHash: 'synthetic-hash', expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000 };
  const { call, calls } = fixture({ session });
  const response = await call('/hub/api/session');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.username, 'synthetic');
  assert.equal(body.entitlement, 'free');
  assert.deepEqual(calls, { db: 1, vapid: 0, assets: 0 });
});
