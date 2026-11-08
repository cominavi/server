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
  const plans = [];
  for (const event of events)
    plans.push(await planEdition(db, event, options.now));
  for (const plan of plans)
    if (plan.statements.length > 0)
      await runBatch(db, plan.statements, { catalogEventKey: plan.key });
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
        checkpointUpsert(db, step, String(to), now, finished),
      ],
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
  const [circle] = await db
    .select({
      wcID: catalogStableCircles.wcID,
      circleKey: catalogEditionCircles.circleKey,
      legacyWCID: catalogEditionCircles.legacyWCID,
      keyOrigin: catalogEditionCircles.keyOrigin,
    })
    .from(catalogStableCircles)
    .innerJoin(
      catalogEditionCircles,
      and(
        eq(catalogEditionCircles.catalogEventKey, key),
        sql`(${catalogEditionCircles.circleKey} = CAST(${catalogStableCircles.wcID} AS TEXT)
             OR ${catalogEditionCircles.legacyWCID} = ${catalogStableCircles.wcID})`,
      ),
    )
    .where(
      and(
        eq(catalogStableCircles.comiketNo, comiketNo),
        sql`${catalogStableCircles.wcID} > ${from} AND ${catalogStableCircles.wcID} <= ${to}`,
        sql`NOT (${catalogEditionCircles.circleKey} = CAST(${catalogStableCircles.wcID} AS TEXT)
                 AND ${catalogEditionCircles.legacyWCID} IS ${catalogStableCircles.wcID}
                 AND ${catalogEditionCircles.keyOrigin} = 'provider_durable')`,
      ),
    )
    .limit(1);
  if (circle)
    throw new CatalogIdentityCollision("circle_key_conflict", {
      catalogEventKey: key,
      wcID: circle.wcID,
      existingCircleKey: circle.circleKey,
      existingLegacyWCID: circle.legacyWCID,
    });

  const [alias] = await db
    .select({
      wcID: catalogStableCircles.wcID,
      aliasValue: catalogProviderAliases.aliasValue,
      circleKey: catalogProviderAliases.circleKey,
      aliasKey: catalogProviderAliases.catalogEventKey,
      retiredAt: catalogProviderAliases.retiredAt,
    })
    .from(catalogStableCircles)
    .innerJoin(
      catalogProviderAliases,
      and(
        eq(catalogProviderAliases.provider, "circlems"),
        eq(catalogProviderAliases.providerEnvironment, "production"),
        eq(catalogProviderAliases.aliasKind, "wcid"),
        sql`((${catalogProviderAliases.aliasScope} = ${key}
              AND ${catalogProviderAliases.aliasValue} = CAST(${catalogStableCircles.wcID} AS TEXT))
          OR (${catalogProviderAliases.catalogEventKey} = ${key}
              AND ${catalogProviderAliases.circleKey} = CAST(${catalogStableCircles.wcID} AS TEXT)
              AND ${catalogProviderAliases.retiredAt} IS NULL))`,
      ),
    )
    .where(
      and(
        eq(catalogStableCircles.comiketNo, comiketNo),
        sql`${catalogStableCircles.wcID} > ${from} AND ${catalogStableCircles.wcID} <= ${to}`,
        sql`NOT (${catalogProviderAliases.aliasScope} = ${key}
                 AND ${catalogProviderAliases.aliasValue} = CAST(${catalogStableCircles.wcID} AS TEXT)
                 AND ${catalogProviderAliases.catalogEventKey} = ${key}
                 AND ${catalogProviderAliases.circleKey} IS CAST(${catalogStableCircles.wcID} AS TEXT)
                 AND ${catalogProviderAliases.retiredAt} IS NULL)`,
      ),
    )
    .limit(1);
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

/** A completed circle step still matches the append-only legacy authority. */
async function circlesReconciled(
  db: CominaviDatabase,
  comiketNo: number,
  key: string,
): Promise<boolean> {
  const [legacy] = await db
    .select({
      count: sql<number>`count(*)`,
      lastPublishedAt: sql<
        number | null
      >`max(${catalogStableCircles.lastPublishedAt})`,
      lastWCID: sql<number | null>`max(${catalogStableCircles.wcID})`,
    })
    .from(catalogStableCircles)
    .where(eq(catalogStableCircles.comiketNo, comiketNo));
  const [neutral] = await db
    .select({
      count: sql<number>`count(*)`,
      lastPublishedAt: sql<
        number | null
      >`max(${catalogEditionCircles.lastPublishedAt})`,
      lastWCID: sql<number | null>`max(${catalogEditionCircles.legacyWCID})`,
    })
    .from(catalogEditionCircles)
    .where(eq(catalogEditionCircles.catalogEventKey, key));
  return (
    legacy.count === neutral.count &&
    legacy.lastPublishedAt === neutral.lastPublishedAt &&
    legacy.lastWCID === neutral.lastWCID
  );
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
      throw new CatalogIdentityCollision(
        context.fromWCID === undefined
          ? "edition_key_taken"
          : "circle_key_conflict",
        { ...context, constraint: error.message.slice(0, 200) },
      );
    throw error;
  }
}
