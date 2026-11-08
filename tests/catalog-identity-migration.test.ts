import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const priorMigrations = [
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
const identityMigration = "migrations/0011_catalog_identity.sql";

/** The documented rollback for 0011 (also listed in the PR body). */
export const catalogIdentityRollbackSQL = `
ALTER TABLE catalog_versions DROP COLUMN capability_snapshot_json;
ALTER TABLE catalog_versions DROP COLUMN source_adapter_version;
ALTER TABLE catalog_versions DROP COLUMN artifact_format;
ALTER TABLE catalog_versions DROP COLUMN catalog_event_key;
DROP TABLE catalog_identity_backfill_checkpoints;
DROP TABLE catalog_edition_circles;
DROP INDEX catalog_provider_aliases_live_target;
DROP TABLE catalog_provider_aliases;
DROP TABLE catalog_edition_capabilities;
DROP TABLE catalog_editions;
`;

function priorDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of priorMigrations)
    database.exec(readFileSync(migration, "utf8"));
  database.exec(`
    INSERT INTO catalog_events (comiket_no, name, provider_circlems_event_id, created_at, updated_at)
    VALUES (108, 'コミックマーケット108', 230, 1, 1);
    INSERT INTO catalog_import_claims (comiket_no, claim_id, lease_expires_at, created_at, updated_at)
    VALUES (108, 'claim', 9999999999, 1, 1);
  `);
  database.exec(`
    INSERT INTO catalog_versions (
      id, comiket_no, schema_version, state, claim_id, source_main_sha256,
      source_image_sha256, created_at
    ) VALUES (
      'c108-v1-0123456789abcdef01234567', 108, 1, 'published', 'claim',
      '${"1".repeat(64)}', '${"2".repeat(64)}', 1
    );
  `);
  return database;
}

function schemaSnapshot(database: DatabaseSync): string[] {
  return (
    database
      .prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Array<{ type: string; name: string; sql: string | null }>
  ).map((row) => `${row.type}|${row.name}|${row.sql ?? ""}`);
}

function migrated(): DatabaseSync {
  const database = priorDatabase();
  database.exec(readFileSync(identityMigration, "utf8"));
  return database;
}

function insertEdition(
  database: DatabaseSync,
  key: string,
  series: string,
  legacy: number | null,
): void {
  database
    .prepare(
      `INSERT INTO catalog_editions (
        catalog_event_key, series_key, legacy_comiket_no, metadata_schema_version,
        metadata_json, metadata_revision, source_provider, listing_state,
        created_at, updated_at
      ) VALUES (?, ?, ?, 1, '{}', 1, ?, 'hidden', 1, 1)`,
    )
    .run(key, series, legacy, series === "comiket" ? "circlems" : "fixture");
}

test("0011 is additive: existing catalog rows survive with NULL identity columns", () => {
  const database = migrated();
  const row = database
    .prepare(
      "SELECT id, state, catalog_event_key, artifact_format, source_adapter_version, capability_snapshot_json FROM catalog_versions",
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...row },
    {
      id: "c108-v1-0123456789abcdef01234567",
      state: "published",
      catalog_event_key: null,
      artifact_format: null,
      source_adapter_version: null,
      capability_snapshot_json: null,
    },
  );
  assert.equal(
    (database.prepare("PRAGMA foreign_key_check").all() as unknown[]).length,
    0,
  );
});

test("catalogEventKey format follows the approved slug and reserved-prefix rules", () => {
  const database = migrated();
  insertEdition(database, "comiket-108", "comiket", 108);
  insertEdition(database, "fixture-mock-1", "fixture", null);
  insertEdition(database, "abc", "fixture", null);
  for (const [key, series, legacy] of [
    ["c108", "fixture", null],
    ["c1", "fixture", null],
    ["event-1", "fixture", null],
    ["Comiket-1", "fixture", null],
    ["1comiket", "fixture", null],
    ["fixture--mock", "fixture", null],
    ["fixture-", "fixture", null],
    ["ab", "fixture", null],
    ["a".repeat(65), "fixture", null],
    ["fixture_mock", "fixture", null],
    ["comiket-109", "fixture", null],
  ] as const) {
    assert.throws(
      () => insertEdition(database, key, series, legacy),
      /CHECK constraint failed/,
      key,
    );
  }
});

test("series and legacy Comiket number must agree", () => {
  const database = migrated();
  assert.throws(
    () => insertEdition(database, "comiket-108", "comiket", null),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insertEdition(database, "fixture-mock-1", "fixture", 108),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insertEdition(database, "comiket-999", "comiket", 999),
    /FOREIGN KEY constraint failed/,
  );
  insertEdition(database, "comiket-108", "comiket", 108);
  assert.throws(
    () => insertEdition(database, "comiket-108b", "comiket", 108),
    /UNIQUE constraint failed/,
  );
});

test("circleKey accepts canonical WCID and minted Crockford keys only", () => {
  const database = migrated();
  insertEdition(database, "comiket-108", "comiket", 108);
  const insert = database.prepare(
    `INSERT INTO catalog_edition_circles (
      catalog_event_key, circle_key, legacy_wc_id, key_origin,
      first_version_id, last_version_id, first_published_at, last_published_at
    ) VALUES ('comiket-108', ?, ?, ?, 'c108-v1-0123456789abcdef01234567',
              'c108-v1-0123456789abcdef01234567', 1, 1)`,
  );
  insert.run("12345678", 12345678, "provider_durable");
  insert.run("m0b8x7k3q9d2r4t6v", null, "minted");
  insert.run("m1c9y8m4r0e3s5w7x", null, "minted");
  for (const key of [
    "012345",
    "",
    "12a",
    "m0b8x7k3q9d2r4t6",
    "m0b8x7k3q9d2r4t6vv",
    "m0b8x7k3q9d2r4t6i",
    "m0b8x7k3q9d2r4t6L",
    "p9f3k2",
  ]) {
    assert.throws(
      () => insert.run(key, null, "minted"),
      /CHECK constraint failed/,
      key,
    );
  }
  assert.throws(
    () => insert.run("87654321", 12345678, "provider_durable"),
    /UNIQUE constraint failed/,
  );
});

test("capability names and states are a closed vocabulary", () => {
  const database = migrated();
  insertEdition(database, "comiket-108", "comiket", 108);
  const insert = database.prepare(
    "INSERT INTO catalog_edition_capabilities VALUES ('comiket-108', ?, ?, 1)",
  );
  insert.run("sharedPlans", "supported");
  insert.run("structuredShinagaki", "unsupported");
  assert.throws(
    () => insert.run("futureCapabilityExample", "supported"),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insert.run("favorites", "partial"),
    /CHECK constraint failed/,
  );
});

test("a target has at most one live alias per kind; retired aliases do not block", () => {
  const database = migrated();
  insertEdition(database, "comiket-108", "comiket", 108);
  const insert = database.prepare(
    `INSERT INTO catalog_provider_aliases VALUES
     ('circlems', 'production', ?, ?, ?, 'comiket-108', ?, 1, ?)`,
  );
  insert.run("circlems_event_id", "", "230", null, null);
  assert.throws(
    () => insert.run("circlems_event_id", "", "231", null, null),
    /UNIQUE constraint failed/,
  );
  database.exec(
    "UPDATE catalog_provider_aliases SET retired_at = 2 WHERE alias_value = '230'",
  );
  insert.run("circlems_event_id", "", "231", null, null);
  insert.run("wcid", "comiket-108", "12345678", "12345678", null);
  assert.throws(
    () => insert.run("wcid", "comiket-108", "12345678", "87654321", null),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => insert.run("wcid", "comiket-108", "11111111", "12345678", null),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () =>
      database.exec(
        "INSERT INTO catalog_provider_aliases VALUES ('circlems', 'sandbox', 'wcid', 'comiket-108', '2', 'comiket-108', '2', 1, NULL)",
      ),
    /CHECK constraint failed/,
  );
});

test("the documented rollback restores the exact pre-0011 schema and keeps data", () => {
  const before = priorDatabase();
  const expected = schemaSnapshot(before);
  const database = migrated();
  insertEdition(database, "comiket-108", "comiket", 108);
  database.exec(catalogIdentityRollbackSQL);
  assert.deepEqual(schemaSnapshot(database), expected);
  assert.equal(
    (
      database
        .prepare("SELECT count(*) AS count FROM catalog_versions")
        .get() as {
        count: number;
      }
    ).count,
    1,
  );
  database.exec(readFileSync(identityMigration, "utf8"));
});
