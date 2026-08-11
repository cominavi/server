import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { getTableName, type SQL } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

import { migratedTables } from "../src/lib/db/schema";

const migrations = [
  "migrations/0001_following_imports.sql",
  "migrations/0002_realtime_service.sql",
  "migrations/0003_accounts_shared_plans.sql",
  "migrations/0004_sanitized_catalog.sql",
  "migrations/0005_shared_plan_crdt_notifications.sql",
  "migrations/0006_notification_inbox.sql",
  "migrations/0007_catalog_genres_all_days.sql",
];

const expectedTextEnums: Record<string, string[]> = {
  "account_deletion_apple_revocations.payload_kind": ["credential", "stage"],
  "account_deletion_jobs.state": [
    "fenced",
    "external_cleanup",
    "leased",
    "completed",
  ],
  "apple_auth_requests.state": [
    "exchanging",
    "staged",
    "indeterminate",
    "completed",
  ],
  "apple_provider_revocations.state": ["queued", "leased"],
  "avatar_object_cleanup.state": ["queued", "leased"],
  "catalog_artifacts.kind": ["source_main", "source_image", "derived_catalog"],
  "catalog_artifacts.visibility": ["private_source", "authenticated_download"],
  "catalog_image_assets.kind": ["circle_cut", "common"],
  "catalog_image_assets.content_type": [
    "image/jpeg",
    "image/png",
    "image/webp",
  ],
  "catalog_multipart_upload_receipts.state": [
    "creating",
    "active",
    "completed",
  ],
  "catalog_multipart_upload_receipts.visibility": [
    "private_source",
    "authenticated_download",
  ],
  "catalog_refresh_command_receipts.action": [
    "lease",
    "renew",
    "complete",
    "release",
  ],
  "catalog_refresh_jobs.state": ["queued", "leased", "published", "failed"],
  "catalog_versions.state": ["staging", "published", "superseded", "failed"],
  "circle_update_events.state_kind": [
    "attendance",
    "inventory",
    "presence",
    "shinagaki",
    "cover",
  ],
  "circle_update_events.confidence": ["high", "medium", "low", "unmatched"],
  "circlems_oauth_starts.purpose": ["authenticate", "link"],
  "circlems_oauth_starts.environment": ["production", "sandbox"],
  "deleted_provider_identity_tombstones.provider": [
    "circlems",
    "google",
    "apple",
  ],
  "deleted_shared_plan_tombstones.reason": ["owner_account_deleted"],
  "following_imports.status": ["fetching", "ready", "failed"],
  "following_snapshot_cleanup.state": ["queued", "leased"],
  "notification_deliveries.status": [
    "pending",
    "processing",
    "retry",
    "delivered",
    "dead",
    "suppressed",
  ],
  "post_media.role": ["shinagaki", "cover", "post_image"],
  "provider_avatar_import_jobs.state": ["queued", "leased"],
  "provider_credential_handoff_receipts.action_scope": [
    "circlems_auth",
    "circlems_link",
  ],
  "push_devices.apns_environment": ["sandbox", "production"],
  "shared_plan_events.source_kind": ["legacy", "operation", "conflict"],
  "shared_plan_members.role": ["owner", "editor"],
  "shared_plan_notification_deliveries.urgency": ["routine", "conflict"],
  "shared_plan_notification_deliveries.status": [
    "pending",
    "processing",
    "retry",
    "delivered",
    "dead",
    "suppressed",
  ],
  "shared_plan_requests.result_status": ["active", "archived"],
  "user_identities.provider": ["circlems", "google", "apple"],
  "user_identities.provider_environment": ["", "production", "sandbox"],
  "users.avatar_content_type": ["image/jpeg", "image/png", "image/webp"],
};

test("Drizzle schema covers the final D1 migration shape", () => {
  const dialect = new SQLiteSyncDialect();
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) {
    database.exec(readFileSync(migration, "utf8"));
  }

  const migratedTableNames = (
    database
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);

  assert.deepEqual(Object.keys(migratedTables).sort(), migratedTableNames);

  for (const tableName of migratedTableNames) {
    const drizzleTable =
      migratedTables[tableName as keyof typeof migratedTables];
    const config = getTableConfig(drizzleTable);
    assert.equal(getTableName(drizzleTable), tableName);

    const migratedColumns = (
      database
        .prepare(`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`)
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: string | null;
      }>
    ).map((column) => ({
      name: column.name,
      type: column.type.toUpperCase(),
      notNull: column.notnull === 1 || column.pk > 0,
      primaryKeyOrder: column.pk,
      default: column.dflt_value,
    }));

    assert.deepEqual(
      config.columns.map((column) => ({
        name: column.name,
        type: column.getSQLType().toUpperCase(),
        notNull: column.notNull,
        primaryKeyOrder: primaryKeyOrder(config, column.name),
        default: renderDefault(dialect, column.default),
      })),
      migratedColumns,
      `${tableName} columns must match the fully migrated D1 table`,
    );

    assert.deepEqual(
      drizzleForeignKeys(config),
      migratedForeignKeys(database, tableName),
      `${tableName} foreign keys must match the fully migrated D1 table`,
    );

    assert.deepEqual(
      drizzleUniqueConstraints(config),
      migratedUniqueConstraints(database, tableName),
      `${tableName} unique constraints must match the fully migrated D1 table`,
    );

    assert.deepEqual(
      drizzleExplicitIndexes(config),
      migratedExplicitIndexes(database, tableName),
      `${tableName} explicit indexes must match the fully migrated D1 table`,
    );

    const source = database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
      )
      .get(tableName) as { sql: string };
    assert.deepEqual(
      config.checks.map((item) =>
        normalizeSQL(dialect.sqlToQuery(item.value).sql),
      ),
      extractChecks(source.sql),
      `${tableName} checks must match the fully migrated D1 table`,
    );
  }

  assert.deepEqual(drizzleTextEnums(), expectedTextEnums);
});

function renderDefault(
  dialect: SQLiteSyncDialect,
  value: unknown,
): string | null {
  if (value === undefined) return null;
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return dialect.sqlToQuery(value as SQL).sql;
}

function drizzleTextEnums(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [tableName, table] of Object.entries(migratedTables)) {
    for (const column of getTableConfig(table).columns) {
      if (column.enumValues)
        result[`${tableName}.${column.name}`] = [...column.enumValues];
    }
  }
  return result;
}

function extractChecks(createSQL: string): string[] {
  const checks: string[] = [];
  const upper = createSQL.toUpperCase();
  let cursor = 0;
  while ((cursor = upper.indexOf("CHECK", cursor)) !== -1) {
    let open = cursor + 5;
    while (/\s/.test(createSQL[open] ?? "")) open += 1;
    if (createSQL[open] !== "(") {
      cursor = open;
      continue;
    }
    let depth = 0;
    let quoted = false;
    let end = open;
    for (; end < createSQL.length; end += 1) {
      const character = createSQL[end];
      if (character === "'" && createSQL[end - 1] !== "\\") quoted = !quoted;
      if (!quoted && character === "(") depth += 1;
      if (!quoted && character === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    checks.push(normalizeSQL(createSQL.slice(open + 1, end)));
    cursor = end + 1;
  }
  return checks;
}

function quoteIdentifier(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function primaryKeyOrder(
  config: ReturnType<typeof getTableConfig>,
  columnName: string,
): number {
  const tablePrimaryKey = config.primaryKeys[0]?.columns;
  if (tablePrimaryKey) {
    const index = tablePrimaryKey.findIndex(
      (column) => column.name === columnName,
    );
    return index === -1 ? 0 : index + 1;
  }
  return config.columns.find((column) => column.name === columnName)?.primary
    ? 1
    : 0;
}

function drizzleForeignKeys(
  config: ReturnType<typeof getTableConfig>,
): string[] {
  return config.foreignKeys
    .map((foreignKey) => {
      const reference = foreignKey.reference();
      return [
        reference.columns.map((column) => column.name).join(","),
        getTableName(reference.foreignTable),
        reference.foreignColumns.map((column) => column.name).join(","),
        foreignKey.onUpdate ?? "no action",
        foreignKey.onDelete ?? "no action",
      ].join("|");
    })
    .sort();
}

function migratedForeignKeys(
  database: DatabaseSync,
  tableName: string,
): string[] {
  const rows = database
    .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`)
    .all() as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
  }>;
  const groups = Map.groupBy(rows, (row) => row.id);
  return [...groups.values()]
    .map((group) => {
      const ordered = group.toSorted((left, right) => left.seq - right.seq);
      return [
        ordered.map((row) => row.from).join(","),
        ordered[0].table,
        ordered.map((row) => row.to).join(","),
        ordered[0].on_update.toLowerCase(),
        ordered[0].on_delete.toLowerCase(),
      ].join("|");
    })
    .sort();
}

function drizzleUniqueConstraints(
  config: ReturnType<typeof getTableConfig>,
): string[] {
  return config.uniqueConstraints
    .map((constraint) =>
      constraint.columns.map((column) => column.name).join(","),
    )
    .sort();
}

function migratedUniqueConstraints(
  database: DatabaseSync,
  tableName: string,
): string[] {
  const indexes = database
    .prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`)
    .all() as Array<{ name: string; origin: string }>;
  return indexes
    .filter(({ origin }) => origin === "u")
    .map(({ name }) =>
      (
        database
          .prepare(`PRAGMA index_info(${quoteIdentifier(name)})`)
          .all() as Array<{
          seqno: number;
          name: string;
        }>
      )
        .toSorted((left, right) => left.seqno - right.seqno)
        .map((column) => column.name)
        .join(","),
    )
    .sort();
}

type NormalizedIndex = {
  name: string;
  unique: boolean;
  columns: string[];
  where: string | null;
};

function drizzleExplicitIndexes(
  config: ReturnType<typeof getTableConfig>,
): NormalizedIndex[] {
  const dialect = new SQLiteSyncDialect();
  return config.indexes
    .map(({ config: index }) => ({
      name: index.name,
      unique: index.unique,
      columns: index.columns.map((column) => {
        if ("name" in column) return `${column.name}:asc`;
        const rendered = dialect.sqlToQuery(column, "indexes").sql;
        const match = rendered.match(/^"([^"]+)"(?: (asc|desc))?$/i);
        assert.ok(match, `unsupported Drizzle index expression: ${rendered}`);
        return `${match[1]}:${(match[2] ?? "asc").toLowerCase()}`;
      }),
      where: index.where
        ? normalizeSQL(dialect.sqlToQuery(index.where, "indexes").sql)
        : null,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function migratedExplicitIndexes(
  database: DatabaseSync,
  tableName: string,
): NormalizedIndex[] {
  const indexes = (
    database
      .prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`)
      .all() as Array<{
      name: string;
      origin: string;
      unique: number;
    }>
  ).filter(({ origin }) => origin === "c");
  return indexes
    .map(({ name, unique }) => {
      const columns = database
        .prepare(`PRAGMA index_xinfo(${quoteIdentifier(name)})`)
        .all() as Array<{
        seqno: number;
        name: string | null;
        desc: number;
        key: number;
      }>;
      const source = database
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
        )
        .get(name) as { sql: string };
      const where = source.sql.match(/\sWHERE\s+([\s\S]+)$/i)?.[1];
      return {
        name,
        unique: unique === 1,
        columns: columns
          .filter((column) => column.key === 1)
          .toSorted((left, right) => left.seqno - right.seqno)
          .map((column) => `${column.name}:${column.desc ? "desc" : "asc"}`),
        where: where ? normalizeSQL(where) : null,
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function normalizeSQL(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
