import { pathToFileURL } from 'node:url';

const REQUIRED = ['HUB_PUSH_URL', 'PUSH_DELIVERY_TOKEN', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'];

function deliveryUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      !['hub.kolobovdjp.org', 'kolobovdjp.org'].includes(url.hostname) ||
      url.pathname !== '/hub/api/push/delivery') {
    throw new Error('Invalid delivery URL');
  }
  return url;
}

function validSubscription(subscription) {
  try {
    const url = new URL(subscription.endpoint);
    const host = url.hostname;
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
      (host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
        host.endsWith('.push.services.mozilla.com') || host === 'web.push.apple.com' || host.endsWith('.push.apple.com')) &&
      typeof subscription.keys?.p256dh === 'string' && typeof subscription.keys?.auth === 'string';
  } catch { return false; }
}

// Dependency injection keeps tests offline and prevents test runs using real secrets.
export async function sendPush({ env = process.env, fetchImpl = fetch, sendNotification, log = console.log } = {}) {
  if (REQUIRED.some((name) => !env[name]?.trim())) {
    log('Web Push skipped: configuration is incomplete.');
    return { skipped: true, sent: 0, expired: 0, failed: 0 };
  }
  let api;
  try { api = deliveryUrl(env.HUB_PUSH_URL); }
  catch { throw new Error('Web Push configuration is invalid.'); }
  const headers = { authorization: `Bearer ${env.PUSH_DELIVERY_TOKEN}` };
  const request = async (options = {}) => {
    let response;
    try {
      response = await fetchImpl(api.href, {
        ...options, headers: { ...headers, ...options.headers },
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
    } catch { throw new Error('Web Push subscription API request failed.'); }
    if (!response.ok) throw new Error(`Web Push subscription API returned HTTP ${response.status}.`);
    return response;
  };
  const response = await request();
  let subscriptions;
  try { ({ subscriptions } = await response.json()); }
  catch { throw new Error('Web Push subscription API returned invalid JSON.'); }
  if (!Array.isArray(subscriptions) || subscriptions.length > 1000 || !subscriptions.every(validSubscription)) {
    throw new Error('Web Push subscription API returned invalid subscriptions.');
  }
  if (!sendNotification) {
    const { default: webpush } = await import('web-push');
    sendNotification = webpush.sendNotification.bind(webpush);
  }
  const result = { skipped: false, sent: 0, expired: 0, failed: 0 };
  const payload = JSON.stringify({ title: 'От агентов', body: 'Есть обновление. Открой хаб.', url: '/' });
  const options = {
    vapidDetails: { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
    timeout: 15000, TTL: 3600, urgency: 'normal',
  };
  for (const subscription of subscriptions) {
    try {
      await sendNotification(subscription, payload, options);
      result.sent++;
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await request({ method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
        result.expired++;
      } else {
        // Provider errors can contain subscription URLs and keys. Never print them.
        result.failed++;
      }
    }
  }
  log(`Web Push: sent=${result.sent}, expired=${result.expired}, failed=${result.failed}.`);
  if (result.failed) throw new Error('Web Push delivery failed for one or more subscriptions.');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sendPush().catch((error) => {
    // Only our own fixed errors are safe to expose; unexpected errors are redacted.
    console.error(error.message.startsWith('Web Push ') ? error.message : 'Web Push failed.');
    process.exitCode = 1;
  });
}
