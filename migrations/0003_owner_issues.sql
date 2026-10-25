-- Prepared only: the approved existing D1 remains unchanged until rollout.
ALTER TABLE owner_outbox ADD COLUMN author_json TEXT;
ALTER TABLE owner_outbox ADD COLUMN delivery_phase TEXT NOT NULL DEFAULT 'idle'
  CHECK(delivery_phase IN ('idle', 'leased', 'uncertain', 'delivered'));
ALTER TABLE owner_outbox ADD COLUMN delivery_attempt TEXT;
ALTER TABLE owner_outbox ADD COLUMN lease_until INTEGER;
ALTER TABLE owner_outbox ADD COLUMN delivery_intent_json TEXT;
CREATE INDEX owner_outbox_delivery_idx ON owner_outbox(delivery_phase, lease_until);
