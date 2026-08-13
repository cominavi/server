-- One-time production cleanup after a complete C108 crawler snapshot is active.
-- The leading guard aborts Wrangler's file execution if publication has not completed.
-- D1 does not require or safely emulate an explicit multi-statement transaction here;
-- after the guard, every delete is idempotent and scoped to the legacy seed authority.
PRAGMA foreign_keys = ON;
CREATE TEMP TABLE require_c108_snapshot (
  ready INTEGER NOT NULL CHECK (ready = 1)
);
INSERT INTO require_c108_snapshot (ready)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM crawler_snapshot_heads WHERE event_number = 108
) THEN 1 ELSE 0 END;

CREATE TEMP TABLE retired_c108_seed_events (id INTEGER PRIMARY KEY);
INSERT INTO retired_c108_seed_events (id)
SELECT event.id
FROM circle_update_events AS event
WHERE event.source = 'seed:c108-local'
  AND EXISTS (
    SELECT 1 FROM crawler_snapshot_heads WHERE event_number = 108
  )
  AND EXISTS (
    SELECT 1 FROM circle_update_targets AS target
    WHERE target.update_event_id = event.id AND target.comiket_no = 108
  );

CREATE TEMP TABLE retired_c108_seed_posts (post_id TEXT PRIMARY KEY);
INSERT INTO retired_c108_seed_posts (post_id)
SELECT DISTINCT event.post_id
FROM circle_update_events AS event
JOIN retired_c108_seed_events AS retired ON retired.id = event.id;

DELETE FROM circle_state_heads
WHERE update_event_id IN (SELECT id FROM retired_c108_seed_events)
  AND EXISTS (
    SELECT 1 FROM crawler_snapshot_heads WHERE event_number = 108
  );

-- notification_deliveries and circle_update_targets cascade from the event.
DELETE FROM circle_update_events
WHERE id IN (SELECT id FROM retired_c108_seed_events)
  AND EXISTS (
    SELECT 1 FROM crawler_snapshot_heads WHERE event_number = 108
  );

DELETE FROM post_media
WHERE post_id IN (SELECT post_id FROM retired_c108_seed_posts)
  AND EXISTS (
    SELECT 1 FROM crawler_snapshot_heads WHERE event_number = 108
  )
  AND NOT EXISTS (
    SELECT 1 FROM circle_update_events AS event
    WHERE event.post_id = post_media.post_id
  );
DELETE FROM social_posts
WHERE post_id IN (SELECT post_id FROM retired_c108_seed_posts)
  AND EXISTS (
    SELECT 1 FROM crawler_snapshot_heads WHERE event_number = 108
  )
  AND NOT EXISTS (
    SELECT 1 FROM circle_update_events AS event
    WHERE event.post_id = social_posts.post_id
  );

DELETE FROM ingest_batches
WHERE source = 'seed:c108-local'
  AND EXISTS (
    SELECT 1 FROM crawler_snapshot_heads WHERE event_number = 108
  )
  AND NOT EXISTS (
    SELECT 1 FROM circle_update_events AS event
    WHERE event.ingest_batch_id = ingest_batches.id
  );
DELETE FROM seed_imports
WHERE seed_key LIKE 'c108:%'
  AND EXISTS (
    SELECT 1 FROM crawler_snapshot_heads WHERE event_number = 108
  );

DROP TABLE retired_c108_seed_posts;
DROP TABLE retired_c108_seed_events;
DROP TABLE require_c108_snapshot;
