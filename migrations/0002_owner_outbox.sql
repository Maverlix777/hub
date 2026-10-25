-- Prepared only. Apply to the existing HUB_DB after explicit rollout authorization.
CREATE TABLE owner_outbox (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'synced', 'error', 'conflict')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  receipt_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, idempotency_key)
);
CREATE INDEX owner_outbox_owner_created_idx ON owner_outbox(owner_id, created_at DESC, id);
