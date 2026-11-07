import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createECDH, createHash } from 'node:crypto';
import { sendPush } from '../tools/send-push.mjs';

// Deterministic synthetic scalar1/2 fixtures; never actual credentials.
function pair(scalar) {
  const privateKey = Buffer.alloc(32); privateKey[31] = scalar;
  const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(privateKey);
  return { privateKey: privateKey.toString('base64url'), publicKey: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url') };
}
const firstPair = pair(1); const secondPair = pair(2);
const publicHash = createHash('sha256').update(Buffer.from(firstPair.publicKey, 'base64url')).digest('hex');
const env = {
  HUB_PUSH_URL: 'https://hub.kolobovdjp.org/hub/api/push/delivery',
  PUSH_DELIVERY_TOKEN: 'synthetic-token', VAPID_PUBLIC_KEY: firstPair.publicKey,
  VAPID_PRIVATE_KEY: firstPair.privateKey, VAPID_SUBJECT: 'mailto:test@example.com',
};
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic', keys: { p256dh: 'synthetic', auth: 'synthetic' } };
const list = (subscriptions = [subscription]) => new Response(JSON.stringify({ subscriptions }));

test('sender skips missing configuration without any network request', async () => {
  let calls = 0;
  const logs = [];
  const result = await sendPush({ env: {}, fetchImpl: () => { calls++; }, log: (s) => logs.push(s) });
  assert.equal(result.skipped, true);
  assert.equal(calls, 0);
  assert.match(logs[0], /configuration is incomplete/);
});

test('sender delivers generic payload with VAPID and bounded requests', async () => {
  let sent = 0; const logs = [];
  const result = await sendPush({ env, log: value => logs.push(value), fetchImpl: async (url, options) => {
    assert.equal(url, env.HUB_PUSH_URL);
    assert.equal(options.headers.authorization, `Bearer ${env.PUSH_DELIVERY_TOKEN}`);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return list();
  }, sendNotification: async (sub, payload, options) => {
    assert.deepEqual(sub, subscription);
    assert.equal(JSON.parse(payload).title, 'От агентов');
    assert.equal(JSON.parse(payload).body, 'Есть обновление. Открой хаб.');
    assert.equal(options.vapidDetails.privateKey, env.VAPID_PRIVATE_KEY);
    assert.equal(options.timeout, 15000);
    sent++;
  } });
  assert.equal(sent, 1);
  assert.deepEqual(result, { skipped: false, sent: 1, expired: 0, failed: 0 });
  assert.deepEqual(logs, ['Web Push: sent=1, expired=0, failed=0.']);
});

for (const statusCode of [404, 410]) {
  test(`sender removes expired HTTP ${statusCode} subscription`, async () => {
    const calls = [];
    const result = await sendPush({ env, log: () => {}, fetchImpl: async (url, options) => {
      calls.push(options);
      return options.method === 'DELETE' ? new Response(null, { status: 204 }) : list();
    }, sendNotification: async () => { throw { statusCode }; } });
    assert.equal(result.expired, 1);
    assert.equal(calls[1].method, 'DELETE');
    assert.deepEqual(JSON.parse(calls[1].body), { endpoint: subscription.endpoint });
  });
}

test('sender attempts remaining subscriptions but fails without leaking provider error', async () => {
  const logs = [];
  let sends = 0;
  await assert.rejects(sendPush({ env, log: (s) => logs.push(s), fetchImpl: async () => list([subscription, subscription]),
    sendNotification: async () => { if (++sends === 1) throw new Error('SECRET subscription private endpoint'); },
  }), /Web Push delivery failed/);
  assert.equal(sends, 2);
  assert.deepEqual(logs, ['Web Push provider failure: network or unknown error.', 'Web Push provider classification: provider=google, reason=unknown.', 'Web Push: sent=1, expired=0, failed=1.']);
});

test('sender rejects unsafe delivery URLs before network and unsafe provider endpoints before send', async () => {
  for (const url of ['http://hub.kolobovdjp.org/api/push/delivery', 'https://attacker.test/api/push/delivery',
    'https://hub.kolobovdjp.org/hub/api/push/delivery?token=x', 'https://user@hub.kolobovdjp.org/hub/api/push/delivery',
    'https://hub.kolobovdjp.org/api/push/delivery']) {
    await assert.rejects(sendPush({ env: { ...env, HUB_PUSH_URL: url }, fetchImpl: () => assert.fail('network called') }), /configuration is invalid/);
  }
  for (const endpoint of ['https://localhost/push', 'https://fcm.googleapis.com.attacker.test/push', 'http://fcm.googleapis.com/push']) {
    await assert.rejects(sendPush({ env, fetchImpl: async () => list([{ ...subscription, endpoint }]),
      sendNotification: () => assert.fail('send called') }), /invalid subscriptions/);
  }
});

test('sender sanitizes API failures and malformed responses', async () => {
  await assert.rejects(sendPush({ env, fetchImpl: async () => { throw new Error('SECRET'); } }), /API request failed/);
  await assert.rejects(sendPush({ env, fetchImpl: async () => new Response('SECRET', { status: 403 }) }), /HTTP 403/);
  await assert.rejects(sendPush({ env, fetchImpl: async () => new Response('SECRET') }), /invalid JSON/);
  await assert.rejects(sendPush({ env, fetchImpl: async () => new Response('{}') }), /invalid subscriptions/);
});

test('sender surfaces expired-subscription cleanup failure', async () => {
  await assert.rejects(sendPush({ env, log: () => {}, fetchImpl: async (url, options) =>
    options.method === 'DELETE' ? new Response(null, { status: 500 }) : list(),
  sendNotification: async () => { throw { statusCode: 410 }; } }), /HTTP 500/);
});

test('sender with no subscriptions succeeds without sends', async () => {
  const result = await sendPush({ env, log: () => {}, fetchImpl: async () => list([]), sendNotification: () => assert.fail('send called') });
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);
});

test('workflow targets the real Worker route and checks out the event revision only inside hub', async () => {
  const workflow = await readFile(new URL('../.github/workflows/push-notifications.yml', import.meta.url), 'utf8');
  const target = workflow.match(/^\s+HUB_PUSH_URL:\s+(https:\/\/\S+)\s*$/m)?.[1];
  assert.equal(target, 'https://hub.kolobovdjp.org/hub/api/push/delivery');
  let calls = 0;
  await sendPush({ env: { ...env, HUB_PUSH_URL: target }, log: () => {}, fetchImpl: async () => { calls++; return list([]); } });
  assert.equal(calls, 1);
  assert.match(workflow, /repository: Maverlix777\/hub/);
  assert.ok(workflow.includes("ref: ${{ github.repository == 'Maverlix777/hub' && github.sha || 'main' }}"));
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /github\.repository_owner == 'Maverlix777' && github\.event\.repository\.fork != true/);
});

test('sender reports only numeric provider HTTP status from a secret-bearing rejection', async () => {
  const logs = [];
  const privateMarker = 'PRIVATE_PROVIDER_ERROR_MUST_NOT_APPEAR';
  await assert.rejects(sendPush({ env, log: value => logs.push(value), fetchImpl: async () => list(),
    sendNotification: async () => { throw { statusCode: 403, message: privateMarker, body: privateMarker,
      endpoint: subscription.endpoint, headers: { authorization: privateMarker }, stack: privateMarker }; },
  }), /Web Push delivery failed for one or more subscriptions\./);
  assert.deepEqual(logs, ['Web Push provider failure: HTTP 403.', 'Web Push provider classification: provider=google, reason=unknown.', `Web Push VAPID configured_public_sha256=${publicHash}.`, 'Web Push: sent=0, expired=0, failed=1.']);
  assert.ok(!logs.join('\n').includes(privateMarker));
  assert.ok(!logs.join('\n').includes(subscription.endpoint));
});

test('sender does not coerce malformed provider status into diagnostic output', async () => {
  for (const statusCode of ['403\nPRIVATE_INJECTION', { toString() { throw new Error('PRIVATE_COERCION'); } },
    undefined, NaN, Infinity, 99, 600, 403.5, true]) {
    const logs = [];
    await assert.rejects(sendPush({ env, log: value => logs.push(value), fetchImpl: async () => list(),
      sendNotification: async () => { throw { statusCode, message: 'PRIVATE_MESSAGE', body: 'PRIVATE_BODY' }; },
    }), /Web Push delivery failed for one or more subscriptions\./);
    assert.deepEqual(logs, ['Web Push provider failure: network or unknown error.', 'Web Push provider classification: provider=google, reason=unknown.', 'Web Push: sent=0, expired=0, failed=1.']);
  }
});


test('sender rejects mismatched real P256 pair before API and emits only validated public fingerprints', async () => {
  const logs = []; let calls = 0;
  await assert.rejects(sendPush({ env: { ...env, VAPID_PRIVATE_KEY: secondPair.privateKey }, log: s => logs.push(s),
    fetchImpl: () => { calls++; }, sendNotification: () => { calls++; } }), /VAPID keypair does not match/);
  assert.equal(calls, 0);
  const derived = createHash('sha256').update(Buffer.from(secondPair.publicKey, 'base64url')).digest('hex');
  assert.deepEqual(logs, [`Web Push VAPID mismatch: configured_public_sha256=${publicHash}, derived_public_sha256=${derived}.`]);
  for (const key of [firstPair.publicKey, firstPair.privateKey, secondPair.publicKey, secondPair.privateKey]) assert.ok(!logs.join('').includes(key));
});

test('sender rejects noncanonical invalid points and private scalars before network without fingerprints', async () => {
  for (const invalid of [{ VAPID_PUBLIC_KEY: firstPair.publicKey + '=' }, { VAPID_PUBLIC_KEY: Buffer.alloc(65, 4).toString('base64url') },
    { VAPID_PRIVATE_KEY: Buffer.alloc(32).toString('base64url') }, { VAPID_PRIVATE_KEY: 'bad' }, { VAPID_PUBLIC_KEY: true }, { VAPID_PRIVATE_KEY: false }]) {
    const logs = [];
    await assert.rejects(sendPush({ env: { ...env, ...invalid }, log: s => logs.push(s), fetchImpl: () => assert.fail('network') }), /VAPID keypair is invalid/);
    assert.deepEqual(logs, []);
  }
});

test('sender classifies finite provider reasons without private response content', async () => {
  const cases = [
    ['https://web.push.apple.com/synthetic', JSON.stringify({ reason: 'VapidPkHashMismatch', message: 'PRIVATE_SENTINEL' }), 'apple', 'VapidPkHashMismatch'],
    ['https://updates.push.services.mozilla.com/synthetic', JSON.stringify({ errno: 101, message: 'PRIVATE_SENTINEL' }), 'mozilla', 'missing_crypto_keys'],
    ['https://fcm.googleapis.com/synthetic', JSON.stringify({ reason: 'VapidPkHashMismatch' }), 'google', 'unknown'],
  ];
  for (const [endpoint, body, kind, reason] of cases) {
    const logs = [];
    await assert.rejects(sendPush({ env, log: s => logs.push(s), fetchImpl: async () => list([{ ...subscription, endpoint }]),
      sendNotification: async () => { throw { statusCode: 400, body, message: 'PRIVATE_SENTINEL' }; } }), /Web Push delivery failed/);
    assert.ok(logs.includes(`Web Push provider classification: provider=${kind}, reason=${reason}.`));
    assert.ok(logs.includes(`Web Push VAPID configured_public_sha256=${publicHash}.`));
    assert.ok(!logs.join('').includes('PRIVATE_SENTINEL')); assert.ok(!logs.join('').includes(endpoint));
  }
});

test('sender finite reason classifier rejects malformed oversized native-only and coercion inputs', async () => {
  for (const body of ['{bad', 'x'.repeat(4097), JSON.stringify({ reason: 'BadDeviceToken' }), JSON.stringify({ reason: 'PRIVATE_SENTINEL' }),
    JSON.stringify({ reason: true }), JSON.stringify(['BadTtl']), JSON.stringify({ errno: '101' }), { toString() { throw Error('PRIVATE_SENTINEL'); } }]) {
    const logs = [];
    await assert.rejects(sendPush({ env, log: s => logs.push(s), fetchImpl: async () => list([{ ...subscription, endpoint: 'https://web.push.apple.com/synthetic' }]),
      sendNotification: async () => { throw { statusCode: 500, body }; } }), /Web Push delivery failed/);
    assert.ok(logs.includes('Web Push provider classification: provider=apple, reason=unknown.'));
    assert.ok(!logs.join('').includes('PRIVATE_SENTINEL'));
  }
});


test('sender reason output is confined to the full documented Apple and Mozilla maps', async () => {
  const apple = ['BadTtl','BadUrgency','BadWebPushRequest','BadWebPushTopic','VapidPkHashMismatch','IdleTimeout',
    'BadAuthorizationHeader','BadJwtToken','BadVapidPublicKey','BadPath','MethodNotAllowed','PayloadTooLarge',
    'TooManyRequests','InternalServerError','ServiceUnavailable','Shutdown'];
  const mozilla = [[101,'missing_crypto_keys'],[108,'invalid_router'],[110,'invalid_crypto_keys'],[111,'missing_header'],
    [112,'invalid_ttl'],[113,'invalid_topic'],[109,'invalid_authentication'],['101','unknown'],[true,'unknown'],[999,'unknown']];
  const cases = [...apple.map(reason => ['apple', 'https://web.push.apple.com/synthetic', JSON.stringify({ reason }), reason]),
    ...mozilla.map(([errno, reason]) => ['mozilla', 'https://updates.push.services.mozilla.com/synthetic', JSON.stringify({ errno }), reason]),
    ['apple', 'https://web.push.apple.com/synthetic', JSON.stringify({ reason:'BadTtl', padding:'é'.repeat(2200) }), 'unknown']];
  for (const [provider, endpoint, body, reason] of cases) {
    const logs = [];
    await assert.rejects(sendPush({ env, log: s => logs.push(s), fetchImpl: async () => list([{ ...subscription, endpoint }]),
      sendNotification: async () => { throw { statusCode: 500, body }; } }), /Web Push delivery failed/);
    assert.ok(logs.includes(`Web Push provider classification: provider=${provider}, reason=${reason}.`));
  }
});
