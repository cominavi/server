-- Writable Shared Plan CRDT notification projection. Collaborative document
-- authority and its immutable operation ledger remain in the per-plan Durable
-- Object; D1 is an idempotent inbox and APNs delivery projection only.

ALTER TABLE shared_plan_events
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy'
  CHECK (source_kind IN ('legacy', 'operation', 'conflict'));
ALTER TABLE shared_plan_events
  ADD COLUMN source_id TEXT;
ALTER TABLE shared_plan_events
  ADD COLUMN membership_epoch INTEGER
  CHECK (membership_epoch IS NULL OR membership_epoch > 0);
ALTER TABLE shared_plan_events
  ADD COLUMN plan_notification_epoch INTEGER NOT NULL DEFAULT 1
  CHECK (plan_notification_epoch > 0);

ALTER TABLE shared_plans
  ADD COLUMN notification_epoch INTEGER NOT NULL DEFAULT 1
  CHECK (notification_epoch > 0);

ALTER TABLE shared_plan_members
  ADD COLUMN notification_epoch INTEGER NOT NULL DEFAULT 1
  CHECK (notification_epoch > 0);

ALTER TABLE shared_plan_event_recipients
  ADD COLUMN membership_notification_epoch INTEGER NOT NULL DEFAULT 1
  CHECK (membership_notification_epoch > 0);

CREATE UNIQUE INDEX shared_plan_events_crdt_source
  ON shared_plan_events (plan_id, source_kind, source_id, event_type)
  WHERE source_id IS NOT NULL;

CREATE TABLE shared_plan_notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES shared_plan_events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  urgency TEXT NOT NULL CHECK (urgency IN ('routine', 'conflict')),
  collapse_key TEXT,
  plan_notification_epoch INTEGER NOT NULL DEFAULT 1
    CHECK (plan_notification_epoch > 0),
  membership_notification_epoch INTEGER NOT NULL
    DEFAULT 1
    CHECK (membership_notification_epoch > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'retry', 'delivered', 'dead', 'suppressed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at INTEGER NOT NULL,
  lease_expires_at INTEGER,
  apns_id TEXT,
  delivered_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (event_id, device_id)
) STRICT;

CREATE INDEX shared_plan_notification_deliveries_ready
  ON shared_plan_notification_deliveries (status, available_at, id);

PRAGMA foreign_key_check;
