import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createECDH, createPublicKey, verify, createHash } from 'node:crypto';
import { handlePush } from '../src/push.js';

const path = '/hub/api/push/delivery/vapid';
const token = 'synthetic-delivery-token-at-least-32-characters';
const endpoint = 'https://web.push.apple.com/synthetic-never-sent';
const now = 1794072000123;
function pair(n) {
  const d = Buffer.alloc(32); d[31] = n;
  const e = createECDH('prime256v1'); e.setPrivateKey(d);
  return { VAPID_PUBLIC_KEY: e.getPublicKey(undefined, 'uncompressed').toString('base64url'), VAPID_PRIVATE_KEY: d.toString('base64url') };
}
function call(env = pair(1), { method = 'POST', body = { endpoint }, bearer = token, headers = {} } = {}) {
  return handlePush(new Request('https://hub.test' + path, {
    method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...headers },
    ...(!['GET', 'HEAD'].includes(method) ? { body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
  }), { PUSH_DELIVERY_TOKEN: token, ...env }, path, null, false, 'https://hub.test', now);
}

test('VAPID bearer route signs fixed claims verifiable by independent Node crypto without DB', async () => {
  const env = pair(1);
  Object.defineProperty(env, 'HUB_DB', { enumerable: true, get() { throw Error('DB must not be used'); } });
  // Pass through without spreading the guarded getter.
  const request = new Request('https://hub.test' + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, sub: 'https://evil.test/', aud: 'evil', exp: 1 }) });
  env.PUSH_DELIVERY_TOKEN = token;
  const response = await handlePush(request, env, path, null, false, 'https://hub.test', now);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(), ['authorization', 'expiresAt', 'publicKeySha256']);
  const match = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(result.authorization);
  assert.ok(match); assert.equal(match[2], env.VAPID_PUBLIC_KEY);
  const [header, payload, signature] = match[1].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { aud: 'https://web.push.apple.com', exp: 1794072600, sub: 'https://hub.kolobovdjp.org/' });
  assert.equal(result.expiresAt, 1794072600);
  const point = Buffer.from(env.VAPID_PUBLIC_KEY, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
  assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
  assert.equal(result.publicKeySha256, createHash('sha256').update(point).digest('hex'));
});

test('VAPID route authenticates before reading keys or DB', async () => {
  const env = { PUSH_DELIVERY_TOKEN: token };
  for (const name of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'HUB_DB']) Object.defineProperty(env, name, { get() { throw Error('unauthorized secret/DB access'); } });
  const request = new Request('https://hub.test' + path, { method: 'POST', headers: { authorization: 'Bearer wrong' } });
  const response = await handlePush(request, env, path, null, false, 'https://hub.test', now);
  assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'unauthorized' });
});

test('VAPID route rejects other methods after bearer auth', async () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await call(pair(1), { method })).status, 405);
});

test('VAPID route enforces bounded JSON and exact provider allowlist', async () => {
  for (const body of [null, [], 2, '{bad', 'x'.repeat(4097), { endpoint: 'https://evil.test/a' }, { endpoint: 'https://web.push.apple.com.evil.test/a' }, { endpoint: 'http://web.push.apple.com/a' }, { endpoint: 'https://web.push.apple.com/' }, { endpoint, padding: 'é'.repeat(2100) }, new Uint8Array([255])]) {
    assert.equal((await call(pair(1), { body })).status, 400);
  }
  assert.equal((await call(pair(1), { headers: { 'content-type': 'text/plain' } })).status, 400);
  for (const allowed of ['https://fcm.googleapis.com/a', 'https://updates.push.services.mozilla.com/a']) assert.equal((await call(pair(1), { body: { endpoint: allowed } })).status, 200);
});

test('VAPID mismatched and invalid keys fail closed without sensitive output', async () => {
  const good = pair(1);
  for (const env of [ {}, { ...good, VAPID_PRIVATE_KEY: pair(2).VAPID_PRIVATE_KEY }, { ...good, VAPID_PUBLIC_KEY: 'bad' }, { ...good, VAPID_PRIVATE_KEY: good.VAPID_PRIVATE_KEY + '=' }, { ...good, VAPID_PRIVATE_KEY: Buffer.alloc(32).toString('base64url') }, { ...good, VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url') } ]) {
    const response = await call(env); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'push_not_configured' });
  }
});

test('VAPID route fails closed on invalid server time', async () => {
  for (const time of [NaN, Infinity, -1, 1.5, '1794072000123', Number.MAX_SAFE_INTEGER + 1]) {
    const request = new Request('https://hub.test' + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ endpoint }) });
    const response = await handlePush(request, { ...pair(1), PUSH_DELIVERY_TOKEN: token }, path, null, false, 'https://hub.test', time);
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'push_not_configured' });
  }
});
