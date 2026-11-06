import { Buffer } from 'node:buffer';
import { signPushVapid } from './push-vapid.js';

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

// APNs device token: hex string (32 bytes today, Apple allows longer).
export function validApnsToken(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{64,200}$/.test(value);
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

// Recognize the two existing storage contracts without changing either table.
async function storageFormat(db) {
  const { results = [] } = await db.prepare("PRAGMA table_info('push_subscriptions')").all();
  const columns = new Map(results.map(column => [column.name, column]));
  const has = fields => Object.entries(fields).every(([name, type]) => columns.get(name)?.type?.toUpperCase() === type);
  const flat = has({ endpoint: 'TEXT', user_id: 'TEXT', p256dh: 'TEXT', auth: 'TEXT', updated_at: 'INTEGER' }) && columns.get('endpoint').pk === 1;
  const legacy = has({ endpoint_hash: 'TEXT', user_id: 'TEXT', subscription_json: 'TEXT', created_at: 'INTEGER', updated_at: 'INTEGER' }) && columns.get('endpoint_hash').pk === 1;
  if (flat === legacy) throw new Error('Unsupported push storage');
  return legacy ? 'legacy' : 'flat';
}

function storedSubscription(row, legacy) {
  let value;
  if (legacy) {
    if (typeof row.subscription_json !== 'string' || Buffer.byteLength(row.subscription_json) > 4096) return null;
    try { value = JSON.parse(row.subscription_json); } catch { return null; }
  } else value = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
  return validPushSubscription(value)
    ? { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } } : null;
}

// CASE prevents malformed or oversized historical JSON from reaching json_extract.
const legacyEndpoint = "CASE WHEN length(CAST(subscription_json AS BLOB)) <= 4096 AND json_valid(subscription_json) THEN json_extract(subscription_json, '$.endpoint') END";

export async function handlePush(request, env, path, session, owner, canonicalOrigin, now, currentOwner = () => false) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
  const delivery = path === '/hub/api/push/delivery';
  const vapid = path === '/hub/api/push/delivery/vapid';
  if (!delivery && !vapid && !['/hub/api/push/config', '/hub/api/push/subscriptions'].includes(path)) return json({ error: 'not_found' }, 404);
  if (delivery || vapid) {
    if (!await deliveryAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
  } else {
    if (!session) return json({ error: 'unauthorized' }, 401);
    if (!owner) return json({ error: 'forbidden' }, 403);
  }
  if (vapid) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const body = await boundedJson(request);
    if (!body || !validPushEndpoint(body.endpoint)) return json({ error: 'invalid_subscription' }, 400);
    try { return json(await signPushVapid(body.endpoint, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, now)); }
    catch { return json({ error: 'push_not_configured' }, 503); }
  }
  if (path === '/hub/api/push/config') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return validPublicKey(env.VAPID_PUBLIC_KEY) ? json({ publicKey: env.VAPID_PUBLIC_KEY }) : json({ error: 'push_not_configured' }, 503);
  }
  if (delivery && request.method === 'GET') {
    const legacy = await storageFormat(env.HUB_DB) === 'legacy';
    // apns rows (type/token columns from migration 0005) exist only in the flat layout.
    const selected = legacy ? 'p.subscription_json' : 'p.endpoint, p.p256dh, p.auth, p.type, p.token';
    const order = legacy ? 'p.updated_at DESC, p.endpoint_hash ASC' : 'p.endpoint';
    const rows = await env.HUB_DB.prepare(`SELECT ${selected}, u.id, u.username
      FROM push_subscriptions p JOIN users u ON u.id = p.user_id ORDER BY ${order}`).all();
    const seen = new Set();
    const subscriptions = (rows.results || []).filter(row => currentOwner({ id: row.id, username: row.username }))
      .map(row => !legacy && row.type === 'apns' ? (validApnsToken(row.token) ? { type: 'apns', token: row.token } : null)
        : storedSubscription(row, legacy)).filter(value => {
        const id = value && (value.type === 'apns' ? `apns:${value.token}` : value.endpoint);
        if (!value || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    return json({ subscriptions });
  }
  if (!['POST', 'DELETE'].includes(request.method) || (delivery && request.method !== 'DELETE')) return json({ error: 'method_not_allowed' }, 405);
  if (!delivery && (request.headers.get('origin') !== canonicalOrigin || request.headers.get('X-Hub-Request') !== '1'
    || (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin'))) return json({ error: 'forbidden_request' }, 403);
  const body = await boundedJson(request);
  const apns = body?.type === 'apns';
  if (!body || (apns ? !validApnsToken(body.token) : !validPushEndpoint(body.endpoint))) return json({ error: 'invalid_subscription' }, 400);
  if (request.method === 'POST' && !apns) {
    if (!validPublicKey(env.VAPID_PUBLIC_KEY)) return json({ error: 'push_not_configured' }, 503);
    if (!validPushSubscription(body)) return json({ error: 'invalid_subscription' }, 400);
  }
  const legacy = await storageFormat(env.HUB_DB) === 'legacy';
  // apns rows are keyed by 'apns:<token>' so the existing primary key stays unique across both types.
  const key = apns ? `apns:${body.token.toLowerCase()}` : body.endpoint;
  if (apns && legacy) return json({ error: 'apns_unsupported_storage' }, 503);
  if (request.method === 'DELETE') {
    const endpoint = legacy ? legacyEndpoint : 'endpoint';
    const statement = delivery
      ? env.HUB_DB.prepare(`DELETE FROM push_subscriptions WHERE ${endpoint} = ?`).bind(key)
      : env.HUB_DB.prepare(`DELETE FROM push_subscriptions WHERE ${endpoint} = ? AND user_id = ?`).bind(key, session.id);
    await statement.run();
    return json({ ok: true });
  }
  if (legacy) {
    // Only NEW rows use this SHA256 hex convention. Existing keys are reused by
    // endpoint lookup: their historical hash/serialization convention is unknown.
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.endpoint))).toString('hex');
    const value = JSON.stringify({ endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } });
    const saved = await env.HUB_DB.prepare(`INSERT INTO push_subscriptions(endpoint_hash, user_id, subscription_json, created_at, updated_at)
      SELECT COALESCE((SELECT endpoint_hash FROM push_subscriptions WHERE ${legacyEndpoint} = ? ORDER BY endpoint_hash LIMIT 1), ?), ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM push_subscriptions WHERE ${legacyEndpoint} = ? AND user_id <> ?)
        AND ((SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?) < 10
          OR EXISTS (SELECT 1 FROM push_subscriptions WHERE ${legacyEndpoint} = ? AND user_id = ?))
      ON CONFLICT(endpoint_hash) DO UPDATE SET subscription_json = excluded.subscription_json, updated_at = excluded.updated_at
        WHERE push_subscriptions.user_id = excluded.user_id AND ${legacyEndpoint} = ?`)
      .bind(body.endpoint, hash, session.id, value, now, now, body.endpoint, session.id, session.id, body.endpoint, session.id, body.endpoint).run();
    return Number(saved?.meta?.changes || 0) === 1 ? json({ ok: true }, 201) : json({ error: 'subscription_limit_or_conflict' }, 409);
  }
  // The count and insert share a statement; concurrent requests cannot bypass the cap.
  const saved = await env.HUB_DB.prepare(`INSERT INTO push_subscriptions(endpoint, user_id, p256dh, auth, updated_at, type, token)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?) < 10
      OR EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id = ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at
      WHERE push_subscriptions.user_id = excluded.user_id`)
    .bind(key, session.id, apns ? '' : body.keys.p256dh, apns ? '' : body.keys.auth, now, apns ? 'apns' : 'webpush',
      apns ? body.token.toLowerCase() : null, session.id, key, session.id).run();
  return Number(saved?.meta?.changes || 0) === 1 ? json({ ok: true }, 201) : json({ error: 'subscription_limit_or_conflict' }, 409);
}
