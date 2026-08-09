import type { CominaviIdentity } from "./cominavi-auth";
import { ServiceError } from "./service-error";

export interface FavoriteInput {
  wcID: number;
  color: number;
  notificationsEnabled: boolean;
}

export interface FavoriteSnapshot {
  eventNumber: number;
  revision: number;
  favorites: FavoriteInput[];
}

interface FavoriteSetRow {
  revision: number;
  last_mutation_id: string | null;
}

interface FavoriteRow {
  wc_id: number;
  color: number;
  notifications_enabled: number;
}

const maximumFavorites = 30_000;

export function parseEventNumber(value: string | undefined): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > 10_000) {
    throw new ServiceError(
      "invalid_event_number",
      400,
      "The Comiket event number is invalid.",
    );
  }
  return number;
}

export function parseFavoriteSnapshotBody(value: unknown): {
  baseRevision: number;
  mutationID: string;
  favorites: FavoriteInput[];
} {
  if (!isRecord(value)) throw invalidFavorites();
  const baseRevision = value.baseRevision;
  const mutationID = value.mutationID;
  const rawFavorites = value.favorites;
  if (
    !Number.isSafeInteger(baseRevision) ||
    Number(baseRevision) < 0 ||
    typeof mutationID !== "string" ||
    !/^[0-9a-fA-F-]{16,64}$/.test(mutationID) ||
    !Array.isArray(rawFavorites) ||
    rawFavorites.length > maximumFavorites
  ) {
    throw invalidFavorites();
  }

  const byWCID = new Map<number, FavoriteInput>();
  for (const item of rawFavorites) {
    if (
      !isRecord(item) ||
      !Number.isSafeInteger(item.wcID) ||
      Number(item.wcID) <= 0 ||
      !Number.isSafeInteger(item.color) ||
      Number(item.color) < 0 ||
      Number(item.color) > 9 ||
      typeof item.notificationsEnabled !== "boolean"
    ) {
      throw invalidFavorites();
    }
    byWCID.set(Number(item.wcID), {
      wcID: Number(item.wcID),
      color: Number(item.color),
      notificationsEnabled: item.notificationsEnabled,
    });
  }
  return {
    baseRevision: Number(baseRevision),
    mutationID,
    favorites: Array.from(byWCID.values()).sort(
      (left, right) => left.wcID - right.wcID,
    ),
  };
}

export async function loadFavoriteSnapshot(
  database: D1Database,
  identity: CominaviIdentity,
  eventNumber: number,
): Promise<FavoriteSnapshot> {
  const [set, rows] = await Promise.all([
    database
      .prepare(
        `SELECT revision, last_mutation_id
         FROM favorite_sets
         WHERE user_id = ?1 AND comiket_no = ?2`,
      )
      .bind(identity.userID, eventNumber)
      .first<FavoriteSetRow>(),
    database
      .prepare(
        `SELECT wc_id, color, notifications_enabled
         FROM user_favorites
         WHERE user_id = ?1 AND comiket_no = ?2 AND active = 1
         ORDER BY wc_id`,
      )
      .bind(identity.userID, eventNumber)
      .all<FavoriteRow>(),
  ]);
  return {
    eventNumber,
    revision: set?.revision ?? 0,
    favorites: rows.results.map((row) => ({
      wcID: row.wc_id,
      color: row.color,
      notificationsEnabled: row.notifications_enabled === 1,
    })),
  };
}

export async function replaceFavoriteSnapshot(
  database: D1Database,
  identity: CominaviIdentity,
  eventNumber: number,
  input: ReturnType<typeof parseFavoriteSnapshotBody>,
  nowMilliseconds = Date.now(),
): Promise<FavoriteSnapshot> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const favoritesJSON = JSON.stringify(input.favorites);
  const unknown = await database
    .prepare(
      `SELECT CAST(json_extract(requested.value, '$.wcID') AS INTEGER) AS wc_id
       FROM json_each(?1) AS requested
       LEFT JOIN circles AS circle
         ON circle.comiket_no = ?2
        AND circle.wc_id = CAST(json_extract(requested.value, '$.wcID') AS INTEGER)
       WHERE circle.wc_id IS NULL
       LIMIT 20`,
    )
    .bind(favoritesJSON, eventNumber)
    .all<{ wc_id: number }>();
  if (unknown.results.length > 0) {
    throw new ServiceError(
      "unknown_circle",
      422,
      "One or more favorites are not in the current service catalog.",
      { wcIDs: unknown.results.map((row) => row.wc_id) },
    );
  }

  await database
    .prepare(
      `INSERT OR IGNORE INTO favorite_sets
         (user_id, comiket_no, revision, last_mutation_id, updated_at)
       VALUES (?1, ?2, 0, NULL, ?3)`,
    )
    .bind(identity.userID, eventNumber, now)
    .run();

  const existing = await database
    .prepare(
      `SELECT revision, last_mutation_id
       FROM favorite_sets
       WHERE user_id = ?1 AND comiket_no = ?2`,
    )
    .bind(identity.userID, eventNumber)
    .first<FavoriteSetRow>();
  if (existing?.last_mutation_id === input.mutationID) {
    return loadFavoriteSnapshot(database, identity, eventNumber);
  }
  if (!existing || existing.revision !== input.baseRevision) {
    throw revisionConflict(existing?.revision ?? 0);
  }

  const nextRevision = input.baseRevision + 1;
  const results = await database.batch([
    database
      .prepare(
        `UPDATE favorite_sets
         SET revision = ?1, last_mutation_id = ?2, updated_at = ?3
         WHERE user_id = ?4 AND comiket_no = ?5 AND revision = ?6`,
      )
      .bind(
        nextRevision,
        input.mutationID,
        now,
        identity.userID,
        eventNumber,
        input.baseRevision,
      ),
    database
      .prepare(
        `INSERT INTO user_favorites (
           user_id, comiket_no, wc_id, color, notifications_enabled,
           active, snapshot_revision, created_at, updated_at
         )
         SELECT ?1, ?2,
                CAST(json_extract(item.value, '$.wcID') AS INTEGER),
                CAST(json_extract(item.value, '$.color') AS INTEGER),
                CASE json_extract(item.value, '$.notificationsEnabled')
                  WHEN 1 THEN 1 ELSE 0 END,
                1, ?3, ?4, ?4
         FROM json_each(?5) AS item
         WHERE EXISTS (
           SELECT 1 FROM favorite_sets
           WHERE user_id = ?1 AND comiket_no = ?2
             AND revision = ?3 AND last_mutation_id = ?6
         )
         ON CONFLICT(user_id, comiket_no, wc_id) DO UPDATE SET
           color = excluded.color,
           notifications_enabled = excluded.notifications_enabled,
           active = 1,
           snapshot_revision = excluded.snapshot_revision,
           updated_at = excluded.updated_at`,
      )
      .bind(
        identity.userID,
        eventNumber,
        nextRevision,
        now,
        favoritesJSON,
        input.mutationID,
      ),
    database
      .prepare(
        `UPDATE user_favorites
         SET active = 0, snapshot_revision = ?1, updated_at = ?2
         WHERE user_id = ?3 AND comiket_no = ?4 AND active = 1
           AND EXISTS (
             SELECT 1 FROM favorite_sets
             WHERE user_id = ?3 AND comiket_no = ?4
               AND revision = ?1 AND last_mutation_id = ?5
           )
           AND NOT EXISTS (
             SELECT 1 FROM json_each(?6) AS item
             WHERE CAST(json_extract(item.value, '$.wcID') AS INTEGER)
                   = user_favorites.wc_id
           )`,
      )
      .bind(
        nextRevision,
        now,
        identity.userID,
        eventNumber,
        input.mutationID,
        favoritesJSON,
      ),
  ]);

  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const current = await loadFavoriteSnapshot(database, identity, eventNumber);
    throw revisionConflict(current.revision);
  }
  return loadFavoriteSnapshot(database, identity, eventNumber);
}

function revisionConflict(currentRevision: number): ServiceError {
  return new ServiceError(
    "favorite_revision_conflict",
    409,
    "Favorites changed on another device. Fetch and merge the latest snapshot.",
    { currentRevision },
  );
}

function invalidFavorites(): ServiceError {
  return new ServiceError(
    "invalid_favorites",
    400,
    "The favorites snapshot is invalid.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
