-- Stable inbox pagination reads only recipient-row authority. Snapshot the
-- immutable event timestamp onto each recipient so the page order and cursor
-- remain valid even when membership or plan lifecycle state later changes.

ALTER TABLE shared_plan_event_recipients
  ADD COLUMN event_created_at INTEGER NOT NULL DEFAULT 0
  CHECK (event_created_at >= 0);

UPDATE shared_plan_event_recipients
SET event_created_at = (
  SELECT event.created_at
  FROM shared_plan_events AS event
  WHERE event.id = shared_plan_event_recipients.event_id
);

CREATE INDEX shared_plan_event_inbox_v2
  ON shared_plan_event_recipients (
    user_id, event_created_at DESC, event_id DESC
  );

PRAGMA foreign_key_check;
