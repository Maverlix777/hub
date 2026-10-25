// Durable owner messages. No GitHub token, network call, or dispatch authority here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Keep target grammar aligned with the existing-writer delivery adapter.
const REVISION = /^[0-9a-f]{40}$/;
const PATH = /^[a-zA-Z0-9][a-zA-Z0-9_./-]*\.md$/;
const ERROR_CODES = new Set(['delivery_conflict', 'delivery_unavailable', 'delivery_uncertain']);

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

export async function enqueue(db, ownerId, payload, now = Date.now()) {
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO owner_outbox
    (id, owner_id, idempotency_key, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, idempotency_key) DO NOTHING`)
    .bind(id, ownerId, payload.idempotencyKey, payloadJson(payload), now, now).run();
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
    version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status != 'synced'`)
    .bind(result.status, result.receipt ? JSON.stringify(result.receipt) : null, result.error || null,
      now, result.id, result.expectedVersion).run();
  return { applied: Number(changed?.meta?.changes || 0) === 1 };
}
