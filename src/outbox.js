// Durable owner messages. No GitHub token, network call, or dispatch authority here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Keep target grammar aligned with the existing-writer delivery adapter.
const REVISION = /^[0-9a-f]{40}$/;
const PATH = /^[a-zA-Z0-9][a-zA-Z0-9_./-]*\.md$/;
const ERROR_CODES = new Set(['delivery_conflict', 'delivery_unavailable', 'delivery_uncertain',
  'delivery_unavailable_github_401', 'delivery_unavailable_github_403', 'delivery_unavailable_github_404',
  'delivery_unavailable_github_429', 'delivery_unavailable_github_5xx', 'delivery_unavailable_github_other_http',
  'delivery_unavailable_timeout', 'delivery_unavailable_network', 'delivery_unavailable_malformed', 'delivery_unavailable_metadata']);

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

export function validatePayload(value) {
  if (!exactKeys(value, ['idempotencyKey', 'kind', 'text', 'target'])
    || typeof value.idempotencyKey !== 'string' || !UUID.test(value.idempotencyKey)
    || !['answer', 'message'].includes(value.kind)
    || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 8000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text)) return null;
  let target = null;
  if (value.kind === 'message' && value.target != null) return null;
  if (value.target !== undefined && value.target !== null) {
    const t = value.target;
    if (!exactKeys(t, ['sourcePath', 'taskId', 'revision'])
      || typeof t.sourcePath !== 'string' || t.sourcePath.length > 300 || !PATH.test(t.sourcePath)
      || t.sourcePath.split('/').some((part) => part === '.' || part === '..' || !part)
      || typeof t.taskId !== 'string' || t.taskId.length > 100 || !/^[A-Z][A-Z0-9_]*-[0-9]+$/.test(t.taskId)
      || typeof t.revision !== 'string' || !REVISION.test(t.revision)) return null;
    target = { sourcePath: t.sourcePath, taskId: t.taskId, revision: t.revision };
  }
  if (value.kind === 'answer' && !target) return null;
  return { idempotencyKey: value.idempotencyKey.toLowerCase(), kind: value.kind, text: value.text, target };
}

function rowToItem(row) {
  if (!row) return null;
  const payload = JSON.parse(row.payload_json);
  return {
    id: row.id, idempotencyKey: row.idempotency_key, ...payload,
    status: row.status, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
    error: row.error_code,
    author: row.author_json ? JSON.parse(row.author_json) : null,
    agentAck: null,
    agentResult: null,
  };
}

const payloadJson = (payload) => JSON.stringify({ kind: payload.kind, text: payload.text, target: payload.target });

// Read-before-validation permits a retry of an already persisted answer after its source changes.
export async function existingSubmission(db, ownerId, payload) {
  const row = await db.prepare('SELECT * FROM owner_outbox WHERE owner_id = ? AND idempotency_key = ?')
    .bind(ownerId, payload.idempotencyKey).first();
  if (!row) return null;
  return row.payload_json === payloadJson(payload)
    ? { item: rowToItem(row), duplicate: true } : { error: 'idempotency_conflict' };
}

export async function enqueue(db, ownerId, payload, now = Date.now(), author = null) {
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO owner_outbox
    (id, owner_id, idempotency_key, payload_json, created_at, updated_at, author_json)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, idempotency_key) DO NOTHING`)
    .bind(id, ownerId, payload.idempotencyKey, payloadJson(payload), now, now, author ? JSON.stringify(author) : null).run();
  const found = await existingSubmission(db, ownerId, payload);
  if (found?.item?.id === id) delete found.duplicate;
  return found;
}

export async function listSubmissions(db, ownerId, before = null) {
  // Cursor is a stable (created_at, id) pair, never an offset that can skip new rows.
  const cursor = before && /^\d{1,16},[0-9a-f-]{36}$/i.test(before) ? before.split(',') : null;
  const query = cursor
    ? 'SELECT * FROM owner_outbox WHERE owner_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 101'
    : 'SELECT * FROM owner_outbox WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT 101';
  const statement = db.prepare(query);
  const rows = await (cursor ? statement.bind(ownerId, Number(cursor[0]), Number(cursor[0]), cursor[1]) : statement.bind(ownerId)).all();
  const page = rows.results || [];
  const items = page.slice(0, 100).map(rowToItem);
  const last = items.at(-1);
  return { items, nextCursor: page.length > 100 ? `${last.createdAt},${last.id}` : null };
}

function validReceipt(receipt) {
  if (!exactKeys(receipt, ['url', 'commit', 'deliveredAt']) || typeof receipt.commit !== 'string'
    || !/^[0-9a-f]{40}$/.test(receipt.commit) || !Number.isSafeInteger(receipt.deliveredAt) || receipt.deliveredAt < 0) return false;
  try {
    const url = new URL(receipt.url);
    return url.protocol === 'https:' && url.host === 'github.com' && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.startsWith(`/Maverlix777/agent-handoffs/blob/${receipt.commit}/`)
      && !/%(?:2f|5c|2e)/i.test(url.pathname);
  } catch { return false; }
}

// Local operator import only; intentionally not available through an HTTP route.
// The trusted adapter must first verify exact GitHub commit readback. CAS prevents stale results.
export async function applyDeliveryResult(db, result, now = Date.now()) {
  if (!exactKeys(result, ['id', 'expectedVersion', 'status', 'receipt', 'error'])
    || !UUID.test(result.id || '') || !Number.isSafeInteger(result.expectedVersion) || result.expectedVersion < 1
    || !['synced', 'error', 'conflict'].includes(result.status)
    || (result.status === 'synced' ? (!validReceipt(result.receipt) || result.error != null)
      : (!ERROR_CODES.has(result.error) || result.receipt != null))) throw new TypeError('invalid_delivery_result');
  const changed = await db.prepare(`UPDATE owner_outbox SET status = ?, receipt_json = ?, error_code = ?,
    version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status != 'synced' AND delivery_phase = 'idle'`)
    .bind(result.status, result.receipt ? JSON.stringify(result.receipt) : null, result.error || null,
      now, result.id, result.expectedVersion).run();
  return { applied: Number(changed?.meta?.changes || 0) === 1 };
}

function validIssueReceipt(receipt) {
  if (!exactKeys(receipt, ['kind', 'url', 'issueNumber', 'commentId', 'deliveredAt'])
    || !['issue', 'comment'].includes(receipt.kind)
    || !Number.isSafeInteger(receipt.issueNumber) || receipt.issueNumber < 1
    || !Number.isSafeInteger(receipt.deliveredAt) || receipt.deliveredAt < 0
    || (receipt.kind === 'issue' ? receipt.commentId !== null : !Number.isSafeInteger(receipt.commentId) || receipt.commentId < 1)) return false;
  const expected = `https://github.com/Maverlix777/agent-handoffs/issues/${receipt.issueNumber}`
    + (receipt.kind === 'comment' ? `#issuecomment-${receipt.commentId}` : '');
  return receipt.url === expected;
}

function validIntent(intent, id) {
  if (!exactKeys(intent, ['schemaVersion', 'kind', 'issueNumber', 'marker', 'payloadHash', 'body', 'title'])
    || intent.schemaVersion !== 1 || !['issue', 'comment'].includes(intent.kind)
    || (intent.kind === 'issue' ? intent.issueNumber !== null : !Number.isSafeInteger(intent.issueNumber) || intent.issueNumber < 1)
    || typeof intent.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(intent.payloadHash)
    || intent.marker !== `<!-- hub-outbox:${id}:${intent.payloadHash} -->`
    || typeof intent.body !== 'string' || intent.body.length > 26000 || !intent.body.includes(intent.marker)
    || intent.title !== `Hub message ${id.slice(0, 8)}`) return false;
  return new TextEncoder().encode(JSON.stringify(intent)).byteLength <= 128 * 1024;
}

// A lease is obtained before any POST. An expired attempt with a durable intent is
// reconciliation-only: lease expiry is never evidence that a remote POST failed.
export async function claimDelivery(db, id, now = Date.now(), leaseMs = 60000) {
  if (!UUID.test(id || '') || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) throw new TypeError('invalid_delivery_claim');
  const attempt = crypto.randomUUID();
  const row = await db.prepare(`UPDATE owner_outbox SET delivery_phase = 'leased', delivery_attempt = ?, lease_until = ?
    WHERE id = ? AND status IN ('pending', 'error') AND (delivery_phase = 'idle'
      OR (delivery_phase IN ('leased', 'uncertain') AND COALESCE(lease_until, 0) <= ?)) RETURNING *`)
    .bind(attempt, now + leaseMs, id, now).first();
  if (!row) return null;
  const intent = row.delivery_intent_json ? JSON.parse(row.delivery_intent_json) : null;
  return { item: { ...rowToItem(row), deliveryIntent: intent }, attempt, mode: intent ? 'reconcile' : 'deliver', intent };
}

export async function beginDeliveryAttempt(db, id, attempt, intent, now = Date.now()) {
  if (!UUID.test(id || '') || !UUID.test(attempt || '') || !validIntent(intent, id)) throw new TypeError('invalid_delivery_intent');
  const result = await db.prepare(`UPDATE owner_outbox SET delivery_intent_json = ?, updated_at = ?
    WHERE id = ? AND delivery_attempt = ? AND delivery_phase = 'leased' AND lease_until > ?
      AND delivery_intent_json IS NULL AND status IN ('pending', 'error')
      AND json_extract(payload_json, '$.kind') = ?`)
    .bind(JSON.stringify(intent), now, id, attempt, now, intent.kind === 'issue' ? 'message' : 'answer').run();
  return { applied: Number(result?.meta?.changes || 0) === 1 };
}

export async function markDeliveryUncertain(db, id, attempt, now = Date.now()) {
  const result = await db.prepare(`UPDATE owner_outbox SET delivery_phase = 'uncertain', status = 'error',
    error_code = 'delivery_uncertain', lease_until = ?, version = version + 1, updated_at = ?
    WHERE id = ? AND delivery_attempt = ? AND delivery_phase = 'leased' AND delivery_intent_json IS NOT NULL AND status != 'synced'`)
    .bind(now + 60000, now, id, attempt).run();
  return { applied: Number(result?.meta?.changes || 0) === 1 };
}

// Only the server-side Issues transport calls this after an exact remote readback.
// Browser input cannot submit receipts or select a delivery target/adapter.
export async function finishDelivery(db, id, attempt, result, now = Date.now()) {
  if (!UUID.test(id || '') || !UUID.test(attempt || '')
    || !exactKeys(result, ['status', 'receipt', 'error']) || !['synced', 'error', 'conflict'].includes(result.status)
    || (result.status === 'synced' ? !validIssueReceipt(result.receipt) || result.error != null
      : !ERROR_CODES.has(result.error) || result.receipt != null)) throw new TypeError('invalid_delivery_result');
  const changed = await db.prepare(`UPDATE owner_outbox SET status = ?, receipt_json = ?, error_code = ?,
    version = version + 1, updated_at = ?, delivery_phase = CASE WHEN ? = 'synced' THEN 'delivered'
      WHEN delivery_intent_json IS NULL THEN 'idle' ELSE 'uncertain' END, lease_until = ?
    WHERE id = ? AND delivery_attempt = ? AND delivery_phase = 'leased' AND status != 'synced'
      AND (? != 'synced' OR (delivery_intent_json IS NOT NULL
        AND json_extract(delivery_intent_json, '$.kind') = ?
        AND (? = 'issue' OR json_extract(delivery_intent_json, '$.issueNumber') = ?)))`)
    .bind(result.status, result.receipt ? JSON.stringify(result.receipt) : null, result.error || null,
      now, result.status, now + 60000, id, attempt, result.status,
      result.receipt?.kind || null, result.receipt?.kind || null, result.receipt?.issueNumber || null).run();
  return { applied: Number(changed?.meta?.changes || 0) === 1 };
}
