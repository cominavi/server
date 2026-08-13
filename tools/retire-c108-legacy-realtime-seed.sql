-- One-time production cleanup after a complete C108 crawler snapshot is active.
-- The leading guard aborts Wrangler's file execution if publication has not completed.
-- Wrangler's remote D1 file import is already atomic, keeps foreign keys enabled,
-- and rejects both PRAGMA foreign_keys and TEMP tables. These short-lived ordinary
-- staging tables are dropped before the same import transaction commits.
CREATE TABLE cominavi_cleanup_require_c108_snapshot (
  ready INTEGER NOT NULL CHECK (ready = 1)
);
INSERT INTO cominavi_cleanup_require_c108_snapshot (ready)
SELECT CASE WHEN
  EXISTS (
    SELECT 1
    FROM crawler_snapshot_heads AS head
    JOIN crawler_snapshot_versions AS version
      ON version.event_number = head.event_number
     AND version.revision = head.revision
    WHERE head.event_number = 108
      AND head.revision = 'b51beff176fae5b9868382d1fa77f53dd94bb46d19ee576833a243d5b9f75e4c'
      AND head.generation = 1
      AND head.publication_cursor = 3406
      AND version.schema_version = 1
      AND version.generation = 1
      AND version.catalog_payload_sha256 = '8ba60301ce35f1c9c3ba49033235175ababf92655724e1f5a55fb5120e20ba56'
      AND version.update_count = 5402
      AND version.object_sha256 = '67cfc72931c7d77c2d72bc0cca6d8c7d765e6a2607e81c7efe3a36b6ca3f3341'
      AND version.byte_count = 8299125
      AND version.publication_cursor = 3406
      AND EXISTS (
        SELECT 1
        FROM crawler_snapshot_publication_receipts AS receipt
        WHERE receipt.event_number = head.event_number
          AND receipt.revision = head.revision
          AND receipt.generation = head.generation
      )
  )
  AND (
    (
      (SELECT COUNT(*) FROM circle_update_events WHERE source = 'seed:c108-local') = 3406 /* legacy-event-count */
      AND (
        SELECT COUNT(*)
        FROM circle_update_events AS event
        WHERE event.source = 'seed:c108-local'
          AND EXISTS (
            SELECT 1 FROM circle_update_targets AS target
            WHERE target.update_event_id = event.id AND target.comiket_no = 108
          )
      ) = 3406 /* legacy-c108-event-count */
      AND (
        SELECT COUNT(*)
        FROM circle_update_targets AS target
        JOIN circle_update_events AS event ON event.id = target.update_event_id
        WHERE event.source = 'seed:c108-local'
      ) = 9161 /* legacy-target-count */
      AND (
        SELECT COUNT(*)
        FROM circle_update_targets AS target
        JOIN circle_update_events AS event ON event.id = target.update_event_id
        WHERE event.source = 'seed:c108-local' AND target.comiket_no <> 108
      ) = 0
      AND (
        SELECT COUNT(*) FROM circle_update_events
        WHERE source = 'seed:c108-local'
          AND state_kind NOT IN ('shinagaki', 'cover')
      ) = 0
      AND (
        SELECT COUNT(*)
        FROM circle_state_heads AS head
        JOIN circle_update_events AS event ON event.id = head.update_event_id
        WHERE event.source = 'seed:c108-local'
      ) = 7071 /* legacy-head-count */
      AND (
        SELECT COUNT(*)
        FROM notification_deliveries AS delivery
        JOIN circle_update_events AS event ON event.id = delivery.update_event_id
        WHERE event.source = 'seed:c108-local'
      ) = 0
      AND (
        SELECT COUNT(DISTINCT event.post_id)
        FROM circle_update_events AS event
        WHERE event.source = 'seed:c108-local'
          AND NOT EXISTS (
            SELECT 1 FROM circle_update_events AS retained
            WHERE retained.post_id = event.post_id
              AND retained.source <> 'seed:c108-local'
          )
      ) = 3249 /* orphan-post-count */
      AND (
        SELECT COUNT(*)
        FROM post_media AS media
        WHERE EXISTS (
          SELECT 1
          FROM circle_update_events AS event
          WHERE event.source = 'seed:c108-local'
            AND event.post_id = media.post_id
            AND NOT EXISTS (
              SELECT 1 FROM circle_update_events AS retained
              WHERE retained.post_id = event.post_id
                AND retained.source <> 'seed:c108-local'
            )
        )
      ) = 4566 /* orphan-media-count */
      AND (SELECT COUNT(*) FROM ingest_batches WHERE source = 'seed:c108-local') = 1
      AND (SELECT COUNT(*) FROM seed_imports WHERE seed_key LIKE 'c108:%') = 1
    )
    OR (
      (SELECT COUNT(*) FROM circle_update_events WHERE source = 'seed:c108-local') = 0
      AND (SELECT COUNT(*) FROM ingest_batches WHERE source = 'seed:c108-local') = 0
      AND (SELECT COUNT(*) FROM seed_imports WHERE seed_key LIKE 'c108:%') = 0
    )
  )
THEN 1 ELSE 0 END;

CREATE TABLE cominavi_cleanup_retired_c108_seed_events (id INTEGER PRIMARY KEY);
INSERT INTO cominavi_cleanup_retired_c108_seed_events (id)
SELECT event.id
FROM circle_update_events AS event
WHERE event.source = 'seed:c108-local'
  AND EXISTS (SELECT 1 FROM cominavi_cleanup_require_c108_snapshot WHERE ready = 1)
  AND EXISTS (
    SELECT 1 FROM circle_update_targets AS target
    WHERE target.update_event_id = event.id AND target.comiket_no = 108
  );

CREATE TABLE cominavi_cleanup_retired_c108_seed_posts (post_id TEXT PRIMARY KEY);
INSERT INTO cominavi_cleanup_retired_c108_seed_posts (post_id)
SELECT DISTINCT event.post_id
FROM circle_update_events AS event
JOIN cominavi_cleanup_retired_c108_seed_events AS retired ON retired.id = event.id;

DELETE FROM circle_state_heads
WHERE update_event_id IN (SELECT id FROM cominavi_cleanup_retired_c108_seed_events)
  AND EXISTS (SELECT 1 FROM cominavi_cleanup_require_c108_snapshot WHERE ready = 1);

-- notification_deliveries and circle_update_targets cascade from the event.
DELETE FROM circle_update_events
WHERE id IN (SELECT id FROM cominavi_cleanup_retired_c108_seed_events)
  AND EXISTS (SELECT 1 FROM cominavi_cleanup_require_c108_snapshot WHERE ready = 1);

DELETE FROM post_media
WHERE post_id IN (SELECT post_id FROM cominavi_cleanup_retired_c108_seed_posts)
  AND EXISTS (SELECT 1 FROM cominavi_cleanup_require_c108_snapshot WHERE ready = 1)
  AND NOT EXISTS (
    SELECT 1 FROM circle_update_events AS event
    WHERE event.post_id = post_media.post_id
  );
DELETE FROM social_posts
WHERE post_id IN (SELECT post_id FROM cominavi_cleanup_retired_c108_seed_posts)
  AND EXISTS (SELECT 1 FROM cominavi_cleanup_require_c108_snapshot WHERE ready = 1)
  AND NOT EXISTS (
    SELECT 1 FROM circle_update_events AS event
    WHERE event.post_id = social_posts.post_id
  );

DELETE FROM ingest_batches
WHERE source = 'seed:c108-local'
  AND EXISTS (SELECT 1 FROM cominavi_cleanup_require_c108_snapshot WHERE ready = 1)
  AND NOT EXISTS (
    SELECT 1 FROM circle_update_events AS event
    WHERE event.ingest_batch_id = ingest_batches.id
  );
DELETE FROM seed_imports
WHERE seed_key LIKE 'c108:%'
  AND EXISTS (SELECT 1 FROM cominavi_cleanup_require_c108_snapshot WHERE ready = 1);

DROP TABLE cominavi_cleanup_retired_c108_seed_posts;
DROP TABLE cominavi_cleanup_retired_c108_seed_events;
DROP TABLE cominavi_cleanup_require_c108_snapshot;
