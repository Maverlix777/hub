import { pathToFileURL } from 'node:url';
import { createECDH, ECDH, createHash, timingSafeEqual } from 'node:crypto';

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

const APPLE_REASONS = new Set(['BadTtl', 'BadUrgency', 'BadWebPushRequest', 'BadWebPushTopic',
  'VapidPkHashMismatch', 'IdleTimeout', 'BadAuthorizationHeader', 'BadJwtToken', 'BadVapidPublicKey',
  'BadPath', 'MethodNotAllowed', 'PayloadTooLarge', 'TooManyRequests', 'InternalServerError', 'ServiceUnavailable', 'Shutdown']);
const MOZILLA_REASONS = new Map([[101, 'missing_crypto_keys'], [108, 'invalid_router'], [110, 'invalid_crypto_keys'],
  [111, 'missing_header'], [112, 'invalid_ttl'], [113, 'invalid_topic'], [109, 'invalid_authentication']]);

function providerClass(subscription, body) {
  const host = new URL(subscription.endpoint).hostname; // Already validated by validSubscription.
  const provider = host === 'fcm.googleapis.com' ? 'google' : host.endsWith('.push.apple.com') ? 'apple'
    : host.endsWith('.push.services.mozilla.com') ? 'mozilla' : 'unknown';
  let reason = 'unknown';
  if (typeof body === 'string' && Buffer.byteLength(body, 'utf8') <= 4096) {
    try {
      const value = JSON.parse(body);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (provider === 'apple' && Object.hasOwn(value, 'reason') && APPLE_REASONS.has(value.reason)) reason = value.reason;
        if (provider === 'mozilla' && Object.hasOwn(value, 'errno') && Number.isInteger(value.errno)) reason = MOZILLA_REASONS.get(value.errno) || 'unknown';
      }
    } catch { /* Unknown response body: never emit its contents. */ }
  }
  return `Web Push provider classification: provider=${provider}, reason=${reason}.`;
}

function vapidPair(env, log) {
  let configured; let derived;
  try {
    const decode = (value, size) => {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.length !== size || bytes.toString('base64url') !== value) throw new Error();
      return bytes;
    };
    configured = decode(env.VAPID_PUBLIC_KEY, 65);
    if (configured[0] !== 4) throw new Error();
    ECDH.convertKey(configured, 'prime256v1', undefined, undefined, 'uncompressed');
    const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(decode(env.VAPID_PRIVATE_KEY, 32));
    derived = ecdh.getPublicKey(undefined, 'uncompressed');
  } catch { throw new Error('Web Push VAPID keypair is invalid.'); }
  const fingerprint = point => createHash('sha256').update(point).digest('hex');
  const publicHash = fingerprint(configured);
  if (!timingSafeEqual(configured, derived)) {
    log(`Web Push VAPID mismatch: configured_public_sha256=${publicHash}, derived_public_sha256=${fingerprint(derived)}.`);
    throw new Error('Web Push VAPID keypair does not match.');
  }
  return publicHash;
}

// Dependency injection keeps tests offline and prevents test runs using real secrets.
export async function sendPush({ env = process.env, fetchImpl = fetch, sendNotification, log = console.log } = {}) {
  if (REQUIRED.some((name) => env[name] == null || env[name] === '' || (typeof env[name] === 'string' && !env[name].trim()))) {
    log('Web Push skipped: configuration is incomplete.');
    return { skipped: true, sent: 0, expired: 0, failed: 0 };
  }
  const publicHash = vapidPair(env, log);
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
        // Provider objects can contain endpoints, keys and private response bodies.
        // Only a bounded numeric status may enter the fixed diagnostic text.
        const status = error?.statusCode;
        log(Number.isInteger(status) && status >= 100 && status <= 599
          ? `Web Push provider failure: HTTP ${status}.`
          : 'Web Push provider failure: network or unknown error.');
        log(providerClass(subscription, error?.body));
        if (status === 400 || status === 403) log(`Web Push VAPID configured_public_sha256=${publicHash}.`);
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
