import { and, eq, exists, gt, inArray, sql } from "drizzle-orm";

import {
  circles,
  circleUpdateEvents,
  circleUpdateTargets,
  postMedia,
  socialPosts,
} from "../db/schema";
import { createDatabase } from "../db/client";
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

export interface RealtimeQuery {
  after: number;
  limit: number;
  wcIDs: number[];
}

export function parseRealtimeQuery(url: URL): RealtimeQuery {
  const after = Number(url.searchParams.get("after") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "100");
  const wcIDs = url.searchParams
    .getAll("wcID")
    .flatMap((value) => value.split(","))
    .filter(Boolean)
    .map(Number);
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    wcIDs.length > 500 ||
    wcIDs.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new ServiceError(
      "invalid_realtime_query",
      400,
      "The realtime update cursor or filter is invalid.",
    );
  }
  return { after, limit, wcIDs: Array.from(new Set(wcIDs)).sort() };
}

export async function loadRealtimeUpdates(
  database: D1Database,
  eventNumber: number,
  query: RealtimeQuery,
): Promise<{
  eventNumber: number;
  updates: unknown[];
  nextCursor: number;
  hasMore: boolean;
  serverTime: string;
}> {
  const db = createDatabase(database);
  const matchingTarget = db
    .select({ value: sql<number>`1` })
    .from(circleUpdateTargets)
    .where(
      and(
        eq(circleUpdateTargets.updateEventID, circleUpdateEvents.id),
        eq(circleUpdateTargets.comiketNo, eventNumber),
        query.wcIDs.length > 0
          ? inArray(circleUpdateTargets.wcID, query.wcIDs)
          : undefined,
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
  const rows: UpdateRow[] = await db
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
      targetsJSON,
      mediaJSON,
    })
    .from(circleUpdateEvents)
    .innerJoin(socialPosts, eq(socialPosts.postID, circleUpdateEvents.postID))
    .where(and(gt(circleUpdateEvents.id, query.after), exists(matchingTarget)))
    .orderBy(circleUpdateEvents.id)
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  return {
    eventNumber,
    updates: page.map((row) => ({
      cursor: row.id,
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
    })),
    nextCursor: page.at(-1)?.id ?? query.after,
    hasMore,
    serverTime: new Date().toISOString(),
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
