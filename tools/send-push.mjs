import { createPrivateKey, sign } from 'node:crypto';
import { connect } from 'node:http2';
import { pathToFileURL } from 'node:url';
import { ECDH, createHash, createPublicKey, verify } from 'node:crypto';

const APNS_TOPIC = 'org.kolobovdjp.hub';
const APNS_REQUIRED = ['APNS_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID'];
const apnsToken = (value) => typeof value === 'string' && /^[0-9a-fA-F]{64,200}$/.test(value);

// ES256 provider token (valid 1 hour). The .p8 key comes from the APNS_KEY secret and is never logged.
export function apnsJwt({ key, keyId, teamId, now = Date.now() }) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = `${part({ alg: 'ES256', kid: keyId })}.${part({ iss: teamId, iat: Math.floor(now / 1000) })}`;
  const signature = sign('sha256', Buffer.from(head), { key: createPrivateKey(key), dsaEncoding: 'ieee-p1363' });
  return `${head}.${signature.toString('base64url')}`;
}

// One HTTP/2 session per run. Resolves { status } or throws; response body (reason) is never returned.
function apnsSender(env) {
  const host = env.APNS_ENV === 'development' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const jwt = apnsJwt({ key: env.APNS_KEY.replace(/\\n/g, '\n'), keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID });
  let session;
  const send = (token, payload) => new Promise((resolve, reject) => {
    session ||= connect(host);
    session.once('error', reject);
    const req = session.request({
      ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${jwt}`,
      'apns-topic': APNS_TOPIC, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
    });
    req.setTimeout(15000, () => { req.close(); reject(new Error('timeout')); });
    let status = 0;
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('error', reject);
    req.on('end', () => resolve({ status }));
    req.resume();
    req.end(payload);
  });
  send.close = () => session?.close();
  return send;
}


const REQUIRED = ['HUB_PUSH_URL', 'PUSH_DELIVERY_TOKEN'];

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
  if (subscription?.type === 'apns') return apnsToken(subscription.token);
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

// Worker owns signing identity. Validate its short-lived response independently;
// never expose a JWT, public key, response body or library exception in diagnostics.
async function signerReceipt(response, endpoint, nowSeconds) {
  try {
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 8192) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!receipt || typeof receipt.authorization !== 'string' || receipt.authorization.length > 2048
      || typeof receipt.publicKeySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.publicKeySha256)
      || !Number.isSafeInteger(receipt.expiresAt)) throw new Error();
    const match = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(receipt.authorization);
    if (!match) throw new Error();
    const decode = text => {
      const bytes = Buffer.from(text, 'base64url');
      if (bytes.toString('base64url') !== text) throw new Error();
      return bytes;
    };
    const point = decode(match[2]);
    if (point.length !== 65 || point[0] !== 4) throw new Error();
    ECDH.convertKey(point, 'prime256v1', undefined, undefined, 'uncompressed');
    if (createHash('sha256').update(point).digest('hex') !== receipt.publicKeySha256) throw new Error();
    const segments = match[1].split('.'); const signature = decode(segments[2]);
    const json = value => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(value)));
    const header = json(segments[0]); const claims = json(segments[1]);
    if (!header || Object.keys(header).length !== 2 || header.alg !== 'ES256' || header.typ !== 'JWT'
      || !claims || Object.keys(claims).length !== 3 || claims.aud !== new URL(endpoint).origin
      || claims.sub !== 'https://hub.kolobovdjp.org/' || !Number.isSafeInteger(claims.exp)
      || claims.exp !== receipt.expiresAt || claims.exp <= nowSeconds || claims.exp > nowSeconds + 600
      || signature.length !== 64) throw new Error();
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
    if (!verify('sha256', Buffer.from(segments[0] + '.' + segments[1]), { key, dsaEncoding: 'ieee-p1363' }, signature)) throw new Error();
    return receipt;
  } catch { throw new Error('Web Push VAPID signer response is invalid.'); }
}

// Dependency injection keeps tests offline and prevents test runs using real secrets.
export async function sendPush({ env = process.env, fetchImpl = fetch, sendNotification, sendApns, log = console.log, now = Date.now } = {}) {
  if (REQUIRED.some((name) => env[name] == null || env[name] === '' || (typeof env[name] === 'string' && !env[name].trim()))) {
    log('Web Push skipped: configuration is incomplete.');
    return { skipped: true, sent: 0, expired: 0, failed: 0 };
  }
  let api;
  try { api = deliveryUrl(env.HUB_PUSH_URL); }
  catch { throw new Error('Web Push configuration is invalid.'); }
  const headers = { authorization: `Bearer ${env.PUSH_DELIVERY_TOKEN}` };
  const request = async (options = {}, target = api.href) => {
    let response;
    try {
      response = await fetchImpl(target, {
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
  const apnsConfigured = APNS_REQUIRED.every((name) => env[name]?.trim());
  let apnsClose;
  if (!sendApns && apnsConfigured && subscriptions.some((item) => item.type === 'apns')) {
    try { sendApns = apnsSender(env); apnsClose = sendApns.close; }
    catch { throw new Error('Web Push APNs configuration is invalid.'); }
  }
  const payload = JSON.stringify({ title: 'От агентов', body: 'Есть обновление. Открой хаб.', url: '/' });
  const cache = new Map();
  const authorize = async subscription => {
    const origin = new URL(subscription.endpoint).origin;
    let receipt = cache.get(origin);
    if (!receipt || receipt.expiresAt <= Math.floor(now() / 1000) + 5) {
      const signed = await request({ method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }) }, api.href + '/vapid');
      receipt = await signerReceipt(signed, subscription.endpoint, Math.floor(now() / 1000));
      cache.set(origin, receipt);
    }
    return receipt;
  };
  // Detect initial signer/configuration failures before the first delivery.
  for (const subscription of subscriptions) {
    if (subscription.type !== 'apns' && !cache.has(new URL(subscription.endpoint).origin)) await authorize(subscription);
  }
  const apnsPayload = JSON.stringify({ aps: { alert: { title: 'От агентов', body: 'Есть обновление. Открой хаб.' }, sound: 'default' }, url: '/' });
  let apnsSkipped = 0;
  for (const subscription of subscriptions) {
    if (subscription.type === 'apns') {
      if (!sendApns) { apnsSkipped++; continue; }
      try {
        const { status } = await sendApns(subscription.token, apnsPayload);
        if (status === 200) result.sent++;
        else if (status === 410 || status === 400) {
          // 410 Unregistered / 400 (BadDeviceToken etc.): drop the token so it is not retried forever.
          await request({ method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'apns', token: subscription.token }) });
          result.expired++;
        } else result.failed++;
      } catch (error) {
        if (error?.message?.startsWith('Web Push ')) throw error;
        result.failed++;
      }
      continue;
    }
    let receipt;
    try { receipt = await authorize(subscription); }
    catch (error) {
      log(`Web Push: sent=${result.sent}, expired=${result.expired}, failed=${result.failed}.`);
      throw error;
    }
    const publicHash = receipt.publicKeySha256;
    const options = { vapidDetails: null, headers: { Authorization: receipt.authorization },
      timeout: 15000, TTL: 3600, urgency: 'normal' };
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
  apnsClose?.();
  if (apnsSkipped) log(`APNs skipped: APNS_KEY, APNS_KEY_ID or APNS_TEAM_ID is not set (${apnsSkipped} subscription(s)).`);
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
