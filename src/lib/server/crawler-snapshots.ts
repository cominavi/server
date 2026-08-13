import {
  and,
  asc,
  count,
  eq,
  inArray,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import { runDrizzleBatch } from "../db/batch";
import { createDatabase } from "../db/client";
import {
  catalogArtifacts,
  catalogEvents,
  catalogStableCircles,
  catalogVersions,
  circleUpdateEvents,
  crawlerSnapshotHeads,
  crawlerSnapshotObjectCleanup,
  crawlerSnapshotPublicationReceipts,
  crawlerSnapshotVersions,
} from "../db/schema";
import { parseCrawlerEvent, type CrawlerEvent } from "./crawler-ingest";
import { ServiceError } from "./service-error";

export interface CrawlerRealtimeSnapshot {
  schemaVersion: 1;
  source: "cominavi-collector";
  eventNumber: number;
  revision: string;
  generation: number;
  catalogPayloadSHA256: string;
  matchingPolicyRevision: string;
  observedAt: string;
  events: CrawlerEvent[];
}

export interface CrawlerSnapshotPublication {
  baseRevision: string;
  snapshot: CrawlerRealtimeSnapshot;
}

export interface CrawlerSnapshotPublicationResult {
  eventNumber: number;
  revision: string;
  generation: number;
  publicationCursor: number;
  active: true;
  publishedAt: string;
  duplicate: boolean;
}

export interface ActiveCrawlerSnapshot {
  revision: string;
  generation: number;
  publicationCursor: number;
  catalogSourceMainSHA256: string;
  events?: CrawlerEvent[];
}

export interface CrawlerSnapshotAuthority {
  schemaVersion: 1;
  eventNumber: number;
  publicationRevision: string;
  publicationGeneration: number;
  publicationCursor: number;
  snapshotCatalogSourceMainSHA256: string;
  activeCatalog: {
    versionID: string;
    sourceMainSHA256: string;
    sourceMainBytes: number;
    contentType: "application/vnd.sqlite3";
    downloadPath: "/api/v2/internal/crawler/catalog-source-main";
  };
  proposedPublication?:
    | {
        revision: string;
        generation: number;
        status: "notActivated";
      }
    | {
        revision: string;
        generation: number;
        status: "activated";
        publicationCursor: number;
        publishedAt: string;
        active: boolean;
      };
}

export interface ProposedCrawlerSnapshotPublication {
  revision: string;
  generation: number;
}

interface SnapshotVersionRow {
  revision: string;
  generation: number;
  publicationCursor: number;
  catalogPayloadSHA256: string;
  objectKey: string;
  objectSHA256: string;
  byteCount: number;
  updateCount: number;
}

interface ActiveCatalogSource {
  versionID: string;
  sourceMainSHA256: string;
  objectKey: string;
  byteCount: number;
  contentType: string;
}

interface StoredPublicationResult extends Omit<
  CrawlerSnapshotPublicationResult,
  "duplicate"
> {}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const digestPattern = /^[0-9a-f]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const maximumSnapshotEvents = 20_000;
const snapshotContentType =
  "application/vnd.cominavi.realtime-snapshot-v1+json";
const catalogSourceDownloadPath =
  "/api/v2/internal/crawler/catalog-source-main";

export const maximumCrawlerSnapshotPublicationBytes = 16 * 1024 * 1024;
export const maximumCrawlerSnapshotAuthorityBytes = 32 * 1024;
export const maximumCrawlerCatalogSourceBytes = 256 * 1024 * 1024;

export function canonicalCrawlerSnapshotSemanticJSON(
  snapshot: CrawlerRealtimeSnapshot,
): string {
  const { revision: _revision, ...semantic } = snapshot;
  return canonicalJSONString(semantic);
}

export function canonicalCrawlerSnapshotJSON(
  snapshot: CrawlerRealtimeSnapshot,
): string {
  return canonicalJSONString(snapshot);
}

export async function calculateCrawlerSnapshotRevision(
  snapshot: CrawlerRealtimeSnapshot,
): Promise<string> {
  return sha256Hex(
    encoder.encode(canonicalCrawlerSnapshotSemanticJSON(snapshot)),
  );
}

export async function parseCrawlerSnapshotPublication(
  rawBody: Uint8Array,
): Promise<CrawlerSnapshotPublication> {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(rawBody));
  } catch {
    throw invalidSnapshot("The snapshot publication is not valid UTF-8 JSON.");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["baseRevision", "snapshot"]) ||
    !isRevisionOrNone(value.baseRevision) ||
    !isRecord(value.snapshot)
  ) {
    throw invalidSnapshot("The snapshot publication envelope is invalid.");
  }
  const source = value.snapshot;
  if (
    !hasExactKeys(source, [
      "schemaVersion",
      "source",
      "eventNumber",
      "revision",
      "generation",
      "catalogPayloadSHA256",
      "matchingPolicyRevision",
      "observedAt",
      "events",
    ]) ||
    source.schemaVersion !== 1 ||
    source.source !== "cominavi-collector" ||
    !isBoundedPositiveInteger(source.eventNumber, 10_000) ||
    !digestPattern.test(String(source.revision)) ||
    !isBoundedPositiveInteger(source.generation, Number.MAX_SAFE_INTEGER) ||
    !digestPattern.test(String(source.catalogPayloadSHA256)) ||
    typeof source.matchingPolicyRevision !== "string" ||
    !identifierPattern.test(source.matchingPolicyRevision) ||
    parseTimestamp(source.observedAt) === null ||
    !Array.isArray(source.events) ||
    source.events.length > maximumSnapshotEvents
  ) {
    throw invalidSnapshot("The snapshot does not match schema version 1.");
  }

  const events = source.events.map(parseCrawlerEvent);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (
      (event.stateKind !== "shinagaki" && event.stateKind !== "cover") ||
      event.stateValue !== event.post.id ||
      event.notifiable ||
      event.post.media.length === 0 ||
      event.circles.some(
        (circle) => circle.comiketNo !== Number(source.eventNumber),
      ) ||
      (index > 0 && events[index - 1]!.eventKey >= event.eventKey)
    ) {
      throw invalidSnapshot(
        "Snapshot events must be unique, canonical, non-notifying artwork states.",
      );
    }
    for (
      let circleIndex = 1;
      circleIndex < event.circles.length;
      circleIndex += 1
    ) {
      if (
        event.circles[circleIndex - 1]!.wcID >= event.circles[circleIndex]!.wcID
      ) {
        throw invalidSnapshot(
          "Snapshot circle targets must be in canonical ascending WCID order.",
        );
      }
    }
  }

  const snapshot: CrawlerRealtimeSnapshot = {
    schemaVersion: 1,
    source: "cominavi-collector",
    eventNumber: Number(source.eventNumber),
    revision: String(source.revision),
    generation: Number(source.generation),
    catalogPayloadSHA256: String(source.catalogPayloadSHA256),
    matchingPolicyRevision: source.matchingPolicyRevision,
    observedAt: source.observedAt as string,
    events,
  };
  if (
    snapshot.revision !== (await calculateCrawlerSnapshotRevision(snapshot))
  ) {
    throw invalidSnapshot(
      "The snapshot revision does not match its canonical semantic content.",
    );
  }
  return { baseRevision: String(value.baseRevision), snapshot };
}

export async function publishCrawlerSnapshot(
  database: D1Database,
  bucket: R2Bucket,
  authenticated: {
    idempotencyKey: string;
    payloadSHA256: string;
    rawBody: Uint8Array;
  },
  nowMilliseconds = Date.now(),
): Promise<CrawlerSnapshotPublicationResult> {
  const publication = await parseCrawlerSnapshotPublication(
    authenticated.rawBody,
  );
  const replay = await loadPublicationReceipt(
    database,
    authenticated.idempotencyKey,
    authenticated.payloadSHA256,
  );
  if (replay) {
    await ensureReceiptObject(
      database,
      bucket,
      publication,
      replay,
      nowMilliseconds,
    );
    return { ...replay, duplicate: true };
  }

  const activeBefore = await loadSnapshotHead(
    database,
    publication.snapshot.eventNumber,
  );
  const expectedGeneration = (activeBefore?.generation ?? 0) + 1;
  if (
    (activeBefore?.revision ?? "none") !== publication.baseRevision ||
    publication.snapshot.generation !== expectedGeneration
  ) {
    throw snapshotRevisionConflict(activeBefore, expectedGeneration);
  }
  const activeCatalog = await loadActiveCatalog(
    database,
    publication.snapshot.eventNumber,
  );
  if (
    !activeCatalog ||
    (activeCatalog.payloadSHA256 !==
      publication.snapshot.catalogPayloadSHA256 &&
      activeBefore?.catalogPayloadSHA256 !==
        publication.snapshot.catalogPayloadSHA256)
  ) {
    throw snapshotCatalogMismatch(activeCatalog?.payloadSHA256 ?? null);
  }
  await assertSnapshotCatalogTargets(database, publication.snapshot);

  const normalizedBytes = encoder.encode(
    canonicalCrawlerSnapshotJSON(publication.snapshot),
  );
  if (normalizedBytes.byteLength > maximumCrawlerSnapshotPublicationBytes) {
    throw invalidSnapshot("The normalized snapshot is too large.", 413);
  }
  const objectSHA256 = await sha256Hex(normalizedBytes);
  const objectKey = snapshotObjectKey(
    publication.snapshot.eventNumber,
    publication.snapshot.revision,
  );
  await enqueueSnapshotPrewriteCleanup(
    database,
    {
      objectKey,
      eventNumber: publication.snapshot.eventNumber,
      revision: publication.snapshot.revision,
      objectSHA256,
    },
    nowMilliseconds,
  );
  await ensureImmutableSnapshotObject(bucket, {
    objectKey,
    objectSHA256,
    bytes: normalizedBytes,
    snapshot: publication.snapshot,
  });

  const now = Math.floor(nowMilliseconds / 1_000);
  const publishedAt = new Date(now * 1_000).toISOString();
  const receiptAbsent = sql`NOT EXISTS (
    SELECT 1 FROM ${crawlerSnapshotPublicationReceipts}
    WHERE ${crawlerSnapshotPublicationReceipts.idempotencyKey} = ${authenticated.idempotencyKey}
  )`;
  const catalogAuthorityMatches = sql`(
    EXISTS (
      SELECT 1 FROM ${catalogEvents}
      JOIN ${catalogVersions}
        ON ${catalogVersions.id} = ${catalogEvents.activeVersionID}
       AND ${catalogVersions.comiketNo} = ${catalogEvents.comiketNo}
       AND ${catalogVersions.state} = 'published'
      WHERE ${catalogEvents.comiketNo} = ${publication.snapshot.eventNumber}
        AND ${catalogVersions.sourceMainSHA256} = ${publication.snapshot.catalogPayloadSHA256}
    )
    OR EXISTS (
      SELECT 1 FROM ${crawlerSnapshotHeads}
      JOIN ${crawlerSnapshotVersions}
        ON ${crawlerSnapshotVersions.eventNumber} = ${crawlerSnapshotHeads.eventNumber}
       AND ${crawlerSnapshotVersions.revision} = ${crawlerSnapshotHeads.revision}
      WHERE ${crawlerSnapshotHeads.eventNumber} = ${publication.snapshot.eventNumber}
        AND ${crawlerSnapshotHeads.revision} = ${publication.baseRevision}
        AND ${crawlerSnapshotHeads.generation} = ${publication.snapshot.generation - 1}
        AND ${crawlerSnapshotVersions.catalogPayloadSHA256} = ${publication.snapshot.catalogPayloadSHA256}
    )
  )`;
  const baseAuthorityMatches = activeBefore
    ? sql`EXISTS (
        SELECT 1 FROM ${crawlerSnapshotHeads}
        WHERE ${crawlerSnapshotHeads.eventNumber} = ${publication.snapshot.eventNumber}
          AND ${crawlerSnapshotHeads.revision} = ${publication.baseRevision}
          AND ${crawlerSnapshotHeads.generation} = ${publication.snapshot.generation - 1}
      )`
    : sql`NOT EXISTS (
        SELECT 1 FROM ${crawlerSnapshotHeads}
        WHERE ${crawlerSnapshotHeads.eventNumber} = ${publication.snapshot.eventNumber}
      )`;

  const activateHead = activeBefore
    ? sql`INSERT INTO ${crawlerSnapshotHeads} (
        event_number, revision, generation, publication_cursor,
        publication_idempotency_key, updated_at
      )
      SELECT event_number, revision, generation, publication_cursor,
        ${authenticated.idempotencyKey}, ${now}
      FROM ${crawlerSnapshotVersions}
      WHERE event_number = ${publication.snapshot.eventNumber}
        AND revision = ${publication.snapshot.revision}
      ON CONFLICT(event_number) DO UPDATE SET
        revision = excluded.revision,
        generation = excluded.generation,
        publication_cursor = excluded.publication_cursor,
        publication_idempotency_key = excluded.publication_idempotency_key,
        updated_at = excluded.updated_at
      WHERE ${crawlerSnapshotHeads.revision} = ${publication.baseRevision}
        AND ${crawlerSnapshotHeads.generation} = ${publication.snapshot.generation - 1}`
    : sql`INSERT INTO ${crawlerSnapshotHeads} (
        event_number, revision, generation, publication_cursor,
        publication_idempotency_key, updated_at
      )
      SELECT event_number, revision, generation, publication_cursor,
        ${authenticated.idempotencyKey}, ${now}
      FROM ${crawlerSnapshotVersions}
      WHERE event_number = ${publication.snapshot.eventNumber}
        AND revision = ${publication.snapshot.revision}
      ON CONFLICT(event_number) DO NOTHING`;

  const results = await runDrizzleBatch(database, [
    sql`INSERT INTO ${crawlerSnapshotVersions} (
        event_number, revision, schema_version, generation,
        catalog_payload_sha256, matching_policy_revision,
        observed_at, update_count, object_key, object_sha256, byte_count,
        publication_cursor, published_at
      )
      SELECT ${publication.snapshot.eventNumber}, ${publication.snapshot.revision}, 1,
        ${publication.snapshot.generation},
        ${publication.snapshot.catalogPayloadSHA256},
        ${publication.snapshot.matchingPolicyRevision},
        ${requireTimestamp(publication.snapshot.observedAt)},
        ${publication.snapshot.events.length}, ${objectKey}, ${objectSHA256},
        ${normalizedBytes.byteLength},
        MAX(
          COALESCE((SELECT MAX(${circleUpdateEvents.id}) FROM ${circleUpdateEvents}), 0),
          COALESCE((
            SELECT seq FROM sqlite_sequence
            WHERE name = 'circle_update_events'
          ), 0)
        ),
        ${now}
      WHERE ${catalogAuthorityMatches} AND ${receiptAbsent}
        AND ${baseAuthorityMatches}
      ON CONFLICT(event_number, revision) DO NOTHING`,
    activateHead,
    sql`INSERT INTO ${crawlerSnapshotPublicationReceipts} (
        idempotency_key, payload_sha256, event_number, base_revision,
        revision, generation, result_json, created_at
      )
      SELECT ${authenticated.idempotencyKey}, ${authenticated.payloadSHA256},
        head.event_number, ${publication.baseRevision}, head.revision,
        head.generation,
        json_object(
          'eventNumber', head.event_number,
          'revision', head.revision,
          'generation', head.generation,
          'publicationCursor', head.publication_cursor,
          'active', json('true'),
          'publishedAt', ${publishedAt}
        ), ${now}
      FROM ${crawlerSnapshotHeads} AS head
      WHERE head.event_number = ${publication.snapshot.eventNumber}
        AND head.revision = ${publication.snapshot.revision}
        AND head.generation = ${publication.snapshot.generation}
        AND head.publication_idempotency_key = ${authenticated.idempotencyKey}
      ON CONFLICT(idempotency_key) DO NOTHING`,
    sql`DELETE FROM ${crawlerSnapshotObjectCleanup}
      WHERE ${crawlerSnapshotObjectCleanup.objectKey} = ${objectKey}
        AND EXISTS (
          SELECT 1 FROM ${crawlerSnapshotPublicationReceipts}
          WHERE ${crawlerSnapshotPublicationReceipts.idempotencyKey} = ${authenticated.idempotencyKey}
            AND ${crawlerSnapshotPublicationReceipts.payloadSHA256} = ${authenticated.payloadSHA256}
        )`,
  ]);
  if (
    (results[0]?.meta.changes ?? 0) === 1 &&
    (results[1]?.meta.changes ?? 0) === 1 &&
    (results[2]?.meta.changes ?? 0) === 1 &&
    (results[3]?.meta.changes ?? 0) === 1
  ) {
    const stored = await loadPublicationReceipt(
      database,
      authenticated.idempotencyKey,
      authenticated.payloadSHA256,
    );
    if (stored) return { ...stored, duplicate: false };
  }

  const racedReplay = await loadPublicationReceipt(
    database,
    authenticated.idempotencyKey,
    authenticated.payloadSHA256,
  );
  if (racedReplay) return { ...racedReplay, duplicate: true };
  const activeAfter = await loadSnapshotHead(
    database,
    publication.snapshot.eventNumber,
  );
  throw snapshotRevisionConflict(
    activeAfter,
    (activeAfter?.generation ?? 0) + 1,
  );
}

export async function loadActiveCrawlerSnapshot(
  database: D1Database,
  bucket: R2Bucket,
  eventNumber: number,
  includeEvents: boolean,
): Promise<ActiveCrawlerSnapshot | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await loadActiveSnapshotVersionRow(database, eventNumber);
    if (!row) return null;
    const base: ActiveCrawlerSnapshot = {
      revision: row.revision,
      generation: row.generation,
      publicationCursor: row.publicationCursor,
      catalogSourceMainSHA256: row.catalogPayloadSHA256,
    };
    if (!includeEvents) {
      if (await activeCrawlerSnapshotStillCurrent(database, eventNumber, base))
        return base;
      continue;
    }

    const events = await loadSnapshotObjectEvents(bucket, eventNumber, row);
    if (await activeCrawlerSnapshotStillCurrent(database, eventNumber, base)) {
      return { ...base, events };
    }
  }
  throw snapshotUnavailable(
    "The active snapshot changed repeatedly while it was being read.",
  );
}

export async function activeCrawlerSnapshotStillCurrent(
  database: D1Database,
  eventNumber: number,
  snapshot: Pick<
    ActiveCrawlerSnapshot,
    "revision" | "generation" | "publicationCursor"
  > | null,
): Promise<boolean> {
  const current = await loadActiveSnapshotVersionRow(database, eventNumber);
  if (!snapshot || !current) return snapshot === null && current === null;
  return (
    current.revision === snapshot.revision &&
    current.generation === snapshot.generation &&
    current.publicationCursor === snapshot.publicationCursor
  );
}

async function loadActiveSnapshotVersionRow(
  database: D1Database,
  eventNumber: number,
): Promise<SnapshotVersionRow | null> {
  try {
    return (
      (await createDatabase(database)
        .select({
          revision: crawlerSnapshotHeads.revision,
          generation: crawlerSnapshotHeads.generation,
          publicationCursor: crawlerSnapshotHeads.publicationCursor,
          catalogPayloadSHA256: crawlerSnapshotVersions.catalogPayloadSHA256,
          objectKey: crawlerSnapshotVersions.objectKey,
          objectSHA256: crawlerSnapshotVersions.objectSHA256,
          byteCount: crawlerSnapshotVersions.byteCount,
          updateCount: crawlerSnapshotVersions.updateCount,
        })
        .from(crawlerSnapshotHeads)
        .innerJoin(
          crawlerSnapshotVersions,
          and(
            eq(
              crawlerSnapshotVersions.eventNumber,
              crawlerSnapshotHeads.eventNumber,
            ),
            eq(crawlerSnapshotVersions.revision, crawlerSnapshotHeads.revision),
          ),
        )
        .where(eq(crawlerSnapshotHeads.eventNumber, eventNumber))
        .get()) ?? null
    );
  } catch (error) {
    // Local/transitional databases that have not applied migration 0009 keep
    // append-only reads; production deployment still applies D1 first.
    if (
      error instanceof Error &&
      /no such table:\s*crawler_snapshot_heads/i.test(error.message)
    ) {
      return null;
    }
    throw error;
  }
}

async function loadSnapshotObjectEvents(
  bucket: R2Bucket,
  eventNumber: number,
  row: SnapshotVersionRow,
): Promise<CrawlerEvent[]> {
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(row.objectKey);
  } catch {
    throw snapshotUnavailable("The active snapshot object could not be read.");
  }
  if (!object)
    throw snapshotUnavailable("The active snapshot object is missing.");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await object.arrayBuffer());
  } catch {
    throw snapshotUnavailable("The active snapshot object could not be read.");
  }
  if (
    bytes.byteLength !== row.byteCount ||
    (await sha256Hex(bytes)) !== row.objectSHA256
  ) {
    throw snapshotUnavailable(
      "The active snapshot object failed integrity checks.",
    );
  }
  let snapshotValue: unknown;
  try {
    snapshotValue = JSON.parse(decoder.decode(bytes));
  } catch {
    throw snapshotUnavailable("The active snapshot object is invalid JSON.");
  }
  const publication = await parseCrawlerSnapshotPublication(
    encoder.encode(
      JSON.stringify({ baseRevision: "none", snapshot: snapshotValue }),
    ),
  );
  if (
    publication.snapshot.eventNumber !== eventNumber ||
    publication.snapshot.revision !== row.revision ||
    publication.snapshot.generation !== row.generation ||
    publication.snapshot.catalogPayloadSHA256 !== row.catalogPayloadSHA256 ||
    publication.snapshot.events.length !== row.updateCount ||
    canonicalCrawlerSnapshotJSON(publication.snapshot) !== decoder.decode(bytes)
  ) {
    throw snapshotUnavailable("The active snapshot metadata is inconsistent.");
  }
  return publication.snapshot.events;
}

async function loadSnapshotHead(
  database: D1Database,
  eventNumber: number,
): Promise<{
  revision: string;
  generation: number;
  catalogPayloadSHA256: string;
} | null> {
  return (
    (await createDatabase(database)
      .select({
        revision: crawlerSnapshotHeads.revision,
        generation: crawlerSnapshotHeads.generation,
        catalogPayloadSHA256: crawlerSnapshotVersions.catalogPayloadSHA256,
      })
      .from(crawlerSnapshotHeads)
      .innerJoin(
        crawlerSnapshotVersions,
        and(
          eq(
            crawlerSnapshotVersions.eventNumber,
            crawlerSnapshotHeads.eventNumber,
          ),
          eq(crawlerSnapshotVersions.revision, crawlerSnapshotHeads.revision),
        ),
      )
      .where(eq(crawlerSnapshotHeads.eventNumber, eventNumber))
      .get()) ?? null
  );
}

async function loadActiveCatalog(
  database: D1Database,
  eventNumber: number,
): Promise<{ versionID: string; payloadSHA256: string } | null> {
  const row = await createDatabase(database)
    .select({
      versionID: catalogVersions.id,
      payloadSHA256: catalogVersions.sourceMainSHA256,
    })
    .from(catalogEvents)
    .innerJoin(
      catalogVersions,
      and(
        eq(catalogVersions.id, catalogEvents.activeVersionID),
        eq(catalogVersions.comiketNo, catalogEvents.comiketNo),
        eq(catalogVersions.state, "published"),
      ),
    )
    .where(eq(catalogEvents.comiketNo, eventNumber))
    .get();
  return row
    ? { versionID: row.versionID, payloadSHA256: row.payloadSHA256 }
    : null;
}

async function assertSnapshotCatalogTargets(
  database: D1Database,
  snapshot: CrawlerRealtimeSnapshot,
): Promise<void> {
  const wcIDs = Array.from(
    new Set(
      snapshot.events.flatMap((event) =>
        event.circles.map((circle) => circle.wcID),
      ),
    ),
  ).sort((left, right) => left - right);
  if (wcIDs.length === 0) return;
  const result = await createDatabase(database)
    .select({ matched: count() })
    .from(catalogStableCircles)
    .where(
      and(
        eq(catalogStableCircles.comiketNo, snapshot.eventNumber),
        inArray(catalogStableCircles.wcID, wcIDs),
      ),
    )
    .get();
  if (result?.matched !== wcIDs.length) {
    throw new ServiceError(
      "crawler_snapshot_unknown_circle",
      409,
      "The snapshot references a WCID outside the durable catalog authority.",
    );
  }
}

export async function loadCrawlerSnapshotAuthority(
  database: D1Database,
  eventNumber: number,
  proposedPublication?: ProposedCrawlerSnapshotPublication,
): Promise<CrawlerSnapshotAuthority> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [snapshot, activeCatalog, proposedActivation] = await Promise.all([
      loadActiveSnapshotVersionRow(database, eventNumber),
      loadActiveCatalogSource(database, eventNumber),
      proposedPublication
        ? loadProposedSnapshotActivation(
            database,
            eventNumber,
            proposedPublication,
          )
        : Promise.resolve(null),
    ]);
    if (!activeCatalog) {
      throw snapshotUnavailable(
        "The active catalog source is not available for the crawler.",
      );
    }
    if (
      activeCatalog.byteCount > maximumCrawlerCatalogSourceBytes ||
      activeCatalog.contentType !== "application/vnd.sqlite3"
    ) {
      throw snapshotUnavailable(
        "The active catalog source exceeds the crawler download contract.",
      );
    }
    const [snapshotStillCurrent, catalogStillCurrent] = await Promise.all([
      activeCrawlerSnapshotStillCurrent(
        database,
        eventNumber,
        snapshot
          ? {
              revision: snapshot.revision,
              generation: snapshot.generation,
              publicationCursor: snapshot.publicationCursor,
            }
          : null,
      ),
      activeCatalogSourceStillCurrent(database, eventNumber, activeCatalog),
    ]);
    if (!snapshotStillCurrent || !catalogStillCurrent) continue;
    return {
      schemaVersion: 1,
      eventNumber,
      publicationRevision: snapshot?.revision ?? "none",
      publicationGeneration: snapshot?.generation ?? 0,
      publicationCursor: snapshot?.publicationCursor ?? 0,
      snapshotCatalogSourceMainSHA256: snapshot?.catalogPayloadSHA256 ?? "none",
      activeCatalog: {
        versionID: activeCatalog.versionID,
        sourceMainSHA256: activeCatalog.sourceMainSHA256,
        sourceMainBytes: activeCatalog.byteCount,
        contentType: "application/vnd.sqlite3",
        downloadPath: catalogSourceDownloadPath,
      },
      ...(proposedPublication
        ? {
            proposedPublication: proposedActivation
              ? {
                  ...proposedActivation,
                  status: "activated" as const,
                  active:
                    snapshot?.revision === proposedActivation.revision &&
                    snapshot.generation === proposedActivation.generation,
                }
              : {
                  ...proposedPublication,
                  status: "notActivated" as const,
                },
          }
        : {}),
    };
  }
  throw snapshotUnavailable(
    "Snapshot authority changed repeatedly while it was being read.",
  );
}

export async function serveActiveCrawlerCatalogSource(
  database: D1Database,
  bucket: R2Bucket,
  input: {
    eventNumber: number;
    versionID: string;
    sourceMainSHA256: string;
  },
): Promise<Response> {
  const artifact = await loadActiveCatalogSource(database, input.eventNumber);
  if (
    !artifact ||
    artifact.versionID !== input.versionID ||
    artifact.sourceMainSHA256 !== input.sourceMainSHA256
  ) {
    throw new ServiceError(
      "crawler_catalog_source_conflict",
      409,
      "The requested catalog source is no longer the active authority.",
    );
  }
  if (
    artifact.byteCount > maximumCrawlerCatalogSourceBytes ||
    artifact.contentType !== "application/vnd.sqlite3"
  ) {
    throw snapshotUnavailable(
      "The active catalog source exceeds the crawler download contract.",
    );
  }
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(artifact.objectKey);
  } catch {
    throw snapshotUnavailable("The active catalog source could not be read.");
  }
  if (
    !object ||
    object.size !== artifact.byteCount ||
    object.httpMetadata?.contentType !== artifact.contentType ||
    object.customMetadata?.sha256 !== artifact.sourceMainSHA256 ||
    object.customMetadata?.visibility !== "private_source"
  ) {
    throw snapshotUnavailable(
      "The active catalog source failed integrity checks.",
    );
  }
  if (
    !(await activeCatalogSourceStillCurrent(
      database,
      input.eventNumber,
      artifact,
    ))
  ) {
    throw new ServiceError(
      "crawler_catalog_source_conflict",
      409,
      "The active catalog changed while its source was being read.",
    );
  }
  return new Response(object.body, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "CDN-Cache-Control": "no-store",
      "Cloudflare-CDN-Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="cominavi-c${input.eventNumber}-${artifact.versionID}-source-main.sqlite"`,
      "Content-Length": String(artifact.byteCount),
      "Content-Type": artifact.contentType,
      Digest: `sha-256=:${hexToBase64(artifact.sourceMainSHA256)}:`,
      ETag: `"sha256-${artifact.sourceMainSHA256}"`,
      "X-ComiNavi-Catalog-Version": artifact.versionID,
      "X-ComiNavi-Source-Main-SHA256": artifact.sourceMainSHA256,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function loadActiveCatalogSource(
  database: D1Database,
  eventNumber: number,
): Promise<ActiveCatalogSource | null> {
  const row = await createDatabase(database)
    .select({
      versionID: catalogVersions.id,
      sourceMainSHA256: catalogVersions.sourceMainSHA256,
      objectKey: catalogArtifacts.objectKey,
      artifactSHA256: catalogArtifacts.sha256,
      byteCount: catalogArtifacts.byteCount,
      contentType: catalogArtifacts.contentType,
    })
    .from(catalogEvents)
    .innerJoin(
      catalogVersions,
      and(
        eq(catalogVersions.id, catalogEvents.activeVersionID),
        eq(catalogVersions.comiketNo, catalogEvents.comiketNo),
        eq(catalogVersions.state, "published"),
      ),
    )
    .innerJoin(
      catalogArtifacts,
      and(
        eq(catalogArtifacts.versionID, catalogVersions.id),
        eq(catalogArtifacts.kind, "source_main"),
        eq(catalogArtifacts.visibility, "private_source"),
      ),
    )
    .where(eq(catalogEvents.comiketNo, eventNumber))
    .get();
  if (!row) return null;
  if (row.artifactSHA256 !== row.sourceMainSHA256) {
    throw snapshotUnavailable(
      "The active catalog source metadata is inconsistent.",
    );
  }
  return {
    versionID: row.versionID,
    sourceMainSHA256: row.sourceMainSHA256,
    objectKey: row.objectKey,
    byteCount: row.byteCount,
    contentType: row.contentType,
  };
}

async function activeCatalogSourceStillCurrent(
  database: D1Database,
  eventNumber: number,
  expected: ActiveCatalogSource,
): Promise<boolean> {
  const current = await loadActiveCatalogSource(database, eventNumber);
  return (
    current?.versionID === expected.versionID &&
    current.sourceMainSHA256 === expected.sourceMainSHA256 &&
    current.objectKey === expected.objectKey &&
    current.byteCount === expected.byteCount &&
    current.contentType === expected.contentType
  );
}

async function loadProposedSnapshotActivation(
  database: D1Database,
  eventNumber: number,
  proposed: ProposedCrawlerSnapshotPublication,
): Promise<{
  revision: string;
  generation: number;
  publicationCursor: number;
  publishedAt: string;
} | null> {
  const row = await createDatabase(database)
    .select({
      revision: crawlerSnapshotPublicationReceipts.revision,
      generation: crawlerSnapshotPublicationReceipts.generation,
      publicationCursor: crawlerSnapshotVersions.publicationCursor,
      publishedAt: crawlerSnapshotVersions.publishedAt,
    })
    .from(crawlerSnapshotPublicationReceipts)
    .innerJoin(
      crawlerSnapshotVersions,
      and(
        eq(
          crawlerSnapshotVersions.eventNumber,
          crawlerSnapshotPublicationReceipts.eventNumber,
        ),
        eq(
          crawlerSnapshotVersions.revision,
          crawlerSnapshotPublicationReceipts.revision,
        ),
      ),
    )
    .where(
      and(
        eq(crawlerSnapshotPublicationReceipts.eventNumber, eventNumber),
        eq(crawlerSnapshotPublicationReceipts.revision, proposed.revision),
        eq(crawlerSnapshotPublicationReceipts.generation, proposed.generation),
      ),
    )
    .get();
  return row
    ? {
        revision: row.revision,
        generation: row.generation,
        publicationCursor: row.publicationCursor,
        publishedAt: new Date(row.publishedAt * 1_000).toISOString(),
      }
    : null;
}

async function loadPublicationReceipt(
  database: D1Database,
  idempotencyKey: string,
  payloadSHA256: string,
): Promise<StoredPublicationResult | null> {
  const row = await createDatabase(database)
    .select({
      payloadSHA256: crawlerSnapshotPublicationReceipts.payloadSHA256,
      resultJSON: crawlerSnapshotPublicationReceipts.resultJSON,
    })
    .from(crawlerSnapshotPublicationReceipts)
    .where(
      eq(crawlerSnapshotPublicationReceipts.idempotencyKey, idempotencyKey),
    )
    .get();
  if (!row) return null;
  if (row.payloadSHA256 !== payloadSHA256) throw idempotencyConflict();
  try {
    return JSON.parse(row.resultJSON) as StoredPublicationResult;
  } catch {
    throw snapshotUnavailable("The snapshot publication receipt is invalid.");
  }
}

async function ensureReceiptObject(
  database: D1Database,
  bucket: R2Bucket,
  publication: CrawlerSnapshotPublication,
  receipt: StoredPublicationResult,
  nowMilliseconds: number,
): Promise<void> {
  if (
    publication.snapshot.eventNumber !== receipt.eventNumber ||
    publication.snapshot.revision !== receipt.revision ||
    publication.snapshot.generation !== receipt.generation
  ) {
    throw snapshotUnavailable("The snapshot receipt payload is inconsistent.");
  }
  const bytes = encoder.encode(
    canonicalCrawlerSnapshotJSON(publication.snapshot),
  );
  const objectSHA256 = await sha256Hex(bytes);
  const objectKey = snapshotObjectKey(receipt.eventNumber, receipt.revision);
  const version = await createDatabase(database)
    .select({
      objectKey: crawlerSnapshotVersions.objectKey,
      objectSHA256: crawlerSnapshotVersions.objectSHA256,
      byteCount: crawlerSnapshotVersions.byteCount,
    })
    .from(crawlerSnapshotVersions)
    .where(
      and(
        eq(crawlerSnapshotVersions.eventNumber, receipt.eventNumber),
        eq(crawlerSnapshotVersions.revision, receipt.revision),
      ),
    )
    .get();
  if (
    !version ||
    version.objectKey !== objectKey ||
    version.objectSHA256 !== objectSHA256 ||
    version.byteCount !== bytes.byteLength
  ) {
    throw snapshotUnavailable("The snapshot receipt version is inconsistent.");
  }
  const existing = await bucket.get(objectKey);
  if (existing) {
    if ((await objectBodySHA256(existing)) !== objectSHA256) {
      throw snapshotUnavailable("The immutable snapshot object is corrupt.");
    }
    return;
  }
  await enqueueSnapshotPrewriteCleanup(
    database,
    {
      objectKey,
      eventNumber: receipt.eventNumber,
      revision: receipt.revision,
      objectSHA256,
    },
    nowMilliseconds,
  );
  await ensureImmutableSnapshotObject(bucket, {
    objectKey,
    objectSHA256,
    bytes,
    snapshot: publication.snapshot,
  });
  await createDatabase(database)
    .delete(crawlerSnapshotObjectCleanup)
    .where(
      and(
        eq(crawlerSnapshotObjectCleanup.objectKey, objectKey),
        sql`EXISTS (
          SELECT 1 FROM ${crawlerSnapshotVersions}
          WHERE ${crawlerSnapshotVersions.eventNumber} = ${receipt.eventNumber}
            AND ${crawlerSnapshotVersions.revision} = ${receipt.revision}
            AND ${crawlerSnapshotVersions.objectSHA256} = ${objectSHA256}
        )`,
      ),
    )
    .run();
}

async function enqueueSnapshotPrewriteCleanup(
  database: D1Database,
  identity: {
    objectKey: string;
    eventNumber: number;
    revision: string;
    objectSHA256: string;
  },
  nowMilliseconds: number,
): Promise<void> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const db = createDatabase(database);
  const inserted = await db
    .insert(crawlerSnapshotObjectCleanup)
    .values({
      ...identity,
      state: "queued",
      attemptCount: 0,
      leaseID: null,
      leaseExpiresAt: null,
      availableAt: now + 600,
      lastError: "prewrite_cleanup",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: crawlerSnapshotObjectCleanup.objectKey })
    .run();
  if ((inserted.meta.changes ?? 0) === 1) return;
  const existing = await db
    .select({
      eventNumber: crawlerSnapshotObjectCleanup.eventNumber,
      revision: crawlerSnapshotObjectCleanup.revision,
      objectSHA256: crawlerSnapshotObjectCleanup.objectSHA256,
      state: crawlerSnapshotObjectCleanup.state,
    })
    .from(crawlerSnapshotObjectCleanup)
    .where(eq(crawlerSnapshotObjectCleanup.objectKey, identity.objectKey))
    .get();
  if (
    existing?.eventNumber !== identity.eventNumber ||
    existing.revision !== identity.revision ||
    existing.objectSHA256 !== identity.objectSHA256 ||
    existing.state !== "queued"
  ) {
    throw snapshotUnavailable("The snapshot cleanup intent conflicts.");
  }
  await db
    .update(crawlerSnapshotObjectCleanup)
    .set({ availableAt: now + 600, updatedAt: now })
    .where(eq(crawlerSnapshotObjectCleanup.objectKey, identity.objectKey))
    .run();
}

async function ensureImmutableSnapshotObject(
  bucket: R2Bucket,
  input: {
    objectKey: string;
    objectSHA256: string;
    bytes: Uint8Array;
    snapshot: CrawlerRealtimeSnapshot;
  },
): Promise<void> {
  const existing = await bucket.get(input.objectKey);
  if (existing) {
    if ((await objectBodySHA256(existing)) !== input.objectSHA256) {
      throw snapshotUnavailable("The immutable snapshot object conflicts.");
    }
    return;
  }
  await bucket.put(input.objectKey, input.bytes, {
    httpMetadata: { contentType: snapshotContentType },
    customMetadata: {
      eventNumber: String(input.snapshot.eventNumber),
      revision: input.snapshot.revision,
      generation: String(input.snapshot.generation),
      payloadSHA256: input.objectSHA256,
      catalogPayloadSHA256: input.snapshot.catalogPayloadSHA256,
    },
  });
  const stored = await bucket.get(input.objectKey);
  if (!stored || (await objectBodySHA256(stored)) !== input.objectSHA256) {
    throw snapshotUnavailable(
      "The snapshot object write could not be verified.",
    );
  }
}

export async function processPendingCrawlerSnapshotCleanup(
  database: D1Database,
  bucket: R2Bucket,
  nowMilliseconds = Date.now(),
): Promise<number> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const db = createDatabase(database);
  const rows = await db
    .select({
      objectKey: crawlerSnapshotObjectCleanup.objectKey,
    })
    .from(crawlerSnapshotObjectCleanup)
    .where(
      or(
        and(
          eq(crawlerSnapshotObjectCleanup.state, "queued"),
          lte(crawlerSnapshotObjectCleanup.availableAt, now),
        ),
        and(
          eq(crawlerSnapshotObjectCleanup.state, "leased"),
          lte(crawlerSnapshotObjectCleanup.leaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(
      asc(crawlerSnapshotObjectCleanup.availableAt),
      asc(crawlerSnapshotObjectCleanup.createdAt),
    )
    .limit(100);
  let removed = 0;
  for (const row of rows) {
    const leaseID = crypto.randomUUID();
    const leased = await db
      .update(crawlerSnapshotObjectCleanup)
      .set({
        state: "leased",
        leaseID,
        leaseExpiresAt: now + 60,
        updatedAt: now,
      })
      .where(
        and(
          eq(crawlerSnapshotObjectCleanup.objectKey, row.objectKey),
          or(
            and(
              eq(crawlerSnapshotObjectCleanup.state, "queued"),
              lte(crawlerSnapshotObjectCleanup.availableAt, now),
            ),
            and(
              eq(crawlerSnapshotObjectCleanup.state, "leased"),
              lte(crawlerSnapshotObjectCleanup.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .run();
    if ((leased.meta.changes ?? 0) !== 1) continue;
    try {
      const referenced = db
        .select({ value: sql`1` })
        .from(crawlerSnapshotVersions)
        .where(eq(crawlerSnapshotVersions.objectKey, row.objectKey));
      const authorized = await db
        .select({ value: sql<number>`1` })
        .from(crawlerSnapshotObjectCleanup)
        .where(
          and(
            eq(crawlerSnapshotObjectCleanup.objectKey, row.objectKey),
            eq(crawlerSnapshotObjectCleanup.leaseID, leaseID),
            notExists(referenced),
          ),
        )
        .get();
      if (authorized) {
        await bucket.delete(row.objectKey);
        removed += 1;
      }
      await db
        .delete(crawlerSnapshotObjectCleanup)
        .where(
          and(
            eq(crawlerSnapshotObjectCleanup.objectKey, row.objectKey),
            eq(crawlerSnapshotObjectCleanup.leaseID, leaseID),
          ),
        )
        .run();
    } catch (error) {
      await db
        .update(crawlerSnapshotObjectCleanup)
        .set({
          state: "queued",
          attemptCount: sql`${crawlerSnapshotObjectCleanup.attemptCount} + 1`,
          leaseID: null,
          leaseExpiresAt: null,
          availableAt: now + 300,
          lastError:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "r2_delete_failed",
          updatedAt: now,
        })
        .where(
          and(
            eq(crawlerSnapshotObjectCleanup.objectKey, row.objectKey),
            eq(crawlerSnapshotObjectCleanup.leaseID, leaseID),
          ),
        )
        .run();
    }
  }
  return removed;
}

function snapshotObjectKey(eventNumber: number, revision: string): string {
  return `crawler-realtime/v1/events/${eventNumber}/sha256/${revision}.json`;
}

function canonicalJSONString(value: unknown): string {
  return JSON.stringify(canonicalJSONValue(value));
}

function canonicalJSONValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJSONValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCanonical)
      .map((key) => [key, canonicalJSONValue(value[key])]),
  );
}

function compareCanonical(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

async function objectBodySHA256(object: R2ObjectBody): Promise<string> {
  return sha256Hex(new Uint8Array(await object.arrayBuffer()));
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isRevisionOrNone(value: unknown): boolean {
  return value === "none" || digestPattern.test(String(value));
}

function isBoundedPositiveInteger(value: unknown, maximum: number): boolean {
  return (
    Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum
  );
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? Math.floor(milliseconds / 1_000)
    : null;
}

function requireTimestamp(value: string): number {
  const parsed = parseTimestamp(value);
  if (parsed === null)
    throw invalidSnapshot("The snapshot timestamp is invalid.");
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return btoa(String.fromCharCode(...bytes));
}

function invalidSnapshot(message: string, status = 400): ServiceError {
  return new ServiceError("invalid_crawler_snapshot", status, message);
}

function snapshotRevisionConflict(
  active: { revision: string; generation: number } | null,
  expectedGeneration: number,
): ServiceError {
  return new ServiceError(
    "crawler_snapshot_revision_conflict",
    409,
    "The snapshot base revision or generation is stale.",
    {
      activeRevision: active?.revision ?? "none",
      activeGeneration: active?.generation ?? 0,
      expectedGeneration,
    },
  );
}

function snapshotCatalogMismatch(
  activeCatalogPayloadSHA256: string | null,
): ServiceError {
  return new ServiceError(
    "crawler_snapshot_catalog_mismatch",
    409,
    "The snapshot does not match the active catalog.",
    { activeCatalogPayloadSHA256 },
  );
}

function snapshotUnavailable(message: string): ServiceError {
  return new ServiceError("crawler_snapshot_unavailable", 503, message);
}

function idempotencyConflict(): ServiceError {
  return new ServiceError(
    "idempotency_conflict",
    409,
    "This idempotency key was already used for a different payload.",
  );
}
