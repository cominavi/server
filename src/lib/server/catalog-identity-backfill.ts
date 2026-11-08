import * as Sentry from "@sentry/cloudflare";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import { createDatabase, type CominaviDatabase } from "../db/client";
import {
  catalogDates,
  catalogEditionCircles,
  catalogEditions,
  catalogEvents,
  catalogIdentityBackfillCheckpoints,
  catalogProviderAliases,
  catalogStableCircles,
} from "../db/schema";
import { comiketEditionKey, comiketEditionMetadata } from "./catalog-identity";

/**
 * P2 backfill from the legacy Comiket tables into the provider-neutral
 * identity tables (cominavi/cominavi docs/proposals/catalog-contracts.md §2.9).
 *
 * - Restartable: progress is a per-step cursor in
 *   `catalog_identity_backfill_checkpoints`, committed in the same D1 batch as
 *   the rows it covers.
 * - Chunked: one bounded set-based batch per chunk of stable circles.
 * - Idempotent: rerunning writes nothing new; a completed step is reconciled
 *   against the legacy table and rescanned only when they diverge.
 * - Fail closed: an existing row that disagrees with the legacy authority
 *   stops the backfill with `CatalogIdentityCollision`; nothing is overwritten.
 */

export type CatalogIdentityCollisionKind =
  | "edition_key_taken"
  | "legacy_number_taken"
  | "event_alias_conflict"
  | "circle_key_conflict"
  | "circle_alias_conflict";

export class CatalogIdentityCollision extends Error {
  readonly code = "catalog_identity_collision";

  constructor(
    readonly kind: CatalogIdentityCollisionKind,
    readonly details: Record<string, string | number | null>,
  ) {
    super(
      `catalog identity backfill collision: ${kind} ${JSON.stringify(details)}`,
    );
    this.name = "CatalogIdentityCollision";
  }
}

export type CatalogIdentityBackfillResult = {
  editions: number;
  chunks: number;
  circlesWritten: number;
  complete: boolean;
};

export const editionsStep = "editions";
export function circlesStep(catalogEventKey: string): string {
  return `circles:${catalogEventKey}`;
}

const defaultChunkSize = 500;
const defaultMaxChunks = 20;

export async function runCatalogIdentityBackfill(
  database: D1Database,
  options: { now: number; chunkSize?: number; maxChunks?: number },
): Promise<CatalogIdentityBackfillResult> {
  const db = createDatabase(database);
  const chunkSize = options.chunkSize ?? defaultChunkSize;
  const maxChunks = options.maxChunks ?? defaultMaxChunks;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 1000)
    throw new RangeError("chunkSize must be between 1 and 1000");

  const events = await db
    .select({
      comiketNo: catalogEvents.comiketNo,
      name: catalogEvents.name,
      providerEventID: catalogEvents.providerCirclemsEventID,
      activeVersionID: catalogEvents.activeVersionID,
    })
    .from(catalogEvents)
    .orderBy(asc(catalogEvents.comiketNo));

  // Check every edition before writing any, so a collision writes nothing.
  const providerEventOwners = new Map<number, number>();
  for (const event of events) {
    if (event.providerEventID === null) continue;
    const owner = providerEventOwners.get(event.providerEventID);
    if (owner !== undefined)
      throw new CatalogIdentityCollision("event_alias_conflict", {
        providerEventID: String(event.providerEventID),
        comiketNo: event.comiketNo,
        otherComiketNo: owner,
      });
    providerEventOwners.set(event.providerEventID, event.comiketNo);
  }
  const plans = [];
  for (const event of events)
    plans.push(await planEdition(db, event, options.now));
  for (const plan of plans)
    await runBatch(db, plan.statements, "event_alias_conflict", {
      catalogEventKey: plan.key,
    });
  await saveCheckpoint(db, editionsStep, events.at(-1)?.comiketNo, options.now);

  const result: CatalogIdentityBackfillResult = {
    editions: events.length,
    chunks: 0,
    circlesWritten: 0,
    complete: true,
  };
  for (const event of events) {
    const remaining = maxChunks - result.chunks;
    const progress = await backfillCircles(
      db,
      event.comiketNo,
      options.now,
      chunkSize,
      remaining,
    );
    result.chunks += progress.chunks;
    result.circlesWritten += progress.circlesWritten;
    if (!progress.complete) {
      result.complete = false;
      break;
    }
  }
  return result;
}

/** Cron entry point: never throws; collisions are reported and stop the run. */
export async function processCatalogIdentityBackfill(
  database: D1Database,
  now = Math.floor(Date.now() / 1000),
): Promise<CatalogIdentityBackfillResult | null> {
  try {
    return await runCatalogIdentityBackfill(database, { now });
  } catch (error) {
    Sentry.withScope((scope) => {
      scope.setTag("cominavi.feature", "catalog-identity-backfill");
      if (error instanceof CatalogIdentityCollision) {
        scope.setTag("cominavi.error_code", error.code);
        scope.setContext("catalog_identity_collision", {
          kind: error.kind,
          ...error.details,
        });
      }
      Sentry.captureException(error, {
        mechanism: {
          handled: true,
          type: "cominavi.catalog_identity_backfill",
        },
      });
    });
    console.error(
      JSON.stringify({
        event: "catalog_identity_backfill_failed",
        code:
          error instanceof CatalogIdentityCollision ? error.code : "unexpected",
        kind: error instanceof CatalogIdentityCollision ? error.kind : null,
        details:
          error instanceof CatalogIdentityCollision ? error.details : null,
      }),
    );
    return null;
  }
}

async function planEdition(
  db: CominaviDatabase,
  event: {
    comiketNo: number;
    name: string;
    providerEventID: number | null;
    activeVersionID: string | null;
  },
  now: number,
): Promise<{ key: string; statements: BatchItem<"sqlite">[] }> {
  const key = comiketEditionKey(event.comiketNo);
  const days = event.activeVersionID
    ? await db
        .select({ day: catalogDates.day, date: catalogDates.dateISO })
        .from(catalogDates)
        .where(eq(catalogDates.versionID, event.activeVersionID))
        .orderBy(asc(catalogDates.day))
    : [];
  const metadataJSON = JSON.stringify(
    comiketEditionMetadata({
      comiketNo: event.comiketNo,
      name: event.name,
      days,
    }),
  );
  const listingState = event.activeVersionID ? "listed" : "hidden";

  const [byLegacy] = await db
    .select({ key: catalogEditions.catalogEventKey })
    .from(catalogEditions)
    .where(eq(catalogEditions.legacyComiketNo, event.comiketNo));
  if (byLegacy && byLegacy.key !== key)
    throw new CatalogIdentityCollision("legacy_number_taken", {
      comiketNo: event.comiketNo,
      expectedKey: key,
      existingKey: byLegacy.key,
    });
  const [existing] = await db
    .select({
      seriesKey: catalogEditions.seriesKey,
      legacyComiketNo: catalogEditions.legacyComiketNo,
      sourceProvider: catalogEditions.sourceProvider,
      metadataJSON: catalogEditions.metadataJSON,
      metadataRevision: catalogEditions.metadataRevision,
      listingState: catalogEditions.listingState,
    })
    .from(catalogEditions)
    .where(eq(catalogEditions.catalogEventKey, key));
  if (
    existing &&
    (existing.seriesKey !== "comiket" ||
      existing.legacyComiketNo !== event.comiketNo ||
      existing.sourceProvider !== "circlems")
  )
    throw new CatalogIdentityCollision("edition_key_taken", {
      catalogEventKey: key,
      comiketNo: event.comiketNo,
      existingSeries: existing.seriesKey,
      existingLegacyComiketNo: existing.legacyComiketNo,
    });

  const statements: BatchItem<"sqlite">[] = [];
  if (!existing) {
    statements.push(
      db
        .insert(catalogEditions)
        .values({
          catalogEventKey: key,
          seriesKey: "comiket",
          legacyComiketNo: event.comiketNo,
          metadataSchemaVersion: 1,
          metadataJSON,
          metadataRevision: 1,
          sourceProvider: "circlems",
          listingState,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing(),
    );
  } else if (
    existing.metadataJSON !== metadataJSON ||
    existing.listingState !== listingState
  ) {
    statements.push(
      db
        .update(catalogEditions)
        .set({
          metadataJSON,
          metadataRevision:
            existing.metadataJSON === metadataJSON
              ? existing.metadataRevision
              : existing.metadataRevision + 1,
          listingState,
          updatedAt: now,
        })
        .where(
          and(
            eq(catalogEditions.catalogEventKey, key),
            eq(catalogEditions.metadataRevision, existing.metadataRevision),
          ),
        ),
    );
  }

  if (event.providerEventID !== null) {
    const aliasValue = String(event.providerEventID);
    const aliases = await db
      .select({
        value: catalogProviderAliases.aliasValue,
        key: catalogProviderAliases.catalogEventKey,
        retiredAt: catalogProviderAliases.retiredAt,
      })
      .from(catalogProviderAliases)
      .where(
        and(
          eq(catalogProviderAliases.provider, "circlems"),
          eq(catalogProviderAliases.providerEnvironment, "production"),
          eq(catalogProviderAliases.aliasKind, "circlems_event_id"),
          eq(catalogProviderAliases.aliasScope, ""),
          sql`(${catalogProviderAliases.aliasValue} = ${aliasValue}
               OR (${catalogProviderAliases.catalogEventKey} = ${key}
                   AND ${catalogProviderAliases.retiredAt} IS NULL))`,
        ),
      );
    const conflict = aliases.find(
      (alias) =>
        alias.key !== key ||
        alias.value !== aliasValue ||
        alias.retiredAt !== null,
    );
    if (conflict)
      throw new CatalogIdentityCollision("event_alias_conflict", {
        catalogEventKey: key,
        providerEventID: aliasValue,
        existingKey: conflict.key,
        existingValue: conflict.value,
        existingRetiredAt: conflict.retiredAt,
      });
    if (aliases.length === 0)
      statements.push(
        db
          .insert(catalogProviderAliases)
          .values({
            provider: "circlems",
            providerEnvironment: "production",
            aliasKind: "circlems_event_id",
            aliasScope: "",
            aliasValue,
            catalogEventKey: key,
            circleKey: null,
            createdAt: now,
            retiredAt: null,
          })
          .onConflictDoNothing(),
      );
  }

  // In-batch assertion: if this edition (and its provider event alias) is
  // not exactly what the legacy authority implies once the writes above have
  // applied, insert a row that violates the catalog_editions key CHECK so
  // the whole batch rolls back. ON CONFLICT DO NOTHING above keeps identical
  // concurrent runs idempotent; this guard keeps disagreeing ones fatal.
  const aliasValue =
    event.providerEventID === null ? null : String(event.providerEventID);
  statements.push(
    db.insert(catalogEditions).select(sql`
      SELECT '', 'comiket', NULL, 1, '{}', 1, 'circlems', 'hidden', 0, 0
      WHERE NOT EXISTS (
          SELECT 1 FROM catalog_editions
          WHERE catalog_event_key = ${key} AND series_key = 'comiket'
            AND legacy_comiket_no = ${event.comiketNo}
            AND source_provider = 'circlems')
        OR (${aliasValue} IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM catalog_provider_aliases
          WHERE provider = 'circlems' AND provider_environment = 'production'
            AND alias_kind = 'circlems_event_id' AND alias_scope = ''
            AND alias_value = ${aliasValue} AND catalog_event_key = ${key}
            AND circle_key IS NULL AND retired_at IS NULL))
        OR EXISTS (
          SELECT 1 FROM catalog_provider_aliases
          WHERE provider = 'circlems' AND provider_environment = 'production'
            AND alias_kind = 'circlems_event_id' AND catalog_event_key = ${key}
            AND retired_at IS NULL AND alias_value IS NOT ${aliasValue})`),
  );
  return { key, statements };
}

async function backfillCircles(
  db: CominaviDatabase,
  comiketNo: number,
  now: number,
  chunkSize: number,
  maxChunks: number,
): Promise<{ chunks: number; circlesWritten: number; complete: boolean }> {
  const key = comiketEditionKey(comiketNo);
  const step = circlesStep(key);
  const [checkpoint] = await db
    .select()
    .from(catalogIdentityBackfillCheckpoints)
    .where(eq(catalogIdentityBackfillCheckpoints.step, step));
  let cursor = checkpoint?.lastKey ? Number(checkpoint.lastKey) : 0;
  if (checkpoint?.completedAt != null) {
    if (await circlesReconciled(db, comiketNo, key))
      return { chunks: 0, circlesWritten: 0, complete: true };
    cursor = 0;
  }

  if (maxChunks > 0) await assertLiveWCIDAliasesCanonical(db, key);

  let chunks = 0;
  let circlesWritten = 0;
  while (chunks < maxChunks) {
    const ids = await db
      .select({ wcID: catalogStableCircles.wcID })
      .from(catalogStableCircles)
      .where(
        and(
          eq(catalogStableCircles.comiketNo, comiketNo),
          gt(catalogStableCircles.wcID, cursor),
        ),
      )
      .orderBy(asc(catalogStableCircles.wcID))
      .limit(chunkSize);
    if (ids.length === 0) {
      await saveCheckpoint(db, step, cursor || undefined, now, true);
      return { chunks, circlesWritten, complete: true };
    }
    const from = cursor;
    const to = ids.at(-1)!.wcID;
    await assertCircleRangeConsistent(db, comiketNo, key, from, to);

    const rangeFilter = sql`FROM catalog_stable_circles
      WHERE comiket_no = ${comiketNo} AND wc_id > ${from} AND wc_id <= ${to}`;
    const finished = ids.length < chunkSize;
    await runBatch(
      db,
      [
        db
          .insert(catalogEditionCircles)
          .select(
            sql`SELECT ${key}, CAST(wc_id AS TEXT), wc_id, 'provider_durable',
                       first_version_id, last_version_id, first_published_at,
                       last_published_at
                ${rangeFilter}`,
          )
          .onConflictDoUpdate({
            target: [
              catalogEditionCircles.catalogEventKey,
              catalogEditionCircles.circleKey,
            ],
            set: {
              firstVersionID: sql`excluded.first_version_id`,
              lastVersionID: sql`excluded.last_version_id`,
              firstPublishedAt: sql`excluded.first_published_at`,
              lastPublishedAt: sql`excluded.last_published_at`,
            },
            setWhere: sql`${catalogEditionCircles.legacyWCID} = excluded.legacy_wc_id
              AND (${catalogEditionCircles.firstVersionID} IS NOT excluded.first_version_id
                OR ${catalogEditionCircles.lastVersionID} IS NOT excluded.last_version_id
                OR ${catalogEditionCircles.firstPublishedAt} IS NOT excluded.first_published_at
                OR ${catalogEditionCircles.lastPublishedAt} IS NOT excluded.last_published_at)`,
          }),
        db
          .insert(catalogProviderAliases)
          .select(
            sql`SELECT 'circlems', 'production', 'wcid', ${key},
                       CAST(wc_id AS TEXT), ${key}, CAST(wc_id AS TEXT),
                       ${now}, NULL
                ${rangeFilter}`,
          )
          .onConflictDoNothing(),
        // In-batch assertion: every stable circle in the range must now have
        // its exact edition circle and live WCID alias, or a row violating
        // the circle_key CHECK aborts the batch (and its checkpoint).
        db.insert(catalogEditionCircles).select(sql`
          SELECT ${key}, '', NULL, 'provider_durable', first_version_id,
                 last_version_id, 0, 0
          FROM catalog_stable_circles AS stable
          WHERE stable.comiket_no = ${comiketNo}
            AND stable.wc_id > ${from} AND stable.wc_id <= ${to}
            AND ${circleMismatch(key)}
          LIMIT 1`),
        checkpointUpsert(db, step, String(to), now, finished),
      ],
      "circle_key_conflict",
      { catalogEventKey: key, fromWCID: from, toWCID: to },
    );
    chunks += 1;
    circlesWritten += ids.length;
    cursor = to;
    if (finished) return { chunks, circlesWritten, complete: true };
  }
  return { chunks, circlesWritten, complete: false };
}

async function assertCircleRangeConsistent(
  db: CominaviDatabase,
  comiketNo: number,
  key: string,
  from: number,
  to: number,
): Promise<void> {
  // Each check is a separate lookup on one full index key per stable circle
  // (no OR joins), so a chunk costs O(chunk) index probes, not a scan of the
  // edition's population.
  const range = sql`stable.comiket_no = ${comiketNo}
    AND stable.wc_id > ${from} AND stable.wc_id <= ${to}`;
  const circleByKey = await db.all<{
    wcID: number;
    circleKey: string;
    legacyWCID: number | null;
  }>(sql`
    SELECT stable.wc_id AS wcID, edition.circle_key AS circleKey,
           edition.legacy_wc_id AS legacyWCID
    FROM catalog_stable_circles AS stable
    JOIN catalog_edition_circles AS edition
      ON edition.catalog_event_key = ${key}
     AND edition.circle_key = CAST(stable.wc_id AS TEXT)
    WHERE ${range}
      AND (edition.legacy_wc_id IS NOT stable.wc_id
        OR edition.key_origin IS NOT 'provider_durable')
    LIMIT 1`);
  const circleByLegacy = circleByKey.length
    ? circleByKey
    : await db.all<{
        wcID: number;
        circleKey: string;
        legacyWCID: number | null;
      }>(sql`
        SELECT stable.wc_id AS wcID, edition.circle_key AS circleKey,
               edition.legacy_wc_id AS legacyWCID
        FROM catalog_stable_circles AS stable
        JOIN catalog_edition_circles AS edition
          ON edition.catalog_event_key = ${key}
         AND edition.legacy_wc_id = stable.wc_id
        WHERE ${range}
          AND edition.circle_key IS NOT CAST(stable.wc_id AS TEXT)
        LIMIT 1`);
  const [circle] = circleByLegacy;
  if (circle)
    throw new CatalogIdentityCollision("circle_key_conflict", {
      catalogEventKey: key,
      wcID: circle.wcID,
      existingCircleKey: circle.circleKey,
      existingLegacyWCID: circle.legacyWCID,
    });

  type AliasRow = {
    wcID: number;
    aliasValue: string;
    circleKey: string | null;
    aliasKey: string;
    retiredAt: number | null;
  };
  // The alias primary key: (provider, environment, kind, scope, value).
  const aliasByValue = await db.all<AliasRow>(sql`
    SELECT stable.wc_id AS wcID, alias.alias_value AS aliasValue,
           alias.circle_key AS circleKey, alias.catalog_event_key AS aliasKey,
           alias.retired_at AS retiredAt
    FROM catalog_stable_circles AS stable
    JOIN catalog_provider_aliases AS alias
      ON alias.provider = 'circlems' AND alias.provider_environment = 'production'
     AND alias.alias_kind = 'wcid' AND alias.alias_scope = ${key}
     AND alias.alias_value = CAST(stable.wc_id AS TEXT)
    WHERE ${range}
      AND (alias.catalog_event_key IS NOT ${key}
        OR alias.circle_key IS NOT CAST(stable.wc_id AS TEXT)
        OR alias.retired_at IS NOT NULL)
    LIMIT 1`);
  const [alias] = aliasByValue;
  if (alias)
    throw new CatalogIdentityCollision("circle_alias_conflict", {
      catalogEventKey: key,
      wcID: alias.wcID,
      existingAliasValue: alias.aliasValue,
      existingCircleKey: alias.circleKey,
      existingAliasKey: alias.aliasKey,
      existingRetiredAt: alias.retiredAt,
    });
}

/**
 * A Circle.ms edition's live WCID aliases always map value -> the same
 * circle key in the edition's own scope. One query per edition, bounded by
 * the live-target index prefix (provider, environment, kind, edition), finds
 * any alias that targets an edition circle under a different value or scope.
 * The in-batch guard still catches one written concurrently.
 */
async function assertLiveWCIDAliasesCanonical(
  db: CominaviDatabase,
  key: string,
): Promise<void> {
  const [alias] = await db.all<{
    aliasScope: string;
    aliasValue: string;
    circleKey: string | null;
  }>(sql`
    SELECT alias_scope AS aliasScope, alias_value AS aliasValue,
           circle_key AS circleKey
    FROM catalog_provider_aliases INDEXED BY catalog_provider_aliases_live_target
    WHERE provider = 'circlems' AND provider_environment = 'production'
      AND alias_kind = 'wcid' AND catalog_event_key = ${key}
      AND retired_at IS NULL
      AND (alias_scope IS NOT ${key} OR alias_value IS NOT circle_key)
    LIMIT 1`);
  if (alias)
    throw new CatalogIdentityCollision("circle_alias_conflict", {
      catalogEventKey: key,
      existingAliasScope: alias.aliasScope,
      existingAliasValue: alias.aliasValue,
      existingCircleKey: alias.circleKey,
    });
}

/**
 * True when the stable circle `stable` (an alias of catalog_stable_circles)
 * lacks its exact edition circle or its exact live WCID alias.
 */
function circleMismatch(key: string) {
  return sql`(NOT EXISTS (
      SELECT 1 FROM catalog_edition_circles AS edition
      WHERE edition.catalog_event_key = ${key}
        AND edition.circle_key = CAST(stable.wc_id AS TEXT)
        AND edition.legacy_wc_id = stable.wc_id
        AND edition.key_origin = 'provider_durable'
        AND edition.first_version_id = stable.first_version_id
        AND edition.last_version_id = stable.last_version_id
        AND edition.first_published_at = stable.first_published_at
        AND edition.last_published_at = stable.last_published_at)
    OR NOT EXISTS (
      SELECT 1 FROM catalog_provider_aliases AS alias
      WHERE alias.provider = 'circlems' AND alias.provider_environment = 'production'
        AND alias.alias_kind = 'wcid' AND alias.alias_scope = ${key}
        AND alias.alias_value = CAST(stable.wc_id AS TEXT)
        AND alias.catalog_event_key = ${key}
        AND alias.circle_key = CAST(stable.wc_id AS TEXT)
        AND alias.retired_at IS NULL))`;
}

/**
 * A completed circle step still matches the append-only legacy authority
 * row for row: every stable circle has its exact edition circle and alias,
 * and the edition has no extra circles.
 */
async function circlesReconciled(
  db: CominaviDatabase,
  comiketNo: number,
  key: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      legacy: sql<number>`(SELECT count(*) FROM catalog_stable_circles WHERE comiket_no = ${comiketNo})`,
      neutral: sql<number>`(SELECT count(*) FROM catalog_edition_circles WHERE catalog_event_key = ${key})`,
      mismatch: sql<number>`EXISTS (
        SELECT 1 FROM catalog_stable_circles AS stable
        WHERE stable.comiket_no = ${comiketNo} AND ${circleMismatch(key)})`,
    })
    .from(sql`(SELECT 1)`);
  return row.legacy === row.neutral && row.mismatch === 0;
}

function checkpointUpsert(
  db: CominaviDatabase,
  step: string,
  lastKey: string | null,
  now: number,
  completed: boolean,
) {
  const completedAt = completed ? now : null;
  return db
    .insert(catalogIdentityBackfillCheckpoints)
    .values({ step, lastKey, completedAt })
    .onConflictDoUpdate({
      target: catalogIdentityBackfillCheckpoints.step,
      set: { lastKey, completedAt },
    });
}

async function saveCheckpoint(
  db: CominaviDatabase,
  step: string,
  lastKey: number | undefined,
  now: number,
  completed = true,
): Promise<void> {
  await checkpointUpsert(
    db,
    step,
    lastKey === undefined ? null : String(lastKey),
    now,
    completed,
  );
}

async function runBatch(
  db: CominaviDatabase,
  statements: BatchItem<"sqlite">[],
  collisionKind: CatalogIdentityCollisionKind,
  context: Record<string, string | number | null>,
): Promise<void> {
  try {
    await db.batch(
      statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
    );
  } catch (error) {
    // A constraint race (another writer inserted a disagreeing row between
    // the consistency check and this batch) is a collision, never a retry.
    if (
      error instanceof Error &&
      /UNIQUE|PRIMARY KEY|CHECK|FOREIGN KEY/i.test(error.message)
    )
      throw new CatalogIdentityCollision(collisionKind, {
        ...context,
        constraint: error.message.slice(0, 200),
      });
    throw error;
  }
}
