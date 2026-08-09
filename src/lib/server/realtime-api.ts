import { ServiceError } from "./service-error";

interface UpdateRow {
  id: number;
  event_key: string;
  update_kind: string;
  state_kind: string;
  state_value: string;
  confidence: string;
  occurred_at: number;
  source_revision: number;
  post_id: string;
  post_url: string | null;
  text: string;
  author_x_user_id: string | null;
  author_handle: string;
  author_name: string | null;
  author_profile_image_url: string | null;
  targets_json: string;
  media_json: string;
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
  const wcIDsJSON = JSON.stringify(query.wcIDs);
  const rows = await database
    .prepare(
      `SELECT event.id, event.event_key, event.update_kind, event.state_kind,
              event.state_value, event.confidence, event.occurred_at,
              event.source_revision, post.post_id, post.post_url, post.text,
              post.author_x_user_id, post.author_handle, post.author_name,
              post.author_profile_image_url,
              COALESCE((
                SELECT json_group_array(json_object(
                  'eventNumber', target.comiket_no,
                  'wcID', target.wc_id,
                  'circleID', circle.circle_id,
                  'circleName', circle.circle_name,
                  'day', circle.day,
                  'areaName', circle.area_name,
                  'blockName', circle.block_name,
                  'spaceNo', circle.space_no,
                  'spaceNoSub', circle.space_no_sub,
                  'location', circle.location
                ))
                FROM circle_update_targets AS target
                JOIN circles AS circle
                  ON circle.comiket_no = target.comiket_no
                 AND circle.wc_id = target.wc_id
                WHERE target.update_event_id = event.id
                  AND target.comiket_no = ?1
              ), '[]') AS targets_json,
              COALESCE((
                SELECT json_group_array(json_object(
                  'key', media.media_key,
                  'type', media.media_type,
                  'role', media.role,
                  'url', media.url,
                  'previewURL', media.preview_url,
                  'width', media.width,
                  'height', media.height,
                  'palette', json(media.palette_json),
                  'payloadSHA256', media.payload_sha256
                ))
                FROM post_media AS media
                WHERE media.post_id = event.post_id
              ), '[]') AS media_json
       FROM circle_update_events AS event
       JOIN social_posts AS post ON post.post_id = event.post_id
       WHERE event.id > ?2
         AND EXISTS (
           SELECT 1 FROM circle_update_targets AS event_target
           WHERE event_target.update_event_id = event.id
             AND event_target.comiket_no = ?1
             AND (?3 = 0 OR event_target.wc_id IN (
               SELECT CAST(value AS INTEGER) FROM json_each(?4)
             ))
         )
       ORDER BY event.id
       LIMIT ?5`,
    )
    .bind(
      eventNumber,
      query.after,
      query.wcIDs.length,
      wcIDsJSON,
      query.limit + 1,
    )
    .all<UpdateRow>();

  const hasMore = rows.results.length > query.limit;
  const page = rows.results.slice(0, query.limit);
  return {
    eventNumber,
    updates: page.map((row) => ({
      cursor: row.id,
      eventKey: row.event_key,
      updateKind: row.update_kind,
      stateKind: row.state_kind,
      stateValue: row.state_value,
      confidence: row.confidence,
      occurredAt: new Date(row.occurred_at * 1_000).toISOString(),
      sourceRevision: row.source_revision,
      post: {
        id: row.post_id,
        url: row.post_url,
        text: row.text,
        author: {
          xUserID: row.author_x_user_id,
          handle: row.author_handle,
          name: row.author_name,
          profileImageURL: row.author_profile_image_url,
        },
        media: parseJSONArray(row.media_json),
      },
      circles: parseJSONArray(row.targets_json),
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
