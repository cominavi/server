import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertNotProduction,
  assertReadOnlySQL,
  CloudflareAPISource,
  exportPublishedData,
  importBundle,
  mirrorResources,
  readWranglerConfig,
  type MirrorTarget,
} from "../tools/mirror-published-data";
import { SQLiteD1Database } from "./sqlite-d1";

const migrations = readdirSync("migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(`migrations/${name}`, "utf8"))
  .join("\n");

const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const derivedBytes = new TextEncoder().encode("sanitized catalog sqlite");
const rawBytes = new TextEncoder().encode("RAW CIRCLE.MS DATABASE");
const overlayBytes = new TextEncoder().encode('{"overlay":1}');
const snapshotBytes = new TextEncoder().encode('{"snapshot":1}');
const derivedKey = "derived/catalogs/c108/v2/catalog.sqlite";
const rawKey = "raw/catalogs/c108/main.sqlite";
const overlayRevision = sha("overlay-revision");
const overlayKey = `derived/tag-overlays/v1/c108/${overlayRevision}.json`;
const snapshotRevision = sha("snapshot-revision");
const snapshotKey = `crawler-realtime/v1/events/108/sha256/${snapshotRevision}.json`;

class MemoryBucket {
  readonly objects = new Map<
    string,
    {
      bytes: Uint8Array;
      contentType?: string;
      customMetadata: Record<string, string>;
    }
  >();
  puts = 0;

  readonly binding = {
    head: async (key: string) => this.describe(key),
    get: async (key: string) => {
      const object = this.objects.get(key);
      return object ? { ...this.describe(key), bytes: object.bytes } : null;
    },
    put: async (
      key: string,
      bytes: Uint8Array,
      options: {
        httpMetadata?: { contentType?: string };
        customMetadata?: Record<string, string>;
      },
    ) => {
      this.puts += 1;
      this.objects.set(key, {
        bytes: new Uint8Array(bytes),
        contentType: options.httpMetadata?.contentType,
        customMetadata: { ...options.customMetadata },
      });
      return this.describe(key);
    },
  } as unknown as R2Bucket;

  private describe(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      size: object.bytes.byteLength,
      httpMetadata: { contentType: object.contentType },
      customMetadata: object.customMetadata,
    } as unknown as R2Object;
  }
}

function seedProduction(database: SQLiteD1Database): void {
  database.native.exec(`
    INSERT INTO catalog_events (comiket_no, name, created_at, updated_at)
    VALUES (108, 'C108', 1, 1);
    INSERT INTO catalog_editions (
      catalog_event_key, series_key, legacy_comiket_no, metadata_schema_version,
      metadata_json, metadata_revision, source_provider, listing_state,
      created_at, updated_at
    ) VALUES ('comiket-108', 'comiket', 108, 1, '{}', 1, 'circlems', 'listed', 1, 1);
    INSERT INTO catalog_versions (
      id, comiket_no, schema_version, state, claim_id,
      source_main_sha256, source_image_sha256, circle_count,
      created_at, published_at, catalog_event_key
    ) VALUES
      ('c108-v1', 108, 1, 'superseded', 'claim-1',
       '${"1".repeat(64)}', '${"2".repeat(64)}', 1, 1, 1, 'comiket-108'),
      ('c108-v2', 108, 1, 'published', 'claim-2',
       '${sha(rawBytes)}', '${"4".repeat(64)}', 2, 2, 2, 'comiket-108'),
      ('c108-v3', 108, 1, 'staging', 'claim-3',
       '${"5".repeat(64)}', '${"6".repeat(64)}', 0, 3, NULL, 'comiket-108');
    INSERT INTO catalog_dates (version_id, day, date_iso, weekday) VALUES
      ('c108-v1', 1, '2026-08-15', 6),
      ('c108-v2', 1, '2026-08-15', 6);
    INSERT INTO catalog_circles (
      version_id, comiket_no, wc_id, day, name, kana, pen_name, book_name, description
    ) VALUES
      ('c108-v1', 108, 101, 1, 'Old 101', '', '', '', ''),
      ('c108-v2', 108, 101, 1, 'Circle 101', '', '', '', ''),
      ('c108-v2', 108, 202, 1, 'Circle 202', '', '', '', '');
    INSERT INTO catalog_stable_circles (
      comiket_no, wc_id, first_version_id, last_version_id,
      first_published_at, last_published_at
    ) VALUES
      (108, 101, 'c108-v1', 'c108-v2', 1, 2),
      (108, 202, 'c108-v2', 'c108-v2', 2, 2);
    INSERT INTO catalog_artifacts (
      version_id, kind, visibility, object_key, sha256, byte_count,
      content_type, created_at
    ) VALUES
      ('c108-v2', 'source_main', 'private_source', '${rawKey}',
       '${sha(rawBytes)}', ${rawBytes.byteLength}, 'application/vnd.sqlite3', 2),
      ('c108-v2', 'derived_catalog', 'authenticated_download', '${derivedKey}',
       '${sha(derivedBytes)}', ${derivedBytes.byteLength}, 'application/vnd.sqlite3', 2);
    UPDATE catalog_events SET active_version_id = 'c108-v2' WHERE comiket_no = 108;

    INSERT INTO circle_tag_overlay_versions (
      event_number, revision, schema_version, catalog_version_id,
      catalog_payload_sha256, taxonomy_revision, matching_policy_revision,
      evaluated_circle_count, tagged_circle_count, term_count, object_key,
      object_sha256, byte_count, published_at
    ) VALUES (
      108, '${overlayRevision}', 1, 'c108-v2', '${"7".repeat(64)}', 'tax-1',
      'match-1', 2, 1, 1, '${overlayKey}', '${sha(overlayBytes)}',
      ${overlayBytes.byteLength}, 5
    );
    INSERT INTO circle_tag_overlay_heads (
      event_number, revision, publication_idempotency_key, updated_at
    ) VALUES (108, '${overlayRevision}', 'overlay-publication-1', 5);
    INSERT INTO crawler_snapshot_versions (
      event_number, revision, schema_version, generation, catalog_payload_sha256,
      matching_policy_revision, observed_at, update_count, object_key,
      object_sha256, byte_count, publication_cursor, published_at
    ) VALUES (
      108, '${snapshotRevision}', 1, 1, '${"8".repeat(64)}', 'match-1', 6, 0,
      '${snapshotKey}', '${sha(snapshotBytes)}', ${snapshotBytes.byteLength}, 0, 6
    );
    INSERT INTO crawler_snapshot_heads (
      event_number, revision, generation, publication_cursor,
      publication_idempotency_key, updated_at
    ) VALUES (108, '${snapshotRevision}', 1, 0, 'snapshot-publication-1', 6);

    INSERT INTO users (
      public_id, display_name, profile_revision, auth_version, created_at,
      updated_at, last_authenticated_at
    ) VALUES ('${"a".repeat(32)}', 'Private Person', 1, 1, 1, 1, 1);
  `);
}

function productionBuckets() {
  const downloads = new MemoryBucket();
  const catalogs = new MemoryBucket();
  downloads.objects.set(derivedKey, {
    bytes: derivedBytes,
    contentType: "application/vnd.sqlite3",
    customMetadata: {},
  });
  catalogs.objects.set(rawKey, { bytes: rawBytes, customMetadata: {} });
  catalogs.objects.set(overlayKey, { bytes: overlayBytes, customMetadata: {} });
  catalogs.objects.set(snapshotKey, {
    bytes: snapshotBytes,
    customMetadata: {},
  });
  return { downloads, catalogs };
}

/** A fake Cloudflare REST API backed by the production fixture. */
function cloudflareAPI(
  database: SQLiteD1Database,
  buckets: ReturnType<typeof productionBuckets>,
  calls: string[],
  queries: string[],
) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer read-only-token",
    );
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const query = url.pathname.match(/\/d1\/database\/prod-db\/query$/);
    if (query) {
      const { sql, params } = JSON.parse(String(init?.body)) as {
        sql: string;
        params: Array<string | number>;
      };
      queries.push(sql);
      const results = database.native.prepare(sql).all(...params);
      return Response.json({
        success: true,
        result: [{ success: true, results }],
      });
    }
    const object = url.pathname.match(/\/r2\/buckets\/([^/]+)\/objects\/(.+)$/);
    if (object && (init?.method ?? "GET") === "GET") {
      const bucket =
        object[1] === "prod-downloads" ? buckets.downloads : buckets.catalogs;
      const key = object[2]!.split("/").map(decodeURIComponent).join("/");
      const stored = bucket.objects.get(key);
      return stored
        ? new Response(new Uint8Array(stored.bytes))
        : new Response("missing", { status: 404 });
    }
    return new Response("unexpected", { status: 500 });
  };
}

function setup() {
  const production = new SQLiteD1Database(migrations);
  seedProduction(production);
  const sourceBuckets = productionBuckets();
  const calls: string[] = [];
  const queries: string[] = [];
  const source = new CloudflareAPISource({
    accountID: "account",
    databaseID: "prod-db",
    buckets: { downloads: "prod-downloads", catalogs: "prod-catalogs" },
    token: "read-only-token",
    fetch: cloudflareAPI(
      production,
      sourceBuckets,
      calls,
      queries,
    ) as typeof fetch,
  });
  const staging = new SQLiteD1Database(migrations);
  const targetBuckets = {
    downloads: new MemoryBucket(),
    catalogs: new MemoryBucket(),
  };
  const target: MirrorTarget = {
    database: staging.binding,
    buckets: {
      downloads: targetBuckets.downloads.binding,
      catalogs: targetBuckets.catalogs.binding,
    },
  };
  const bundle = mkdtempSync(join(tmpdir(), "cominavi-mirror-test-"));
  return {
    production,
    sourceBuckets,
    source,
    calls,
    queries,
    staging,
    targetBuckets,
    target,
    bundle,
  };
}

const count = (database: SQLiteD1Database, sql: string) =>
  (database.native.prepare(sql).get() as { n: number }).n;

test("export reads production with SELECTs and GETs only and never touches raw or user data", async () => {
  const { source, calls, queries, bundle } = setup();
  const manifest = await exportPublishedData(source, bundle);

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.match(
      call,
      /^(POST \/client\/v4\/accounts\/account\/d1\/database\/prod-db\/query|GET \/client\/v4\/accounts\/account\/r2\/)/,
    );
  }
  assert.ok(!calls.some((call) => call.includes("raw/")), "raw object fetched");
  assert.deepEqual(
    manifest.objects.map((object) => object.key).sort(),
    [derivedKey, overlayKey, snapshotKey].sort(),
  );
  const tables = new Map(
    manifest.tables.map((table) => [table.table, table.rows]),
  );
  for (const sql of queries) {
    assert.match(
      sql,
      /^SELECT \* FROM "(catalog_|circle_tag_overlay_|crawler_snapshot_)/,
      sql,
    );
    assert.doesNotMatch(sql, /users|identit|session|token|favorite|plan/i, sql);
  }
  assert.ok(
    readdirSync(join(bundle, "rows")).every((name) =>
      /^(catalog_|circle_tag_overlay_|crawler_snapshot_)[a-z_]+\.ndjson$/.test(
        name,
      ),
    ),
  );
  assert.equal(tables.get("catalog_artifacts"), 1, "only the derived artifact");
  assert.equal(tables.get("catalog_versions"), 2, "published + superseded");
  assert.equal(tables.get("catalog_circles"), 2, "active version rows only");
  const bundleText = readdirSync(join(bundle, "rows"))
    .map((name) => readFileSync(join(bundle, "rows", name), "utf8"))
    .join("");
  assert.ok(!bundleText.includes("Private Person"));
  assert.ok(!bundleText.includes(rawKey));
  assert.ok(
    !bundleText.includes("claim-3"),
    "staging versions are not mirrored",
  );
});

test("import reproduces the published data in the target and is idempotent", async () => {
  const { source, staging, target, targetBuckets, bundle } = setup();
  await exportPublishedData(source, bundle);
  const first = await importBundle(bundle, target);
  assert.equal(first.uploadedObjects, 3);
  assert.ok(first.insertedRows > 0);

  assert.equal(
    count(
      staging,
      "SELECT COUNT(*) AS n FROM catalog_circles WHERE version_id = 'c108-v2'",
    ),
    2,
  );
  assert.equal(
    (
      staging.native
        .prepare(
          "SELECT active_version_id AS id FROM catalog_events WHERE comiket_no = 108",
        )
        .get() as { id: string }
    ).id,
    "c108-v2",
  );
  assert.equal(count(staging, "SELECT COUNT(*) AS n FROM users"), 0);
  assert.equal(
    count(
      staging,
      "SELECT COUNT(*) AS n FROM catalog_artifacts WHERE kind != 'derived_catalog'",
    ),
    0,
  );
  assert.equal(
    count(staging, "SELECT COUNT(*) AS n FROM circle_tag_overlay_heads"),
    1,
  );
  assert.equal(
    count(staging, "SELECT COUNT(*) AS n FROM crawler_snapshot_heads"),
    1,
  );

  const derived = targetBuckets.downloads.objects.get(derivedKey)!;
  assert.deepEqual(derived.customMetadata, {
    sha256: sha(derivedBytes),
    visibility: "authenticated_download",
  });
  assert.equal(derived.contentType, "application/vnd.sqlite3");
  assert.equal(
    targetBuckets.catalogs.objects.get(overlayKey)!.customMetadata.visibility,
    "tag_overlay",
  );
  assert.equal(targetBuckets.catalogs.objects.has(rawKey), false);

  const puts = targetBuckets.downloads.puts + targetBuckets.catalogs.puts;
  await exportPublishedData(source, bundle);
  const second = await importBundle(bundle, target);
  assert.deepEqual(second, {
    insertedRows: 0,
    uploadedObjects: 0,
    skippedSnapshotEvents: [],
  });
  assert.equal(
    targetBuckets.downloads.puts + targetBuckets.catalogs.puts,
    puts,
  );
});

test("pointers follow production while target-only rows are kept", async () => {
  const { production, sourceBuckets, source, staging, target, bundle } =
    setup();
  staging.native.exec(`
    INSERT INTO catalog_events (comiket_no, name, created_at, updated_at)
    VALUES (999, 'Staging-only event', 1, 1);
  `);
  await exportPublishedData(source, bundle);
  await importBundle(bundle, target);

  const nextRevision = sha("overlay-revision-2");
  const nextKey = `derived/tag-overlays/v1/c108/${nextRevision}.json`;
  const nextBytes = new TextEncoder().encode('{"overlay":2}');
  sourceBuckets.catalogs.objects.set(nextKey, {
    bytes: nextBytes,
    customMetadata: {},
  });
  production.native.exec(`
    INSERT INTO circle_tag_overlay_versions (
      event_number, revision, schema_version, catalog_version_id,
      catalog_payload_sha256, taxonomy_revision, matching_policy_revision,
      evaluated_circle_count, tagged_circle_count, term_count, object_key,
      object_sha256, byte_count, published_at
    ) VALUES (
      108, '${nextRevision}', 1, 'c108-v2', '${"7".repeat(64)}', 'tax-1',
      'match-1', 2, 2, 1, '${nextKey}', '${sha(nextBytes)}', ${nextBytes.byteLength}, 9
    );
    UPDATE circle_tag_overlay_heads
      SET revision = '${nextRevision}', publication_idempotency_key = 'overlay-publication-2', updated_at = 9
      WHERE event_number = 108;
  `);
  await exportPublishedData(source, bundle);
  await importBundle(bundle, target);

  assert.equal(
    (
      staging.native
        .prepare(
          "SELECT revision FROM circle_tag_overlay_heads WHERE event_number = 108",
        )
        .get() as { revision: string }
    ).revision,
    nextRevision,
  );
  assert.equal(
    count(staging, "SELECT COUNT(*) AS n FROM circle_tag_overlay_versions"),
    2,
  );
  assert.equal(
    count(
      staging,
      "SELECT COUNT(*) AS n FROM catalog_events WHERE comiket_no = 999",
    ),
    1,
  );
});

test("a corrupt source object stops the export", async () => {
  const { sourceBuckets, source, bundle } = setup();
  sourceBuckets.downloads.objects.get(derivedKey)!.bytes =
    new TextEncoder().encode("tampered");
  await assert.rejects(
    exportPublishedData(source, bundle),
    /does not match its row/,
  );
});

test("the source accepts only single SELECT statements", () => {
  assertReadOnlySQL("SELECT * FROM catalog_events");
  for (const sql of [
    "DELETE FROM users",
    "UPDATE catalog_events SET name = 'x'",
    "SELECT 1; DELETE FROM users",
    "  INSERT INTO users VALUES (1)",
    "PRAGMA foreign_keys = OFF",
  ]) {
    assert.throws(() => assertReadOnlySQL(sql), /only single SELECT/);
  }
});

test("the import target can never be a production resource", async () => {
  const { unstable_readConfig } = await import("wrangler");
  const production = mirrorResources(
    unstable_readConfig({ config: "wrangler.jsonc" }) as never,
  );
  const staging = mirrorResources(
    unstable_readConfig({ config: "wrangler.jsonc", env: "staging" }) as never,
  );
  assert.throws(
    () => assertNotProduction(production, production),
    /production resource/,
  );
  assert.throws(
    () =>
      assertNotProduction(production, {
        ...staging,
        databaseID: "11111111-1111-1111-1111-111111111111",
        buckets: {
          ...staging.buckets,
          downloads: production.buckets.downloads,
        },
      }),
    /production resource/,
  );
  assert.throws(
    () =>
      assertNotProduction(production, {
        ...staging,
        databaseID: "11111111-1111-1111-1111-111111111111",
        buckets: { ...staging.buckets, catalogs: "cominavi-avatars" },
      }),
    /production resource cominavi-avatars/,
  );
  // The committed staging config still has the zero placeholder ID.
  assert.throws(() => assertNotProduction(production, staging), /placeholder/);
  assertNotProduction(production, {
    ...staging,
    databaseID: "11111111-1111-1111-1111-111111111111",
  });
});

test("snapshot cursors fence the target's existing append log", async () => {
  const { source, staging, target, bundle } = setup();
  staging.native.exec(`
    PRAGMA foreign_keys = OFF;
    INSERT INTO circle_update_events (
      id, event_key, ingest_batch_id, source, source_revision, post_id,
      update_kind, state_kind, state_value, confidence, occurred_at, created_at
    ) VALUES (41, 'pre-import', 1, 'test', 1, 'p1', 'cover', 'cover', 'x', 'high', 1, 1);
    PRAGMA foreign_keys = ON;
  `);
  await exportPublishedData(source, bundle);
  await importBundle(bundle, target);
  assert.equal(
    count(
      staging,
      "SELECT publication_cursor AS n FROM crawler_snapshot_heads",
    ),
    41,
  );

  // Re-importing the same snapshot keeps its fence, even after the target
  // log has grown; only a new revision would move it.
  staging.native.exec(`
    PRAGMA foreign_keys = OFF;
    INSERT INTO circle_update_events (
      id, event_key, ingest_batch_id, source, source_revision, post_id,
      update_kind, state_kind, state_value, confidence, occurred_at, created_at
    ) VALUES (42, 'post-import', 1, 'test', 1, 'p1', 'cover', 'cover', 'y', 'high', 2, 2);
    PRAGMA foreign_keys = ON;
  `);
  await importBundle(bundle, target);
  assert.equal(
    count(
      staging,
      "SELECT publication_cursor AS n FROM crawler_snapshot_heads",
    ),
    41,
  );
});

test("a failed import never retires the version that is still active", async () => {
  const { production, source, staging, target, bundle } = setup();
  await exportPublishedData(source, bundle);
  await importBundle(bundle, target);

  production.native.exec(`
    INSERT INTO catalog_versions (
      id, comiket_no, schema_version, state, claim_id,
      source_main_sha256, source_image_sha256, circle_count,
      created_at, published_at, catalog_event_key
    ) VALUES ('c108-v4', 108, 1, 'published', 'claim-4',
      '${"a".repeat(64)}', '${"b".repeat(64)}', 1, 4, 4, 'comiket-108');
    INSERT INTO catalog_dates (version_id, day, date_iso, weekday)
    VALUES ('c108-v4', 1, '2026-08-15', 6);
    INSERT INTO catalog_circles (
      version_id, comiket_no, wc_id, day, name, kana, pen_name, book_name, description
    ) VALUES ('c108-v4', 108, 101, 1, 'Circle 101 v4', '', '', '', '');
    UPDATE catalog_versions SET state = 'superseded' WHERE id = 'c108-v2';
    UPDATE catalog_events SET active_version_id = 'c108-v4' WHERE comiket_no = 108;
  `);
  await exportPublishedData(source, bundle);
  staging.native.exec(`
    CREATE TRIGGER refuse_circles BEFORE INSERT ON catalog_circles
    BEGIN SELECT RAISE(ABORT, 'simulated outage'); END;
  `);
  await assert.rejects(importBundle(bundle, target), /simulated outage/);
  const state = (id: string) =>
    (
      staging.native
        .prepare("SELECT state FROM catalog_versions WHERE id = ?")
        .get(id) as { state: string }
    ).state;
  assert.equal(
    state("c108-v2"),
    "published",
    "the active version stays published",
  );
  assert.equal(state("c108-v4"), "staging", "the new version stays invisible");

  staging.native.exec("DROP TRIGGER refuse_circles");
  await importBundle(bundle, target);
  assert.equal(state("c108-v2"), "superseded");
  assert.equal(state("c108-v4"), "published");
});

test("production is the top-level config even when CLOUDFLARE_ENV is set", async () => {
  const saved = process.env.CLOUDFLARE_ENV;
  process.env.CLOUDFLARE_ENV = "staging";
  try {
    const config = await readWranglerConfig();
    assert.equal(config.name, "cominavi-homepage");
    assert.equal(process.env.CLOUDFLARE_ENV, "staging", "restored");
  } finally {
    if (saved === undefined) delete process.env.CLOUDFLARE_ENV;
    else process.env.CLOUDFLARE_ENV = saved;
  }
});

test("snapshot cursors are rebased onto the target's own append log", async () => {
  const { production, source, staging, target, bundle } = setup();
  production.native.exec(`
    UPDATE crawler_snapshot_versions SET publication_cursor = 1000;
    UPDATE crawler_snapshot_heads SET publication_cursor = 1000;
  `);
  await exportPublishedData(source, bundle);
  await importBundle(bundle, target);
  for (const table of ["crawler_snapshot_versions", "crawler_snapshot_heads"]) {
    assert.equal(
      count(staging, `SELECT MAX(publication_cursor) AS n FROM ${table}`),
      0,
      table,
    );
  }
});

test("a failed import never activates a catalog whose rows are missing", async () => {
  const { source, staging, target, bundle } = setup();
  await exportPublishedData(source, bundle);
  staging.native.exec(`
    CREATE TRIGGER refuse_circles BEFORE INSERT ON catalog_circles
    BEGIN SELECT RAISE(ABORT, 'simulated outage'); END;
  `);
  await assert.rejects(importBundle(bundle, target), /simulated outage/);
  const active = () =>
    (
      staging.native
        .prepare(
          "SELECT active_version_id AS id FROM catalog_events WHERE comiket_no = 108",
        )
        .get() as { id: string | null }
    ).id;
  assert.equal(active(), null);

  staging.native.exec("DROP TRIGGER refuse_circles");
  await importBundle(bundle, target);
  assert.equal(active(), "c108-v2");
});

test("an alias retirement and its live replacement mirror in one import", async () => {
  const { production, source, staging, target, bundle } = setup();
  const alias = (value: string, createdAt: number) => `
    INSERT INTO catalog_provider_aliases (
      provider, provider_environment, alias_kind, alias_scope, alias_value,
      catalog_event_key, circle_key, created_at, retired_at
    ) VALUES ('circlems', 'production', 'circlems_event_id', '', '${value}',
              'comiket-108', NULL, ${createdAt}, NULL);`;
  production.native.exec(alias("999", 1));
  await exportPublishedData(source, bundle);
  await importBundle(bundle, target);

  production.native.exec(
    `UPDATE catalog_provider_aliases SET retired_at = 5 WHERE alias_value = '999';` +
      alias("100", 5),
  );
  await exportPublishedData(source, bundle);
  await importBundle(bundle, target);
  assert.deepEqual(
    staging.native
      .prepare(
        "SELECT alias_value, retired_at FROM catalog_provider_aliases ORDER BY alias_value",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { alias_value: "100", retired_at: null },
      { alias_value: "999", retired_at: 5 },
    ],
  );
});

test("a snapshot that collides with target-local history is skipped, not rewritten", async () => {
  const { source, staging, target, bundle } = setup();
  const localRevision = sha("staging-only snapshot");
  staging.native.exec(`
    INSERT INTO crawler_snapshot_versions (
      event_number, revision, schema_version, generation, catalog_payload_sha256,
      matching_policy_revision, observed_at, update_count, object_key,
      object_sha256, byte_count, publication_cursor, published_at
    ) VALUES (
      108, '${localRevision}', 1, 1, '${"8".repeat(64)}', 'match-1', 1, 0,
      'crawler-realtime/v1/events/108/sha256/${localRevision}.json',
      '${"9".repeat(64)}', 10, 0, 1
    );
    INSERT INTO crawler_snapshot_heads (
      event_number, revision, generation, publication_cursor,
      publication_idempotency_key, updated_at
    ) VALUES (108, '${localRevision}', 1, 0, 'staging-local-publication', 1);
  `);
  await exportPublishedData(source, bundle);
  const lines: string[] = [];
  const result = await importBundle(bundle, target, (line) => lines.push(line));
  assert.deepEqual(result.skippedSnapshotEvents, [108]);
  assert.ok(lines.some((line) => line.includes("skipped crawler snapshot")));
  const head = staging.native
    .prepare("SELECT revision, generation FROM crawler_snapshot_heads")
    .get() as { revision: string; generation: number };
  assert.deepEqual({ ...head }, { revision: localRevision, generation: 1 });
  // The rest of the bundle still imported and activated.
  assert.equal(
    (
      staging.native
        .prepare(
          "SELECT active_version_id AS id FROM catalog_events WHERE comiket_no = 108",
        )
        .get() as { id: string }
    ).id,
    "c108-v2",
  );
  assert.equal(
    count(staging, "SELECT COUNT(*) AS n FROM circle_tag_overlay_heads"),
    1,
  );
});

test("an export that races a production publication is read again", async () => {
  const { production, source, staging, target, bundle } = setup();
  let published = false;
  const racing = {
    select: async (sql: string, params?: Array<string | number>) => {
      const rows = await source.select(sql, params);
      if (!published && sql.includes('FROM "catalog_events"')) {
        published = true;
        production.native.exec(`
          INSERT INTO catalog_versions (
            id, comiket_no, schema_version, state, claim_id,
            source_main_sha256, source_image_sha256, circle_count,
            created_at, published_at, catalog_event_key
          ) VALUES ('c108-v4', 108, 1, 'published', 'claim-4',
            '${"a".repeat(64)}', '${"b".repeat(64)}', 0, 4, 4, 'comiket-108');
          UPDATE catalog_versions SET state = 'superseded' WHERE id = 'c108-v2';
          UPDATE catalog_events SET active_version_id = 'c108-v4' WHERE comiket_no = 108;
        `);
      }
      return rows;
    },
    getObject: source.getObject.bind(source),
  };
  const lines: string[] = [];
  await exportPublishedData(racing, bundle, (line) => lines.push(line));
  assert.ok(lines.some((line) => line.includes("Retrying the export")));
  await importBundle(bundle, target);
  assert.equal(
    (
      staging.native
        .prepare(
          "SELECT active_version_id AS id FROM catalog_events WHERE comiket_no = 108",
        )
        .get() as { id: string }
    ).id,
    "c108-v4",
  );
});

test("a tag overlay bound to a superseded version keeps its circle-set evidence", async () => {
  const { production, source, staging, target, bundle } = setup();
  production.native.exec(
    "UPDATE circle_tag_overlay_versions SET catalog_version_id = 'c108-v1'",
  );
  await exportPublishedData(source, bundle);
  await importBundle(bundle, target);
  assert.equal(
    count(
      staging,
      "SELECT COUNT(*) AS n FROM catalog_circles WHERE version_id = 'c108-v1'",
    ),
    1,
  );
  assert.equal(
    count(
      staging,
      "SELECT COUNT(*) AS n FROM catalog_artifacts WHERE version_id = 'c108-v1'",
    ),
    0,
    "only active versions get a downloadable artifact",
  );
  assert.equal(
    count(staging, "SELECT COUNT(*) AS n FROM circle_tag_overlay_heads"),
    1,
  );
});

test("importing an older bundle never rolls a snapshot head backward", async () => {
  const { production, sourceBuckets, source, staging, target, bundle } =
    setup();
  const older = mkdtempSync(join(tmpdir(), "cominavi-mirror-older-"));
  await exportPublishedData(source, older);

  const nextRevision = sha("snapshot-revision-2");
  const nextKey = `crawler-realtime/v1/events/108/sha256/${nextRevision}.json`;
  const nextBytes = new TextEncoder().encode('{"snapshot":2}');
  sourceBuckets.catalogs.objects.set(nextKey, {
    bytes: nextBytes,
    customMetadata: {},
  });
  production.native.exec(`
    INSERT INTO crawler_snapshot_versions (
      event_number, revision, schema_version, generation, catalog_payload_sha256,
      matching_policy_revision, observed_at, update_count, object_key,
      object_sha256, byte_count, publication_cursor, published_at
    ) VALUES (
      108, '${nextRevision}', 1, 2, '${"8".repeat(64)}', 'match-1', 7, 0,
      '${nextKey}', '${sha(nextBytes)}', ${nextBytes.byteLength}, 0, 7
    );
    UPDATE crawler_snapshot_heads
      SET revision = '${nextRevision}', generation = 2,
          publication_idempotency_key = 'snapshot-publication-2', updated_at = 7;
  `);
  await exportPublishedData(source, bundle);
  await importBundle(bundle, target);
  await importBundle(older, target);

  const head = staging.native
    .prepare("SELECT revision, generation FROM crawler_snapshot_heads")
    .get() as { revision: string; generation: number };
  assert.deepEqual({ ...head }, { revision: nextRevision, generation: 2 });
});
