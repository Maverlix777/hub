import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../src/worker.js';
import { expectedOrigins } from '../src/native-app.js';
import { apnsJwt, sendPush } from '../tools/send-push.mjs';

const origin = 'https://hub.test';
const env = { HUB_DB: {}, ASSETS: { fetch: async () => new Response('x') }, RP_ID: 'hub.test', CANONICAL_ORIGIN: origin };

test('apple-app-site-association is public JSON for the app id', async () => {
  const response = await worker.fetch(new Request(`${origin}/.well-known/apple-app-site-association`), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const body = await response.json();
  assert.deepEqual(body.webcredentials.apps, ['S9VUV87V4M.org.kolobovdjp.hub']);
  assert.deepEqual(body.applinks.details[0].appIDs, ['S9VUV87V4M.org.kolobovdjp.hub']);
  assert.equal((await worker.fetch(new Request(`${origin}/.well-known/apple-app-site-association`, { method: 'POST' }), env)).status, 405);
});

test('assetlinks.json is public JSON for the package with a marked placeholder fingerprint', async () => {
  const response = await worker.fetch(new Request(`${origin}/.well-known/assetlinks.json`), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const [link] = await response.json();
  assert.equal(link.target.package_name, 'org.kolobovdjp.hub');
  assert.match(link.target.sha256_cert_fingerprints[0], /^TODO/);
});

test('native passkey origins: canonical, legacy, valid android hash only', () => {
  const hash = 'A'.repeat(43);
  assert.deepEqual(expectedOrigins({}, origin), [origin, 'https://kolobovdjp.org']);
  assert.ok(expectedOrigins({ NATIVE_ANDROID_ORIGINS: `android:apk-key-hash:${hash}, bad` }, origin).includes(`android:apk-key-hash:${hash}`));
  assert.equal(expectedOrigins({ NATIVE_ANDROID_ORIGINS: 'bad' }, origin).length, 2);
});

test('0005 migration keeps old rows as webpush', () => {
  const db = new DatabaseSync(':memory:');
  for (const name of ['0001_auth.sql', '0004_push_subscriptions.sql']) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  db.exec("INSERT INTO users VALUES ('u','u',1); INSERT INTO push_subscriptions VALUES ('https://fcm.googleapis.com/a','u','p','a',1)");
  db.exec(readFileSync(new URL('../migrations/0005_push_native.sql', import.meta.url), 'utf8'));
  assert.equal(db.prepare('SELECT type FROM push_subscriptions').get().type, 'webpush');
});

const sendEnv = { HUB_PUSH_URL: 'https://hub.kolobovdjp.org/hub/api/push/delivery', PUSH_DELIVERY_TOKEN: 'synthetic-token',
  VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b', VAPID_SUBJECT: 'mailto:t@example.com' };
const token = 'ab'.repeat(32);
const list = () => new Response(JSON.stringify({ subscriptions: [{ type: 'apns', token }] }));

test('sender skips apns subscriptions with a log when APNs secrets are absent', async () => {
  const logs = [];
  const result = await sendPush({ env: sendEnv, log: (s) => logs.push(s), fetchImpl: async () => list(), sendNotification: () => assert.fail('webpush called') });
  assert.equal(result.sent, 0); assert.equal(result.failed, 0);
  assert.match(logs[0], /APNs skipped/);
});

test('sender sends apns via injected transport and drops dead tokens', async () => {
  const calls = [];
  const sent = await sendPush({ env: sendEnv, log: () => {}, fetchImpl: async () => list(), sendNotification: () => {},
    sendApns: async (t, payload) => { calls.push([t, JSON.parse(payload)]); return { status: 200 }; } });
  assert.equal(sent.sent, 1);
  assert.equal(calls[0][0], token); assert.equal(calls[0][1].aps.alert.title, 'От агентов');
  const deletes = [];
  const gone = await sendPush({ env: sendEnv, log: () => {}, sendNotification: () => {}, sendApns: async () => ({ status: 410 }),
    fetchImpl: async (url, options) => { if (options.method === 'DELETE') { deletes.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); } return list(); } });
  assert.equal(gone.expired, 1); assert.deepEqual(deletes, [{ type: 'apns', token }]);
});

test('apns JWT is ES256 with team and key id', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwt = apnsJwt({ key: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'KID1234567', teamId: 'S9VUV87V4M', now: 1000000 });
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KID1234567' });
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), { iss: 'S9VUV87V4M', iat: 1000 });
  assert.equal(Buffer.from(sig, 'base64url').length, 64);
});
