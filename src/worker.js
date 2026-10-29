import { Buffer } from 'node:buffer';
import { loadBoardSources } from './board-sources.js';
import { readTelemetry } from './telemetry.js';
import { validatePayload, existingSubmission, enqueue, listSubmissions } from './outbox.js';
import { readIssueResponses } from './issue-responses.js';
import { handlePush } from './push.js';
import { listThreads, readThread, replyToThread } from './messenger.js';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

const SESSION_COOKIE = '__Host-hub_session';
const GATEWAY_TOKEN_HEADER = 'X-Hub-Gateway-Token';
const GATEWAY_CLIENT_IP_HEADER = 'X-Hub-Client-IP';
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// Sliding renewal: a live session is extended at most once per hour.
const SESSION_RENEW_AFTER_MS = 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_BODY_BYTES = 128 * 1024;

const noStore = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
};
const STATIC_CACHE_CONTROL = 'private, max-age=3600';
// Registration policy A (owner, 23.10.2026): anyone may register; the server decides app access by tier.
// Every file under /hub/apps/<id>.* needs an entry here; an app missing from the matrix is denied.
// External tiles listed here (location-fusion) are only hidden in the hub: their hosts are outside this Worker.
const APP_ACCESS = Object.freeze({
  chat: Object.freeze(['free', 'paid']),
  downloads: Object.freeze(['free', 'paid']),
  'location-fusion': Object.freeze(['paid']),
  // Job Forge: only a plan so far (agent-handoffs, 20.10.2026); reserved paid-only before its files land in public/apps/.
  'job-forge': Object.freeze(['paid']),
});

// Board dashboard: owner only. Not an entitlement tier (open registration hands out 'free' to anyone);
// access needs the session username to be in env.BOARD_OWNER_USERNAME (comma-separated list). Unset means nobody.
// Explicit author mappings bind a GitHub identity to an existing stable Hub account,
// never to a username alone (registration is open). No Danya account is inferred.
export function boardAuthor(session, env) {
  if (!session || typeof session.id !== 'string' || typeof session.username !== 'string') return null;
  if (env.BOARD_AUTHORS_JSON !== undefined) {
    let authors;
    try { authors = JSON.parse(env.BOARD_AUTHORS_JSON); } catch { return null; }
    // Two people may have three Hub accounts (for example desktop/mobile).
    // Accounts remain unique; GitHub principals are bounded separately.
    if (!Array.isArray(authors) || authors.length > 3 || authors.some((author) => !author || Array.isArray(author)
      || Object.keys(author).length !== 3 || !['hubUserId', 'hubUsername', 'githubLogin'].every((key) => Object.hasOwn(author, key))
      || typeof author.hubUserId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(author.hubUserId)
      || typeof author.hubUsername !== 'string' || !/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(author.hubUsername)
      || typeof author.githubLogin !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(author.githubLogin))) return null;
    for (const field of ['hubUserId', 'hubUsername']) {
      if (new Set(authors.map((author) => author[field].toLowerCase())).size !== authors.length) return null;
    }
    if (new Set(authors.map((author) => author.githubLogin.toLowerCase())).size > 2) return null;
    const mapped = authors.find((author) => author.hubUserId === session.id || author.hubUsername === session.username.toLowerCase());
    return mapped && mapped.hubUserId === session.id && mapped.hubUsername === session.username.toLowerCase() ? { ...mapped } : null;
  }
  const owners = typeof env.BOARD_OWNER_USERNAME === 'string'
    ? env.BOARD_OWNER_USERNAME.split(',').map((u) => u.trim().toLowerCase()).filter(Boolean)
    : [];
  return owners.includes(session.username.toLowerCase())
    ? { hubUserId: session.id, hubUsername: session.username.toLowerCase(), githubLogin: null } : null;
}

function isBoardOwner(session, env) {
  return Boolean(boardAuthor(session, env));
}

function issuesDeliveryEnabled(env) {
  return env.HUB_ISSUES_ENABLED === 'true' && typeof env.HUB_ISSUES_GITHUB_TOKEN === 'string'
    && env.HUB_ISSUES_GITHUB_TOKEN.length >= 20;
}

function scheduleIssueDelivery(db, env, item, ctx) {
  if (!item || item.status === 'synced' || item.status === 'conflict' || !issuesDeliveryEnabled(env) || !ctx?.waitUntil) return;
  // Background delivery starts only after the durable INSERT or existing-item read.
  // No second scheduler, direct session messaging, or browser credential is involved.
  ctx.waitUntil(import('./issues-delivery.js').then(({ flushIssueDelivery }) => flushIssueDelivery(db, env, item.id)).catch(() => {
    // Transport journals its attempt before POST; never surface raw exception/secret text.
    // An unavailable transport leaves saved/pending visible for an explicit safe retry.
  }));
}

// Reads the private board files at request time; nothing is stored here. Token never leaves the Worker.
async function loadBoard(env, fetchImpl = fetch) {
  const result = await loadBoardSources(env, fetchImpl);
  if (result.error) return result;
  return { board: { ...result.board, telemetry: await readTelemetry(env, fetchImpl) } };
}

function appAllowed(appId, tier) {
  return Object.hasOwn(APP_ACCESS, appId) && APP_ACCESS[appId].includes(tier);
}

function allowedApps(tier) {
  return Object.keys(APP_ACCESS).filter((id) => appAllowed(id, tier));
}

function lockedApps(tier) {
  return Object.keys(APP_ACCESS).filter((id) => !appAllowed(id, tier));
}

// '/apps/chat.js' -> 'chat'; null for paths outside /apps/; '' for anything else under /apps/ (denied).
// assetPath is already decoded by safePublicPath; slashes are collapsed and case folded so '//apps/' or 'APPS' cannot skip it.
function appIdForAsset(assetPath) {
  const canonical = assetPath.replace(/\/+/g, '/').toLowerCase();
  if (!canonical.startsWith('/apps/') && canonical !== '/apps') return null;
  const match = /^\/apps\/([a-z0-9-]+)\.[a-z]+$/.exec(assetPath);
  return match ? match[1] : '';
}

const HIDDEN_PAGE = /^\/hub\/s\/([0-9a-f]{32})\/(index\.html|[A-Za-z0-9._-]+\.shortcut)?$/;
const CACHEABLE_STATIC = /^\/hub\/(?:icons\/.+|style\.css|login\.css|manifest\.webmanifest|apps\/[^/]+\.css)$/;
// Doktor pages are public and session-free, so they may be cached by shared caches.
const DOKTOR_CACHE_CONTROL = 'public, max-age=300';

// Single exit point: every response (JSON, redirects, ASSETS) gets the same security headers.
// Redirect/ASSETS responses may have immutable headers, so the response is always rebuilt.
function finalize(response, request) {
  const headers = new Headers(response.headers);
  let cacheControl = 'no-store';
  const pathname = new URL(request.url).pathname;
  if (response.status === 200 && ['GET', 'HEAD'].includes(request.method) && !headers.has('set-cookie')) {
    if (CACHEABLE_STATIC.test(pathname)) cacheControl = STATIC_CACHE_CONTROL;
    else if (pathname.startsWith('/doktor/')) cacheControl = DOKTOR_CACHE_CONTROL;
  }
  headers.set('cache-control', cacheControl);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-frame-options', 'DENY');
  headers.set('content-security-policy', "frame-ancestors 'none'");
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function parseTransports(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rateLimitKeyReady(env) {
  return typeof env.RATE_LIMIT_HMAC_KEY === 'string' && env.RATE_LIMIT_HMAC_KEY.length >= 32;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...noStore, 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function fromBase64url(value) {
  return Buffer.from(value, 'base64url');
}

function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64url(digest);
}

async function sha256Bytes(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function isExactOrigin(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === value && parsed.pathname === '/'
      && !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

async function gatewayAuthorized(request, env) {
  const secret = env.HUB_GATEWAY_SECRET;
  const supplied = request.headers.get(GATEWAY_TOKEN_HEADER);
  if (typeof secret !== 'string' || new TextEncoder().encode(secret).byteLength < 32 || supplied === null) return false;
  const [expectedDigest, suppliedDigest] = await Promise.all([sha256Bytes(secret), sha256Bytes(supplied)]);
  return constantTimeEqual(expectedDigest, suppliedDigest);
}

function usableForwardedClientIP(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
    && value === value.trim() && !/[\s,\u0000-\u001f\u007f]/.test(value);
}

function stripGatewayHeaders(request, targetUrl = request.url) {
  const copy = new Request(targetUrl, request);
  const headers = new Headers(copy.headers);
  headers.delete(GATEWAY_TOKEN_HEADER);
  headers.delete(GATEWAY_CLIENT_IP_HEADER);
  return new Request(copy, { headers });
}

function rewriteGatewayRequest(request, canonicalOrigin) {
  const source = new URL(request.url);
  const canonical = new URL(canonicalOrigin);
  canonical.pathname = source.pathname;
  canonical.search = source.search;
  return stripGatewayHeaders(request, canonical.toString());
}

function cookieValue(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const item of header.split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function setSessionCookie(token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const username = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username) ? username : null;
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_BODY_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function originAllowed(request, canonicalOrigin) {
  return request.headers.get('origin') === canonicalOrigin;
}

async function applyRateLimit(db, env, request, scope, identifier, limit, now, trustedClientIP = null) {
  if (!rateLimitKeyReady(env)) return false;
  const ip = trustedClientIP || request.headers.get('CF-Connecting-IP');
  if (!ip) return false;
  const keyMaterial = `${scope}\0${ip}\0${identifier}`;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.RATE_LIMIT_HMAC_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const keyHash = base64url(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(keyMaterial)));
  const windowStartedAt = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const result = await db.prepare(`
    INSERT INTO rate_limits (key_hash, window_started_at, count) VALUES (?, ?, 1)
    ON CONFLICT(key_hash) DO UPDATE SET
      count = CASE WHEN rate_limits.window_started_at = excluded.window_started_at THEN rate_limits.count + 1 ELSE 1 END,
      window_started_at = excluded.window_started_at
    RETURNING count
  `).bind(keyHash, windowStartedAt).first();
  return Number(result?.count || 0) <= limit;
}

// Housekeeping for expired rows; called only from the *_options endpoints, never for asset requests.
// A failure here must not block authentication.
async function pruneExpired(db, now) {
  try {
    await db.batch([
      db.prepare('DELETE FROM challenges WHERE expires_at <= ?').bind(now),
      db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL').bind(now),
      db.prepare('DELETE FROM rate_limits WHERE window_started_at < ?').bind(now - RATE_WINDOW_MS * 2),
    ]);
  } catch {
    // ignored: the next options request retries
  }
}

async function authRateLimit(db, env, request, scope, identifier, limit, now, trustedClientIP) {
  if (!rateLimitKeyReady(env)) return json({ error: 'auth_unavailable' }, 503);
  if (!(trustedClientIP || request.headers.get('CF-Connecting-IP'))) return json({ error: 'service_unavailable' }, 503);
  const underLimit = await applyRateLimit(db, env, request, scope, identifier, limit, now, trustedClientIP)
    && await applyRateLimit(db, env, request, 'ip', 'auth', 20, now, trustedClientIP);
  return underLimit ? null : json({ error: 'rate_limited' }, 429);
}

async function consumeChallenge(db, id, operation, userId, now) {
  const result = await db.prepare(`
    UPDATE challenges SET consumed_at = ?
    WHERE id = ? AND operation = ? AND user_id = ? AND consumed_at IS NULL AND expires_at > ?
  `).bind(now, id, operation, userId, now).run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function loadSession(request, env, now = Date.now()) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{40,48}$/.test(token)) return null;
  const tokenHash = await sha256(token);
  return env.HUB_DB.prepare(`
    SELECT u.id, u.username, e.tier, s.token_hash AS tokenHash, s.expires_at AS expiresAt
    FROM sessions s JOIN users u ON u.id = s.user_id
    JOIN entitlements e ON e.user_id = u.id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
  `).bind(tokenHash, now).first();
}

async function newSession(userId, now) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = now + SESSION_TTL_MS;
  return { token, tokenHash, userId, now, expiresAt };
}

async function createSession(db, userId, now) {
  const session = await newSession(userId, now);
  await db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(session.tokenHash, userId, now, session.expiresAt).run();
  return session;
}

function safePublicPath(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (/%(?:2e|2f|5c)/i.test(url.pathname) || pathname.includes('%')
    || pathname.includes('\\') || pathname.split('/').some((part) => part === '.' || part === '..')) return null;
  if (!pathname.startsWith('/hub/') && !pathname.startsWith('/doktor/')) return null;
  return pathname;
}

function withPath(request, path) {
  const url = new URL(request.url);
  url.pathname = path;
  return new Request(url, request);
}

function isPublicLoginAsset(pathname) {
  return pathname === '/hub/login/' || pathname === '/hub/login' || pathname === '/hub/login.html'
    || pathname === '/hub/login.js' || pathname === '/hub/login.css'
    || pathname === '/hub/style.css' || pathname === '/hub/manifest.webmanifest' || pathname.startsWith('/hub/icons/');
}

function staticAssetPath(pathname) {
  if (pathname === '/hub/login/' || pathname === '/hub/login') return '/login.html';
  if (pathname === '/hub/login.html') return '/login.html';
  if (pathname === '/hub/manifest.webmanifest') return '/manifest.webmanifest';
  return pathname.slice('/hub'.length);
}

function responseWithCookie(response, cookie) {
  const headers = new Headers(response.headers);
  headers.append('set-cookie', cookie);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function api(request, env, path, session, webauthn, now, canonicalOrigin, trustedClientIP = null, ctx = null) {
  const db = env.HUB_DB;
  if (path.startsWith('/hub/api/push/')) {
    try { return await handlePush(request, env, path, session, isBoardOwner(session, env), canonicalOrigin, now,
      candidate => isBoardOwner(candidate, env)); }
    catch { return json({ error: 'push_unavailable' }, 503); }
  }
  if (request.method === 'GET' && path === '/hub/api/session') {
    return session
      ? json({
        username: session.username,
        entitlement: session.tier,
        apps: [...allowedApps(session.tier), ...(isBoardOwner(session, env) ? ['board'] : [])],
        locked: lockedApps(session.tier),
      })
      : json({ error: 'unauthorized' }, 401);
  }
  if (request.method === 'GET' && path === '/hub/api/board') {
    if (!session) return json({ error: 'unauthorized' }, 401);
    if (!isBoardOwner(session, env)) return json({ error: 'forbidden' }, 403);
    const result = await loadBoard(env);
    return result.error ? json({ error: result.error }, 503) : json(result.board);
  }
  if (path === '/hub/api/outbox') {
    if (!session) return json({ error: 'unauthorized' }, 401);
    if (!isBoardOwner(session, env)) return json({ error: 'forbidden' }, 403);
    try {
      if (request.method === 'GET') {
        const page = await listSubmissions(db, session.id, new URL(request.url).searchParams.get('before'));
        page.items = await readIssueResponses(env, page.items);
        return json({ ...page, delivery: { status: issuesDeliveryEnabled(env) ? 'enabled' : 'not_configured' } });
      }
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' });
      if (request.headers.get('X-Hub-Request') !== '1'
        || (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) {
        return json({ error: 'forbidden_request' }, 403);
      }
      const payload = validatePayload(await readJson(request));
      if (!payload) return json({ error: 'invalid_payload' }, 400);
      if (!rateLimitKeyReady(env) || !(trustedClientIP || request.headers.get('CF-Connecting-IP'))) {
        return json({ error: 'outbox_unavailable' }, 503);
      }
      if (!await applyRateLimit(db, env, request, 'owner-outbox', session.id, 20, now, trustedClientIP)) {
        return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
      }
      const existing = await existingSubmission(db, session.id, payload);
      if (existing) {
        if (!existing.error) scheduleIssueDelivery(db, env, existing.item, ctx);
        return json(existing, existing.error ? 409 : 200);
      }
      if (payload.target) {
        const result = await loadBoard(env);
        if (result.error) return json({ error: result.error }, 503);
        const source = result.board.sources.find((entry) => entry.path === payload.target.sourcePath);
        if (source?.status === 'error') return json({ error: 'board_unavailable' }, 503);
        const target = result.board.cards.find((card) => card.id === payload.target.taskId && card.sourcePath === payload.target.sourcePath);
        if (!target) return json({ error: 'invalid_target' }, 400);
        if (target.sourceRevision !== payload.target.revision) return json({ error: 'target_conflict' }, 409);
      }
      const saved = await enqueue(db, session.id, payload, now, boardAuthor(session, env));
      if (!saved.error) scheduleIssueDelivery(db, env, saved.item, ctx);
      return json(saved, saved.error ? 409 : saved.duplicate ? 200 : 201);
    } catch {
      // A missing unapplied migration and a transient storage failure are not an empty queue.
      return json({ error: 'outbox_unavailable' }, 503);
    }
  }
  if (path.startsWith('/hub/api/chat/')) {
    if (!session) return json({ error: 'unauthorized' }, 401);
    if (!isBoardOwner(session, env)) return json({ error: 'forbidden' }, 403);
    const fail = (error) => {
      const code = error?.code;
      return code === 'not_found' ? json({ error: 'not_found' }, 404) : code === 'invalid_issue' ? json({ error: 'invalid_issue' }, 400)
        : code === 'not_configured' ? json({ error: 'not_configured' }, 503) : json({ error: 'chat_unavailable' }, 502);
    };
    try {
      if (request.method === 'GET' && path === '/hub/api/chat/threads') return json({ threads: await listThreads(db, session.id) });
      if (request.method === 'GET' && path === '/hub/api/chat/thread') {
        const raw = new URL(request.url).searchParams.get('issue') || '';
        return json(await readThread(db, env, session.id, /^[0-9]{1,9}$/.test(raw) ? Number(raw) : 0));
      }
      if (request.method === 'POST' && path === '/hub/api/chat/reply') {
        if (request.headers.get('X-Hub-Request') !== '1'
          || (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) {
          return json({ error: 'forbidden_request' }, 403);
        }
        const body = await readJson(request);
        const text = body?.text;
        if (typeof text !== 'string' || !text.trim() || text.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
          || !Number.isSafeInteger(body.issue)) return json({ error: 'invalid_payload' }, 400);
        if (!rateLimitKeyReady(env) || !(trustedClientIP || request.headers.get('CF-Connecting-IP'))) return json({ error: 'chat_unavailable' }, 503);
        if (!await applyRateLimit(db, env, request, 'owner-chat', session.id, 30, now, trustedClientIP)) {
          return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
        }
        return json(await replyToThread(db, env, session.id, body.issue, text, boardAuthor(session, env).hubUsername), 201);
      }
    } catch (error) { return fail(error); }
    return json({ error: 'not_found' }, 404);
  }
  // Origin of POST requests is already checked once in fetch().

  if (request.method === 'POST' && path === '/hub/api/register/options') {
    const body = await readJson(request);
    const username = normalizeUsername(body?.username);
    if (!username) return json({ error: 'invalid_username' }, 400);
    const limited = await authRateLimit(db, env, request, 'register', username, 5, now, trustedClientIP);
    if (limited) return limited;
    await pruneExpired(db, now);
    const exists = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (exists) return json({ error: 'registration_unavailable' }, 409);
    const userId = randomToken(24);
    const options = await webauthn.generateRegistrationOptions({
      rpName: env.RP_NAME,
      rpID: env.RP_ID,
      userID: Buffer.from(userId, 'utf8'),
      userName: username,
      userDisplayName: username,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -257],
      timeout: CHALLENGE_TTL_MS,
    });
    const challengeId = randomToken(24);
    await db.batch([
      db.prepare('INSERT INTO challenges (id, user_id, operation, username, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(challengeId, userId, 'register', username, options.challenge, now + CHALLENGE_TTL_MS),
    ]);
    return json({ challengeId, options });
  }

  if (request.method === 'POST' && path === '/hub/api/register/verify') {
    const body = await readJson(request);
    const challengeId = typeof body?.challengeId === 'string' ? body.challengeId : '';
    const challenge = await db.prepare(`SELECT id, user_id, username, challenge FROM challenges
      WHERE id = ? AND operation = 'register' AND consumed_at IS NULL AND expires_at > ?`).bind(challengeId, now).first();
    if (!challenge || !body?.response || typeof body.response !== 'object') return json({ error: 'invalid_or_expired_challenge' }, 400);
    if (!await consumeChallenge(db, challengeId, 'register', challenge.user_id, now)) return json({ error: 'invalid_or_expired_challenge' }, 400);
    let verified;
    try {
      verified = await webauthn.verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: canonicalOrigin,
        expectedRPID: env.RP_ID,
        requireUserVerification: true,
      });
    } catch {
      return json({ error: 'registration_verification_failed' }, 400);
    }
    if (!verified.verified || !verified.registrationInfo?.credential) return json({ error: 'registration_verification_failed' }, 400);
    const credential = verified.registrationInfo.credential;
    const session = await newSession(challenge.user_id, now);
    try {
      await db.batch([
        db.prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)')
          .bind(challenge.user_id, challenge.username, now),
        db.prepare(`INSERT INTO credentials (id, user_id, public_key, counter, transports_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(credential.id, challenge.user_id, base64url(credential.publicKey), credential.counter,
            JSON.stringify(credential.transports || []), now),
        db.prepare('INSERT INTO entitlements (user_id, tier, source, created_at) VALUES (?, ?, ?, ?)')
          .bind(challenge.user_id, 'free', 'registration', now),
        db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
          .bind(session.tokenHash, challenge.user_id, now, session.expiresAt),
      ]);
    } catch {
      return json({ error: 'registration_unavailable' }, 409);
    }
    return responseWithCookie(json({ ok: true }), setSessionCookie(session.token, session.expiresAt));
  }

  if (request.method === 'POST' && path === '/hub/api/login/options') {
    const body = await readJson(request);
    const username = normalizeUsername(body?.username);
    if (!username) return json({ error: 'login_unavailable' }, 401);
    const limited = await authRateLimit(db, env, request, 'login', username, 8, now, trustedClientIP);
    if (limited) return limited;
    await pruneExpired(db, now);
    const user = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (!user) return json({ error: 'login_unavailable' }, 401);
    const credentials = await db.prepare('SELECT id, transports_json FROM credentials WHERE user_id = ?').bind(user.id).all();
    const rows = credentials.results || [];
    if (!rows.length) return json({ error: 'login_unavailable' }, 401);
    const options = await webauthn.generateAuthenticationOptions({
      rpID: env.RP_ID,
      allowCredentials: rows.map((credential) => ({ id: credential.id, transports: parseTransports(credential.transports_json) })),
      userVerification: 'required',
      timeout: CHALLENGE_TTL_MS,
    });
    const challengeId = randomToken(24);
    await db.batch([
      db.prepare('INSERT INTO challenges (id, user_id, operation, username, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(challengeId, user.id, 'login', username, options.challenge, now + CHALLENGE_TTL_MS),
    ]);
    return json({ challengeId, options });
  }

  if (request.method === 'POST' && path === '/hub/api/login/verify') {
    const body = await readJson(request);
    const challengeId = typeof body?.challengeId === 'string' ? body.challengeId : '';
    const challenge = await db.prepare(`SELECT id, user_id, challenge FROM challenges
      WHERE id = ? AND operation = 'login' AND consumed_at IS NULL AND expires_at > ?`).bind(challengeId, now).first();
    if (!challenge || !body?.response || typeof body.response.id !== 'string') return json({ error: 'login_unavailable' }, 401);
    if (!await consumeChallenge(db, challengeId, 'login', challenge.user_id, now)) return json({ error: 'login_unavailable' }, 401);
    const row = await db.prepare(`SELECT c.id, c.public_key, c.counter, c.transports_json
      FROM credentials c WHERE c.user_id = ? AND c.id = ?`).bind(challenge.user_id, body.response.id).first();
    if (!row) return json({ error: 'login_unavailable' }, 401);
    let verified;
    try {
      verified = await webauthn.verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: canonicalOrigin,
        expectedRPID: env.RP_ID,
        credential: {
          id: row.id,
          publicKey: fromBase64url(row.public_key),
          counter: Number(row.counter),
          transports: parseTransports(row.transports_json),
        },
        requireUserVerification: true,
      });
    } catch {
      return json({ error: 'login_unavailable' }, 401);
    }
    if (!verified.verified) return json({ error: 'login_unavailable' }, 401);
    const updated = await db.prepare('UPDATE credentials SET counter = ? WHERE id = ? AND counter = ?')
      .bind(verified.authenticationInfo.newCounter, row.id, row.counter).run();
    if (Number(updated?.meta?.changes || 0) !== 1) return json({ error: 'login_unavailable' }, 401);
    const session = await createSession(db, challenge.user_id, now);
    return responseWithCookie(json({ ok: true }), setSessionCookie(session.token, session.expiresAt));
  }

  if (request.method === 'POST' && path === '/hub/api/logout') {
    if (!session) return responseWithCookie(json({ error: 'unauthorized' }, 401), clearSessionCookie());
    const token = cookieValue(request, SESSION_COOKIE);
    await db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .bind(now, await sha256(token)).run();
    return responseWithCookie(new Response(null, { status: 204, headers: noStore }), clearSessionCookie());
  }

  return json({ error: 'not_found' }, 404);
}

export function createWorker(webauthn = {
  generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse, verifyAuthenticationResponse,
}) {
  const core = {
    async fetch(request, env, ctx, state = {}) {
      const now = Date.now();
      const canonicalOrigin = env.CANONICAL_ORIGIN || 'https://hub.kolobovdjp.org';
      const receivedUrl = new URL(request.url);
      let trustedClientIP = null;
      const legacyOrigin = env.LEGACY_ORIGIN || 'https://kolobovdjp.org';
      if (receivedUrl.origin === legacyOrigin && legacyOrigin !== canonicalOrigin
        && (receivedUrl.pathname === '/hub' || receivedUrl.pathname.startsWith('/hub/'))) {
        // Old address: send every /hub/* request to the hub host (the RP ID stays the parent domain).
        const target = new URL(receivedUrl.pathname + receivedUrl.search, canonicalOrigin);
        return Response.redirect(target.toString(), ['GET', 'HEAD'].includes(request.method) ? 301 : 308);
      }
      if (receivedUrl.origin === canonicalOrigin || receivedUrl.origin === legacyOrigin) {
        // /doktor/* stays reachable on the old host too; it is public and reads no cookie.
        request = stripGatewayHeaders(request);
      } else {
        if (!isExactOrigin(env.HUB_GATEWAY_ORIGIN) || receivedUrl.origin !== env.HUB_GATEWAY_ORIGIN) {
          return new Response('Not found', { status: 404, headers: noStore });
        }
        if (!await gatewayAuthorized(request, env)) return new Response('Not found', { status: 404, headers: noStore });
        trustedClientIP = request.headers.get(GATEWAY_CLIENT_IP_HEADER);
        if (!usableForwardedClientIP(trustedClientIP)) {
          return new Response('Service unavailable', { status: 503, headers: noStore });
        }
        request = rewriteGatewayRequest(request, canonicalOrigin);
      }
      const url = new URL(request.url);
      if (!env.HUB_DB || !env.ASSETS || !env.RP_ID) return new Response('Service unavailable', { status: 503, headers: noStore });

      let decodedPath;
      try { decodedPath = decodeURIComponent(url.pathname); } catch { return new Response('Bad request', { status: 400, headers: noStore }); }
      if (decodedPath === '/hub') return Response.redirect(`${canonicalOrigin}/hub/`, 308);
      if (decodedPath === '/doktor') return Response.redirect(`${canonicalOrigin}/doktor/`, 308);
      if (decodedPath === '/хаб' || decodedPath === '/хаб/' || decodedPath.startsWith('/хаб/')) {
        const rest = decodedPath === '/хаб' || decodedPath === '/хаб/' ? '' : decodedPath.slice('/хаб/'.length);
        const segments = rest.split('/');
        if (segments.some((part) => part === '.' || part === '..' || part.includes('\\'))) {
          return new Response('Bad request', { status: 400, headers: noStore });
        }
        const target = new URL(canonicalOrigin);
        target.pathname = `/hub/${segments.map((part) => encodeURIComponent(part)).join('/')}`;
        target.search = url.search;
        return Response.redirect(target.toString(), 308);
      }

      let pathname;
      try { pathname = safePublicPath(url); } catch { pathname = null; }
      if (!pathname) return new Response('Bad request', { status: 400, headers: noStore });
      if (pathname.startsWith('/doktor/')) {
        // Public static pages: no session is read or set.
        if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...noStore, allow: 'GET, HEAD' } });
        const assetPath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
        const response = await env.ASSETS.fetch(withPath(request, assetPath));
        const headers = { ...Object.fromEntries(response.headers), ...noStore };
        delete headers['set-cookie'];
        if (response.status === 200) headers['cache-control'] = DOKTOR_CACHE_CONTROL; // finalize() keeps it for /doktor/*
        return new Response(response.body, { status: response.status, headers });
      }
      // Unlisted download pages: /hub/s/<32 hex>/ and the file inside. No session, no D1.
      // The unguessable directory lives only in the deployed assets (never committed) and 404s otherwise.
      const hidden = HIDDEN_PAGE.exec(pathname);
      if (hidden) {
        if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...noStore, allow: 'GET, HEAD' } });
        const file = hidden[2] || 'index.html';
        const response = await env.ASSETS.fetch(withPath(request, `/s/${hidden[1]}/${file}`));
        if (response.status !== 200) return new Response('Not found', { status: 404, headers: { ...noStore, 'x-robots-tag': 'noindex, nofollow' } });
        const headers = { ...Object.fromEntries(response.headers), ...noStore, 'x-robots-tag': 'noindex, nofollow' };
        delete headers['set-cookie'];
        if (file !== 'index.html') {
          headers['content-type'] = 'application/octet-stream';
          headers['content-disposition'] = `attachment; filename="${file}"`;
        } else {
          headers['content-type'] = 'text/html; charset=utf-8';
        }
        return new Response(response.body, { status: 200, headers });
      }
      if (pathname.startsWith('/hub/api/') && request.method === 'POST' && !originAllowed(request, canonicalOrigin)) {
        return json({ error: 'forbidden_origin' }, 403);
      }
      // Browsers update service workers after sessions expire. This script contains no private data.
      if (pathname === '/hub/push-sw.js' && ['GET', 'HEAD'].includes(request.method)) {
        const response = await env.ASSETS.fetch(withPath(request, '/push-sw.js'));
        return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...noStore } });
      }
      const session = await loadSession(request, env, now);
      if (session && session.expiresAt - now < SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) {
        // Best effort: a failed renewal must never break an otherwise valid request.
        try {
          const expiresAt = now + SESSION_TTL_MS;
          const renewed = await env.HUB_DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
            .bind(expiresAt, session.tokenHash).run();
          if (Number(renewed?.meta?.changes || 0) === 1) state.renewCookie = setSessionCookie(cookieValue(request, SESSION_COOKIE), expiresAt);
        } catch { /* keep the current session as is */ }
      }
      if (pathname.startsWith('/hub/api/')) {
        return api(request, env, pathname, session, webauthn, now, canonicalOrigin, trustedClientIP, ctx);
      }
      if (pathname === '/hub/login' && ['GET', 'HEAD'].includes(request.method)) return Response.redirect(`${canonicalOrigin}/hub/login/`, 308);
      if (isPublicLoginAsset(pathname) && ['GET', 'HEAD'].includes(request.method)) {
        if (session && ['/hub/login/', '/hub/login', '/hub/login.html'].includes(pathname)) return Response.redirect(`${canonicalOrigin}/hub/`, 303);
        const response = await env.ASSETS.fetch(withPath(request, staticAssetPath(pathname)));
        return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...noStore } });
      }
      if (!session) return Response.redirect(`${canonicalOrigin}/hub/login/`, 302);
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...noStore, allow: 'GET, HEAD' } });
      if (pathname === '/hub/chat' || pathname === '/hub/chat/') pathname = '/hub/apps/messenger.html';
      if (pathname === '/hub/') pathname = isBoardOwner(session, env) ? '/hub/apps/board.html' : '/hub/index.html';
      const assetPath = staticAssetPath(pathname);
      const appId = appIdForAsset(assetPath);
      if (appId === 'board' || appId === 'messenger' ? !isBoardOwner(session, env) : (appId !== null && !appAllowed(appId, session.tier))) return new Response('Forbidden', { status: 403, headers: noStore });
      const response = await env.ASSETS.fetch(withPath(request, assetPath));
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...noStore } });
    },
  };
  return {
    async fetch(request, env, ctx) {
      let response;
      try {
        const state = {};
        response = await core.fetch(request, env, ctx, state);
        if (state.renewCookie && !response.headers.has('set-cookie')) {
          const headers = new Headers(response.headers);
          headers.append('set-cookie', state.renewCookie);
          response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        }
      } catch {
        // No exception text or stack in the response or logs.
        response = json({ error: 'internal_error' }, 500);
      }
      return finalize(response, request);
    },
  };
}

export default createWorker();
