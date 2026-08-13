import { and, eq, exists, gt, inArray, lte, sql, type SQL } from "drizzle-orm";

import {
  circles,
  circleStateHeads,
  circleUpdateEvents,
  circleUpdateTargets,
  postMedia,
  socialPosts,
} from "../db/schema";
import { createDatabase } from "../db/client";
import {
  activeCrawlerSnapshotStillCurrent,
  loadActiveCrawlerSnapshot,
} from "./crawler-snapshots";
import { ServiceError } from "./service-error";

interface UpdateRow {
  id: number;
  eventKey: string;
  updateKind: string;
  stateKind: string;
  stateValue: string;
  confidence: string;
  occurredAt: number;
  sourceRevision: number;
  postID: string;
  postURL: string | null;
  text: string;
  authorXUserID: string | null;
  authorHandle: string;
  authorName: string | null;
  authorProfileImageURL: string | null;
  targetsJSON: string;
  mediaJSON: string;
}

const incrementalPageSize = 500;

export async function loadRealtimeUpdates(
  database: D1Database,
  bucket: R2Bucket,
  eventNumber: number,
  afterCursor?: number,
  callerPublicationRevision?: string,
): Promise<{
  eventNumber: number;
  hasMore: boolean;
  updates: unknown[];
  publicationRevision: string;
  publicationGeneration: number;
  publicationCursor: number;
  resetRequired: boolean;
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await loadRealtimeUpdatesAttempt(
      database,
      bucket,
      eventNumber,
      afterCursor,
      callerPublicationRevision,
    );
    const current =
      result.publicationRevision === "none"
        ? null
        : {
            revision: result.publicationRevision,
            generation: result.publicationGeneration,
            publicationCursor: result.publicationCursor,
          };
    if (
      await activeCrawlerSnapshotStillCurrent(database, eventNumber, current)
    ) {
      return result;
    }
  }
  throw new ServiceError(
    "crawler_snapshot_unavailable",
    503,
    "The active snapshot changed repeatedly while realtime updates were being read.",
  );
}

async function loadRealtimeUpdatesAttempt(
  database: D1Database,
  bucket: R2Bucket,
  eventNumber: number,
  afterCursor?: number,
  callerPublicationRevision?: string,
): Promise<{
  eventNumber: number;
  hasMore: boolean;
  updates: unknown[];
  publicationRevision: string;
  publicationGeneration: number;
  publicationCursor: number;
  resetRequired: boolean;
}> {
  const snapshotHead = await loadActiveCrawlerSnapshot(
    database,
    bucket,
    eventNumber,
    false,
  );
  let publicationRevision = snapshotHead?.revision ?? "none";
  let publicationGeneration = snapshotHead?.generation ?? 0;
  let publicationCursor = snapshotHead?.publicationCursor ?? 0;
  const legacyRequest = callerPublicationRevision === undefined;
  let resetRequired =
    !legacyRequest && callerPublicationRevision !== publicationRevision;
  const db = createDatabase(database);
  const matchingTarget = db
    .select({ value: sql<number>`1` })
    .from(circleUpdateTargets)
    .where(
      and(
        eq(circleUpdateTargets.updateEventID, circleUpdateEvents.id),
        eq(circleUpdateTargets.comiketNo, eventNumber),
      ),
    );
  // SQLite's JSON aggregate remains an intentional SQL expression, while
  // every table, column, predicate, join, and bound value stays Drizzle-owned.
  const targetsJSON = sql<string>`COALESCE((
    SELECT json_group_array(json_object(
      'eventNumber', ${circleUpdateTargets.comiketNo},
      'wcID', ${circleUpdateTargets.wcID},
      'circleID', ${circles.circleID},
      'circleName', ${circles.circleName},
      'day', ${circles.day},
      'areaName', ${circles.areaName},
      'blockName', ${circles.blockName},
      'spaceNo', ${circles.spaceNo},
      'spaceNoSub', ${circles.spaceNoSub},
      'location', ${circles.location}
    ))
    FROM ${circleUpdateTargets}
    JOIN ${circles}
      ON ${circles.comiketNo} = ${circleUpdateTargets.comiketNo}
     AND ${circles.wcID} = ${circleUpdateTargets.wcID}
    WHERE ${circleUpdateTargets.updateEventID} = ${circleUpdateEvents.id}
      AND ${circleUpdateTargets.comiketNo} = ${eventNumber}
  ), '[]')`;
  const currentHeadTargetsJSON = sql<string>`COALESCE((
    SELECT json_group_array(json_object(
      'eventNumber', ${circleUpdateTargets.comiketNo},
      'wcID', ${circleUpdateTargets.wcID},
      'circleID', ${circles.circleID},
      'circleName', ${circles.circleName},
      'day', ${circles.day},
      'areaName', ${circles.areaName},
      'blockName', ${circles.blockName},
      'spaceNo', ${circles.spaceNo},
      'spaceNoSub', ${circles.spaceNoSub},
      'location', ${circles.location}
    ))
    FROM ${circleUpdateTargets}
    JOIN ${circles}
      ON ${circles.comiketNo} = ${circleUpdateTargets.comiketNo}
     AND ${circles.wcID} = ${circleUpdateTargets.wcID}
    JOIN ${circleStateHeads}
      ON ${circleStateHeads.comiketNo} = ${circleUpdateTargets.comiketNo}
     AND ${circleStateHeads.wcID} = ${circleUpdateTargets.wcID}
     AND ${circleStateHeads.stateKind} = ${circleUpdateEvents.stateKind}
     AND ${circleStateHeads.updateEventID} = ${circleUpdateEvents.id}
    WHERE ${circleUpdateTargets.updateEventID} = ${circleUpdateEvents.id}
      AND ${circleUpdateTargets.comiketNo} = ${eventNumber}
  ), '[]')`;
  const mediaJSON = sql<string>`COALESCE((
    SELECT json_group_array(json_object(
      'key', ${postMedia.mediaKey},
      'type', ${postMedia.mediaType},
      'role', ${postMedia.role},
      'url', ${postMedia.url},
      'previewURL', ${postMedia.previewURL},
      'width', ${postMedia.width},
      'height', ${postMedia.height},
      'palette', json(${postMedia.paletteJSON}),
      'payloadSHA256', ${postMedia.payloadSHA256}
    ))
    FROM ${postMedia}
    WHERE ${postMedia.postID} = ${circleUpdateEvents.postID}
  ), '[]')`;
  const query = (
    cursorPredicate?: SQL<unknown>,
    responseTargetsJSON: SQL<string> = targetsJSON,
  ) =>
    db
      .select({
        id: circleUpdateEvents.id,
        eventKey: circleUpdateEvents.eventKey,
        updateKind: circleUpdateEvents.updateKind,
        stateKind: circleUpdateEvents.stateKind,
        stateValue: circleUpdateEvents.stateValue,
        confidence: circleUpdateEvents.confidence,
        occurredAt: circleUpdateEvents.occurredAt,
        sourceRevision: circleUpdateEvents.sourceRevision,
        postID: socialPosts.postID,
        postURL: socialPosts.postURL,
        text: socialPosts.text,
        authorXUserID: socialPosts.authorXUserID,
        authorHandle: socialPosts.authorHandle,
        authorName: socialPosts.authorName,
        authorProfileImageURL: socialPosts.authorProfileImageURL,
        targetsJSON: responseTargetsJSON,
        mediaJSON,
      })
      .from(circleUpdateEvents)
      .innerJoin(socialPosts, eq(socialPosts.postID, circleUpdateEvents.postID))
      .where(and(exists(matchingTarget), cursorPredicate))
      .orderBy(circleUpdateEvents.id);
  if (snapshotHead && (legacyRequest || resetRequired)) {
    const snapshot = await loadActiveCrawlerSnapshot(
      database,
      bucket,
      eventNumber,
      true,
    );
    if (snapshot) {
      publicationRevision = snapshot.revision;
      publicationGeneration = snapshot.generation;
      publicationCursor = snapshot.publicationCursor;
      resetRequired =
        !legacyRequest && callerPublicationRevision !== publicationRevision;
    }
    const [baselineStateRows, deltaRows] = await Promise.all([
      query(
        and(
          lte(circleUpdateEvents.id, publicationCursor),
          exists(
            db
              .select({ value: sql<number>`1` })
              .from(circleStateHeads)
              .where(
                and(
                  eq(circleStateHeads.updateEventID, circleUpdateEvents.id),
                  eq(circleStateHeads.comiketNo, eventNumber),
                  inArray(circleStateHeads.stateKind, [
                    "attendance",
                    "inventory",
                    "presence",
                  ]),
                ),
              ),
          ),
        ),
        currentHeadTargetsJSON,
      ),
      query(gt(circleUpdateEvents.id, publicationCursor)),
    ]);
    const baseline = [
      ...(snapshot?.events ?? []).map((event) =>
        snapshotEventResponse(event, publicationCursor),
      ),
      ...baselineStateRows.map((row) =>
        updateRowResponse(row, publicationCursor),
      ),
    ].sort((left, right) => left.eventKey.localeCompare(right.eventKey));
    return {
      eventNumber,
      hasMore: false,
      updates: [...baseline, ...deltaRows.map((row) => updateRowResponse(row))],
      publicationRevision,
      publicationGeneration,
      publicationCursor,
      resetRequired,
    };
  }
  const incrementalCursor = snapshotHead
    ? Math.max(afterCursor ?? publicationCursor, publicationCursor)
    : afterCursor;
  const rows: UpdateRow[] =
    incrementalCursor === undefined
      ? await query()
      : await query(gt(circleUpdateEvents.id, incrementalCursor)).limit(
          incrementalPageSize + 1,
        );
  const hasMore =
    incrementalCursor !== undefined && rows.length > incrementalPageSize;
  const pageRows = hasMore ? rows.slice(0, incrementalPageSize) : rows;

  return {
    eventNumber,
    hasMore,
    publicationRevision,
    publicationGeneration,
    publicationCursor,
    resetRequired,
    updates: pageRows.map((row) => updateRowResponse(row)),
  };
}

function updateRowResponse(row: UpdateRow, cursor = row.id) {
  return {
    cursor,
    eventKey: row.eventKey,
    updateKind: row.updateKind,
    stateKind: row.stateKind,
    stateValue: row.stateValue,
    confidence: row.confidence,
    occurredAt: new Date(row.occurredAt * 1_000).toISOString(),
    sourceRevision: row.sourceRevision,
    post: {
      id: row.postID,
      url: row.postURL,
      text: row.text,
      author: {
        xUserID: row.authorXUserID,
        handle: row.authorHandle,
        name: row.authorName,
        profileImageURL: row.authorProfileImageURL,
      },
      media: parseJSONArray(row.mediaJSON),
    },
    circles: parseJSONArray(row.targetsJSON),
  };
}

function snapshotEventResponse(
  event: import("./crawler-ingest").CrawlerEvent,
  cursor: number,
) {
  return {
    cursor,
    eventKey: event.eventKey,
    updateKind: event.updateKind,
    stateKind: event.stateKind,
    stateValue: event.stateValue,
    confidence: event.confidence,
    occurredAt: event.post.occurredAt,
    sourceRevision: event.sourceRevision,
    post: {
      id: event.post.id,
      url: event.post.url ?? null,
      text: event.post.text,
      author: {
        xUserID: event.post.author.xUserID ?? null,
        handle: event.post.author.handle,
        name: event.post.author.name ?? null,
        profileImageURL: event.post.author.profileImageURL ?? null,
      },
      media: event.post.media.map((media) => ({
        key: media.key,
        type: media.type,
        role: media.role,
        url: media.url,
        previewURL: media.previewURL ?? null,
        width: media.width ?? null,
        height: media.height ?? null,
        palette: media.palette ?? null,
        payloadSHA256: media.payloadSHA256 ?? null,
      })),
    },
    circles: event.circles.map((circle) => ({
      eventNumber: circle.comiketNo,
      wcID: circle.wcID,
      circleID: circle.circleID ?? null,
      circleName: circle.circleName ?? "",
      day: circle.day ?? null,
      areaName: circle.areaName ?? null,
      blockName: circle.blockName ?? null,
      spaceNo: circle.spaceNo ?? null,
      spaceNoSub: circle.spaceNoSub ?? null,
      location: circle.location ?? null,
    })),
  };
}

function parseJSONArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
