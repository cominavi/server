import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CatalogIdentityCollision,
  circlesStep,
  runCatalogIdentityBackfill,
} from "../src/lib/server/catalog-identity-backfill";
import {
  catalogEditionMetadataSchema,
  isCatalogEventKey,
  isCircleKey,
  readCatalogCapabilities,
} from "../src/lib/server/catalog-identity";
import { SQLiteD1Database } from "./sqlite-d1";

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
  "migrations/0011_catalog_identity.sql",
];

/** Shared fixtures from cominavi/cominavi fixtures/catalog-contracts (2a1394f). */
function fixture(name: string): any {
  return JSON.parse(
    readFileSync(`tests/fixtures/catalog-contracts/${name}`, "utf8"),
  );
}

function database(): SQLiteD1Database {
  return new SQLiteD1Database(
    migrations.map((path) => readFileSync(path, "utf8")).join("\n"),
  );
}

/** Seeds one published Comiket with `wcIDs` in the stable-circle authority. */
function seedComiket(
  db: SQLiteD1Database,
  input: {
    comiketNo: number;
    providerEventID: number | null;
    versionID: string;
    dates: string[];
    wcIDs: number[];
    publishedAt?: number;
  },
): void {
  const publishedAt = input.publishedAt ?? 1_786_280_400;
  db.native
    .prepare(
      `INSERT INTO catalog_events (comiket_no, name, provider_circlems_event_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1)`,
    )
    .run(
      input.comiketNo,
      `コミックマーケット${input.comiketNo}`,
      input.providerEventID,
    );
  db.native
    .prepare(
      `INSERT INTO catalog_versions (
         id, comiket_no, schema_version, state, claim_id, source_main_sha256,
         source_image_sha256, created_at, published_at
       ) VALUES (?, ?, 1, 'published', ?, ?, ?, 1, ?)`,
    )
    .run(
      input.versionID,
      input.comiketNo,
      `claim-${input.comiketNo}`,
      "1".repeat(64),
      "2".repeat(64),
      publishedAt,
    );
  const date = db.native.prepare(
    "INSERT INTO catalog_dates (version_id, day, date_iso, weekday) VALUES (?, ?, ?, 1)",
  );
  input.dates.forEach((iso, index) =>
    date.run(input.versionID, index + 1, iso),
  );
  addStableCircles(
    db,
    input.comiketNo,
    input.versionID,
    input.wcIDs,
    publishedAt,
  );
  db.native
    .prepare(
      "UPDATE catalog_events SET active_version_id = ? WHERE comiket_no = ?",
    )
    .run(input.versionID, input.comiketNo);
}

function addStableCircles(
  db: SQLiteD1Database,
  comiketNo: number,
  versionID: string,
  wcIDs: number[],
  publishedAt: number,
): void {
  const insert = db.native.prepare(
    `INSERT INTO catalog_stable_circles VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const wcID of wcIDs)
    insert.run(comiketNo, wcID, versionID, versionID, publishedAt, publishedAt);
}

function range(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => from + index);
}

function snapshot(db: SQLiteD1Database): unknown {
  return {
    editions: db.rows(
      "SELECT * FROM catalog_editions ORDER BY catalog_event_key",
    ),
    circles: db.rows(
      "SELECT * FROM catalog_edition_circles ORDER BY catalog_event_key, legacy_wc_id",
    ),
    aliases: db.rows(
      "SELECT * FROM catalog_provider_aliases ORDER BY alias_kind, alias_scope, alias_value",
    ),
  };
}

async function runToCompletion(
  db: SQLiteD1Database,
  now: number,
  options: { chunkSize?: number; maxChunks?: number } = {},
): Promise<number> {
  for (let runs = 1; runs <= 50; runs += 1) {
    const result = await runCatalogIdentityBackfill(db.binding, {
      now,
      ...options,
    });
    if (result.complete) return runs;
  }
  throw new Error("backfill did not complete");
}

test("shared manifest fixtures decode with the identity vocabulary", () => {
  for (const name of [
    "manifest-v2-comiket-108.json",
    "manifest-v2-comiket-109.json",
    "manifest-v2-fixture-mock-1.json",
  ]) {
    const manifest = fixture(name);
    const metadata = catalogEditionMetadataSchema.parse(manifest.metadata);
    assert.equal(metadata.catalogEventKey, manifest.catalogEventKey, name);
    assert.equal(metadata.legacyComiketNo, manifest.legacyComiketNo, name);
    assert.ok(
      isCatalogEventKey(manifest.catalogEventKey, metadata.seriesKey),
      name,
    );
  }
  const mock = fixture("manifest-v2-fixture-mock-1.json");
  const capabilities = readCatalogCapabilities(mock.capabilities);
  assert.equal(capabilities.catalogArtifact, true);
  assert.equal(capabilities.sharedPlans, false);
  assert.equal(
    capabilities.favorites,
    false,
    "omitted capability is unsupported",
  );
  assert.ok(
    !("futureCapabilityExample" in capabilities),
    "unknown names are ignored",
  );
  assert.deepEqual(
    Object.values(readCatalogCapabilities({ favorites: "partial" })).filter(
      Boolean,
    ),
    [],
  );
  assert.ok(!isCatalogEventKey("comiket-108", "fixture"));
  assert.ok(!isCatalogEventKey("c108", "comiket"));
  assert.ok(isCircleKey("10000001") && isCircleKey("m0b8x7k3q9d2r4t6v"));
  assert.ok(!isCircleKey("010") && !isCircleKey("m0b8x7k3q9d2r4t6i"));
});

test("backfills comiket-108/109 editions matching the shared fixtures, in restartable chunks", async () => {
  const db = database();
  seedComiket(db, {
    comiketNo: 108,
    providerEventID: 230,
    versionID: "c108-v1-0123456789abcdef01234567",
    dates: ["2026-08-15", "2026-08-16"],
    wcIDs: range(10_000_001, 1_234),
  });
  seedComiket(db, {
    comiketNo: 109,
    providerEventID: 231,
    versionID: "c109-v1-fedcba9876543210fedcba98",
    dates: ["2026-12-30", "2026-12-31"],
    wcIDs: range(20_000_001, 7),
  });

  const runs = await runToCompletion(db, 100, { chunkSize: 100, maxChunks: 3 });
  assert.ok(runs > 1, "the bounded run resumes from its checkpoint");

  for (const [key, name] of [
    ["comiket-108", "manifest-v2-comiket-108.json"],
    ["comiket-109", "manifest-v2-comiket-109.json"],
  ]) {
    const [edition] = db.rows(
      `SELECT * FROM catalog_editions WHERE catalog_event_key = '${key}'`,
    );
    assert.deepEqual(
      JSON.parse(String(edition.metadata_json)),
      fixture(name).metadata,
    );
    assert.equal(edition.series_key, "comiket");
    assert.equal(edition.listing_state, "listed");
    assert.equal(edition.metadata_revision, 1);
  }

  const counts = db.rows(`
    SELECT
      (SELECT count(*) FROM catalog_stable_circles) AS stable,
      (SELECT count(*) FROM catalog_edition_circles
         WHERE circle_key = CAST(legacy_wc_id AS TEXT)
           AND key_origin = 'provider_durable') AS circles,
      (SELECT count(*) FROM catalog_provider_aliases
         WHERE alias_kind = 'wcid' AND alias_value = circle_key
           AND alias_scope = catalog_event_key) AS aliases,
      (SELECT count(*) FROM catalog_stable_circles AS s
         JOIN catalog_edition_circles AS e
           ON e.legacy_wc_id = s.wc_id
          AND e.catalog_event_key = 'comiket-' || s.comiket_no
          AND e.first_version_id = s.first_version_id
          AND e.last_published_at = s.last_published_at) AS matched
  `)[0];
  assert.deepEqual(
    { ...counts },
    { stable: 1_241, circles: 1_241, aliases: 1_241, matched: 1_241 },
  );
  assert.deepEqual(
    db.rows(
      "SELECT alias_value, catalog_event_key FROM catalog_provider_aliases WHERE alias_kind = 'circlems_event_id' ORDER BY alias_value",
    ),
    [
      { alias_value: "230", catalog_event_key: "comiket-108" },
      { alias_value: "231", catalog_event_key: "comiket-109" },
    ],
  );
  assert.deepEqual(
    db.rows(
      "SELECT step, last_key, completed_at FROM catalog_identity_backfill_checkpoints ORDER BY step",
    ),
    [
      { step: "circles:comiket-108", last_key: "10001234", completed_at: 100 },
      { step: "circles:comiket-109", last_key: "20000007", completed_at: 100 },
      { step: "editions", last_key: "109", completed_at: 100 },
    ],
  );
});

test("a rerun is a no-op and a later publication is reconciled", async () => {
  const db = database();
  seedComiket(db, {
    comiketNo: 108,
    providerEventID: 230,
    versionID: "c108-v1-0123456789abcdef01234567",
    dates: ["2026-08-15", "2026-08-16"],
    wcIDs: range(10_000_010, 20),
  });
  await runToCompletion(db, 100);
  const before = snapshot(db);
  const rerun = await runCatalogIdentityBackfill(db.binding, { now: 200 });
  assert.deepEqual(rerun, {
    editions: 1,
    chunks: 0,
    circlesWritten: 0,
    complete: true,
  });
  assert.deepEqual(snapshot(db), before);

  // A newer published version adds a lower WCID and advances existing circles.
  db.native.exec(`
    INSERT INTO catalog_versions (id, comiket_no, schema_version, state, claim_id,
      source_main_sha256, source_image_sha256, created_at, published_at)
    VALUES ('c108-v1-111111111111111111111111', 108, 1, 'published', 'claim-2',
      '${"3".repeat(64)}', '${"4".repeat(64)}', 2, 1786290000);
    UPDATE catalog_stable_circles
       SET last_version_id = 'c108-v1-111111111111111111111111', last_published_at = 1786290000
     WHERE wc_id = 10000010;
    INSERT INTO catalog_stable_circles VALUES
      (108, 10000001, 'c108-v1-111111111111111111111111',
       'c108-v1-111111111111111111111111', 1786290000, 1786290000);
  `);
  await runToCompletion(db, 300);
  assert.deepEqual(
    db.rows(
      "SELECT circle_key, last_version_id, last_published_at FROM catalog_edition_circles WHERE legacy_wc_id IN (10000001, 10000010) ORDER BY legacy_wc_id",
    ),
    [
      {
        circle_key: "10000001",
        last_version_id: "c108-v1-111111111111111111111111",
        last_published_at: 1786290000,
      },
      {
        circle_key: "10000010",
        last_version_id: "c108-v1-111111111111111111111111",
        last_published_at: 1786290000,
      },
    ],
  );
  assert.equal(
    db.rows("SELECT count(*) AS n FROM catalog_edition_circles")[0].n,
    21,
  );
});

test("a crash inside a chunk batch leaves the checkpoint behind and resumes cleanly", async () => {
  const db = database();
  seedComiket(db, {
    comiketNo: 108,
    providerEventID: 230,
    versionID: "c108-v1-0123456789abcdef01234567",
    dates: ["2026-08-15"],
    wcIDs: range(10_000_001, 250),
  });
  await runCatalogIdentityBackfill(db.binding, {
    now: 100,
    chunkSize: 100,
    maxChunks: 1,
  });
  assert.equal(
    db.rows("SELECT count(*) AS n FROM catalog_edition_circles")[0].n,
    100,
  );
  db.beforeNextBatch = () => {
    throw new Error("isolate died");
  };
  await assert.rejects(
    runCatalogIdentityBackfill(db.binding, {
      now: 101,
      chunkSize: 100,
      maxChunks: 1,
    }),
    /isolate died/,
  );
  assert.equal(
    db.rows("SELECT count(*) AS n FROM catalog_edition_circles")[0].n,
    100,
  );
  assert.equal(
    db.rows(
      `SELECT last_key FROM catalog_identity_backfill_checkpoints WHERE step = '${circlesStep("comiket-108")}'`,
    )[0].last_key,
    "10000100",
  );
  await runToCompletion(db, 102, { chunkSize: 100 });
  assert.equal(
    db.rows("SELECT count(*) AS n FROM catalog_edition_circles")[0].n,
    250,
  );
});

test("an event without a provider ID or active version backfills as hidden", async () => {
  const db = database();
  db.native.exec(
    "INSERT INTO catalog_events (comiket_no, name, created_at, updated_at) VALUES (110, 'コミックマーケット110', 1, 1)",
  );
  await runToCompletion(db, 100);
  const [edition] = db.rows("SELECT * FROM catalog_editions");
  assert.equal(edition.catalog_event_key, "comiket-110");
  assert.equal(edition.listing_state, "hidden");
  assert.deepEqual(JSON.parse(String(edition.metadata_json)).days, []);
  assert.equal(
    db.rows("SELECT count(*) AS n FROM catalog_provider_aliases")[0].n,
    0,
  );
});

async function assertCollision(
  db: SQLiteD1Database,
  kind: string,
): Promise<void> {
  const before = snapshot(db);
  await assert.rejects(
    runCatalogIdentityBackfill(db.binding, { now: 500 }),
    (error: unknown) =>
      error instanceof CatalogIdentityCollision &&
      error.code === "catalog_identity_collision" &&
      error.kind === kind,
  );
  assert.deepEqual(snapshot(db), before, "a collision writes nothing");
}

function seededForCollision(): SQLiteD1Database {
  const db = database();
  seedComiket(db, {
    comiketNo: 108,
    providerEventID: 230,
    versionID: "c108-v1-0123456789abcdef01234567",
    dates: ["2026-08-15"],
    wcIDs: [777, 778],
  });
  return db;
}

function insertComiketEdition(db: SQLiteD1Database, key: string): void {
  db.native
    .prepare(
      `INSERT INTO catalog_editions VALUES (?, 'comiket', 108, 1, '{}', 1, 'circlems', 'hidden', 1, 1)`,
    )
    .run(key);
}

test("collision: the legacy number already belongs to another edition key", async () => {
  const db = seededForCollision();
  insertComiketEdition(db, "comiket-108-old");
  await assertCollision(db, "legacy_number_taken");
});

test("collision: the provider event ID already aliases another edition", async () => {
  const db = seededForCollision();
  db.native.exec(`
    INSERT INTO catalog_events (comiket_no, name, created_at, updated_at) VALUES (107, 'C107', 1, 1);
    INSERT INTO catalog_editions VALUES ('comiket-107', 'comiket', 107, 1, '{}', 1, 'circlems', 'hidden', 1, 1);
    INSERT INTO catalog_provider_aliases VALUES
      ('circlems', 'production', 'circlems_event_id', '', '230', 'comiket-107', NULL, 1, NULL);
  `);
  await assertCollision(db, "event_alias_conflict");
});

test("collision: the edition already has a different live provider event ID", async () => {
  const db = seededForCollision();
  await runToCompletion(db, 100);
  db.native.exec(
    "UPDATE catalog_events SET provider_circlems_event_id = 999 WHERE comiket_no = 108",
  );
  await assertCollision(db, "event_alias_conflict");
});

test("collision: an edition circle disagrees with the legacy WCID", async () => {
  const db = seededForCollision();
  await runCatalogIdentityBackfill(db.binding, { now: 100, maxChunks: 0 });
  db.native.exec(`
    INSERT INTO catalog_edition_circles VALUES
      ('comiket-108', '777', 778, 'provider_durable',
       'c108-v1-0123456789abcdef01234567', 'c108-v1-0123456789abcdef01234567', 1, 1);
  `);
  await assertCollision(db, "circle_key_conflict");
});

test("collision: a WCID alias points at another circle key", async () => {
  const db = seededForCollision();
  await runCatalogIdentityBackfill(db.binding, { now: 100, maxChunks: 0 });
  db.native.exec(`
    INSERT INTO catalog_provider_aliases VALUES
      ('circlems', 'production', 'wcid', 'comiket-108', '777', 'comiket-108', '778', 1, NULL);
  `);
  await assertCollision(db, "circle_alias_conflict");
});

test("a publication between chunks that advances already-copied circles is reconciled", async () => {
  const db = database();
  seedComiket(db, {
    comiketNo: 108,
    providerEventID: 230,
    versionID: "c108-v1-0123456789abcdef01234567",
    dates: ["2026-08-15"],
    wcIDs: [1, 2, 3, 4],
    publishedAt: 100,
  });
  await runCatalogIdentityBackfill(db.binding, {
    now: 1,
    chunkSize: 2,
    maxChunks: 1,
  });
  db.native.exec(`
    INSERT INTO catalog_versions (id, comiket_no, schema_version, state, claim_id,
      source_main_sha256, source_image_sha256, created_at, published_at)
    VALUES ('c108-v1-222222222222222222222222', 108, 1, 'published', 'claim-2',
      '${"5".repeat(64)}', '${"6".repeat(64)}', 2, 200);
    UPDATE catalog_stable_circles
       SET last_version_id = 'c108-v1-222222222222222222222222', last_published_at = 200;
  `);
  await runToCompletion(db, 2, { chunkSize: 2 });
  await runToCompletion(db, 3, { chunkSize: 2 });
  assert.deepEqual(
    db.rows(
      "SELECT DISTINCT last_version_id, last_published_at FROM catalog_edition_circles",
    ),
    [
      {
        last_version_id: "c108-v1-222222222222222222222222",
        last_published_at: 200,
      },
    ],
  );
});

test("collision: two legacy events share one provider event ID", async () => {
  const db = database();
  seedComiket(db, {
    comiketNo: 108,
    providerEventID: 230,
    versionID: "c108-v1-0123456789abcdef01234567",
    dates: ["2026-08-15"],
    wcIDs: [1],
  });
  seedComiket(db, {
    comiketNo: 109,
    providerEventID: 230,
    versionID: "c109-v1-fedcba9876543210fedcba98",
    dates: ["2026-12-30"],
    wcIDs: [2],
  });
  await assertCollision(db, "event_alias_conflict");
});

test("collision: a disagreeing WCID alias racing the chunk batch rolls it back", async () => {
  const db = seededForCollision();
  await runCatalogIdentityBackfill(db.binding, { now: 100, maxChunks: 0 });
  // Skip the edition batch; race the first circle chunk batch.
  db.beforeNextBatch = () => {
    db.beforeNextBatch = () => {
      db.native.exec(`
        INSERT INTO catalog_provider_aliases VALUES
          ('circlems', 'production', 'wcid', 'comiket-108', '777', 'comiket-108', '778', 1, NULL);
      `);
    };
  };
  await assert.rejects(
    runCatalogIdentityBackfill(db.binding, { now: 101 }),
    (error: unknown) =>
      error instanceof CatalogIdentityCollision &&
      error.kind === "circle_key_conflict",
  );
  assert.equal(
    db.rows("SELECT count(*) AS n FROM catalog_edition_circles")[0].n,
    0,
  );
  assert.equal(
    db.rows(
      `SELECT count(*) AS n FROM catalog_identity_backfill_checkpoints WHERE step = 'circles:comiket-108'`,
    )[0].n,
    0,
  );
  await assertCollision(db, "circle_alias_conflict");
});
