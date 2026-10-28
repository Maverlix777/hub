import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sendPush } from '../tools/send-push.mjs';

const env = {
  HUB_PUSH_URL: 'https://hub.kolobovdjp.org/hub/api/push/delivery',
  PUSH_DELIVERY_TOKEN: 'synthetic-token', VAPID_PUBLIC_KEY: 'synthetic-public',
  VAPID_PRIVATE_KEY: 'synthetic-private', VAPID_SUBJECT: 'mailto:test@example.com',
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
  let sent = 0;
  const result = await sendPush({ env, log: () => {}, fetchImpl: async (url, options) => {
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
  assert.deepEqual(logs, ['Web Push: sent=1, expired=0, failed=1.']);
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
