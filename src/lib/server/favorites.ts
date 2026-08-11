import { and, eq, sql } from "drizzle-orm";

import { runDrizzleBatch } from "../db/batch";
import { createDatabase } from "../db/client";
import {
  catalogStableCircles,
  favoriteMutationAtomicAssertions,
  favoriteMutationReceipts,
  favoriteSets,
  userFavorites,
  users,
} from "../db/schema";
import type { CominaviIdentity } from "./cominavi-auth";
import { sha256Hex } from "./auth-sessions";
import { parseCanonicalRequestID } from "./request-id";
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

interface FavoriteSnapshotRow {
  revision: number | null;
  wc_id: number | null;
  color: number | null;
  notifications_enabled: number | null;
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
    mutationID: parseCanonicalRequestID(mutationID),
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
  // Revision and rows come from one SQLite read snapshot. Rows from an older
  // replacement are excluded even if a concurrent writer advances the set.
  const rows = await createDatabase(database).all<FavoriteSnapshotRow>(sql`
    SELECT favorite_set.revision, favorite.wc_id, favorite.color,
           favorite.notifications_enabled
    FROM (SELECT 1) AS singleton
    LEFT JOIN ${favoriteSets} AS favorite_set
      ON favorite_set.user_id = ${identity.userID}
     AND favorite_set.comiket_no = ${eventNumber}
    LEFT JOIN ${userFavorites} AS favorite
      ON favorite.user_id = ${identity.userID}
     AND favorite.comiket_no = ${eventNumber}
     AND favorite.active = 1
     AND favorite.snapshot_revision = favorite_set.revision
    ORDER BY favorite.wc_id
  `);
  const revision = rows[0]?.revision ?? 0;
  return {
    eventNumber,
    revision,
    favorites: rows.flatMap((row) =>
      row.wc_id === null
        ? []
        : [
            {
              wcID: row.wc_id,
              color: row.color!,
              notificationsEnabled: row.notifications_enabled === 1,
            },
          ],
    ),
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
  const payloadHash = await sha256Hex(
    JSON.stringify({
      v: 1,
      eventNumber,
      baseRevision: input.baseRevision,
      favorites: input.favorites,
    }),
  );
  const db = createDatabase(database);
  const prior = await db
    .select({ payloadHash: favoriteMutationReceipts.payloadHash })
    .from(favoriteMutationReceipts)
    .where(
      and(
        eq(favoriteMutationReceipts.userID, identity.userID),
        eq(favoriteMutationReceipts.comiketNo, eventNumber),
        eq(favoriteMutationReceipts.mutationID, input.mutationID),
      ),
    )
    .get();
  if (prior) {
    if (prior.payloadHash !== payloadHash) throw idempotencyConflict();
    return loadFavoriteSnapshot(database, identity, eventNumber);
  }
  const unknown = await db.all<{ wc_id: number }>(sql`
    SELECT CAST(json_extract(requested.value, '$.wcID') AS INTEGER) AS wc_id
    FROM json_each(${favoritesJSON}) AS requested
    LEFT JOIN ${catalogStableCircles} AS circle
      ON circle.comiket_no = ${eventNumber}
     AND circle.wc_id = CAST(json_extract(requested.value, '$.wcID') AS INTEGER)
    WHERE circle.wc_id IS NULL
    LIMIT 20
  `);
  if (unknown.length > 0) {
    throw new ServiceError(
      "unknown_circle",
      422,
      "One or more favorites are not in the current service catalog.",
      { wcIDs: unknown.map((row) => row.wc_id) },
    );
  }

  const existing = await db
    .select({
      revision: favoriteSets.revision,
      last_mutation_id: favoriteSets.lastMutationID,
      last_mutation_payload_hash: favoriteSets.lastMutationPayloadHash,
    })
    .from(favoriteSets)
    .where(
      and(
        eq(favoriteSets.userID, identity.userID),
        eq(favoriteSets.comiketNo, eventNumber),
      ),
    )
    .get();
  if (
    existing?.last_mutation_id === input.mutationID &&
    existing.last_mutation_payload_hash === payloadHash
  ) {
    return loadFavoriteSnapshot(database, identity, eventNumber);
  }
  if ((existing?.revision ?? 0) !== input.baseRevision) {
    throw revisionConflict(existing?.revision ?? 0);
  }

  const nextRevision = input.baseRevision + 1;
  const results = await runDrizzleBatch(database, [
    sql`INSERT INTO ${favoriteSets} (
      user_id, comiket_no, revision, last_mutation_id,
      last_mutation_payload_hash, updated_at
    )
    SELECT ${identity.userID}, ${eventNumber}, ${nextRevision},
      ${input.mutationID}, ${payloadHash}, ${now}
    FROM ${users}
    WHERE ${users.id} = ${identity.userID}
      AND ${users.authVersion} = ${identity.authVersion}
      AND ${users.deletionPendingAt} IS NULL
    ON CONFLICT(user_id, comiket_no) DO UPDATE SET
      revision = excluded.revision,
      last_mutation_id = excluded.last_mutation_id,
      last_mutation_payload_hash = excluded.last_mutation_payload_hash,
      updated_at = excluded.updated_at
    WHERE ${favoriteSets.revision} = ${input.baseRevision}`,
    sql`INSERT INTO ${userFavorites} (
      user_id, comiket_no, wc_id, color, notifications_enabled,
      active, snapshot_revision, created_at, updated_at
    )
    SELECT ${identity.userID}, ${eventNumber},
      CAST(json_extract(item.value, '$.wcID') AS INTEGER),
      CAST(json_extract(item.value, '$.color') AS INTEGER),
      CASE json_extract(item.value, '$.notificationsEnabled')
        WHEN 1 THEN 1 ELSE 0 END,
      1, ${nextRevision}, ${now}, ${now}
    FROM json_each(${favoritesJSON}) AS item
    WHERE EXISTS (
      SELECT 1 FROM ${favoriteSets}
      WHERE ${favoriteSets.userID} = ${identity.userID}
        AND ${favoriteSets.comiketNo} = ${eventNumber}
        AND ${favoriteSets.revision} = ${nextRevision}
        AND ${favoriteSets.lastMutationID} = ${input.mutationID}
        AND ${favoriteSets.lastMutationPayloadHash} = ${payloadHash}
    )
    ON CONFLICT(user_id, comiket_no, wc_id) DO UPDATE SET
      color = excluded.color,
      notifications_enabled = excluded.notifications_enabled,
      active = 1,
      snapshot_revision = excluded.snapshot_revision,
      updated_at = excluded.updated_at`,
    sql`UPDATE ${userFavorites}
    SET active = 0, snapshot_revision = ${nextRevision}, updated_at = ${now}
    WHERE ${userFavorites.userID} = ${identity.userID}
      AND ${userFavorites.comiketNo} = ${eventNumber}
      AND ${userFavorites.active} = 1
      AND EXISTS (
        SELECT 1 FROM ${favoriteSets}
        WHERE ${favoriteSets.userID} = ${identity.userID}
          AND ${favoriteSets.comiketNo} = ${eventNumber}
          AND ${favoriteSets.revision} = ${nextRevision}
          AND ${favoriteSets.lastMutationID} = ${input.mutationID}
          AND ${favoriteSets.lastMutationPayloadHash} = ${payloadHash}
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(${favoritesJSON}) AS item
        WHERE CAST(json_extract(item.value, '$.wcID') AS INTEGER)
          = ${userFavorites.wcID}
      )`,
    sql`INSERT INTO ${favoriteMutationReceipts} (
      user_id, comiket_no, mutation_id, payload_hash,
      result_revision, created_at
    )
    SELECT ${identity.userID}, ${eventNumber}, ${input.mutationID},
      ${payloadHash}, ${favoriteSets.revision}, ${now}
    FROM ${favoriteSets}
    WHERE ${favoriteSets.userID} = ${identity.userID}
      AND ${favoriteSets.comiketNo} = ${eventNumber}
      AND ${favoriteSets.revision} = ${nextRevision}
      AND ${favoriteSets.lastMutationID} = ${input.mutationID}
      AND ${favoriteSets.lastMutationPayloadHash} = ${payloadHash}`,
    sql`INSERT INTO ${favoriteMutationAtomicAssertions} (
      user_id, comiket_no, mutation_id, committed, created_at
    ) VALUES (
      ${identity.userID}, ${eventNumber}, ${input.mutationID},
      CASE WHEN EXISTS (
        SELECT 1 FROM ${favoriteMutationReceipts}
        WHERE ${favoriteMutationReceipts.userID} = ${identity.userID}
          AND ${favoriteMutationReceipts.comiketNo} = ${eventNumber}
          AND ${favoriteMutationReceipts.mutationID} = ${input.mutationID}
          AND ${favoriteMutationReceipts.payloadHash} = ${payloadHash}
          AND ${favoriteMutationReceipts.resultRevision} = ${nextRevision}
      ) THEN 1 ELSE 0 END,
      ${now}
    )`,
  ]);
  void results;
  return loadFavoriteSnapshot(database, identity, eventNumber);
}

function idempotencyConflict(): ServiceError {
  return new ServiceError(
    "idempotency_conflict",
    409,
    "This mutationID was already used with a different favorites payload.",
  );
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
