import { Buffer } from 'node:buffer';

// Delivery follows these URLs outside the Worker, so never accept arbitrary hosts.
export function validPushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const host = url.hostname;
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && (host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com'
        || host.endsWith('.push.services.mozilla.com') || host.endsWith('.push.apple.com'))
      && url.pathname.length > 1 && url.href === value;
  } catch { return false; }
}

function validKey(value, bytes) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
    && Buffer.from(value, 'base64url').length === bytes
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

export function validPushSubscription(value) {
  return value && validPushEndpoint(value.endpoint) && value.keys
    && validKey(value.keys.p256dh, 65) && Buffer.from(value.keys.p256dh, 'base64url')[0] === 4
    && validKey(value.keys.auth, 16);
}

export function validPublicKey(value) {
  return validKey(value, 65) && Buffer.from(value, 'base64url')[0] === 4;
}

async function deliveryAuthorized(request, env) {
  if (typeof env.PUSH_DELIVERY_TOKEN !== 'string' || env.PUSH_DELIVERY_TOKEN.length < 32) return false;
  const supplied = request.headers.get('authorization');
  if (!supplied?.startsWith('Bearer ') || supplied.length > 512) return false;
  const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([digest(supplied.slice(7)), digest(env.PUSH_DELIVERY_TOKEN)]);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function boundedJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '') || !request.body) return null;
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { return null; } finally { reader.releaseLock(); }
}

export async function handlePush(request, env, path, session, owner, canonicalOrigin, now, currentOwner = () => false) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
  const delivery = path === '/hub/api/push/delivery';
  if (!delivery && !['/hub/api/push/config', '/hub/api/push/subscriptions'].includes(path)) return json({ error: 'not_found' }, 404);
  if (delivery) {
    if (!await deliveryAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
  } else {
    if (!session) return json({ error: 'unauthorized' }, 401);
    if (!owner) return json({ error: 'forbidden' }, 403);
  }
  if (path === '/hub/api/push/config') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return validPublicKey(env.VAPID_PUBLIC_KEY) ? json({ publicKey: env.VAPID_PUBLIC_KEY }) : json({ error: 'push_not_configured' }, 503);
  }
  if (delivery && request.method === 'GET') {
    const rows = await env.HUB_DB.prepare(`SELECT p.endpoint, p.p256dh, p.auth, u.id, u.username
      FROM push_subscriptions p JOIN users u ON u.id = p.user_id ORDER BY p.endpoint`).all();
    return json({ subscriptions: (rows.results || []).filter(row => currentOwner({ id: row.id, username: row.username }))
      .map(row => ({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } })) });
  }
  if (!['POST', 'DELETE'].includes(request.method) || (delivery && request.method !== 'DELETE')) return json({ error: 'method_not_allowed' }, 405);
  if (!delivery && (request.headers.get('origin') !== canonicalOrigin || request.headers.get('X-Hub-Request') !== '1'
    || (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin'))) return json({ error: 'forbidden_request' }, 403);
  const body = await boundedJson(request);
  if (!body || !validPushEndpoint(body.endpoint)) return json({ error: 'invalid_subscription' }, 400);
  if (request.method === 'DELETE') {
    const statement = delivery
      ? env.HUB_DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(body.endpoint)
      : env.HUB_DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(body.endpoint, session.id);
    await statement.run();
    return json({ ok: true });
  }
  if (!validPublicKey(env.VAPID_PUBLIC_KEY)) return json({ error: 'push_not_configured' }, 503);
  if (!validPushSubscription(body)) return json({ error: 'invalid_subscription' }, 400);
  // The count and insert share a statement; concurrent requests cannot bypass the cap.
  const saved = await env.HUB_DB.prepare(`INSERT INTO push_subscriptions(endpoint, user_id, p256dh, auth, updated_at)
    SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?) < 10
      OR EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id = ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at
      WHERE push_subscriptions.user_id = excluded.user_id`)
    .bind(body.endpoint, session.id, body.keys.p256dh, body.keys.auth, now, session.id, body.endpoint, session.id).run();
  return Number(saved?.meta?.changes || 0) === 1 ? json({ ok: true }, 201) : json({ error: 'subscription_limit_or_conflict' }, 409);
}
