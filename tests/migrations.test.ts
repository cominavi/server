import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrations = [
  "migrations/0001_following_imports.sql",
  "migrations/0002_realtime_service.sql",
  "migrations/0003_accounts_shared_plans.sql",
  "migrations/0004_sanitized_catalog.sql",
  "migrations/0005_shared_plan_crdt_notifications.sql",
  "migrations/0006_notification_inbox.sql",
  "migrations/0007_catalog_genres_all_days.sql",
  "migrations/0008_circle_tag_overlays.sql",
  "migrations/0009_crawler_realtime_snapshots.sql",
  "migrations/0010_shinagaki_analysis.sql",
];

test("provider-neutral migration preserves every existing user-dependent row in a D1 transaction", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(readFileSync(migrations[0], "utf8"));
  database.exec(readFileSync(migrations[1], "utf8"));
  database.exec(`
    INSERT INTO users (
      id, subject, circlems_environment, circlems_user_id, nickname,
      auth_version, created_at, updated_at, last_authenticated_at
    ) VALUES (42, 'legacy-subject', 'production', 777, 'Legacy User', 4, 10, 11, 12);
    INSERT INTO circles (
      comiket_no, wc_id, circle_name, pen_name, created_at, updated_at
    ) VALUES (108, 9001, 'Circle', 'Pen', 10, 10);
    INSERT INTO favorite_sets (user_id, comiket_no, revision, updated_at)
    VALUES (42, 108, 3, 20);
    INSERT INTO user_favorites (
      user_id, comiket_no, wc_id, snapshot_revision, created_at, updated_at
    ) VALUES (42, 108, 9001, 3, 20, 20);
    INSERT INTO ingest_batches (
      id, source, idempotency_key, payload_sha256, schema_version,
      observed_at, received_at, raw_payload_json
    ) VALUES (51, 'test', 'batch', '${"a".repeat(64)}', 1, 20, 20, '{}');
    INSERT INTO social_posts (
      post_id, author_handle, text, occurred_at, latest_observed_at, raw_post_json
    ) VALUES ('post', 'author', 'text', 20, 20, '{}');
    INSERT INTO circle_update_events (
      id, event_key, ingest_batch_id, source, source_revision, post_id,
      update_kind, state_kind, state_value, confidence, occurred_at, created_at
    ) VALUES (73, 'event', 51, 'test', 1, 'post', 'change', 'presence',
              'present', 'high', 20, 20);
    INSERT INTO push_devices (
      id, user_id, installation_id, token, token_sha256, apns_environment,
      bundle_id, created_at, updated_at, last_registered_at
    ) VALUES (99, 42, 'installation', '${"b".repeat(64)}', '${"c".repeat(64)}',
              'sandbox', 'llc.mikunet.cominavi.debug', 20, 20, 20);
    INSERT INTO notification_deliveries (
      id, update_event_id, user_id, device_id, available_at, created_at, updated_at
    ) VALUES (123, 73, 42, 99, 20, 20, 20);
  `);

  database.exec("BEGIN IMMEDIATE");
  database.exec(readFileSync(migrations[2], "utf8"));
  database.exec(readFileSync(migrations[3], "utf8"));
  database.exec(readFileSync(migrations[4], "utf8"));
  database.exec(`
    INSERT INTO shared_plans (
      id, comiket_no, name, owner_user_id, revision, created_at, updated_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 108, 'Migration', 42, 1, 20, 20
    );
    INSERT INTO shared_plan_members (
      plan_id, user_id, role, joined_at, updated_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 42, 'owner', 20, 20
    );
    INSERT INTO shared_plan_events (
      id, plan_id, actor_user_id, event_type, i18n_key,
      payload_version, payload_json, created_at
    ) VALUES (
      '${"d".repeat(64)}', '11111111-1111-4111-8111-111111111111', 42,
      'shared_plan.circle.presence.v1', 'shared_plan.circle.presence',
      1, '{"v":1}', 123
    );
    INSERT INTO shared_plan_event_recipients (event_id, user_id, read_at)
    VALUES ('${"d".repeat(64)}', 42, NULL);
  `);
  database.exec(readFileSync(migrations[5], "utf8"));
  database.exec(readFileSync(migrations[6], "utf8"));
  database.exec(readFileSync(migrations[7], "utf8"));
  database.exec(readFileSync(migrations[8], "utf8"));
  database.exec(readFileSync(migrations[9], "utf8"));
  database.exec("COMMIT");

  assert.deepEqual(
    {
      ...(database
        .prepare(
          `SELECT
           (SELECT count(*) FROM users) AS users,
           (SELECT count(*) FROM user_identities) AS identities,
           (SELECT count(*) FROM favorite_sets) AS favorite_sets,
           (SELECT count(*) FROM user_favorites) AS user_favorites,
           (SELECT count(*) FROM push_devices) AS push_devices,
           (SELECT count(*) FROM notification_deliveries) AS deliveries`,
        )
        .get() as Record<string, unknown>),
    },
    {
      users: 1,
      identities: 1,
      favorite_sets: 1,
      user_favorites: 1,
      push_devices: 1,
      deliveries: 1,
    },
  );
  assert.deepEqual(
    {
      ...(database
        .prepare(
          `SELECT user.id, user.display_name, user.auth_version,
                identity.provider, identity.provider_environment,
                identity.provider_subject, identity.provider_user_id
         FROM users AS user
         JOIN user_identities AS identity ON identity.user_id = user.id`,
        )
        .get() as Record<string, unknown>),
    },
    {
      id: 42,
      display_name: "Legacy User",
      auth_version: 4,
      provider: "circlems",
      provider_environment: "production",
      provider_subject: "777",
      provider_user_id: 777,
    },
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(
    (
      database
        .prepare(
          `SELECT event_created_at FROM shared_plan_event_recipients
           WHERE event_id = ?`,
        )
        .all("d".repeat(64)) as Array<{ event_created_at: number }>
    ).map((row) => ({ ...row })),
    [{ event_created_at: 123 }],
  );
  assert.deepEqual(
    (
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name = 'shared_plan_event_inbox_v2'`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => ({ ...row })),
    [{ name: "shared_plan_event_inbox_v2" }],
  );
  assert.deepEqual(
    (
      database
        .prepare(
          `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'catalog_versions', 'catalog_circles', 'catalog_artifacts',
           'provider_credentials', 'circle_tag_overlay_versions',
           'circle_tag_overlay_heads',
           'circle_tag_overlay_publication_receipts',
           'crawler_snapshot_versions', 'crawler_snapshot_heads',
           'crawler_snapshot_publication_receipts',
           'shinagaki_analysis_versions', 'shinagaki_analysis_records',
           'shinagaki_analysis_heads'
         ) ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => ({ ...row })),
    [
      { name: "catalog_artifacts" },
      { name: "catalog_circles" },
      { name: "catalog_versions" },
      { name: "circle_tag_overlay_heads" },
      { name: "circle_tag_overlay_publication_receipts" },
      { name: "circle_tag_overlay_versions" },
      { name: "crawler_snapshot_heads" },
      { name: "crawler_snapshot_publication_receipts" },
      { name: "crawler_snapshot_versions" },
      { name: "provider_credentials" },
      { name: "shinagaki_analysis_heads" },
      { name: "shinagaki_analysis_records" },
      { name: "shinagaki_analysis_versions" },
    ],
  );
  assert.equal(
    (
      database
        .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'")
        .get() as { seq: number } | undefined
    )?.seq,
    42,
  );
});
