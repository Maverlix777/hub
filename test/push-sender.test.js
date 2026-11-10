import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createECDH, createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { sendPush as runSender } from '../tools/send-push.mjs';

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

// Existing regressions receive a synthetic signing endpoint; remote-signer tests
// below call runSender directly and exercise the actual transport boundary.
async function sendPush(options) {
  const fetchImpl = options.fetchImpl;
  return runSender({ ...options, fetchImpl: async (url, request) => url.endsWith('/delivery/vapid')
    ? Response.json(signerReceipt(JSON.parse(request.body).endpoint)) : fetchImpl(url, request) });
}

test('sender APNs alert preserves text and URL without requesting a sound', async () => {
  let payload;
  const result = await runSender({ env, log: () => {},
    fetchImpl: async () => list([{ type: 'apns', token: 'ab'.repeat(32) }]),
    sendNotification: () => assert.fail('webpush called'),
    sendApns: async (_, body) => { payload = JSON.parse(body); return { status: 200 }; },
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(payload.aps.alert, { title: 'От агентов', body: 'Есть обновление. Открой хаб.' });
  assert.equal(payload.url, '/');
  assert.equal(Object.hasOwn(payload.aps, 'sound'), false);
});

test('sender closes its internal APNs session when expired-token cleanup fails', async () => {
  const http2 = createRequire(import.meta.url)('node:http2');
  const originalConnect = http2.connect;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const session = new EventEmitter();
  let connects = 0;
  let closes = 0;
  session.request = () => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.resume = () => request;
    request.end = () => queueMicrotask(() => {
      request.emit('response', { ':status': 410 });
      request.emit('end');
    });
    return request;
  };
  session.close = () => { closes++; };
  try {
    http2.connect = () => { connects++; return session; };
    syncBuiltinESMExports();
    await assert.rejects(runSender({ env: { ...env,
      APNS_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      APNS_KEY_ID: 'SYNTHETIC_KEY', APNS_TEAM_ID: 'SYNTHETIC_TEAM',
    }, log: () => {}, sendNotification: () => assert.fail('webpush called'),
    fetchImpl: async (_, options) => options.method === 'DELETE'
      ? new Response(null, { status: 500 })
      : list([{ type: 'apns', token: 'ab'.repeat(32) }]),
    }), /Web Push subscription API returned HTTP 500\./);
    assert.equal(connects, 1);
    assert.equal(closes, 1);
  } finally {
    http2.connect = originalConnect;
    syncBuiltinESMExports();
  }
});

test('sender retains APNs subscriptions on HTTP 400 and reports delivery failure', async () => {
  const token = 'ab'.repeat(32);
  const deletes = [];
  const logs = [];
  const outcome = await runSender({ env, log: value => logs.push(value),
    fetchImpl: async (url, options) => {
      assert.equal(url, env.HUB_PUSH_URL);
      if (options.method === 'DELETE') {
        deletes.push(JSON.parse(options.body));
        return new Response(null, { status: 204 });
      }
      return list([{ type: 'apns', token }]);
    },
    sendNotification: () => assert.fail('webpush called'),
    sendApns: async value => { assert.equal(value, token); return { status: 400 }; },
  }).then(result => ({ result }), error => ({ error }));
  assert.deepEqual(deletes, []);
  assert.match(outcome.error?.message || '', /^Web Push delivery failed for one or more subscriptions\.$/);
  assert.deepEqual(logs, ['Web Push: sent=0, expired=0, failed=1.']);
});

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
    assert.equal(options.vapidDetails, null);
    assert.match(options.headers.Authorization, /^vapid t=/);
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


test('sender ignores obsolete GH signing values and uses only Worker signer identity', async () => {
  let sent = 0;
  const result = await sendPush({ env: { ...env, VAPID_PUBLIC_KEY: true, VAPID_PRIVATE_KEY: false, VAPID_SUBJECT: 'invalid' },
    log: () => {}, fetchImpl: async () => list(), sendNotification: async (_, __, options) => {
      sent++; assert.equal(options.vapidDetails, null); assert.match(options.headers.Authorization, /^vapid t=/);
    } });
  assert.equal(sent, 1); assert.equal(result.sent, 1);
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

// Synthetic Worker-signer receipts; generated locally, never real credentials.
function signerReceipt(endpoint, { expiration = Math.floor(Date.now() / 1000) + 600, claims = {}, header = {}, key = firstPair, receipt = {} } = {}) {
  const point = Buffer.from(key.publicKey, 'base64url');
  const privateKey = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
    x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'), d: key.privateKey } });
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'ES256', typ: 'JWT', ...header })}.${encode({ aud: new URL(endpoint).origin, sub: 'https://hub.kolobovdjp.org/', exp: expiration, ...claims })}`;
  const jwt = `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  return { authorization: `vapid t=${jwt}, k=${key.publicKey}`, publicKeySha256: createHash('sha256').update(point).digest('hex'), expiresAt: expiration, ...receipt };
}
const onlyHub = { HUB_PUSH_URL: env.HUB_PUSH_URL, PUSH_DELIVERY_TOKEN: env.PUSH_DELIVERY_TOKEN };

test('remote signer: no GH signing keys, strict POST and custom VAPID authorization', async () => {
  const receipt = signerReceipt(subscription.endpoint); const requests = []; let sent = 0;
  const result = await runSender({ env: onlyHub, fetchImpl: async (url, options) => {
    requests.push([url, options]);
    if (url === env.HUB_PUSH_URL) return list();
    assert.equal(url, env.HUB_PUSH_URL + '/vapid'); assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.authorization, `Bearer ${env.PUSH_DELIVERY_TOKEN}`);
    assert.deepEqual(JSON.parse(options.body), { endpoint: subscription.endpoint });
    return Response.json(receipt);
  }, sendNotification: async (sub, payload, options) => {
    sent++; assert.equal(options.vapidDetails, null); assert.equal(options.headers.Authorization, receipt.authorization);
    assert.equal(options.TTL, 3600); assert.equal(options.urgency, 'normal'); assert.equal(options.timeout, 15000);
  }, log: () => {} });
  assert.equal(requests.length, 2); assert.equal(sent, 1); assert.equal(result.sent, 1);
});

test('remote signer: invalid receipts never reach provider or expose values', async () => {
  const valid = signerReceipt(subscription.endpoint);
  const mutated = valid.authorization.replace(/t=([^.]+)/, (all, part) => 't=' + part + '=');
  const bad = [ {}, { ...valid, authorization: valid.authorization + '\r\nPRIVATE_SENTINEL' },
    { ...valid, publicKeySha256: '0'.repeat(64) }, { ...valid, expiresAt: true },
    signerReceipt(subscription.endpoint, { claims: { aud: 'https://attacker.test' } }),
    signerReceipt(subscription.endpoint, { claims: { sub: 'mailto:unexpected@example.test' } }),
    signerReceipt(subscription.endpoint, { header: { alg: 'none' } }),
    signerReceipt(subscription.endpoint, { expiration: Math.floor(Date.now()/1000) - 1 }),
    signerReceipt(subscription.endpoint, { expiration: Math.floor(Date.now()/1000) + 601 }),
    { ...valid, expiresAt: valid.expiresAt - 1 }, { ...valid, authorization: mutated },
    { ...valid, authorization: valid.authorization.replace(/t=([^ ]+)/, 't=a.b.c,') },
    { ...valid, authorization: valid.authorization.replace(/k=.+$/, 'k=' + secondPair.publicKey), publicKeySha256: createHash('sha256').update(Buffer.from(secondPair.publicKey, 'base64url')).digest('hex') },
    { ...valid, authorization: valid.authorization.replace(/k=.+$/, 'k=' + Buffer.alloc(65,4).toString('base64url')) } ];
  for (const value of bad) {
    const logs = []; let sent = 0;
    await assert.rejects(runSender({ env: onlyHub, log: s => logs.push(s), fetchImpl: async url =>
      url === env.HUB_PUSH_URL ? list() : Response.json(value), sendNotification: () => { sent++; } }), /Web Push VAPID signer response is invalid\./);
    assert.equal(sent, 0); assert.ok(!logs.join('').includes('PRIVATE_SENTINEL')); assert.ok(!logs.join('').includes(valid.authorization));
  }
});

test('remote signer: origin cache refreshes near expiry without provider retry', async () => {
  let nowMs = 1700000000000; let signs = 0; let sends = 0;
  const other = { ...subscription, endpoint: subscription.endpoint + '2' };
  const result = await runSender({ env: onlyHub, now: () => nowMs, log: () => {}, fetchImpl: async url => {
    if (url === env.HUB_PUSH_URL) return list([subscription, other, { ...other, endpoint: other.endpoint + '3' }]);
    signs++; return Response.json(signerReceipt(subscription.endpoint, { expiration: Math.floor(nowMs/1000) + 600 }));
  }, sendNotification: async () => { sends++; if (sends === 2) nowMs += 600000; } });
  assert.equal(signs, 2); assert.equal(sends, 3); assert.equal(result.sent, 3);
});

test('remote signer: API failure is sanitized and never starts provider delivery', async () => {
  for (const response of [new Response('PRIVATE_SENTINEL', { status: 503 }), new Response('PRIVATE_SENTINEL'),
    Response.json({ padding: 'x'.repeat(9000) })]) {
    await assert.rejects(runSender({ env: onlyHub, log: () => {}, fetchImpl: async url => url === env.HUB_PUSH_URL ? list() : response,
      sendNotification: () => assert.fail('provider called') }), /Web Push (subscription API returned HTTP 503|VAPID signer response is invalid)\./);
  }
});

test('remote signer: origin isolation prewarms all receipts before provider side effects', async () => {
  const second = { ...subscription, endpoint: 'https://web.push.apple.com/synthetic' }; let signed = 0; let sent = 0;
  await assert.rejects(runSender({ env: onlyHub, log: () => {}, fetchImpl: async (url, options) => {
    if (url === env.HUB_PUSH_URL) return list([subscription, second]);
    signed++; const endpoint = JSON.parse(options.body).endpoint;
    return Response.json(endpoint === second.endpoint ? {} : signerReceipt(endpoint));
  }, sendNotification: () => { sent++; } }), /signer response is invalid/);
  assert.equal(signed, 2); assert.equal(sent, 0);
});

test('remote signer: installed web-push preserves custom authorization with null VAPID', async () => {
  const { default: webpush } = await import('web-push');
  const receipt = signerReceipt(subscription.endpoint);
  const sub = { ...subscription, keys: { p256dh: firstPair.publicKey, auth: Buffer.alloc(16, 3).toString('base64url') } };
  const details = webpush.generateRequestDetails(sub, 'synthetic payload', {
    vapidDetails: null, headers: { Authorization: receipt.authorization }, TTL: 3600, urgency: 'normal', timeout: 15000 });
  assert.equal(details.headers.Authorization, receipt.authorization); assert.equal(details.endpoint, sub.endpoint);
  assert.equal(details.method, 'POST'); assert.ok(details.body.length > 0);
});
