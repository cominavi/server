import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import { runDrizzleBatch } from "../db/batch";
import { createDatabase } from "../db/client";
import {
  catalogEvents,
  catalogCircles,
  catalogVersions,
  circleTagOverlayObjectCleanup,
  circleTagOverlayHeads,
  circleTagOverlayPublicationReceipts,
  circleTagOverlayVersions,
} from "../db/schema";
import { enqueueCircleTagOverlayPrewriteCleanup } from "./tag-overlay-cleanup";
import { ServiceError } from "./service-error";

export const tagOverlayKinds = [
  "work",
  "character",
  "content",
  "theme",
  "format",
  "activity",
] as const;

export type TagOverlayKind = (typeof tagOverlayKinds)[number];

export interface TagOverlayTerm {
  id: string;
  label: string;
  kind: TagOverlayKind;
}

export interface TagOverlayCircle {
  wcID: number;
  tagIDs: string[];
}

export interface CircleTagOverlay {
  schemaVersion: 1;
  revision: string;
  catalogPayloadSHA256: string;
  taxonomyRevision: string;
  matchingPolicyRevision: string;
  evaluatedCircleCount: number;
  taggedCircleCount: number;
  terms: TagOverlayTerm[];
  circles: TagOverlayCircle[];
}

export interface TagOverlayPublication {
  eventNumber: number;
  baseRevision: string;
  overlay: CircleTagOverlay;
}

export interface TagOverlayPublicationResult {
  eventNumber: number;
  revision: string;
  activeRevision: string;
  active: true;
  publishedAt: string;
  duplicate: boolean;
}

export type TagOverlayStatus =
  "current" | "absent" | "invalidated" | "unavailable";

export interface TagOverlayLoadResult {
  status: TagOverlayStatus;
  overlay?: CircleTagOverlay;
}

interface StoredPublicationResult extends Omit<
  TagOverlayPublicationResult,
  "duplicate"
> {}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const digestPattern = /^[0-9a-f]{64}$/;
const constrainedIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const maximumTerms = 10_000;
const maximumCircles = 100_000;
const maximumTagsPerCircle = 512;
const maximumEvaluatedCircles = 1_000_000;
const tagOverlayContentType = "application/vnd.cominavi.tag-overlay-v1+json";

export const maximumTagOverlayPublicationBytes = 16 * 1024 * 1024;

/**
 * Returns the one canonical semantic representation used by every producer
 * and verifier. Object key order is deliberate; the revision itself is the
 * only field omitted from the digest input.
 */
export function canonicalTagOverlaySemanticJSON(
  overlay: CircleTagOverlay,
): string {
  return JSON.stringify({
    schemaVersion: overlay.schemaVersion,
    catalogPayloadSHA256: overlay.catalogPayloadSHA256,
    taxonomyRevision: overlay.taxonomyRevision,
    matchingPolicyRevision: overlay.matchingPolicyRevision,
    evaluatedCircleCount: overlay.evaluatedCircleCount,
    taggedCircleCount: overlay.taggedCircleCount,
    terms: overlay.terms.map((term) => ({
      id: term.id,
      label: term.label,
      kind: term.kind,
    })),
    circles: overlay.circles.map((circle) => ({
      wcID: circle.wcID,
      tagIDs: circle.tagIDs,
    })),
  });
}

/** The normalized immutable R2 representation, including its revision. */
export function canonicalTagOverlayJSON(overlay: CircleTagOverlay): string {
  return JSON.stringify({
    schemaVersion: overlay.schemaVersion,
    revision: overlay.revision,
    catalogPayloadSHA256: overlay.catalogPayloadSHA256,
    taxonomyRevision: overlay.taxonomyRevision,
    matchingPolicyRevision: overlay.matchingPolicyRevision,
    evaluatedCircleCount: overlay.evaluatedCircleCount,
    taggedCircleCount: overlay.taggedCircleCount,
    terms: overlay.terms.map((term) => ({
      id: term.id,
      label: term.label,
      kind: term.kind,
    })),
    circles: overlay.circles.map((circle) => ({
      wcID: circle.wcID,
      tagIDs: circle.tagIDs,
    })),
  });
}

export async function calculateTagOverlayRevision(
  overlay: CircleTagOverlay,
): Promise<string> {
  return sha256Hex(encoder.encode(canonicalTagOverlaySemanticJSON(overlay)));
}

export async function verifyTagOverlayRevision(
  overlay: CircleTagOverlay,
): Promise<boolean> {
  return overlay.revision === (await calculateTagOverlayRevision(overlay));
}

export async function parseTagOverlayPublication(
  rawBody: Uint8Array,
): Promise<TagOverlayPublication> {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(rawBody));
  } catch {
    throw invalidTagOverlay(
      "The tag overlay publication is not valid UTF-8 JSON.",
    );
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["eventNumber", "baseRevision", "overlay"]) ||
    !isEventNumber(value.eventNumber) ||
    !isBaseRevision(value.baseRevision)
  ) {
    throw invalidTagOverlay("The tag overlay publication envelope is invalid.");
  }
  const overlay = parseTagOverlay(value.overlay);
  if (!(await verifyTagOverlayRevision(overlay))) {
    throw invalidTagOverlay(
      "The tag overlay revision does not match its canonical semantic content.",
    );
  }
  return {
    eventNumber: value.eventNumber,
    baseRevision: value.baseRevision,
    overlay,
  };
}

export function parseTagOverlay(value: unknown): CircleTagOverlay {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "revision",
      "catalogPayloadSHA256",
      "taxonomyRevision",
      "matchingPolicyRevision",
      "evaluatedCircleCount",
      "taggedCircleCount",
      "terms",
      "circles",
    ]) ||
    value.schemaVersion !== 1 ||
    !isDigest(value.revision) ||
    !isDigest(value.catalogPayloadSHA256) ||
    !isConstrainedIdentifier(value.taxonomyRevision) ||
    !isConstrainedIdentifier(value.matchingPolicyRevision) ||
    !isBoundedInteger(value.evaluatedCircleCount, maximumEvaluatedCircles) ||
    !isBoundedInteger(value.taggedCircleCount, maximumCircles) ||
    !Array.isArray(value.terms) ||
    value.terms.length > maximumTerms ||
    !Array.isArray(value.circles) ||
    value.circles.length > maximumCircles
  ) {
    throw invalidTagOverlay("The tag overlay does not match schema version 1.");
  }

  const terms = value.terms.map(parseTerm);
  for (let index = 1; index < terms.length; index += 1) {
    if (compareCanonical(terms[index - 1].id, terms[index].id) >= 0) {
      throw invalidTagOverlay(
        "Tag terms must have unique IDs in canonical ascending order.",
      );
    }
  }
  const termIDs = new Set(terms.map((term) => term.id));
  const referencedTermIDs = new Set<string>();
  const circles = value.circles.map((circle) =>
    parseCircle(circle, termIDs, referencedTermIDs),
  );
  for (let index = 1; index < circles.length; index += 1) {
    if (circles[index - 1].wcID >= circles[index].wcID) {
      throw invalidTagOverlay(
        "Tagged circles must have unique WCIDs in canonical ascending order.",
      );
    }
  }
  if (value.taggedCircleCount !== circles.length) {
    throw invalidTagOverlay(
      "taggedCircleCount must equal the number of tagged circle entries.",
    );
  }
  if (value.evaluatedCircleCount < value.taggedCircleCount) {
    throw invalidTagOverlay(
      "evaluatedCircleCount cannot be smaller than taggedCircleCount.",
    );
  }
  if (referencedTermIDs.size !== terms.length) {
    throw invalidTagOverlay(
      "Every published term must be referenced by at least one tagged circle.",
    );
  }

  return {
    schemaVersion: 1,
    revision: value.revision,
    catalogPayloadSHA256: value.catalogPayloadSHA256,
    taxonomyRevision: value.taxonomyRevision,
    matchingPolicyRevision: value.matchingPolicyRevision,
    evaluatedCircleCount: value.evaluatedCircleCount,
    taggedCircleCount: value.taggedCircleCount,
    terms,
    circles,
  };
}

export async function publishTagOverlay(
  database: D1Database,
  bucket: R2Bucket,
  authenticated: {
    idempotencyKey: string;
    payloadSHA256: string;
    rawBody: Uint8Array;
  },
  nowMilliseconds = Date.now(),
): Promise<TagOverlayPublicationResult> {
  const replay = await loadPublicationReceipt(
    database,
    authenticated.idempotencyKey,
    authenticated.payloadSHA256,
  );
  if (replay) {
    const publication = await parseTagOverlayPublication(authenticated.rawBody);
    await ensureReceiptOverlayObject(
      database,
      bucket,
      publication,
      replay,
      nowMilliseconds,
    );
    return { ...replay, duplicate: true };
  }
  const publication = await parseTagOverlayPublication(authenticated.rawBody);

  const activeBefore = await loadActiveRevision(
    database,
    publication.eventNumber,
  );
  if (activeBefore !== publication.baseRevision) {
    throw tagOverlayRevisionConflict(activeBefore);
  }
  const activeCatalog = await loadActiveCatalog(
    database,
    publication.eventNumber,
  );
  if (
    !activeCatalog ||
    activeCatalog.payloadSHA256 !== publication.overlay.catalogPayloadSHA256
  ) {
    throw tagOverlayCatalogMismatch(activeCatalog?.payloadSHA256 ?? null);
  }
  await assertOverlayCatalogCoverage(
    database,
    activeCatalog,
    publication.overlay,
  );

  const normalizedJSON = canonicalTagOverlayJSON(publication.overlay);
  const normalizedBytes = encoder.encode(normalizedJSON);
  if (normalizedBytes.byteLength > maximumTagOverlayPublicationBytes) {
    throw invalidTagOverlay("The normalized tag overlay is too large.", 413);
  }
  const objectSHA256 = await sha256Hex(normalizedBytes);
  const objectKey = tagOverlayObjectKey(
    publication.eventNumber,
    publication.overlay.revision,
  );
  await enqueueCircleTagOverlayPrewriteCleanup(
    database,
    {
      objectKey,
      eventNumber: publication.eventNumber,
      revision: publication.overlay.revision,
      objectSHA256,
    },
    nowMilliseconds,
  );
  await ensureImmutableTagOverlayObject(bucket, {
    objectKey,
    objectSHA256,
    bytes: normalizedBytes,
    eventNumber: publication.eventNumber,
    overlay: publication.overlay,
  });

  const now = Math.floor(nowMilliseconds / 1_000);
  const storedResult: StoredPublicationResult = {
    eventNumber: publication.eventNumber,
    revision: publication.overlay.revision,
    activeRevision: publication.overlay.revision,
    active: true,
    publishedAt: new Date(now * 1_000).toISOString(),
  };
  const versionMatches = sql`
    ${circleTagOverlayVersions.eventNumber} = ${publication.eventNumber}
    AND ${circleTagOverlayVersions.revision} = ${publication.overlay.revision}
    AND ${circleTagOverlayVersions.schemaVersion} = 1
    AND ${circleTagOverlayVersions.catalogPayloadSHA256} = ${publication.overlay.catalogPayloadSHA256}
    AND ${circleTagOverlayVersions.taxonomyRevision} = ${publication.overlay.taxonomyRevision}
    AND ${circleTagOverlayVersions.matchingPolicyRevision} = ${publication.overlay.matchingPolicyRevision}
    AND ${circleTagOverlayVersions.evaluatedCircleCount} = ${publication.overlay.evaluatedCircleCount}
    AND ${circleTagOverlayVersions.taggedCircleCount} = ${publication.overlay.taggedCircleCount}
    AND ${circleTagOverlayVersions.termCount} = ${publication.overlay.terms.length}
    AND ${circleTagOverlayVersions.objectKey} = ${objectKey}
    AND ${circleTagOverlayVersions.objectSHA256} = ${objectSHA256}
    AND ${circleTagOverlayVersions.byteCount} = ${normalizedBytes.byteLength}`;
  const receiptAbsent = sql`NOT EXISTS (
    SELECT 1 FROM ${circleTagOverlayPublicationReceipts}
    WHERE ${circleTagOverlayPublicationReceipts.idempotencyKey} = ${authenticated.idempotencyKey}
  )`;
  const catalogAuthorityMatches = sql`EXISTS (
    SELECT 1 FROM ${catalogEvents}
    JOIN ${catalogVersions}
      ON ${catalogVersions.id} = ${catalogEvents.activeVersionID}
     AND ${catalogVersions.comiketNo} = ${catalogEvents.comiketNo}
     AND ${catalogVersions.state} = 'published'
    WHERE ${catalogEvents.comiketNo} = ${publication.eventNumber}
      AND ${catalogVersions.id} = ${activeCatalog.versionID}
      AND ${catalogVersions.sourceMainSHA256} = ${publication.overlay.catalogPayloadSHA256}
      AND ${catalogVersions.circleCount} = ${publication.overlay.evaluatedCircleCount}
  )`;
  const baseRevisionMatches =
    publication.baseRevision === "none"
      ? sql`NOT EXISTS (
          SELECT 1 FROM ${circleTagOverlayHeads}
          WHERE ${circleTagOverlayHeads.eventNumber} = ${publication.eventNumber}
        )`
      : sql`EXISTS (
          SELECT 1 FROM ${circleTagOverlayHeads}
          WHERE ${circleTagOverlayHeads.eventNumber} = ${publication.eventNumber}
            AND ${circleTagOverlayHeads.revision} = ${publication.baseRevision}
        )`;
  const activateHead =
    publication.baseRevision === "none"
      ? sql`INSERT INTO ${circleTagOverlayHeads} (
          event_number, revision, publication_idempotency_key, updated_at
        )
        SELECT ${publication.eventNumber}, ${publication.overlay.revision},
          ${authenticated.idempotencyKey}, ${now}
        FROM ${circleTagOverlayVersions}
        WHERE ${versionMatches} AND ${catalogAuthorityMatches}
          AND ${receiptAbsent}
          AND NOT EXISTS (
            SELECT 1 FROM ${circleTagOverlayHeads}
            WHERE ${circleTagOverlayHeads.eventNumber} = ${publication.eventNumber}
          )
        ON CONFLICT(event_number) DO NOTHING`
      : sql`INSERT INTO ${circleTagOverlayHeads} (
          event_number, revision, publication_idempotency_key, updated_at
        )
        SELECT ${publication.eventNumber}, ${publication.overlay.revision},
          ${authenticated.idempotencyKey}, ${now}
        FROM ${circleTagOverlayVersions}
        WHERE ${versionMatches} AND ${catalogAuthorityMatches}
          AND ${receiptAbsent}
        ON CONFLICT(event_number) DO UPDATE SET
          revision = excluded.revision,
          publication_idempotency_key = excluded.publication_idempotency_key,
          updated_at = excluded.updated_at
        WHERE ${circleTagOverlayHeads.revision} = ${publication.baseRevision}`;
  const results = await runDrizzleBatch(database, [
    sql`INSERT INTO ${circleTagOverlayVersions} (
        event_number, revision, schema_version, catalog_version_id,
        catalog_payload_sha256,
        taxonomy_revision, matching_policy_revision, evaluated_circle_count,
        tagged_circle_count, term_count, object_key, object_sha256, byte_count,
        published_at
      ) SELECT
        ${publication.eventNumber}, ${publication.overlay.revision}, 1,
        ${activeCatalog.versionID},
        ${publication.overlay.catalogPayloadSHA256},
        ${publication.overlay.taxonomyRevision},
        ${publication.overlay.matchingPolicyRevision},
        ${publication.overlay.evaluatedCircleCount},
        ${publication.overlay.taggedCircleCount},
        ${publication.overlay.terms.length}, ${objectKey}, ${objectSHA256},
        ${normalizedBytes.byteLength}, ${now}
      WHERE ${catalogAuthorityMatches} AND ${receiptAbsent}
        AND ${baseRevisionMatches}
      ON CONFLICT(event_number, revision) DO NOTHING`,
    activateHead,
    sql`INSERT INTO ${circleTagOverlayPublicationReceipts} (
        idempotency_key, payload_sha256, event_number, base_revision,
        revision, result_json, created_at
      )
      SELECT ${authenticated.idempotencyKey}, ${authenticated.payloadSHA256},
        ${publication.eventNumber}, ${publication.baseRevision},
        ${publication.overlay.revision}, ${JSON.stringify(storedResult)}, ${now}
      FROM ${circleTagOverlayHeads}
      WHERE ${circleTagOverlayHeads.eventNumber} = ${publication.eventNumber}
        AND ${circleTagOverlayHeads.revision} = ${publication.overlay.revision}
        AND ${circleTagOverlayHeads.publicationIdempotencyKey} = ${authenticated.idempotencyKey}
      ON CONFLICT(idempotency_key) DO NOTHING`,
    sql`DELETE FROM ${circleTagOverlayObjectCleanup}
        WHERE ${circleTagOverlayObjectCleanup.objectKey} = ${objectKey}
          AND EXISTS (
            SELECT 1 FROM ${circleTagOverlayPublicationReceipts}
            WHERE ${circleTagOverlayPublicationReceipts.idempotencyKey} = ${authenticated.idempotencyKey}
              AND ${circleTagOverlayPublicationReceipts.payloadSHA256} = ${authenticated.payloadSHA256}
              AND ${circleTagOverlayPublicationReceipts.eventNumber} = ${publication.eventNumber}
              AND ${circleTagOverlayPublicationReceipts.revision} = ${publication.overlay.revision}
          )`,
  ]);

  if (
    (results[1]?.meta.changes ?? 0) === 1 &&
    (results[2]?.meta.changes ?? 0) === 1 &&
    (results[3]?.meta.changes ?? 0) === 1
  ) {
    return { ...storedResult, duplicate: false };
  }
  const racedReplay = await loadPublicationReceipt(
    database,
    authenticated.idempotencyKey,
    authenticated.payloadSHA256,
  );
  if (racedReplay) return { ...racedReplay, duplicate: true };
  const activeAfter = await loadActiveRevision(
    database,
    publication.eventNumber,
  );
  if (activeAfter !== publication.baseRevision) {
    throw tagOverlayRevisionConflict(activeAfter);
  }
  const activeCatalogAfter = await loadActiveCatalog(
    database,
    publication.eventNumber,
  );
  if (
    !activeCatalogAfter ||
    activeCatalogAfter.versionID !== activeCatalog.versionID ||
    activeCatalogAfter.payloadSHA256 !==
      publication.overlay.catalogPayloadSHA256
  ) {
    throw tagOverlayCatalogMismatch(activeCatalogAfter?.payloadSHA256 ?? null);
  }
  throw tagOverlayUnavailable();
}

export async function loadTagOverlay(
  database: D1Database,
  bucket: R2Bucket,
  eventNumber: number,
  callerRevision: string,
): Promise<TagOverlayLoadResult> {
  const row = await createDatabase(database)
    .select({
      revision: circleTagOverlayVersions.revision,
      schemaVersion: circleTagOverlayVersions.schemaVersion,
      catalogVersionID: circleTagOverlayVersions.catalogVersionID,
      catalogPayloadSHA256: circleTagOverlayVersions.catalogPayloadSHA256,
      taxonomyRevision: circleTagOverlayVersions.taxonomyRevision,
      matchingPolicyRevision: circleTagOverlayVersions.matchingPolicyRevision,
      evaluatedCircleCount: circleTagOverlayVersions.evaluatedCircleCount,
      taggedCircleCount: circleTagOverlayVersions.taggedCircleCount,
      termCount: circleTagOverlayVersions.termCount,
      objectKey: circleTagOverlayVersions.objectKey,
      objectSHA256: circleTagOverlayVersions.objectSHA256,
      byteCount: circleTagOverlayVersions.byteCount,
    })
    .from(circleTagOverlayHeads)
    .innerJoin(
      circleTagOverlayVersions,
      and(
        eq(
          circleTagOverlayVersions.eventNumber,
          circleTagOverlayHeads.eventNumber,
        ),
        eq(circleTagOverlayVersions.revision, circleTagOverlayHeads.revision),
      ),
    )
    .where(eq(circleTagOverlayHeads.eventNumber, eventNumber))
    .get();
  if (!row) {
    return callerRevision === "none"
      ? { status: "absent" }
      : { status: "invalidated" };
  }
  const activeCatalog = await loadActiveCatalog(database, eventNumber);
  if (
    !activeCatalog ||
    activeCatalog.payloadSHA256 !== row.catalogPayloadSHA256 ||
    activeCatalog.circleCount !== row.evaluatedCircleCount
  ) {
    return { status: "invalidated" };
  }

  if (callerRevision !== "none" && callerRevision !== row.revision) {
    const knownRevision = await createDatabase(database)
      .select({ revision: circleTagOverlayVersions.revision })
      .from(circleTagOverlayVersions)
      .where(
        and(
          eq(circleTagOverlayVersions.eventNumber, eventNumber),
          eq(circleTagOverlayVersions.revision, callerRevision),
        ),
      )
      .get();
    if (!knownRevision) return { status: "invalidated" };
  }

  if (
    activeCatalog.versionID !== row.catalogVersionID &&
    !(await catalogCircleSetsMatch(
      database,
      row.catalogVersionID,
      activeCatalog.versionID,
      row.evaluatedCircleCount,
    ))
  ) {
    return { status: "invalidated" };
  }
  if (row.revision === callerRevision) return { status: "current" };

  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(row.objectKey);
  } catch {
    return { status: "unavailable" };
  }
  if (
    !object ||
    !matchesObjectMetadata(object, {
      objectKey: row.objectKey,
      objectSHA256: row.objectSHA256,
      byteCount: row.byteCount,
      eventNumber,
      revision: row.revision,
      catalogPayloadSHA256: row.catalogPayloadSHA256,
    })
  ) {
    return { status: "unavailable" };
  }

  let bytes: Uint8Array;
  let value: unknown;
  try {
    bytes = new Uint8Array(await object.arrayBuffer());
    if (
      bytes.byteLength !== row.byteCount ||
      (await sha256Hex(bytes)) !== row.objectSHA256
    ) {
      return { status: "unavailable" };
    }
    value = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    if (error instanceof ServiceError) return { status: "unavailable" };
    return { status: "unavailable" };
  }
  let overlay: CircleTagOverlay;
  try {
    overlay = parseTagOverlay(value);
    if (
      !(await verifyTagOverlayRevision(overlay)) ||
      canonicalTagOverlayJSON(overlay) !== decoder.decode(bytes) ||
      overlay.revision !== row.revision ||
      overlay.schemaVersion !== row.schemaVersion ||
      overlay.catalogPayloadSHA256 !== row.catalogPayloadSHA256 ||
      overlay.taxonomyRevision !== row.taxonomyRevision ||
      overlay.matchingPolicyRevision !== row.matchingPolicyRevision ||
      overlay.evaluatedCircleCount !== row.evaluatedCircleCount ||
      overlay.taggedCircleCount !== row.taggedCircleCount ||
      overlay.terms.length !== row.termCount
    ) {
      return { status: "unavailable" };
    }
  } catch {
    return { status: "unavailable" };
  }
  return { status: "current", overlay };
}

async function loadPublicationReceipt(
  database: D1Database,
  idempotencyKey: string,
  payloadSHA256: string,
): Promise<StoredPublicationResult | null> {
  const row = await createDatabase(database)
    .select({
      payloadSHA256: circleTagOverlayPublicationReceipts.payloadSHA256,
      resultJSON: circleTagOverlayPublicationReceipts.resultJSON,
    })
    .from(circleTagOverlayPublicationReceipts)
    .where(
      eq(circleTagOverlayPublicationReceipts.idempotencyKey, idempotencyKey),
    )
    .get();
  if (!row) return null;
  if (row.payloadSHA256 !== payloadSHA256) throw idempotencyConflict();
  try {
    return JSON.parse(row.resultJSON) as StoredPublicationResult;
  } catch {
    throw tagOverlayUnavailable();
  }
}

async function ensureReceiptOverlayObject(
  database: D1Database,
  bucket: R2Bucket,
  publication: TagOverlayPublication,
  receipt: StoredPublicationResult,
  nowMilliseconds: number,
): Promise<void> {
  if (
    publication.eventNumber !== receipt.eventNumber ||
    publication.overlay.revision !== receipt.revision
  ) {
    throw tagOverlayUnavailable();
  }
  const normalizedBytes = encoder.encode(
    canonicalTagOverlayJSON(publication.overlay),
  );
  const objectSHA256 = await sha256Hex(normalizedBytes);
  const objectKey = tagOverlayObjectKey(
    publication.eventNumber,
    publication.overlay.revision,
  );
  const version = await createDatabase(database)
    .select({
      schemaVersion: circleTagOverlayVersions.schemaVersion,
      catalogPayloadSHA256: circleTagOverlayVersions.catalogPayloadSHA256,
      taxonomyRevision: circleTagOverlayVersions.taxonomyRevision,
      matchingPolicyRevision: circleTagOverlayVersions.matchingPolicyRevision,
      evaluatedCircleCount: circleTagOverlayVersions.evaluatedCircleCount,
      taggedCircleCount: circleTagOverlayVersions.taggedCircleCount,
      termCount: circleTagOverlayVersions.termCount,
      objectKey: circleTagOverlayVersions.objectKey,
      objectSHA256: circleTagOverlayVersions.objectSHA256,
      byteCount: circleTagOverlayVersions.byteCount,
    })
    .from(circleTagOverlayVersions)
    .where(
      and(
        eq(circleTagOverlayVersions.eventNumber, publication.eventNumber),
        eq(circleTagOverlayVersions.revision, publication.overlay.revision),
      ),
    )
    .get();
  if (
    !version ||
    version.schemaVersion !== publication.overlay.schemaVersion ||
    version.catalogPayloadSHA256 !== publication.overlay.catalogPayloadSHA256 ||
    version.taxonomyRevision !== publication.overlay.taxonomyRevision ||
    version.matchingPolicyRevision !==
      publication.overlay.matchingPolicyRevision ||
    version.evaluatedCircleCount !== publication.overlay.evaluatedCircleCount ||
    version.taggedCircleCount !== publication.overlay.taggedCircleCount ||
    version.termCount !== publication.overlay.terms.length ||
    version.objectKey !== objectKey ||
    version.objectSHA256 !== objectSHA256 ||
    version.byteCount !== normalizedBytes.byteLength
  ) {
    throw tagOverlayUnavailable();
  }

  let existing: R2ObjectBody | null;
  try {
    existing = await bucket.get(objectKey);
  } catch {
    throw tagOverlayUnavailable();
  }
  const expected = {
    objectKey,
    objectSHA256,
    byteCount: normalizedBytes.byteLength,
    eventNumber: publication.eventNumber,
    revision: publication.overlay.revision,
    catalogPayloadSHA256: publication.overlay.catalogPayloadSHA256,
  };
  if (existing) {
    if (!(await storedObjectMatches(existing, expected))) {
      throw tagOverlayUnavailable();
    }
    return;
  }

  await enqueueCircleTagOverlayPrewriteCleanup(
    database,
    {
      objectKey,
      eventNumber: publication.eventNumber,
      revision: publication.overlay.revision,
      objectSHA256,
    },
    nowMilliseconds,
  );
  await ensureImmutableTagOverlayObject(bucket, {
    objectKey,
    objectSHA256,
    bytes: normalizedBytes,
    eventNumber: publication.eventNumber,
    overlay: publication.overlay,
  });
  await createDatabase(database)
    .delete(circleTagOverlayObjectCleanup)
    .where(
      and(
        eq(circleTagOverlayObjectCleanup.objectKey, objectKey),
        sql`EXISTS (
          SELECT 1 FROM ${circleTagOverlayVersions}
          WHERE ${circleTagOverlayVersions.eventNumber} = ${publication.eventNumber}
            AND ${circleTagOverlayVersions.revision} = ${publication.overlay.revision}
            AND ${circleTagOverlayVersions.objectKey} = ${objectKey}
            AND ${circleTagOverlayVersions.objectSHA256} = ${objectSHA256}
        )`,
      ),
    )
    .run();
}

async function loadActiveRevision(
  database: D1Database,
  eventNumber: number,
): Promise<string> {
  const row = await createDatabase(database)
    .select({ revision: circleTagOverlayHeads.revision })
    .from(circleTagOverlayHeads)
    .where(eq(circleTagOverlayHeads.eventNumber, eventNumber))
    .get();
  return row?.revision ?? "none";
}

async function loadActiveCatalog(
  database: D1Database,
  eventNumber: number,
): Promise<{
  versionID: string;
  payloadSHA256: string;
  circleCount: number;
} | null> {
  const row = await createDatabase(database)
    .select({
      versionID: catalogVersions.id,
      payloadSHA256: catalogVersions.sourceMainSHA256,
      circleCount: catalogVersions.circleCount,
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
  return row ?? null;
}

async function catalogCircleSetsMatch(
  database: D1Database,
  previousVersionID: string,
  activeVersionID: string,
  expectedCircleCount: number,
): Promise<boolean> {
  const db = createDatabase(database);
  const counts = await db
    .select({
      versionID: catalogCircles.versionID,
      circleCount: count(),
    })
    .from(catalogCircles)
    .where(
      inArray(catalogCircles.versionID, [previousVersionID, activeVersionID]),
    )
    .groupBy(catalogCircles.versionID)
    .all();
  const countByVersion = new Map(
    counts.map((row) => [row.versionID, row.circleCount]),
  );
  if (
    countByVersion.get(previousVersionID) !== expectedCircleCount ||
    countByVersion.get(activeVersionID) !== expectedCircleCount
  ) {
    return false;
  }

  const previousCircle = alias(catalogCircles, "previous_overlay_circle");
  const activeCircle = alias(catalogCircles, "active_overlay_circle");
  const missing = await db
    .select({ wcID: previousCircle.wcID })
    .from(previousCircle)
    .leftJoin(
      activeCircle,
      and(
        eq(activeCircle.versionID, activeVersionID),
        eq(activeCircle.wcID, previousCircle.wcID),
      ),
    )
    .where(
      and(
        eq(previousCircle.versionID, previousVersionID),
        isNull(activeCircle.wcID),
      ),
    )
    .limit(1)
    .get();
  return missing === undefined;
}

async function assertOverlayCatalogCoverage(
  database: D1Database,
  activeCatalog: {
    versionID: string;
    payloadSHA256: string;
    circleCount: number;
  },
  overlay: CircleTagOverlay,
): Promise<void> {
  if (overlay.evaluatedCircleCount !== activeCatalog.circleCount) {
    throw invalidTagOverlay(
      "evaluatedCircleCount must equal the active catalog circle count.",
    );
  }
  const rows = await createDatabase(database)
    .select({ wcID: catalogCircles.wcID })
    .from(catalogCircles)
    .where(eq(catalogCircles.versionID, activeCatalog.versionID));
  const catalogWCIDs = new Set(rows.map((row) => row.wcID));
  if (overlay.circles.some((circle) => !catalogWCIDs.has(circle.wcID))) {
    throw invalidTagOverlay(
      "Every tagged WCID must exist in the active catalog version.",
    );
  }
}

async function ensureImmutableTagOverlayObject(
  bucket: R2Bucket,
  input: {
    objectKey: string;
    objectSHA256: string;
    bytes: Uint8Array;
    eventNumber: number;
    overlay: CircleTagOverlay;
  },
): Promise<void> {
  const expected = {
    objectKey: input.objectKey,
    objectSHA256: input.objectSHA256,
    byteCount: input.bytes.byteLength,
    eventNumber: input.eventNumber,
    revision: input.overlay.revision,
    catalogPayloadSHA256: input.overlay.catalogPayloadSHA256,
  };
  try {
    const existing = await bucket.get(input.objectKey);
    if (existing) {
      if (!(await storedObjectMatches(existing, expected))) {
        throw tagOverlayUnavailable();
      }
      return;
    }
    await bucket.put(input.objectKey, input.bytes, {
      httpMetadata: { contentType: tagOverlayContentType },
      customMetadata: {
        schemaVersion: "1",
        sha256: input.objectSHA256,
        revision: input.overlay.revision,
        eventNumber: String(input.eventNumber),
        catalogPayloadSHA256: input.overlay.catalogPayloadSHA256,
        visibility: "tag_overlay",
      },
    });
    const stored = await bucket.get(input.objectKey);
    if (!stored || !(await storedObjectMatches(stored, expected))) {
      throw tagOverlayUnavailable();
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw tagOverlayUnavailable();
  }
}

async function storedObjectMatches(
  object: R2ObjectBody,
  expected: {
    objectKey: string;
    objectSHA256: string;
    byteCount: number;
    eventNumber: number;
    revision: string;
    catalogPayloadSHA256: string;
  },
): Promise<boolean> {
  if (!matchesObjectMetadata(object, expected)) return false;
  const bytes = new Uint8Array(await object.arrayBuffer());
  return (
    bytes.byteLength === expected.byteCount &&
    (await sha256Hex(bytes)) === expected.objectSHA256
  );
}

function matchesObjectMetadata(
  object: R2Object,
  expected: {
    objectKey: string;
    objectSHA256: string;
    byteCount: number;
    eventNumber: number;
    revision: string;
    catalogPayloadSHA256: string;
  },
): boolean {
  return (
    object.key === expected.objectKey &&
    object.size === expected.byteCount &&
    object.httpMetadata?.contentType === tagOverlayContentType &&
    object.customMetadata?.schemaVersion === "1" &&
    object.customMetadata.sha256 === expected.objectSHA256 &&
    object.customMetadata.revision === expected.revision &&
    object.customMetadata.eventNumber === String(expected.eventNumber) &&
    object.customMetadata.catalogPayloadSHA256 ===
      expected.catalogPayloadSHA256 &&
    object.customMetadata.visibility === "tag_overlay"
  );
}

function parseTerm(value: unknown): TagOverlayTerm {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "label", "kind"]) ||
    !isConstrainedIdentifier(value.id) ||
    typeof value.label !== "string" ||
    value.label.length === 0 ||
    Array.from(value.label).length > 200 ||
    value.label.trim().length === 0 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value.label) ||
    !isTagOverlayKind(value.kind)
  ) {
    throw invalidTagOverlay("A tag term is invalid.");
  }
  return { id: value.id, label: value.label, kind: value.kind };
}

function parseCircle(
  value: unknown,
  termIDs: ReadonlySet<string>,
  referencedTermIDs: Set<string>,
): TagOverlayCircle {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["wcID", "tagIDs"]) ||
    !Number.isSafeInteger(value.wcID) ||
    typeof value.wcID !== "number" ||
    value.wcID <= 0 ||
    !Array.isArray(value.tagIDs) ||
    value.tagIDs.length === 0 ||
    value.tagIDs.length > maximumTagsPerCircle
  ) {
    throw invalidTagOverlay("A tagged circle entry is invalid.");
  }
  const tagIDs: string[] = [];
  for (const tagID of value.tagIDs) {
    if (
      !isConstrainedIdentifier(tagID) ||
      !termIDs.has(tagID) ||
      (tagIDs.length > 0 &&
        compareCanonical(tagIDs[tagIDs.length - 1], tagID) >= 0)
    ) {
      throw invalidTagOverlay(
        "Circle tag IDs must reference terms in canonical ascending order.",
      );
    }
    tagIDs.push(tagID);
    referencedTermIDs.add(tagID);
  }
  return { wcID: value.wcID, tagIDs };
}

function tagOverlayObjectKey(eventNumber: number, revision: string): string {
  return `derived/tag-overlays/v1/c${eventNumber}/${revision}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

function isBaseRevision(value: unknown): value is string {
  return value === "none" || isDigest(value);
}

function isConstrainedIdentifier(value: unknown): value is string {
  return typeof value === "string" && constrainedIdentifierPattern.test(value);
}

function isEventNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 10_000
  );
}

function isBoundedInteger(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}

function isTagOverlayKind(value: unknown): value is TagOverlayKind {
  return (
    typeof value === "string" &&
    (tagOverlayKinds as readonly string[]).includes(value)
  );
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const bytes = Uint8Array.from(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function invalidTagOverlay(message: string, status = 400): ServiceError {
  return new ServiceError("invalid_tag_overlay", status, message);
}

function tagOverlayRevisionConflict(activeRevision: string): ServiceError {
  return new ServiceError(
    "tag_overlay_revision_conflict",
    409,
    "The tag overlay base revision is stale.",
    { activeRevision },
  );
}

function tagOverlayCatalogMismatch(
  activeCatalogPayloadSHA256: string | null,
): ServiceError {
  return new ServiceError(
    "tag_overlay_catalog_mismatch",
    409,
    "The tag overlay does not match the active catalog source.",
    { activeCatalogPayloadSHA256 },
  );
}

function idempotencyConflict(): ServiceError {
  return new ServiceError(
    "idempotency_conflict",
    409,
    "The crawler idempotency key was used with a different tag overlay payload.",
  );
}

function tagOverlayUnavailable(): ServiceError {
  return new ServiceError(
    "tag_overlay_unavailable",
    503,
    "The active tag overlay could not be verified.",
  );
}
