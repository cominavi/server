/**
 * One-way mirror of PUBLISHED, SANITIZED catalog and overlay data from
 * production into staging or local dev (data-layering proposal §7, Q9).
 *
 *   tsx tools/mirror-published-data.ts export --out <dir>
 *   tsx tools/mirror-published-data.ts import --bundle <dir> --target local|staging
 *
 * `export` reads production through the Cloudflare REST API with a read-only
 * token (`COMINAVI_MIRROR_SOURCE_API_TOKEN`). It issues only SELECT
 * statements and object GETs, and writes a content-addressed bundle:
 * `manifest.json`, `rows/<table>.ndjson`, and `objects/<sha256>`.
 *
 * `import` writes a bundle through real Worker bindings (`getPlatformProxy`):
 * the local dev state for `--target local`, or the remote `env.staging`
 * resources for `--target staging`. It refuses any target that names a
 * production resource. Immutable rows (artifacts, normalized catalog rows,
 * overlay and snapshot versions) use INSERT OR IGNORE. Rows whose state can
 * change in production (events, editions, capabilities, aliases, versions,
 * stable and edition circles, overlay and snapshot heads) are upserted when a
 * column differs. Event activation is applied last, so a target never points
 * at a version whose rows are not all imported. Objects are skipped when an
 * identical object is already present. Running either step twice is a no-op.
 *
 * What is mirrored: catalog events, editions, capabilities, provider aliases,
 * published/superseded version metadata, the normalized rows and the derived
 * (client-downloadable) artifact of each ACTIVE version, stable circles and
 * edition circles, and the current tag-overlay and crawler-snapshot heads with
 * their objects. Never mirrored: raw Circle.ms source artifacts, users,
 * identities, tokens, sessions, favorites, Shared Plans, receipts, jobs, and
 * every other table.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const bundleFormat = 1;
const pageSize = 500;
const insertBatchSize = 50;

type BucketName = "downloads" | "catalogs";
type Row = Record<string, string | number | null>;

/** Production, read-only. */
export interface MirrorSource {
  select(sql: string, params?: Array<string | number>): Promise<Row[]>;
  getObject(bucket: BucketName, key: string): Promise<Uint8Array | null>;
}

/** Staging or local dev bindings. */
export interface MirrorTarget {
  database: D1Database;
  buckets: Record<BucketName, R2Bucket>;
}

export interface MirrorObject {
  bucket: BucketName;
  key: string;
  sha256: string;
  bytes: number;
  contentType: string;
  customMetadata: Record<string, string>;
}

export interface MirrorTable {
  table: string;
  /** "ignore": copy missing rows. "replace": the row follows production. */
  conflict: "ignore" | "replace";
  primaryKey: string[];
  rows: number;
}

export interface MirrorManifest {
  format: typeof bundleFormat;
  exportedAt: string;
  tables: MirrorTable[];
  objects: MirrorObject[];
}

/** Import order respects every foreign key between mirrored tables. */
const tableSpecs: Array<Omit<MirrorTable, "rows">> = [
  { table: "catalog_events", conflict: "replace", primaryKey: ["comiket_no"] },
  {
    table: "catalog_editions",
    conflict: "replace",
    primaryKey: ["catalog_event_key"],
  },
  {
    table: "catalog_edition_capabilities",
    conflict: "replace",
    primaryKey: ["catalog_event_key", "capability"],
  },
  {
    table: "catalog_provider_aliases",
    conflict: "replace",
    primaryKey: [
      "provider",
      "provider_environment",
      "alias_kind",
      "alias_scope",
      "alias_value",
    ],
  },
  { table: "catalog_versions", conflict: "replace", primaryKey: ["id"] },
  {
    table: "catalog_artifacts",
    conflict: "ignore",
    primaryKey: ["version_id", "kind"],
  },
  {
    table: "catalog_dates",
    conflict: "ignore",
    primaryKey: ["version_id", "day"],
  },
  {
    table: "catalog_maps",
    conflict: "ignore",
    primaryKey: ["version_id", "map_id"],
  },
  {
    table: "catalog_areas",
    conflict: "ignore",
    primaryKey: ["version_id", "area_id"],
  },
  {
    table: "catalog_blocks",
    conflict: "ignore",
    primaryKey: ["version_id", "block_id"],
  },
  {
    table: "catalog_floors",
    conflict: "ignore",
    primaryKey: ["version_id", "floor_id"],
  },
  {
    table: "catalog_mappings",
    conflict: "ignore",
    primaryKey: ["version_id", "day", "block_id"],
  },
  {
    table: "catalog_genres",
    conflict: "ignore",
    primaryKey: ["version_id", "genre_id"],
  },
  {
    table: "catalog_layouts",
    conflict: "ignore",
    primaryKey: ["version_id", "block_id", "space_no"],
  },
  {
    table: "catalog_circles",
    conflict: "ignore",
    primaryKey: ["version_id", "wc_id"],
  },
  {
    table: "catalog_image_assets",
    conflict: "ignore",
    primaryKey: ["version_id", "kind", "asset_key"],
  },
  {
    table: "catalog_stable_circles",
    conflict: "replace",
    primaryKey: ["comiket_no", "wc_id"],
  },
  {
    table: "catalog_edition_circles",
    conflict: "replace",
    primaryKey: ["catalog_event_key", "circle_key"],
  },
  {
    table: "circle_tag_overlay_versions",
    conflict: "ignore",
    primaryKey: ["event_number", "revision"],
  },
  {
    table: "circle_tag_overlay_heads",
    conflict: "replace",
    primaryKey: ["event_number"],
  },
  {
    table: "crawler_snapshot_versions",
    conflict: "ignore",
    primaryKey: ["event_number", "revision"],
  },
  {
    table: "crawler_snapshot_heads",
    conflict: "replace",
    primaryKey: ["event_number"],
  },
];

const versionChildTables = [
  "catalog_dates",
  "catalog_maps",
  "catalog_areas",
  "catalog_blocks",
  "catalog_floors",
  "catalog_mappings",
  "catalog_genres",
  "catalog_layouts",
  "catalog_circles",
  "catalog_image_assets",
] as const;

const tagOverlayContentType = "application/vnd.cominavi.tag-overlay-v1+json";
const snapshotContentType =
  "application/vnd.cominavi.realtime-snapshot-v1+json";

// ---------------------------------------------------------------------------
// Export (production, read-only)

class InconsistentSourceRead extends Error {}

/**
 * Exports, retrying when production published a catalog between two of the
 * export's reads (the reads are not one transaction).
 */
export async function exportPublishedData(
  source: MirrorSource,
  outDir: string,
  log: (line: string) => void = () => {},
  now = new Date(),
): Promise<MirrorManifest> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await exportPublishedDataOnce(source, outDir, log, now);
    } catch (error) {
      if (!(error instanceof InconsistentSourceRead) || attempt >= 3)
        throw error;
      log(`${error.message} Retrying the export.`);
    }
  }
}

async function exportPublishedDataOnce(
  source: MirrorSource,
  outDir: string,
  log: (line: string) => void = () => {},
  now = new Date(),
): Promise<MirrorManifest> {
  mkdirSync(join(outDir, "rows"), { recursive: true });
  mkdirSync(join(outDir, "objects"), { recursive: true });
  const rowsByTable = new Map<string, Row[]>();
  const add = (table: string, rows: Row[]) => {
    rowsByTable.set(table, [...(rowsByTable.get(table) ?? []), ...rows]);
  };
  const spec = (table: string) => tableSpecs.find((s) => s.table === table)!;
  const all = (
    table: string,
    where = "",
    params: Array<string | number> = [],
  ) => selectAll(source, table, spec(table).primaryKey, where, params);

  add("catalog_events", await all("catalog_events"));
  add("catalog_editions", await all("catalog_editions"));
  add(
    "catalog_edition_capabilities",
    await all("catalog_edition_capabilities"),
  );
  add("catalog_provider_aliases", await all("catalog_provider_aliases"));
  add(
    "catalog_versions",
    await all("catalog_versions", "state IN ('published', 'superseded')"),
  );

  const versionIDs = new Set(
    rowsByTable.get("catalog_versions")!.map((row) => String(row.id)),
  );
  const activeVersionIDs = rowsByTable
    .get("catalog_events")!
    .map((row) => row.active_version_id)
    .filter((id): id is string => typeof id === "string" && versionIDs.has(id))
    .sort();
  // The events were read before the versions. If production published a new
  // version in between, an event still points at a version that is now
  // superseded; that snapshot is unreadable, so read everything again.
  const versionStateByID = new Map(
    rowsByTable
      .get("catalog_versions")!
      .map((row) => [String(row.id), String(row.state)]),
  );
  for (const versionID of activeVersionIDs) {
    if (versionStateByID.get(versionID) !== "published") {
      throw new InconsistentSourceRead(
        `Active version ${versionID} is not published in the same export.`,
      );
    }
  }
  // Pointers to versions that are not mirrored (never expected) are cleared,
  // so the target can never point at a missing version.
  for (const event of rowsByTable.get("catalog_events")!) {
    if (
      typeof event.active_version_id === "string" &&
      !versionIDs.has(event.active_version_id)
    ) {
      event.active_version_id = null;
    }
  }

  const objects: MirrorObject[] = [];
  for (const versionID of activeVersionIDs) {
    log(`catalog version ${versionID}`);
    const artifacts = await all(
      "catalog_artifacts",
      "version_id = ? AND kind = 'derived_catalog' AND visibility = 'authenticated_download'",
      [versionID],
    );
    add("catalog_artifacts", artifacts);
    for (const artifact of artifacts) {
      objects.push({
        bucket: "downloads",
        key: String(artifact.object_key),
        sha256: String(artifact.sha256),
        bytes: Number(artifact.byte_count),
        contentType: String(artifact.content_type),
        customMetadata: {
          sha256: String(artifact.sha256),
          visibility: "authenticated_download",
        },
      });
    }
    for (const table of versionChildTables) {
      add(table, await all(table, "version_id = ?", [versionID]));
    }
  }

  add(
    "catalog_stable_circles",
    (await all("catalog_stable_circles")).filter(
      (row) =>
        versionIDs.has(String(row.first_version_id)) &&
        versionIDs.has(String(row.last_version_id)),
    ),
  );
  add(
    "catalog_edition_circles",
    (await all("catalog_edition_circles")).filter(
      (row) =>
        versionIDs.has(String(row.first_version_id)) &&
        versionIDs.has(String(row.last_version_id)),
    ),
  );

  for (const head of await all("circle_tag_overlay_heads")) {
    const [version] = await all(
      "circle_tag_overlay_versions",
      "event_number = ? AND revision = ?",
      [Number(head.event_number), String(head.revision)],
    );
    if (!version || !versionIDs.has(String(version.catalog_version_id))) {
      continue;
    }
    add("circle_tag_overlay_versions", [version]);
    add("circle_tag_overlay_heads", [head]);
    objects.push({
      bucket: "catalogs",
      key: String(version.object_key),
      sha256: String(version.object_sha256),
      bytes: Number(version.byte_count),
      contentType: tagOverlayContentType,
      customMetadata: {
        schemaVersion: "1",
        sha256: String(version.object_sha256),
        revision: String(version.revision),
        eventNumber: String(version.event_number),
        catalogPayloadSHA256: String(version.catalog_payload_sha256),
        visibility: "tag_overlay",
      },
    });
  }

  for (const head of await all("crawler_snapshot_heads")) {
    const [version] = await all(
      "crawler_snapshot_versions",
      "event_number = ? AND revision = ?",
      [Number(head.event_number), String(head.revision)],
    );
    if (!version) continue;
    // `publication_cursor` is a position in production's realtime append log
    // (`circle_update_events`), which is not mirrored. In the target's own log
    // the snapshot covers nothing yet, so the cursor is 0; carrying the
    // production value would hide the target's first events.
    version.publication_cursor = 0;
    head.publication_cursor = 0;
    add("crawler_snapshot_versions", [version]);
    add("crawler_snapshot_heads", [head]);
    objects.push({
      bucket: "catalogs",
      key: String(version.object_key),
      sha256: String(version.object_sha256),
      bytes: Number(version.byte_count),
      contentType: snapshotContentType,
      customMetadata: {
        eventNumber: String(version.event_number),
        revision: String(version.revision),
        generation: String(version.generation),
        payloadSHA256: String(version.object_sha256),
        catalogPayloadSHA256: String(version.catalog_payload_sha256),
      },
    });
  }

  for (const object of objects) {
    assertSafeObject(object);
    const path = join(outDir, "objects", object.sha256);
    if (existsSync(path) && sha256Hex(readFileSync(path)) === object.sha256) {
      continue;
    }
    log(`object ${object.bucket}/${object.key}`);
    const bytes = await source.getObject(object.bucket, object.key);
    if (!bytes) throw new Error(`Missing source object ${object.key}.`);
    if (
      bytes.byteLength !== object.bytes ||
      sha256Hex(bytes) !== object.sha256
    ) {
      throw new Error(`Source object ${object.key} does not match its row.`);
    }
    writeFileAtomic(path, bytes);
  }

  const tables: MirrorTable[] = tableSpecs.map((spec) => {
    const rows = rowsByTable.get(spec.table) ?? [];
    writeFileAtomic(
      join(outDir, "rows", `${spec.table}.ndjson`),
      rows.map((row) => JSON.stringify(row)).join("\n") +
        (rows.length ? "\n" : ""),
    );
    return { ...spec, rows: rows.length };
  });
  const manifest: MirrorManifest = {
    format: bundleFormat,
    exportedAt: now.toISOString(),
    tables,
    objects: dedupeObjects(objects),
  };
  writeFileAtomic(
    join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}

async function selectAll(
  source: MirrorSource,
  table: string,
  primaryKey: string[],
  where: string,
  params: Array<string | number>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await source.select(
      `SELECT * FROM ${quoteIdentifier(table)}${where ? ` WHERE ${where}` : ""} ORDER BY ${primaryKey
        .map(quoteIdentifier)
        .join(", ")} LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    );
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function assertSafeObject(object: MirrorObject): void {
  // Raw Circle.ms sources live under raw/ in the private bucket. They are
  // never mirrored, whatever a row says.
  if (object.key.startsWith("raw/") || !/^[0-9a-f]{64}$/.test(object.sha256)) {
    throw new Error(`Refusing to mirror object ${object.key}.`);
  }
}

function dedupeObjects(objects: MirrorObject[]): MirrorObject[] {
  const seen = new Map<string, MirrorObject>();
  for (const object of objects)
    seen.set(`${object.bucket}\0${object.key}`, object);
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Import (staging or local)

export async function importBundle(
  bundleDir: string,
  target: MirrorTarget,
  log: (line: string) => void = () => {},
): Promise<{
  insertedRows: number;
  uploadedObjects: number;
  skippedSnapshotEvents: number[];
}> {
  const manifest = JSON.parse(
    readFileSync(join(bundleDir, "manifest.json"), "utf8"),
  ) as MirrorManifest;
  if (manifest.format !== bundleFormat) {
    throw new Error(`Unsupported bundle format ${String(manifest.format)}.`);
  }
  const known = new Map(tableSpecs.map((spec) => [spec.table, spec]));
  for (const table of manifest.tables) {
    const spec = known.get(table.table);
    if (
      !spec ||
      spec.conflict !== table.conflict ||
      spec.primaryKey.join() !== table.primaryKey.join()
    ) {
      throw new Error(`Bundle names an unexpected table ${table.table}.`);
    }
  }

  // Objects first: a row is only visible once its object exists.
  let uploadedObjects = 0;
  for (const object of manifest.objects) {
    assertSafeObject(object);
    const bucket = target.buckets[object.bucket];
    const existing = await bucket.head(object.key);
    if (existing && objectMatches(existing, object)) continue;
    const bytes = readFileSync(join(bundleDir, "objects", object.sha256));
    if (
      bytes.byteLength !== object.bytes ||
      sha256Hex(bytes) !== object.sha256
    ) {
      throw new Error(`Bundle object ${object.key} is corrupt.`);
    }
    log(`put ${object.bucket}/${object.key}`);
    await bucket.put(object.key, bytes, {
      httpMetadata: { contentType: object.contentType },
      customMetadata: object.customMetadata,
    });
    const stored = await bucket.head(object.key);
    if (!stored || !objectMatches(stored, object)) {
      throw new Error(`Could not verify ${object.bucket}/${object.key}.`);
    }
    uploadedObjects += 1;
  }

  let insertedRows = 0;
  const activations: Row[] = [];
  const versionStates: Row[] = [];
  const snapshotVersions: Row[] = [];
  const snapshotHeads: Row[] = [];
  for (const table of manifest.tables) {
    if (table.rows === 0) continue;
    let rows = readFileSync(
      join(bundleDir, "rows", `${table.table}.ndjson`),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Row);
    if (rows.length !== table.rows) {
      throw new Error(`Row count mismatch for ${table.table}.`);
    }
    if (table.table === "catalog_events") {
      // Events are needed first (editions reference them), but activating a
      // version must wait until its version row, artifact, and normalized rows
      // exist. New events start inactive and existing ones keep their current
      // version; the production pointers are applied after every table.
      activations.push(...rows);
      rows = rows.map(({ active_version_id: _, ...row }) => row);
    }
    let preserve: string[] = [];
    if (table.table === "catalog_versions") {
      // A version's state changes (published -> superseded) only together
      // with event activation at the end. New versions land as invisible
      // `staging` rows and existing ones keep their state until then, so a
      // failed import never retires the version that is still active.
      versionStates.push(...rows);
      rows = rows.map((row) => ({ ...row, state: "staging" }));
      preserve = ["state"];
    }
    if (table.table === "crawler_snapshot_versions") {
      snapshotVersions.push(...rows);
      continue;
    }
    if (table.table === "crawler_snapshot_heads") {
      snapshotHeads.push(...rows);
      continue;
    }
    if (table.table === "catalog_provider_aliases") {
      // Retirements first, so a live replacement never collides with the
      // alias it replaces on the live-target unique index.
      rows = [...rows].sort(
        (left, right) =>
          Number(left.retired_at === null) - Number(right.retired_at === null),
      );
    }
    const targetColumns = await tableColumns(target.database, table.table);
    const columns = Object.keys(rows[0]!);
    for (const column of columns) {
      if (!targetColumns.includes(column)) {
        throw new Error(
          `Target ${table.table} has no column ${column}; apply migrations first.`,
        );
      }
    }
    log(`rows ${table.table} (${rows.length})`);
    for (let start = 0; start < rows.length; start += insertBatchSize) {
      const statements = rows
        .slice(start, start + insertBatchSize)
        .map((row) =>
          upsertStatement(target.database, table, columns, row, preserve),
        );
      const results = await target.database.batch(statements);
      insertedRows += results.reduce(
        (sum, result) => sum + (result.meta.changes ?? 0),
        0,
      );
    }
  }
  // Publication: crawler snapshots, version states, and event activation in
  // one atomic batch.
  const snapshots = await snapshotStatements(
    target.database,
    snapshotVersions,
    snapshotHeads,
    log,
  );
  const publication = [
    ...snapshots.statements,
    ...versionStates.map((version) =>
      target.database
        .prepare(
          `UPDATE "catalog_versions" SET "state" = ?1
           WHERE "id" = ?2 AND "state" IS NOT ?1`,
        )
        .bind(version.state, version.id),
    ),
    ...activations.map((event) =>
      target.database
        .prepare(
          `UPDATE "catalog_events" SET "active_version_id" = ?1
           WHERE "comiket_no" = ?2 AND "active_version_id" IS NOT ?1`,
        )
        .bind(event.active_version_id, event.comiket_no),
    ),
  ];
  if (publication.length > 0) {
    const results = await target.database.batch(publication);
    insertedRows += results.reduce(
      (sum, result) => sum + (result.meta.changes ?? 0),
      0,
    );
  }
  return {
    insertedRows,
    uploadedObjects,
    skippedSnapshotEvents: snapshots.skipped,
  };
}

/**
 * Crawler snapshots are installed inside the final publication batch.
 *
 * - `publication_cursor` is a position in the TARGET's own realtime append log
 *   (production's log is not mirrored). It is read inside the same atomic
 *   batch, so the imported snapshot replaces every target event committed
 *   before it, with no window for a concurrent append.
 * - `generation` is part of the canonical snapshot object, so it is never
 *   rewritten. If the target already has a DIFFERENT snapshot at the same
 *   `(event, generation)` (target-local history), that event's snapshot is
 *   skipped with a warning and the target keeps its own; everything else
 *   still imports.
 * - Re-importing the head's current revision changes nothing, so its fence is
 *   kept; only a new revision moves the head.
 */
async function snapshotStatements(
  database: D1Database,
  versions: Row[],
  heads: Row[],
  log: (line: string) => void,
): Promise<{ statements: D1PreparedStatement[]; skipped: number[] }> {
  const cursor = `(SELECT COALESCE(MAX("id"), 0) FROM "circle_update_events")`;
  const statements: D1PreparedStatement[] = [];
  const skipped: number[] = [];
  for (const head of heads) {
    const version = versions.find(
      (row) =>
        row.event_number === head.event_number &&
        row.revision === head.revision,
    );
    if (!version)
      throw new Error(`Bundle lacks snapshot ${String(head.revision)}.`);
    const collision = await database
      .prepare(
        `SELECT "revision" FROM "crawler_snapshot_versions"
         WHERE "event_number" = ?1 AND "generation" = ?2 AND "revision" != ?3`,
      )
      .bind(version.event_number, version.generation, version.revision)
      .first<{ revision: string }>();
    if (collision) {
      log(
        `skipped crawler snapshot for event ${String(version.event_number)}: the target already has a different snapshot (${collision.revision}) at generation ${String(version.generation)}`,
      );
      skipped.push(Number(version.event_number));
      continue;
    }
    const generation = Number(version.generation);
    statements.push(
      insertSelect(
        database,
        "crawler_snapshot_versions",
        { ...version, generation },
        "OR IGNORE",
        cursor,
        "",
      ),
      insertSelect(
        database,
        "crawler_snapshot_heads",
        { ...head, generation },
        "",
        cursor,
        `ON CONFLICT ("event_number") DO UPDATE SET
           "revision" = excluded."revision",
           "generation" = excluded."generation",
           "publication_cursor" = excluded."publication_cursor",
           "publication_idempotency_key" = excluded."publication_idempotency_key",
           "updated_at" = excluded."updated_at"
         WHERE "crawler_snapshot_heads"."revision" IS NOT excluded."revision"`,
      ),
    );
  }
  return { statements, skipped };
}

/** `INSERT … SELECT` with `publication_cursor` taken from a SQL expression. */
function insertSelect(
  database: D1Database,
  table: string,
  row: Row,
  modifier: string,
  cursorExpression: string,
  conflict: string,
): D1PreparedStatement {
  const columns = Object.keys(row);
  const values: Array<string | number | null> = [];
  const expressions = columns.map((column) => {
    if (column === "publication_cursor") return cursorExpression;
    values.push(row[column] ?? null);
    return `?${values.length}`;
  });
  return database
    .prepare(
      `INSERT ${modifier} INTO ${quoteIdentifier(table)}
         (${columns.map(quoteIdentifier).join(", ")})
       SELECT ${expressions.join(", ")} WHERE true ${conflict}`,
    )
    .bind(...values);
}

function upsertStatement(
  database: D1Database,
  table: MirrorTable,
  columns: string[],
  row: Row,
  preserve: string[] = [],
): D1PreparedStatement {
  const names = columns.map(quoteIdentifier).join(", ");
  const placeholders = columns.map((_, index) => `?${index + 1}`).join(", ");
  const values = columns.map((column) => {
    const value = row[column];
    if (value === undefined) {
      throw new Error(`Row in ${table.table} lacks ${column}.`);
    }
    return value;
  });
  if (table.conflict === "ignore") {
    return database
      .prepare(
        `INSERT OR IGNORE INTO ${quoteIdentifier(table.table)} (${names}) VALUES (${placeholders})`,
      )
      .bind(...values);
  }
  const mutable = columns.filter(
    (column) =>
      !table.primaryKey.includes(column) && !preserve.includes(column),
  );
  const updates = mutable.map(
    (column) =>
      `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`,
  );
  const changed = mutable.map(
    (column) =>
      `${quoteIdentifier(table.table)}.${quoteIdentifier(column)} IS NOT excluded.${quoteIdentifier(column)}`,
  );
  return database
    .prepare(
      `INSERT INTO ${quoteIdentifier(table.table)} (${names}) VALUES (${placeholders})
       ON CONFLICT (${table.primaryKey.map(quoteIdentifier).join(", ")})
       DO UPDATE SET ${updates.join(", ")}
       WHERE ${changed.join(" OR ")}`,
    )
    .bind(...values);
}

async function tableColumns(
  database: D1Database,
  table: string,
): Promise<string[]> {
  const result = await database
    .prepare(`SELECT name FROM pragma_table_info(?1)`)
    .bind(table)
    .all<{ name: string }>();
  return result.results.map((row) => row.name);
}

function objectMatches(object: R2Object, expected: MirrorObject): boolean {
  if (object.size !== expected.bytes) return false;
  if (object.httpMetadata?.contentType !== expected.contentType) return false;
  return Object.entries(expected.customMetadata).every(
    ([key, value]) => object.customMetadata?.[key] === value,
  );
}

// ---------------------------------------------------------------------------
// Production source over the Cloudflare REST API

export class CloudflareAPISource implements MirrorSource {
  constructor(
    private readonly options: {
      accountID: string;
      databaseID: string;
      buckets: Record<BucketName, string>;
      token: string;
      fetch?: typeof fetch;
      apiOrigin?: string;
    },
  ) {}

  async select(
    sql: string,
    params: Array<string | number> = [],
  ): Promise<Row[]> {
    assertReadOnlySQL(sql);
    const response = await this.request(
      `/d1/database/${this.options.databaseID}/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params }),
      },
    );
    const body = (await response.json()) as {
      success: boolean;
      errors?: unknown[];
      result?: Array<{ results: Row[]; success: boolean }>;
    };
    if (!response.ok || !body.success || !body.result?.[0]?.success) {
      throw new Error(`D1 query failed (${response.status}).`);
    }
    return body.result[0].results;
  }

  async getObject(bucket: BucketName, key: string): Promise<Uint8Array | null> {
    const response = await this.request(
      `/r2/buckets/${this.options.buckets[bucket]}/objects/${key
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      { method: "GET" },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 GET failed (${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    const origin = this.options.apiOrigin ?? "https://api.cloudflare.com";
    const method = init.method ?? "GET";
    if (method !== "GET" && !path.endsWith("/query")) {
      throw new Error("The mirror source is read-only.");
    }
    return (this.options.fetch ?? fetch)(
      `${origin}/client/v4/accounts/${this.options.accountID}${path}`,
      {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${this.options.token}`,
        },
      },
    );
  }
}

export function assertReadOnlySQL(sql: string): void {
  if (!/^SELECT\s/i.test(sql) || sql.includes(";")) {
    throw new Error("The mirror source accepts only single SELECT statements.");
  }
}

// ---------------------------------------------------------------------------
// Target resolution: production can never be a target

/**
 * Reads wrangler.jsonc for one environment. Wrangler falls back to the
 * CLOUDFLARE_ENV variable when no environment is passed, so it is unset for
 * the read: "production" must always mean the top-level config.
 */
async function readWranglerConfig(env?: string): Promise<ResolvedConfig> {
  const { unstable_readConfig } = await import("wrangler");
  const saved = process.env.CLOUDFLARE_ENV;
  delete process.env.CLOUDFLARE_ENV;
  try {
    return unstable_readConfig({
      config: "wrangler.jsonc",
      env,
    }) as unknown as ResolvedConfig;
  } finally {
    if (saved !== undefined) process.env.CLOUDFLARE_ENV = saved;
  }
}

interface ResolvedConfig {
  name?: string;
  account_id?: string;
  d1_databases: Array<{
    binding: string;
    database_name?: string;
    database_id?: string;
  }>;
  r2_buckets: Array<{ binding: string; bucket_name?: string }>;
}

const bucketBindings: Record<BucketName, string> = {
  downloads: "COMINAVI_CATALOG_DOWNLOADS",
  catalogs: "COMINAVI_CATALOGS",
};

export { readWranglerConfig };

export function mirrorResources(config: ResolvedConfig) {
  const database = config.d1_databases.find((d) => d.binding === "COMINAVI_DB");
  const bucket = (name: BucketName) =>
    config.r2_buckets.find((b) => b.binding === bucketBindings[name])
      ?.bucket_name;
  if (!database?.database_id || !database.database_name) {
    throw new Error("The config has no COMINAVI_DB database.");
  }
  const downloads = bucket("downloads");
  const catalogs = bucket("catalogs");
  if (!downloads || !catalogs)
    throw new Error("The config lacks a catalog bucket.");
  return {
    workerName: config.name ?? "",
    databaseID: database.database_id,
    databaseName: database.database_name,
    buckets: { downloads, catalogs },
    allBuckets: config.r2_buckets.flatMap((b) =>
      b.bucket_name ? [b.bucket_name] : [],
    ),
  };
}

/** Throws unless `target` shares no resource with `production`. */
export function assertNotProduction(
  production: ReturnType<typeof mirrorResources>,
  target: ReturnType<typeof mirrorResources>,
): void {
  const used = new Set([
    production.workerName,
    production.databaseID,
    production.databaseName,
    // Every production bucket, not only the two the mirror writes.
    ...production.allBuckets,
  ]);
  for (const value of [
    target.workerName,
    target.databaseID,
    target.databaseName,
    target.buckets.downloads,
    target.buckets.catalogs,
    ...target.allBuckets,
  ]) {
    if (used.has(value)) {
      throw new Error(`Refusing to write to production resource ${value}.`);
    }
  }
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(target.databaseID)) {
    throw new Error("The staging database ID is still a placeholder.");
  }
}

async function openTarget(
  name: string,
  persistTo: string | undefined,
): Promise<{ target: MirrorTarget; dispose: () => Promise<void> }> {
  const { getPlatformProxy } = await import("wrangler");
  const productionConfig = await readWranglerConfig();
  const production = mirrorResources(productionConfig);
  let proxy: Awaited<ReturnType<typeof getPlatformProxy<Cloudflare.Env>>>;
  if (name === "local") {
    // Local miniflare state only: no remote binding is ever created.
    proxy = await getPlatformProxy<Cloudflare.Env>({
      configPath: "wrangler.jsonc",
      // Same layout as `wrangler ... --local --persist-to <dir>` (<dir>/v3).
      persist: persistTo ? { path: join(persistTo, "v3") } : true,
      remoteBindings: false,
    });
  } else if (name === "staging") {
    const staging = mirrorResources(await readWranglerConfig("staging"));
    assertNotProduction(production, staging);
    // A throwaway config that binds exactly the staging D1 and buckets as
    // remote bindings. Nothing else, and never a production resource.
    const directory = join(tmpdir(), `cominavi-mirror-${process.pid}`);
    mkdirSync(directory, { recursive: true });
    const configPath = join(directory, "wrangler.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        name: `${staging.workerName}-mirror`,
        account_id: productionConfig.account_id,
        compatibility_date: "2026-07-14",
        d1_databases: [
          {
            binding: "COMINAVI_DB",
            database_name: staging.databaseName,
            database_id: staging.databaseID,
            remote: true,
          },
        ],
        r2_buckets: [
          {
            binding: bucketBindings.downloads,
            bucket_name: staging.buckets.downloads,
            remote: true,
          },
          {
            binding: bucketBindings.catalogs,
            bucket_name: staging.buckets.catalogs,
            remote: true,
          },
        ],
      }),
    );
    proxy = await getPlatformProxy<Cloudflare.Env>({
      configPath,
      persist: false,
      remoteBindings: true,
    });
  } else {
    throw new Error("--target must be local or staging.");
  }
  return {
    target: {
      database: proxy.env.COMINAVI_DB,
      buckets: {
        downloads: proxy.env.COMINAVI_CATALOG_DOWNLOADS,
        catalogs: proxy.env.COMINAVI_CATALOGS,
      },
    },
    dispose: () => proxy.dispose(),
  };
}

// ---------------------------------------------------------------------------
// Helpers and CLI

function quoteIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name))
    throw new Error(`Bad identifier ${name}.`);
  return `"${name}"`;
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeFileAtomic(path: string, data: Uint8Array | string): void {
  const temporary = `${path}.partial`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(args: string[]): Promise<void> {
  const command = args[0];
  // The source is always production and the target is chosen by --target;
  // an exported CLOUDFLARE_ENV must not silently redirect either one.
  delete process.env.CLOUDFLARE_ENV;
  const log = (line: string) => console.error(line);
  if (command === "export") {
    const out = argument(args, "--out");
    const token = process.env.COMINAVI_MIRROR_SOURCE_API_TOKEN ?? "";
    if (!out) throw new Error("export needs --out <dir>.");
    if (!token) {
      throw new Error("Set COMINAVI_MIRROR_SOURCE_API_TOKEN (read-only).");
    }
    const config = await readWranglerConfig();
    const production = mirrorResources(config);
    const manifest = await exportPublishedData(
      new CloudflareAPISource({
        accountID: config.account_id ?? "",
        databaseID: production.databaseID,
        buckets: production.buckets,
        token,
      }),
      out,
      log,
    );
    log(
      `exported ${manifest.tables.reduce((n, t) => n + t.rows, 0)} rows and ${manifest.objects.length} objects to ${out}`,
    );
    return;
  }
  if (command === "import") {
    const bundle = argument(args, "--bundle");
    const targetName = argument(args, "--target");
    if (!bundle || !targetName) {
      throw new Error("import needs --bundle <dir> --target local|staging.");
    }
    const { target, dispose } = await openTarget(
      targetName,
      argument(args, "--persist-to"),
    );
    try {
      const result = await importBundle(bundle, target, log);
      log(
        `imported into ${targetName}: ${result.insertedRows} rows changed, ${result.uploadedObjects} objects uploaded`,
      );
    } finally {
      await dispose();
    }
    return;
  }
  throw new Error(
    "usage: mirror-published-data.ts export --out <dir> | import --bundle <dir> --target local|staging [--persist-to <dir>]",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
