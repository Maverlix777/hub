import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../src/worker.js';
import { validPushEndpoint } from '../src/push.js';

const origin = 'https://hub.test';
// Synthetic fixtures only, never used for delivery.
const p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
const auth = Buffer.alloc(16, 2).toString('base64url');
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic', keys: { p256dh, auth } };

async function fixture(t, layout = 'flat') {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8'));
  if (layout === 'flat') db.exec(readFileSync(new URL('../migrations/0004_push_subscriptions.sql', import.meta.url), 'utf8'));
  else db.exec('CREATE TABLE push_subscriptions (endpoint_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), subscription_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  const queries = [];
  const statement = (sql, values = []) => ({
    bind(...args) { return statement(sql, args); },
    first() { return db.prepare(sql).get(...values) || null; },
    all() { return { results: db.prepare(sql).all(...values) }; },
    run() { return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; },
  });
  const env = { HUB_DB: { prepare(sql) { queries.push(sql); return statement(sql); } }, ASSETS: { fetch: async request => new Response(new URL(request.url).pathname) },
    RP_ID: 'hub.test', CANONICAL_ORIGIN: origin, BOARD_OWNER_USERNAME: 'owner,other',
    VAPID_PUBLIC_KEY: p256dh, PUSH_DELIVERY_TOKEN: 'synthetic-delivery-token-minimum-32-characters' };
  const cookies = {};
  for (const name of ['owner', 'other', 'guest']) {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
    db.prepare('INSERT INTO users VALUES (?, ?, 1)').run(name, name);
    db.prepare('INSERT INTO entitlements(user_id,tier,created_at) VALUES (?, ?, 1)').run(name, 'free');
    db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?, ?, 1, ?)').run(hash, name, Date.now() + 100000);
    cookies[name] = `__Host-hub_session=${token}`;
  }
  const call = (path, { user, bearer, method = 'GET', body, headers = {} } = {}) => worker.fetch(new Request(`${origin}/hub/api/push/${path}`, {
    method, headers: { ...(user ? { cookie: cookies[user] } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body !== undefined ? { origin, 'content-type': 'application/json', 'X-Hub-Request': '1' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  }), env);
  return { db, env, call, queries };
}

test('push endpoint accepts only canonical HTTPS push providers', () => {
  for (const endpoint of ['https://fcm.googleapis.com/a', 'https://updates.push.services.mozilla.com/wpush/a', 'https://web.push.apple.com/a', 'https://region.push.apple.com/a']) assert.equal(validPushEndpoint(endpoint), true);
  for (const endpoint of ['http://fcm.googleapis.com/a', 'https://localhost/a', 'https://fcm.googleapis.com.evil.test/a', 'https://user@fcm.googleapis.com/a',
    'https://fcm.googleapis.com:8443/a', 'https://web.push.apple.com/a#fragment', 'https://127.0.0.1/a', 'https://fcm.googleapis.com/',
    'https://push.apple.com/a', 'https://evilpush.apple.com/a', 'https://web.push.apple.com.evil.test/a']) assert.equal(validPushEndpoint(endpoint), false, endpoint);
});

test('Worker push config requires owner session and explicit configuration', async t => {
  const { call, env } = await fixture(t);
  assert.equal((await call('config')).status, 401);
  assert.equal((await call('config', { user: 'guest' })).status, 403);
  const response = await call('config', { user: 'owner' });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { publicKey: p256dh });
  delete env.VAPID_PUBLIC_KEY;
  assert.equal((await call('config', { user: 'owner' })).status, 503);
});

test('Worker persists subscriptions idempotently and restricts delivery credentials', async t => {
  const { call, env, db } = await fixture(t);
  assert.equal((await call('subscriptions', { user: 'owner', method: 'POST', body: subscription })).status, 201);
  assert.equal((await call('subscriptions', { user: 'owner', method: 'POST', body: subscription })).status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 1);
  assert.equal((await call('subscriptions', { user: 'other', method: 'POST', body: subscription })).status, 409);
  assert.equal((await call('delivery', { user: 'owner' })).status, 401);
  assert.equal((await call('delivery', { bearer: 'wrong' })).status, 401);
  const result = await call('delivery', { bearer: env.PUSH_DELIVERY_TOKEN });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { subscriptions: [subscription] });
  assert.equal((await call('subscriptions', { user: 'other', method: 'DELETE', body: { endpoint: subscription.endpoint } })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 1);
  assert.equal((await call('delivery', { bearer: env.PUSH_DELIVERY_TOKEN, method: 'DELETE', body: { endpoint: subscription.endpoint }, headers: { origin: 'https://actions.test' } })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
  delete env.PUSH_DELIVERY_TOKEN;
  assert.equal((await call('delivery', { bearer: 'synthetic-delivery-token-minimum-32-characters' })).status, 401);
});

test('Worker rejects cross-origin, non-owner, invalid keys and oversized push mutations', async t => {
  const { call, db } = await fixture(t);
  assert.equal((await call('subscriptions', { method: 'POST', body: subscription })).status, 401);
  assert.equal((await call('subscriptions', { user: 'guest', method: 'POST', body: subscription })).status, 403);
  for (const method of ['POST', 'DELETE']) {
    for (const headers of [{ origin: 'https://evil.test' }, { 'X-Hub-Request': '0' }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await call('subscriptions', { user: 'owner', method, body: subscription, headers })).status, 403);
    }
  }
  for (const body of [null, [], '{broken', 'x'.repeat(5000), { ...subscription, endpoint: 'https://localhost/a' },
    { ...subscription, keys: { p256dh: 'bad', auth } }, { ...subscription, keys: { p256dh, auth: 'bad' } }]) {
    assert.equal((await call('subscriptions', { user: 'owner', method: 'POST', body })).status, 400);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
});

test('Worker caps per-owner subscriptions and permits updates and unsubscribe at the cap', async t => {
  const { call, db } = await fixture(t);
  const items = Array.from({ length: 11 }, (_, index) => ({ ...subscription, endpoint: `${subscription.endpoint}${index}` }));
  for (const body of items.slice(0, 10)) assert.equal((await call('subscriptions', { user: 'owner', method: 'POST', body })).status, 201);
  assert.equal((await call('subscriptions', { user: 'owner', method: 'POST', body: items[10] })).status, 409);
  assert.equal((await call('subscriptions', { user: 'owner', method: 'POST', body: items[0] })).status, 201);
  assert.equal((await call('subscriptions', { user: 'owner', method: 'DELETE', body: items[0] })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 9);
});

test('delivery excludes revoked owners and applies current stable author identities', async t => {
  const { call, env } = await fixture(t);
  const otherSubscription = { ...subscription, endpoint: `${subscription.endpoint}-other` };
  assert.equal((await call('subscriptions', { user: 'owner', method: 'POST', body: subscription })).status, 201);
  assert.equal((await call('subscriptions', { user: 'other', method: 'POST', body: otherSubscription })).status, 201);
  env.BOARD_OWNER_USERNAME = '';
  const delivery = async () => (await call('delivery', { bearer: env.PUSH_DELIVERY_TOKEN })).json();
  assert.deepEqual(await delivery(), { subscriptions: [] });
  env.BOARD_AUTHORS_JSON = JSON.stringify([{ hubUserId: 'owner', hubUsername: 'owner', githubLogin: 'trusted-owner' }]);
  assert.deepEqual(await delivery(), { subscriptions: [subscription] });
  // A username alone cannot re-authorize a different stable ID, nor vice versa.
  env.BOARD_AUTHORS_JSON = JSON.stringify([{ hubUserId: 'other', hubUsername: 'owner', githubLogin: 'trusted-owner' }]);
  assert.deepEqual(await delivery(), { subscriptions: [] });
  env.BOARD_AUTHORS_JSON = 'malformed';
  assert.deepEqual(await delivery(), { subscriptions: [] });
});

test('Worker serves push SW for browser update even after session expiration', async () => {
  const response = await worker.fetch(new Request(`${origin}/hub/push-sw.js`), { HUB_DB: {}, RP_ID: 'hub.test', CANONICAL_ORIGIN: origin,
    ASSETS: { fetch: async request => new Response(new URL(request.url).pathname, { headers: { 'content-type': 'text/javascript' } }) } });
  assert.equal(response.status, 200); assert.equal(await response.text(), '/push-sw.js');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});


test('legacy exact production schema exports only current owner valid bounded envelopes', async t => {
  const { db, env, call } = await fixture(t, 'legacy');
  const put = db.prepare('INSERT INTO push_subscriptions VALUES (?, ?, ?, 7, 8)');
  put.run('unknown-hash', 'owner', JSON.stringify(subscription));
  put.run('guest-hash', 'guest', JSON.stringify({ ...subscription, endpoint: subscription.endpoint + '-guest' }));
  put.run('bad-json', 'owner', '{bad');
  put.run('bad-subscription', 'owner', JSON.stringify({ endpoint: 'https://evil.test/x', keys: subscription.keys }));
  put.run('oversized', 'owner', JSON.stringify({ ...subscription, padding: 'x'.repeat(5000) }));
  const response = await call('delivery', { bearer: env.PUSH_DELIVERY_TOKEN });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { subscriptions: [subscription] });
  env.BOARD_OWNER_USERNAME = '';
  assert.deepEqual(await (await call('delivery', { bearer: env.PUSH_DELIVERY_TOKEN })).json(), { subscriptions: [] });
});

test('legacy upsert preserves unknown hash and created_at and prevents cross-owner takeover', async t => {
  const { db, call } = await fixture(t, 'legacy');
  db.prepare('INSERT INTO push_subscriptions VALUES (?, ?, ?, 7, 8)').run('historical-not-sha256', 'owner', JSON.stringify(subscription));
  const changed = { ...subscription, keys: { ...subscription.keys, auth: Buffer.alloc(16, 4).toString('base64url') } };
  assert.equal((await call('subscriptions', { user: 'owner', method: 'POST', body: changed })).status, 201);
  const row = db.prepare('SELECT * FROM push_subscriptions').get();
  assert.equal(row.endpoint_hash, 'historical-not-sha256');
  assert.equal(row.created_at, 7);
  assert.ok(row.updated_at > 8);
  assert.deepEqual(JSON.parse(row.subscription_json), changed);
  assert.equal((await call('subscriptions', { user: 'other', method: 'POST', body: changed })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 1);
});

test('legacy new records use explicit SHA256 and cap10 updates atomically', async t => {
  const { db, call } = await fixture(t, 'legacy');
  for (let i = 0; i < 10; i++) assert.equal((await call('subscriptions', { user: 'owner', method: 'POST', body: { ...subscription, endpoint: subscription.endpoint + i } })).status, 201);
  assert.equal((await call('subscriptions', { user: 'owner', method: 'POST', body: { ...subscription, endpoint: subscription.endpoint + 'extra' } })).status, 409);
  assert.equal((await call('subscriptions', { user: 'owner', method: 'POST', body: { ...subscription, endpoint: subscription.endpoint + '0' } })).status, 201);
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint + '0'))).toString('hex');
  const row = db.prepare('SELECT endpoint_hash,created_at,updated_at FROM push_subscriptions WHERE endpoint_hash = ?').get(expected);
  assert.ok(row); assert.ok(row.created_at > 0); assert.ok(row.updated_at >= row.created_at);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 10);
});

test('legacy deletion uses envelope endpoint and owner scope; delivery bearer can expire any owner', async t => {
  const { db, env, call } = await fixture(t, 'legacy');
  db.prepare('INSERT INTO push_subscriptions VALUES (?, ?, ?, 7, 8)').run('arbitrary-old-hash', 'owner', JSON.stringify(subscription));
  assert.equal((await call('subscriptions', { user: 'other', method: 'DELETE', body: { endpoint: subscription.endpoint } })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 1);
  assert.equal((await call('delivery', { bearer: env.PUSH_DELIVERY_TOKEN, method: 'DELETE', body: { endpoint: subscription.endpoint } })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
});

test('storage discovery happens after unauthorized or invalid request guards', async t => {
  const { call, queries } = await fixture(t, 'legacy');
  assert.equal((await call('delivery', { bearer: 'wrong' })).status, 401);
  assert.equal(queries.length, 0);
  assert.equal((await call('subscriptions', { user: 'owner', method: 'POST', body: { endpoint: 'https://evil.test/x' } })).status, 400);
  assert.ok(!queries.some(sql => sql.includes('table_info')));
});

test('missing and unknown subscription schemas fail closed with sanitized503', async t => {
  const { db, call, env } = await fixture(t);
  db.exec('DROP TABLE push_subscriptions');
  for (const create of ['', 'CREATE TABLE push_subscriptions (mystery TEXT)']) {
    if (create) db.exec(create);
    const response = await call('delivery', { bearer: env.PUSH_DELIVERY_TOKEN });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'push_unavailable' });
  }
});

test('legacy endpoint lookup excludes oversized UTF8 envelopes without rewriting them', async t => {
  const { db, call } = await fixture(t, 'legacy');
  const oversized = JSON.stringify({ ...subscription, padding: 'é'.repeat(2200) });
  assert.ok(oversized.length < 4096 && Buffer.byteLength(oversized) > 4096);
  db.prepare('INSERT INTO push_subscriptions VALUES (?, ?, ?, 7, 8)').run('held-oversized', 'owner', oversized);
  assert.equal((await call('subscriptions', { user: 'owner', method: 'POST', body: subscription })).status, 201);
  assert.equal(db.prepare('SELECT subscription_json FROM push_subscriptions WHERE endpoint_hash = ?').get('held-oversized').subscription_json, oversized);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 2);
});

test('legacy simultaneous final-slot subscriptions cannot bypass cap10', async t => {
  const { db, call } = await fixture(t, 'legacy');
  for (let i = 0; i < 9; i++) db.prepare('INSERT INTO push_subscriptions VALUES (?, ?, ?, 7, 8)').run('old' + i, 'owner', JSON.stringify({ ...subscription, endpoint: subscription.endpoint + i }));
  const results = await Promise.all(['a', 'b'].map(suffix => call('subscriptions', { user: 'owner', method: 'POST', body: { ...subscription, endpoint: subscription.endpoint + suffix } })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 10);
});

test('legacy new hash collision never overwrites an unrelated historical row', async t => {
  const { db, call } = await fixture(t, 'legacy');
  const key = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint))).toString('hex');
  const held = JSON.stringify({ ...subscription, endpoint: subscription.endpoint + '-different' });
  db.prepare('INSERT INTO push_subscriptions VALUES (?, ?, ?, 7, 8)').run(key, 'owner', held);
  assert.equal((await call('subscriptions', { user: 'owner', method: 'POST', body: subscription })).status, 409);
  assert.equal(db.prepare('SELECT subscription_json FROM push_subscriptions').get().subscription_json, held);
});

test('legacy duplicate endpoint exports newest valid authorized record without rewriting history', async t => {
  const { db, env, call } = await fixture(t, 'legacy');
  const newer = { ...subscription, keys: { ...subscription.keys, auth: Buffer.alloc(16, 4).toString('base64url') } };
  const put = db.prepare('INSERT INTO push_subscriptions VALUES (?, ?, ?, 7, ?)');
  put.run('old-valid', 'owner', JSON.stringify(subscription), 8);
  put.run('new-valid', 'owner', JSON.stringify(newer), 10);
  put.run('invalid-newest', 'owner', JSON.stringify({ ...subscription, keys: { p256dh, auth: 'invalid' } }), 20);
  put.run('unauthorized-newest', 'guest', JSON.stringify(subscription), 30);
  const before = db.prepare('SELECT * FROM push_subscriptions ORDER BY endpoint_hash').all();
  const response = await call('delivery', { bearer: env.PUSH_DELIVERY_TOKEN });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { subscriptions: [newer] });
  assert.deepEqual(db.prepare('SELECT * FROM push_subscriptions ORDER BY endpoint_hash').all(), before);
});

test('legacy equal timestamp duplicate endpoints use deterministic historical key order', async t => {
  const { db, env, call } = await fixture(t, 'legacy');
  const preferred = { ...subscription, keys: { ...subscription.keys, auth: Buffer.alloc(16, 5).toString('base64url') } };
  const put = db.prepare('INSERT INTO push_subscriptions VALUES (?, ?, ?, 7, 10)');
  put.run('z-key', 'owner', JSON.stringify(subscription));
  put.run('a-key', 'owner', JSON.stringify(preferred));
  const response = await call('delivery', { bearer: env.PUSH_DELIVERY_TOKEN });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { subscriptions: [preferred] });
});
