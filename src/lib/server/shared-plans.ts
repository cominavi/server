import type { CominaviIdentity } from "./cominavi-auth";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  lt,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { parameterizedSQL, runDrizzleBatch } from "../db/batch";
import { createDatabase } from "../db/client";
import {
  ownedPlanSlots,
  sharedPlanEvents,
  sharedPlanInvitations,
  sharedPlanMembers,
  sharedPlanNotificationDeliveries,
  sharedPlanRequests,
  sharedPlans,
  users,
} from "../db/schema";
import { base64URL, decodeBase64URL, sha256Hex } from "./auth-sessions";
import { ServiceError } from "./service-error";
import { parseCanonicalRequestID } from "./request-id";

const maximumActivePlanMembers = 50;

export interface SharedPlan {
  id: string;
  name: string;
  comiketNo: number;
  role: "owner" | "editor";
  status: "active" | "archived";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlanMutationResult {
  plan: SharedPlan;
  receipt: {
    requestId: string;
    replayed: boolean;
    resultRevision: number;
    resultStatus: "active" | "archived";
  };
}

interface PlanReceiptReplay {
  plan: SharedPlan;
  resultRevision: number;
  resultStatus: "active" | "archived";
}

interface PlanRow {
  id: string;
  name: string;
  comiket_no: number;
  owner_user_id: number;
  owner_public_id: string;
  role: "owner" | "editor";
  archived_at: number | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface InvitationRow {
  id: string;
  plan_id: string;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
  plan_name: string;
  comiket_no: number;
  created_by_public_id: string;
  created_by_display_name: string;
  created_by_avatar_object_key: string | null;
  created_by_avatar_content_type:
    "image/jpeg" | "image/png" | "image/webp" | null;
}

export interface CollectionPage {
  limit: number;
  cursor: string | null;
}

export interface CollectionPageResult<T> {
  items: T[];
  nextCursor: string | null;
}

export function parseCollectionPage(request: Request): CollectionPage {
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw invalidPagination();
  }
  return { limit, cursor: url.searchParams.get("cursor") };
}

export function parseCreatePlan(value: unknown): {
  requestID: string;
  name: string;
  comiketNo: number;
} {
  if (!isRecord(value)) throw invalidPlan();
  return {
    requestID: parseRequestID(value.requestId),
    name: parsePlanName(value.name),
    comiketNo: parseComiketNo(value.comiketNo),
  };
}

export function parsePlanUpdate(value: unknown): {
  requestID: string;
  baseRevision: number;
  name?: string;
  archived?: boolean;
} {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.baseRevision) ||
    Number(value.baseRevision) < 1 ||
    (value.name === undefined && value.archived === undefined) ||
    (value.archived !== undefined && typeof value.archived !== "boolean")
  ) {
    throw invalidPlan();
  }
  return {
    requestID: parseRequestID(value.requestId),
    baseRevision: Number(value.baseRevision),
    ...(value.name !== undefined ? { name: parsePlanName(value.name) } : {}),
    ...(typeof value.archived === "boolean"
      ? { archived: value.archived }
      : {}),
  };
}

export function parsePlanArchive(value: unknown): {
  requestID: string;
  baseRevision: number;
  archived: true;
} {
  const mutation = parseMembershipMutation(value);
  return { ...mutation, archived: true };
}

export async function createSharedPlan(
  database: D1Database,
  identity: CominaviIdentity,
  input: ReturnType<typeof parseCreatePlan>,
  nowMilliseconds = Date.now(),
): Promise<PlanMutationResult> {
  const scope = `plans:create:${input.comiketNo}`;
  const payloadHash = await payloadDigest(input);
  const replay = await loadRequestPlan(
    database,
    identity.userID,
    scope,
    input.requestID,
    payloadHash,
  );
  if (replay) return replayedMutationResult(replay, input.requestID);
  const planID = crypto.randomUUID();
  const now = Math.floor(nowMilliseconds / 1_000);
  const results = await runDrizzleBatch(database, [
    sql`INSERT INTO ${sharedPlans} (
           id, comiket_no, name, owner_user_id, archived_at,
           revision, created_at, updated_at, last_mutation_scope,
           last_mutation_request_id, last_mutation_payload_hash
         )
         SELECT ${planID}, ${input.comiketNo}, ${input.name}, ${identity.userID},
                NULL, 1, ${now}, ${now}, ${scope}, ${input.requestID}, ${payloadHash}
         WHERE NOT EXISTS (
           SELECT 1 FROM ${sharedPlanRequests}
           WHERE user_id = ${identity.userID} AND scope = ${scope}
             AND request_id = ${input.requestID}
         )
         AND EXISTS (
           WITH RECURSIVE slots(slot) AS (
             VALUES(0) UNION ALL SELECT slot + 1 FROM slots WHERE slot < 49
           )
           SELECT 1 FROM slots
           LEFT JOIN ${ownedPlanSlots} AS used
             ON used.owner_user_id = ${identity.userID}
            AND used.comiket_no = ${input.comiketNo}
            AND used.slot = slots.slot
           WHERE used.slot IS NULL LIMIT 1
         )
         AND EXISTS (
           SELECT 1 FROM ${users}
           WHERE id = ${identity.userID} AND auth_version = ${identity.authVersion}
             AND deletion_pending_at IS NULL
         )`,
    sql`INSERT INTO ${sharedPlanMembers} (
           plan_id, user_id, role, joined_at, revoked_at, updated_at
         )
         SELECT id, owner_user_id, 'owner', ${now}, NULL, ${now}
         FROM ${sharedPlans} WHERE id = ${planID}`,
    sql`INSERT INTO ${ownedPlanSlots} (owner_user_id, comiket_no, slot, plan_id)
         SELECT ${identity.userID}, ${input.comiketNo}, slots.slot, ${planID}
         FROM (
           WITH RECURSIVE generated(slot) AS (
             VALUES(0) UNION ALL
             SELECT slot + 1 FROM generated WHERE slot < 49
           ) SELECT slot FROM generated
         ) AS slots
         WHERE EXISTS (SELECT 1 FROM ${sharedPlans} WHERE id = ${planID})
           AND NOT EXISTS (
             SELECT 1 FROM ${ownedPlanSlots} AS used
             WHERE used.owner_user_id = ${identity.userID}
               AND used.comiket_no = ${input.comiketNo}
               AND used.slot = slots.slot
           )
         ORDER BY slots.slot LIMIT 1`,
    requestStatement(
      identity.userID,
      scope,
      input.requestID,
      "create",
      payloadHash,
      planID,
      now,
      1,
    ),
  ]);
  if (results.slice(0, 4).some((result) => (result.meta.changes ?? 0) !== 1)) {
    const raced = await loadRequestPlan(
      database,
      identity.userID,
      scope,
      input.requestID,
      payloadHash,
    );
    if (raced) return replayedMutationResult(raced, input.requestID);
    throw new ServiceError(
      "active_plan_limit",
      409,
      "You already own 50 active plans for this Comiket.",
    );
  }
  return mutationResult(
    await loadSharedPlan(database, identity, planID),
    input.requestID,
    false,
  );
}

export async function listSharedPlans(
  database: D1Database,
  identity: CominaviIdentity,
  page: CollectionPage = { limit: 50, cursor: null },
): Promise<CollectionPageResult<SharedPlan>> {
  const cursor = decodePlansCursor(page.cursor);
  const archived = sql<number>`CASE WHEN ${sharedPlans.archivedAt} IS NULL THEN 0 ELSE 1 END`;
  const cursorCondition = cursor
    ? or(
        gt(archived, cursor.archived),
        and(
          eq(archived, cursor.archived),
          lt(sharedPlans.updatedAt, cursor.updatedAt),
        ),
        and(
          eq(archived, cursor.archived),
          eq(sharedPlans.updatedAt, cursor.updatedAt),
          gt(sharedPlans.id, cursor.id),
        ),
      )
    : undefined;
  const result = await createDatabase(database)
    .select({
      id: sharedPlans.id,
      name: sharedPlans.name,
      comiketNo: sharedPlans.comiketNo,
      ownerUserID: sharedPlans.ownerUserID,
      ownerPublicID: users.publicID,
      role: sharedPlanMembers.role,
      archivedAt: sharedPlans.archivedAt,
      revision: sharedPlans.revision,
      createdAt: sharedPlans.createdAt,
      updatedAt: sharedPlans.updatedAt,
    })
    .from(sharedPlanMembers)
    .innerJoin(sharedPlans, eq(sharedPlans.id, sharedPlanMembers.planID))
    .innerJoin(users, eq(users.id, sharedPlans.ownerUserID))
    .where(
      and(
        eq(sharedPlanMembers.userID, identity.userID),
        isNull(sharedPlanMembers.revokedAt),
        cursorCondition,
      ),
    )
    .orderBy(asc(archived), desc(sharedPlans.updatedAt), asc(sharedPlans.id))
    .limit(page.limit + 1);
  const pageRows: PlanRow[] = result.slice(0, page.limit).map((row) => ({
    id: row.id,
    name: row.name,
    comiket_no: row.comiketNo,
    owner_user_id: row.ownerUserID,
    owner_public_id: row.ownerPublicID,
    role: row.role,
    archived_at: row.archivedAt,
    revision: row.revision,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }));
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(serializePlan),
    nextCursor:
      result.length > page.limit && last
        ? encodeCursor({
            v: 1,
            kind: "plans",
            archived: last.archived_at === null ? 0 : 1,
            updatedAt: last.updated_at,
            id: last.id,
          })
        : null,
  };
}

export async function loadSharedPlan(
  database: D1Database,
  identity: CominaviIdentity,
  planID: string,
): Promise<SharedPlan> {
  const row = await loadPlanRow(database, identity.userID, planID);
  if (!row) throw planNotFound();
  return serializePlan(row);
}

export async function updateSharedPlan(
  database: D1Database,
  identity: CominaviIdentity,
  planID: string,
  input: ReturnType<typeof parsePlanUpdate>,
  nowMilliseconds = Date.now(),
): Promise<PlanMutationResult> {
  const scope = `plans:${planID}:update`;
  const payloadHash = await payloadDigest(input);
  const replay = await loadRequestPlan(
    database,
    identity.userID,
    scope,
    input.requestID,
    payloadHash,
  );
  if (replay) return replayedMutationResult(replay, input.requestID);
  const current = await loadPlanRow(database, identity.userID, planID);
  if (!current) throw planNotFound();
  if (current.role !== "owner") throw ownerRequired();
  const targetArchived = input.archived ?? current.archived_at !== null;
  const currentlyArchived = current.archived_at !== null;
  const now = Math.floor(nowMilliseconds / 1_000);

  let statements: SQLWrapper[];
  let requiredExactlyOne: number[];
  if (!currentlyArchived && targetArchived) {
    statements = [
      sql`UPDATE ${sharedPlans}
           SET name = COALESCE(${input.name ?? null}, name), archived_at = ${now},
               revision = revision + 1,
               notification_epoch = notification_epoch + 1,
               updated_at = ${now}, last_mutation_scope = ${scope},
               last_mutation_request_id = ${input.requestID},
               last_mutation_payload_hash = ${payloadHash}
           WHERE id = ${planID} AND owner_user_id = ${identity.userID}
             AND revision = ${input.baseRevision}
             AND archived_at IS NULL
             AND EXISTS (
               SELECT 1 FROM ${users}
               WHERE id = ${identity.userID}
                 AND auth_version = ${identity.authVersion}
                 AND deletion_pending_at IS NULL
             )
             AND EXISTS (
               SELECT 1 FROM ${ownedPlanSlots}
               WHERE plan_id = ${planID} AND owner_user_id = ${identity.userID}
             )`,
      sql`DELETE FROM ${ownedPlanSlots}
           WHERE plan_id = ${planID} AND EXISTS (
             SELECT 1 FROM ${sharedPlans}
             WHERE id = ${planID} AND revision = ${input.baseRevision + 1}
               AND archived_at = ${now} AND last_mutation_scope = ${scope}
               AND last_mutation_request_id = ${input.requestID}
               AND last_mutation_payload_hash = ${payloadHash}
           )`,
      sql`UPDATE ${sharedPlanInvitations} SET revoked_at = ${now}
           WHERE plan_id = ${planID} AND revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM ${sharedPlans}
               WHERE id = ${planID} AND revision = ${input.baseRevision + 1}
                 AND archived_at = ${now} AND last_mutation_scope = ${scope}
                 AND last_mutation_request_id = ${input.requestID}
                 AND last_mutation_payload_hash = ${payloadHash}
             )`,
      sql`UPDATE ${sharedPlanNotificationDeliveries}
           SET status = 'suppressed', lease_expires_at = NULL,
               last_error = 'plan_archived', updated_at = ${now}
           WHERE event_id IN (
             SELECT id FROM ${sharedPlanEvents} WHERE plan_id = ${planID}
           ) AND status IN ('pending', 'processing', 'retry')
             AND EXISTS (
               SELECT 1 FROM ${sharedPlans}
               WHERE id = ${planID} AND revision = ${input.baseRevision + 1}
                 AND archived_at = ${now} AND last_mutation_scope = ${scope}
                 AND last_mutation_request_id = ${input.requestID}
                 AND last_mutation_payload_hash = ${payloadHash}
             )`,
      requestStatement(
        identity.userID,
        scope,
        input.requestID,
        "update",
        payloadHash,
        planID,
        now,
        input.baseRevision + 1,
      ),
    ];
    requiredExactlyOne = [0, 1, 4];
  } else if (currentlyArchived && !targetArchived) {
    statements = [
      sql`UPDATE ${sharedPlans}
           SET name = COALESCE(${input.name ?? null}, name), archived_at = NULL,
               revision = revision + 1,
               notification_epoch = notification_epoch + 1,
               updated_at = ${now}, last_mutation_scope = ${scope},
               last_mutation_request_id = ${input.requestID},
               last_mutation_payload_hash = ${payloadHash}
           WHERE id = ${planID} AND owner_user_id = ${identity.userID}
             AND revision = ${input.baseRevision}
             AND archived_at IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM ${users}
               WHERE id = ${identity.userID}
                 AND auth_version = ${identity.authVersion}
                 AND deletion_pending_at IS NULL
             )
             AND EXISTS (
               WITH RECURSIVE generated(slot) AS (
                 VALUES(0) UNION ALL
                 SELECT slot + 1 FROM generated WHERE slot < 49
               )
               SELECT 1 FROM generated
               LEFT JOIN ${ownedPlanSlots} AS used
                 ON used.owner_user_id = ${identity.userID}
                AND used.comiket_no = ${current.comiket_no}
                AND used.slot = generated.slot
               WHERE used.slot IS NULL LIMIT 1
             )`,
      allocateSlotStatement(identity.userID, current.comiket_no, planID, {
        scope,
        requestID: input.requestID,
        payloadHash,
      }),
      requestStatement(
        identity.userID,
        scope,
        input.requestID,
        "update",
        payloadHash,
        planID,
        now,
        input.baseRevision + 1,
      ),
    ];
    requiredExactlyOne = [0, 1, 2];
  } else {
    statements = [
      sql`UPDATE ${sharedPlans}
           SET name = COALESCE(${input.name ?? null}, name),
               revision = revision + 1, updated_at = ${now},
               last_mutation_scope = ${scope},
               last_mutation_request_id = ${input.requestID},
               last_mutation_payload_hash = ${payloadHash}
           WHERE id = ${planID} AND owner_user_id = ${identity.userID}
             AND revision = ${input.baseRevision}
             AND EXISTS (
               SELECT 1 FROM ${users}
               WHERE id = ${identity.userID}
                 AND auth_version = ${identity.authVersion}
                 AND deletion_pending_at IS NULL
             )`,
      requestStatement(
        identity.userID,
        scope,
        input.requestID,
        "update",
        payloadHash,
        planID,
        now,
        input.baseRevision + 1,
      ),
    ];
    requiredExactlyOne = [0, 1];
  }
  const results = await runDrizzleBatch(
    database,
    statements as [SQLWrapper, ...SQLWrapper[]],
  );
  if (
    requiredExactlyOne.some(
      (index) => (results[index]?.meta.changes ?? 0) !== 1,
    )
  ) {
    const replayed = await loadRequestPlan(
      database,
      identity.userID,
      scope,
      input.requestID,
      payloadHash,
    );
    if (replayed) return replayedMutationResult(replayed, input.requestID);
    const latest = await loadSharedPlan(database, identity, planID);
    if (
      currentlyArchived &&
      !targetArchived &&
      latest.revision === input.baseRevision
    ) {
      throw new ServiceError(
        "active_plan_limit",
        409,
        "You already own 50 active plans for this Comiket.",
      );
    }
    throw revisionConflict(latest);
  }
  return mutationResult(
    await loadSharedPlan(database, identity, planID),
    input.requestID,
    false,
  );
}

export async function assertPlanMember(
  database: D1Database,
  userID: number,
  planID: string,
): Promise<{ comiketNo: number; role: "owner" | "editor"; revision: number }> {
  const row = await loadPlanRow(database, userID, planID);
  if (!row) throw planNotFound();
  return { comiketNo: row.comiket_no, role: row.role, revision: row.revision };
}

export async function listPlanMembers(
  database: D1Database,
  identity: CominaviIdentity,
  planID: string,
  page: CollectionPage = { limit: 50, cursor: null },
): Promise<CollectionPageResult<unknown>> {
  const cursor = decodeMembersCursor(page.cursor);
  const rows = await createDatabase(database).all<{
    user_id: number | null;
    public_id: string | null;
    role: "owner" | "editor" | null;
    joined_at: number | null;
    revoked_at: number | null;
    display_name: string | null;
    avatar_object_key: string | null;
    sentinel: number;
  }>(sql`WITH authorized AS (
         SELECT role FROM ${sharedPlanMembers}
         WHERE plan_id = ${planID} AND user_id = ${identity.userID}
           AND revoked_at IS NULL
       ), page AS (
         SELECT member.user_id, user.public_id, member.role, member.joined_at,
                member.revoked_at, user.display_name, user.avatar_object_key
         FROM ${sharedPlanMembers} AS member
         JOIN ${users} AS user ON user.id = member.user_id
         CROSS JOIN authorized
         WHERE member.plan_id = ${planID}
           AND (member.revoked_at IS NULL OR authorized.role = 'owner')
           AND (${cursor ? 1 : 0} = 0 OR
             (CASE WHEN member.role = 'owner' THEN 0 ELSE 1 END) > ${cursor?.roleRank ?? 0} OR
             ((CASE WHEN member.role = 'owner' THEN 0 ELSE 1 END) = ${cursor?.roleRank ?? 0}
               AND member.joined_at > ${cursor?.joinedAt ?? 0}) OR
             ((CASE WHEN member.role = 'owner' THEN 0 ELSE 1 END) = ${cursor?.roleRank ?? 0}
               AND member.joined_at = ${cursor?.joinedAt ?? 0}
               AND user.public_id > ${cursor?.publicID ?? ""}))
         ORDER BY member.role = 'owner' DESC, member.joined_at, user.public_id
         LIMIT ${page.limit + 1}
       )
       SELECT page.*, CASE WHEN page.user_id IS NULL THEN 1 ELSE 0 END AS sentinel
       FROM authorized LEFT JOIN page ON 1 = 1
       ORDER BY sentinel, page.role = 'owner' DESC, page.joined_at, page.public_id`);
  if (rows.length === 0) throw planNotFound();
  const data = rows.filter(
    (
      row,
    ): row is typeof row & {
      user_id: number;
      public_id: string;
      role: "owner" | "editor";
      joined_at: number;
      display_name: string;
    } => row.sentinel === 0 && row.user_id !== null,
  );
  const pageRows = data.slice(0, page.limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((row) => ({
      userID: row.public_id,
      displayName: row.display_name,
      avatarURL: row.avatar_object_key
        ? `/api/v2/users/${row.public_id}/avatar`
        : null,
      role: row.role,
      membershipStatus: row.revoked_at === null ? "active" : "removed",
      joinedAt: new Date(row.joined_at * 1_000).toISOString(),
      removedAt:
        row.revoked_at === null
          ? null
          : new Date(row.revoked_at * 1_000).toISOString(),
    })),
    nextCursor:
      data.length > page.limit && last
        ? encodeCursor({
            v: 1,
            kind: "members",
            roleRank: last.role === "owner" ? 0 : 1,
            joinedAt: last.joined_at,
            publicID: last.public_id,
          })
        : null,
  };
}

export function parseMembershipMutation(value: unknown): {
  requestID: string;
  baseRevision: number;
} {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.baseRevision) ||
    Number(value.baseRevision) < 1
  ) {
    throw invalidPlan();
  }
  return {
    requestID: parseRequestID(value.requestId),
    baseRevision: Number(value.baseRevision),
  };
}

export function parseOwnershipTransfer(value: unknown): {
  requestID: string;
  baseRevision: number;
  newOwnerUserID: string;
} {
  const mutation = parseMembershipMutation(value);
  if (
    !isRecord(value) ||
    typeof value.newOwnerUserID !== "string" ||
    !/^[0-9a-f]{32}$/.test(value.newOwnerUserID)
  ) {
    throw invalidPlan();
  }
  return { ...mutation, newOwnerUserID: value.newOwnerUserID };
}

export async function transferPlanOwnership(
  database: D1Database,
  identity: CominaviIdentity,
  planID: string,
  input: ReturnType<typeof parseOwnershipTransfer>,
  nowMilliseconds = Date.now(),
): Promise<PlanMutationResult> {
  const scope = `plans:${planID}:transfer-owner`;
  const payloadHash = await payloadDigest(input);
  const replay = await loadRequestPlan(
    database,
    identity.userID,
    scope,
    input.requestID,
    payloadHash,
  );
  if (replay) return replayedMutationResult(replay, input.requestID);
  const current = await loadPlanRow(database, identity.userID, planID);
  if (!current) throw planNotFound();
  if (current.role !== "owner") throw ownerRequired();
  if (current.archived_at !== null) {
    throw new ServiceError(
      "archived_plan",
      409,
      "Restore the plan before transferring ownership.",
    );
  }
  const target = await createDatabase(database).get<{ id: number }>(
    parameterizedSQL(
      `SELECT user.id
       FROM users AS user
       JOIN shared_plan_members AS member ON member.user_id = user.id
       WHERE user.public_id = ?1 AND member.plan_id = ?2
         AND member.revoked_at IS NULL AND member.role = 'editor'`,
      [input.newOwnerUserID, planID],
    ),
  );
  if (!target) {
    throw new ServiceError(
      "invalid_new_owner",
      422,
      "The new owner must be an active editor of this plan.",
    );
  }
  const now = Math.floor(nowMilliseconds / 1_000);
  const results = await runDrizzleBatch(database, [
    parameterizedSQL(
      `UPDATE shared_plans
         SET owner_user_id = ?1, revision = revision + 1, updated_at = ?2,
             last_mutation_scope = ?6,
             last_mutation_request_id = ?7,
             last_mutation_payload_hash = ?8
         WHERE id = ?3 AND owner_user_id = ?4 AND revision = ?5
           AND archived_at IS NULL
           AND EXISTS (
             SELECT 1 FROM users WHERE id = ?4 AND auth_version = ?10
               AND deletion_pending_at IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM users WHERE id = ?1
               AND deletion_pending_at IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM owned_plan_slots
             WHERE plan_id = ?3 AND owner_user_id = ?4
           )
           AND EXISTS (
             SELECT 1 FROM shared_plan_members
             WHERE plan_id = ?3 AND user_id = ?1 AND role = 'editor'
               AND revoked_at IS NULL
           )
           AND EXISTS (
             WITH RECURSIVE generated(slot) AS (
               VALUES(0) UNION ALL
               SELECT slot + 1 FROM generated WHERE slot < 49
             )
             SELECT 1 FROM generated
             LEFT JOIN owned_plan_slots AS used
               ON used.owner_user_id = ?1 AND used.comiket_no = ?9
              AND used.slot = generated.slot
             WHERE used.slot IS NULL LIMIT 1
           )`,
      [
        target.id,
        now,
        planID,
        identity.userID,
        input.baseRevision,
        scope,
        input.requestID,
        payloadHash,
        current.comiket_no,
        identity.authVersion,
      ],
    ),
    parameterizedSQL(
      `UPDATE owned_plan_slots
         SET owner_user_id = ?1,
             slot = (
               WITH RECURSIVE generated(slot) AS (
                 VALUES(0) UNION ALL
                 SELECT slot + 1 FROM generated WHERE slot < 49
               )
               SELECT generated.slot FROM generated
               LEFT JOIN owned_plan_slots AS used
                 ON used.owner_user_id = ?1 AND used.comiket_no = ?2
                AND used.slot = generated.slot
               WHERE used.slot IS NULL ORDER BY generated.slot LIMIT 1
             )
         WHERE plan_id = ?3 AND owner_user_id = ?4
           AND EXISTS (
             SELECT 1 FROM shared_plans
             WHERE id = ?3 AND owner_user_id = ?1
               AND last_mutation_scope = ?5
               AND last_mutation_request_id = ?6
               AND last_mutation_payload_hash = ?7
           )`,
      [
        target.id,
        current.comiket_no,
        planID,
        identity.userID,
        scope,
        input.requestID,
        payloadHash,
      ],
    ),
    parameterizedSQL(
      `UPDATE shared_plan_members SET role = 'editor', updated_at = ?1
         WHERE plan_id = ?2 AND user_id = ?3 AND role = 'owner'
           AND EXISTS (
             SELECT 1 FROM shared_plans
             WHERE id = ?2 AND owner_user_id = ?4 AND revision = ?5
               AND last_mutation_scope = ?6
               AND last_mutation_request_id = ?7
               AND last_mutation_payload_hash = ?8
           )`,
      [
        now,
        planID,
        identity.userID,
        target.id,
        input.baseRevision + 1,
        scope,
        input.requestID,
        payloadHash,
      ],
    ),
    parameterizedSQL(
      `UPDATE shared_plan_members SET role = 'owner', updated_at = ?1
         WHERE plan_id = ?2 AND user_id = ?3 AND role = 'editor'
           AND revoked_at IS NULL AND EXISTS (
             SELECT 1 FROM shared_plans
             WHERE id = ?2 AND owner_user_id = ?3 AND revision = ?4
               AND last_mutation_scope = ?5
               AND last_mutation_request_id = ?6
               AND last_mutation_payload_hash = ?7
           )`,
      [
        now,
        planID,
        target.id,
        input.baseRevision + 1,
        scope,
        input.requestID,
        payloadHash,
      ],
    ),
    requestStatement(
      identity.userID,
      scope,
      input.requestID,
      "transfer_owner",
      payloadHash,
      planID,
      now,
      input.baseRevision + 1,
    ),
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    const replayed = await loadRequestPlan(
      database,
      identity.userID,
      scope,
      input.requestID,
      payloadHash,
    );
    if (replayed) return replayedMutationResult(replayed, input.requestID);
    const latest = await loadSharedPlan(database, identity, planID);
    if (latest.revision === input.baseRevision) {
      throw new ServiceError(
        "new_owner_active_plan_limit",
        409,
        "The new owner already owns 50 active plans for this Comiket.",
      );
    }
    throw revisionConflict(latest);
  }
  return mutationResult(
    await loadSharedPlan(database, identity, planID),
    input.requestID,
    false,
  );
}

export async function setPlanMemberRevoked(
  database: D1Database,
  identity: CominaviIdentity,
  planID: string,
  targetPublicID: string,
  input: ReturnType<typeof parseMembershipMutation>,
  revoked: boolean,
  nowMilliseconds = Date.now(),
): Promise<PlanMutationResult> {
  if (!/^[0-9a-f]{32}$/.test(targetPublicID)) throw planNotFound();
  const operation = revoked ? "revoke_member" : "reinstate_member";
  const scope = `plans:${planID}:members:${targetPublicID}:${operation}`;
  const payloadHash = await payloadDigest(input);
  const replay = await loadRequestPlan(
    database,
    identity.userID,
    scope,
    input.requestID,
    payloadHash,
  );
  if (replay) return replayedMutationResult(replay, input.requestID);
  const current = await loadPlanRow(database, identity.userID, planID);
  if (!current) throw planNotFound();
  if (current.role !== "owner") throw ownerRequired();
  const target = await createDatabase(database).get<{
    id: number;
    revoked_at: number | null;
  }>(
    parameterizedSQL(
      `SELECT user.id, member.revoked_at
       FROM users AS user
       JOIN shared_plan_members AS member ON member.user_id = user.id
       WHERE user.public_id = ?1 AND member.plan_id = ?2
         AND member.role = 'editor'`,
      [targetPublicID, planID],
    ),
  );
  if (
    !target ||
    (revoked ? target.revoked_at !== null : target.revoked_at === null)
  ) {
    throw new ServiceError(
      revoked ? "member_not_found" : "member_not_revoked",
      404,
      "The plan member was not found in the required state.",
    );
  }
  const now = Math.floor(nowMilliseconds / 1_000);
  const statements: SQLWrapper[] = [
    parameterizedSQL(
      `UPDATE shared_plans
         SET revision = revision + 1, updated_at = ?1,
             last_mutation_scope = ?6,
             last_mutation_request_id = ?7,
             last_mutation_payload_hash = ?8
         WHERE id = ?2 AND owner_user_id = ?3 AND revision = ?4
           AND EXISTS (
             SELECT 1 FROM users WHERE id = ?3 AND auth_version = ?9
               AND deletion_pending_at IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM shared_plan_members
             WHERE plan_id = ?2 AND user_id = ?5 AND role = 'editor'
               AND ${revoked ? "revoked_at IS NULL" : "revoked_at IS NOT NULL"}
           )
           AND (${revoked ? "1" : "0"} = 1 OR (
             SELECT count(*) FROM shared_plan_members
             WHERE plan_id = ?2 AND revoked_at IS NULL
           ) < ${maximumActivePlanMembers})
           AND (${revoked ? "1" : "0"} = 1 OR EXISTS (
             SELECT 1 FROM users
             WHERE id = ?5 AND deletion_pending_at IS NULL
           ))`,
      [
        now,
        planID,
        identity.userID,
        input.baseRevision,
        target.id,
        scope,
        input.requestID,
        payloadHash,
        identity.authVersion,
      ],
    ),
    parameterizedSQL(
      `UPDATE shared_plan_members
         SET revoked_at = ?1, notification_epoch = notification_epoch + 1,
             updated_at = ?2
         WHERE plan_id = ?3 AND user_id = ?4 AND role = 'editor'
           AND ${revoked ? "revoked_at IS NULL" : "revoked_at IS NOT NULL"}
           AND EXISTS (
             SELECT 1 FROM shared_plans
             WHERE id = ?3 AND last_mutation_scope = ?5
               AND last_mutation_request_id = ?6
               AND last_mutation_payload_hash = ?7
           )`,
      [
        revoked ? now : null,
        now,
        planID,
        target.id,
        scope,
        input.requestID,
        payloadHash,
      ],
    ),
    ...(revoked
      ? [
          parameterizedSQL(
            `UPDATE shared_plan_notification_deliveries
               SET status = 'suppressed', lease_expires_at = NULL,
                   last_error = 'membership_revoked', updated_at = ?1
               WHERE user_id = ?2 AND event_id IN (
                 SELECT id FROM shared_plan_events WHERE plan_id = ?3
               ) AND status IN ('pending', 'processing', 'retry')
                 AND EXISTS (
                   SELECT 1 FROM shared_plan_members
                   WHERE plan_id = ?3 AND user_id = ?2
                     AND revoked_at = ?1
                 )`,
            [now, target.id, planID],
          ),
        ]
      : []),
    requestStatement(
      identity.userID,
      scope,
      input.requestID,
      operation,
      payloadHash,
      planID,
      now,
      input.baseRevision + 1,
    ),
  ];
  const results = await runDrizzleBatch(
    database,
    statements as [SQLWrapper, ...SQLWrapper[]],
  );
  const receiptIndex = revoked ? 3 : 2;
  if (
    (results[0]?.meta.changes ?? 0) !== 1 ||
    (results[1]?.meta.changes ?? 0) !== 1 ||
    (results[receiptIndex]?.meta.changes ?? 0) !== 1
  ) {
    if (!revoked) {
      const active = await createDatabase(database).get<{ count: number }>(
        parameterizedSQL(
          `SELECT count(*) AS count FROM shared_plan_members
           WHERE plan_id = ?1 AND revoked_at IS NULL`,
          [planID],
        ),
      );
      if ((active?.count ?? 0) >= maximumActivePlanMembers) {
        throw memberLimit();
      }
    }
    const latest = await loadSharedPlan(database, identity, planID);
    throw revisionConflict(latest);
  }
  return mutationResult(
    await loadSharedPlan(database, identity, planID),
    input.requestID,
    false,
  );
}

export function parseInvitationCreate(value: unknown): {
  requestID: string;
  baseRevision: number;
  expiresAt?: number;
} {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.baseRevision) ||
    Number(value.baseRevision) < 1
  ) {
    throw invalidInvitation();
  }
  let expiresAt: number | undefined;
  if (value.expiresAt !== undefined) {
    if (typeof value.expiresAt !== "string") throw invalidInvitation();
    const parsed = Date.parse(value.expiresAt);
    if (!Number.isFinite(parsed)) throw invalidInvitation();
    expiresAt = Math.floor(parsed / 1_000);
  }
  return {
    requestID: parseRequestID(value.requestId),
    baseRevision: Number(value.baseRevision),
    expiresAt,
  };
}

export async function createInvitation(
  database: D1Database,
  identity: CominaviIdentity,
  planID: string,
  input: ReturnType<typeof parseInvitationCreate>,
  tokenSecret: string,
  nowMilliseconds = Date.now(),
): Promise<unknown> {
  await assertPlanMember(database, identity.userID, planID);
  const scope = `plans:${planID}:invitations:create`;
  const payloadHash = await payloadDigest(input);
  const replay = await createDatabase(database).get<{
    resource_id: string;
    payload_hash: string;
  }>(
    parameterizedSQL(
      `SELECT resource_id, payload_hash FROM shared_plan_requests
       WHERE user_id = ?1 AND scope = ?2 AND request_id = ?3`,
      [identity.userID, scope, input.requestID],
    ),
  );
  if (replay) {
    if (replay.payload_hash !== payloadHash) throw idempotencyConflict();
    throw new ServiceError(
      "invitation_token_already_returned",
      409,
      "This request already created an invitation; its token cannot be returned again.",
      { invitationID: replay.resource_id },
    );
  }
  const now = Math.floor(nowMilliseconds / 1_000);
  const expiresAt = input.expiresAt ?? now + 7 * 24 * 60 * 60;
  if (expiresAt <= now || expiresAt > now + 90 * 24 * 60 * 60) {
    throw invalidInvitation();
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = base64URL(crypto.getRandomValues(new Uint8Array(9)));
    const invitationID = crypto.randomUUID();
    const tokenHash = await invitationDigest(token, tokenSecret);
    try {
      const results = await runDrizzleBatch(database, [
        parameterizedSQL(
          `UPDATE shared_plans
             SET revision = revision + 1, updated_at = ?1,
                 last_mutation_scope = ?5,
                 last_mutation_request_id = ?6,
                 last_mutation_payload_hash = ?7
             WHERE id = ?2 AND revision = ?3 AND archived_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM users WHERE id = ?4 AND auth_version = ?8
                   AND deletion_pending_at IS NULL
               )
               AND EXISTS (
                 SELECT 1 FROM shared_plan_members
                 WHERE plan_id = ?2 AND user_id = ?4 AND revoked_at IS NULL
               )`,
          [
            now,
            planID,
            input.baseRevision,
            identity.userID,
            scope,
            input.requestID,
            payloadHash,
            identity.authVersion,
          ],
        ),
        parameterizedSQL(
          `INSERT INTO shared_plan_invitations (
               id, plan_id, token_hash, created_by_user_id,
               expires_at, revoked_at, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, NULL, ?6
             WHERE EXISTS (
               SELECT 1 FROM shared_plans WHERE id = ?2
                 AND last_mutation_scope = ?7
                 AND last_mutation_request_id = ?8
                 AND last_mutation_payload_hash = ?9
             )`,
          [
            invitationID,
            planID,
            tokenHash,
            identity.userID,
            expiresAt,
            now,
            scope,
            input.requestID,
            payloadHash,
          ],
        ),
        requestStatement(
          identity.userID,
          scope,
          input.requestID,
          "invite",
          payloadHash,
          planID,
          now,
          input.baseRevision + 1,
          invitationID,
        ),
      ]);
      if ((results[0]?.meta.changes ?? 0) !== 1) {
        const latest = await loadSharedPlan(database, identity, planID);
        throw revisionConflict(latest);
      }
      if (results.some((result) => (result.meta.changes ?? 0) !== 1)) continue;
      return {
        invitationID,
        token,
        expiresAt: new Date(expiresAt * 1_000).toISOString(),
        canonicalURL: `https://cominavi.net/join/${token}`,
        fallbackURL: `cominavi://join/${token}`,
        receipt: {
          requestId: input.requestID,
          replayed: false,
          resultRevision: input.baseRevision + 1,
          resultStatus: "active",
        },
      };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      // A random token collision is retried. A duplicate request is surfaced by
      // the replay check above and never re-exposes the original token.
    }
  }
  throw new ServiceError(
    "invitation_unavailable",
    503,
    "The invitation could not be created.",
  );
}

export async function listInvitations(
  database: D1Database,
  identity: CominaviIdentity,
  planID: string,
  page: CollectionPage = { limit: 50, cursor: null },
): Promise<CollectionPageResult<unknown>> {
  const cursor = decodeInvitationsCursor(page.cursor);
  const rows = await createDatabase(database).all<{
    id: string | null;
    expires_at: number | null;
    revoked_at: number | null;
    created_at: number | null;
    created_by_public_id: string | null;
    current_user_can_revoke: number | null;
    sentinel: number;
  }>(
    parameterizedSQL(
      `WITH authorized AS (
         SELECT role FROM shared_plan_members
         WHERE plan_id = ?1 AND user_id = ?2 AND revoked_at IS NULL
       ), page AS (
         SELECT invitation.id, invitation.expires_at,
                invitation.revoked_at, invitation.created_at,
                creator.public_id AS created_by_public_id,
                CASE WHEN authorized.role = 'owner'
                       OR invitation.created_by_user_id = ?2
                     THEN 1 ELSE 0 END AS current_user_can_revoke
         FROM shared_plan_invitations AS invitation
         JOIN users AS creator ON creator.id = invitation.created_by_user_id
         CROSS JOIN authorized
         WHERE invitation.plan_id = ?1
           AND (?3 = 0 OR invitation.created_at < ?4 OR
             (invitation.created_at = ?4 AND invitation.id > ?5))
         ORDER BY invitation.created_at DESC, invitation.id
         LIMIT ?6
       )
       SELECT page.*, CASE WHEN page.id IS NULL THEN 1 ELSE 0 END AS sentinel
       FROM authorized LEFT JOIN page ON 1 = 1
       ORDER BY sentinel, page.created_at DESC, page.id`,
      [
        planID,
        identity.userID,
        cursor ? 1 : 0,
        cursor?.createdAt ?? 0,
        cursor?.id ?? "",
        page.limit + 1,
      ],
    ),
  );
  if (rows.length === 0) throw planNotFound();
  const data = rows.filter(
    (
      row,
    ): row is typeof row & {
      id: string;
      expires_at: number;
      created_at: number;
      created_by_public_id: string;
      current_user_can_revoke: number;
    } =>
      row.sentinel === 0 &&
      row.id !== null &&
      row.created_by_public_id !== null &&
      row.current_user_can_revoke !== null,
  );
  const pageRows = data.slice(0, page.limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((row) => ({
      invitationID: row.id,
      createdByUserID: row.created_by_public_id,
      currentUserCanRevoke: row.current_user_can_revoke === 1,
      expiresAt: new Date(row.expires_at * 1_000).toISOString(),
      revokedAt:
        row.revoked_at === null
          ? null
          : new Date(row.revoked_at * 1_000).toISOString(),
      createdAt: new Date(row.created_at * 1_000).toISOString(),
    })),
    nextCursor:
      data.length > page.limit && last
        ? encodeCursor({
            v: 1,
            kind: "invitations",
            createdAt: last.created_at,
            id: last.id,
          })
        : null,
  };
}

export async function revokeInvitation(
  database: D1Database,
  identity: CominaviIdentity,
  planID: string,
  invitationID: string,
  input: ReturnType<typeof parseMembershipMutation>,
  nowMilliseconds = Date.now(),
): Promise<PlanMutationResult> {
  const scope = `plans:${planID}:invitations:${invitationID}:revoke`;
  const payloadHash = await payloadDigest(input);
  const replay = await loadRequestPlan(
    database,
    identity.userID,
    scope,
    input.requestID,
    payloadHash,
  );
  if (replay) return replayedMutationResult(replay, input.requestID);
  await assertPlanMember(database, identity.userID, planID);
  const now = Math.floor(nowMilliseconds / 1_000);
  const results = await runDrizzleBatch(database, [
    parameterizedSQL(
      `UPDATE shared_plans
         SET revision = revision + 1, updated_at = ?1,
             last_mutation_scope = ?6,
             last_mutation_request_id = ?7,
             last_mutation_payload_hash = ?8
         WHERE id = ?3 AND revision = ?5
           AND EXISTS (
             SELECT 1 FROM users WHERE id = ?4 AND auth_version = ?9
               AND deletion_pending_at IS NULL
           )
           AND EXISTS (
             SELECT 1
             FROM shared_plan_invitations AS invitation
             JOIN shared_plan_members AS caller ON caller.plan_id = invitation.plan_id
             WHERE invitation.id = ?2 AND invitation.plan_id = ?3
               AND invitation.revoked_at IS NULL
               AND caller.user_id = ?4 AND caller.revoked_at IS NULL
               AND (caller.role = 'owner' OR invitation.created_by_user_id = ?4)
           )`,
      [
        now,
        invitationID,
        planID,
        identity.userID,
        input.baseRevision,
        scope,
        input.requestID,
        payloadHash,
        identity.authVersion,
      ],
    ),
    parameterizedSQL(
      `UPDATE shared_plan_invitations SET revoked_at = ?1
         WHERE id = ?2 AND plan_id = ?3 AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM shared_plans WHERE id = ?3
               AND last_mutation_scope = ?4
               AND last_mutation_request_id = ?5
               AND last_mutation_payload_hash = ?6
           )`,
      [now, invitationID, planID, scope, input.requestID, payloadHash],
    ),
    requestStatement(
      identity.userID,
      scope,
      input.requestID,
      "revoke_invite",
      payloadHash,
      planID,
      now,
      input.baseRevision + 1,
    ),
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    const latest = await loadSharedPlan(database, identity, planID);
    throw revisionConflict(latest);
  }
  return mutationResult(
    await loadSharedPlan(database, identity, planID),
    input.requestID,
    false,
  );
}

export async function previewInvitation(
  database: D1Database,
  token: string,
  tokenSecret: string,
  nowMilliseconds = Date.now(),
): Promise<{
  planID: string;
  planName: string;
  comiketNo: number;
  expiresAt: string;
  inviter: {
    userID: string;
    displayName: string;
    avatarURL: string | null;
  };
}> {
  const row = await findValidInvitation(
    database,
    token,
    tokenSecret,
    nowMilliseconds,
  );
  if (!row) throw invitationNotFound();
  return {
    planID: row.plan_id,
    planName: row.plan_name,
    comiketNo: row.comiket_no,
    expiresAt: new Date(row.expires_at * 1_000).toISOString(),
    inviter: {
      userID: row.created_by_public_id,
      displayName: row.created_by_display_name,
      avatarURL: row.created_by_avatar_object_key
        ? `/join/${token}/avatar`
        : null,
    },
  };
}

export async function loadInvitationInviterAvatar(
  database: D1Database,
  bucket: R2Bucket,
  token: string,
  tokenSecret: string,
  nowMilliseconds = Date.now(),
): Promise<Response> {
  const row = await findValidInvitation(
    database,
    token,
    tokenSecret,
    nowMilliseconds,
  );
  if (
    !row?.created_by_avatar_object_key ||
    !row.created_by_avatar_content_type
  ) {
    throw invitationNotFound();
  }
  const object = await bucket.get(row.created_by_avatar_object_key);
  if (!object) throw invitationNotFound();
  return new Response(object.body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": String(object.size),
      "Content-Type": row.created_by_avatar_content_type,
      ETag: object.httpEtag,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

export async function acceptInvitation(
  database: D1Database,
  identity: CominaviIdentity,
  token: string,
  requestID: string,
  tokenSecret: string,
  nowMilliseconds = Date.now(),
): Promise<unknown> {
  const parsedRequestID = parseRequestID(requestID);
  if (!/^[A-Za-z0-9_-]{12}$/.test(token)) throw invitationNotFound();
  const tokenHash = await invitationDigest(token, tokenSecret);
  const scope = `invitations:${tokenHash}:accept`;
  const payloadHash = await payloadDigest({});
  const replay = await loadRequestPlan(
    database,
    identity.userID,
    scope,
    parsedRequestID,
    payloadHash,
  );
  if (replay) {
    return replayedMutationResult(replay, parsedRequestID);
  }
  const invitation = await findValidInvitation(
    database,
    token,
    tokenSecret,
    nowMilliseconds,
  );
  if (!invitation) throw invitationNotFound();
  const blocked = await createDatabase(database).get<{ blocked: number }>(
    parameterizedSQL(
      `SELECT 1 AS blocked
       FROM shared_plan_members AS member
       WHERE member.plan_id = ?1 AND member.user_id = ?2
         AND member.revoked_at IS NOT NULL`,
      [invitation.plan_id, identity.userID],
    ),
  );
  if (blocked) {
    throw new ServiceError(
      "plan_membership_revoked",
      403,
      "Only the plan owner can reinstate this removed member.",
    );
  }
  const now = Math.floor(nowMilliseconds / 1_000);
  const results = await runDrizzleBatch(database, [
    parameterizedSQL(
      `INSERT INTO shared_plan_members (
           plan_id, user_id, role, joined_at, revoked_at, updated_at
         )
         SELECT invitation.plan_id, ?2, 'editor', ?3, NULL, ?3
         FROM shared_plan_invitations AS invitation
         JOIN shared_plans AS plan ON plan.id = invitation.plan_id
         WHERE invitation.token_hash = ?1 AND invitation.revoked_at IS NULL
           AND invitation.expires_at > ?3 AND plan.archived_at IS NULL
           AND EXISTS (
             SELECT 1 FROM users WHERE id = ?2 AND auth_version = ?4
               AND deletion_pending_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM shared_plan_members AS blocked
             WHERE blocked.plan_id = invitation.plan_id AND blocked.user_id = ?2
               AND blocked.revoked_at IS NOT NULL
           )
           AND (
             EXISTS (
               SELECT 1 FROM shared_plan_members AS current
               WHERE current.plan_id = invitation.plan_id
                 AND current.user_id = ?2 AND current.revoked_at IS NULL
             ) OR (
               SELECT count(*) FROM shared_plan_members AS active
               WHERE active.plan_id = invitation.plan_id
                 AND active.revoked_at IS NULL
             ) < ${maximumActivePlanMembers}
           )
         ON CONFLICT(plan_id, user_id) DO UPDATE SET
           updated_at = shared_plan_members.updated_at
         WHERE shared_plan_members.revoked_at IS NULL`,
      [tokenHash, identity.userID, now, identity.authVersion],
    ),
    parameterizedSQL(
      `INSERT INTO shared_plan_requests (
           user_id, scope, request_id, operation, payload_hash,
           resource_id, result_revision, result_status, created_at
         )
         SELECT ?1, ?2, ?3, 'accept_invite', ?4, invitation.plan_id,
                plan.revision,
                CASE WHEN plan.archived_at IS NULL THEN 'active' ELSE 'archived' END,
                ?5
         FROM shared_plan_invitations AS invitation
         JOIN shared_plans AS plan ON plan.id = invitation.plan_id
         WHERE invitation.token_hash = ?6 AND invitation.revoked_at IS NULL
           AND invitation.expires_at > ?5 AND plan.archived_at IS NULL
           AND EXISTS (
             SELECT 1 FROM users WHERE id = ?1 AND auth_version = ?7
               AND deletion_pending_at IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM shared_plan_members
             WHERE plan_id = invitation.plan_id AND user_id = ?1
               AND revoked_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM shared_plan_members AS blocked
             WHERE blocked.plan_id = invitation.plan_id AND blocked.user_id = ?1
               AND blocked.revoked_at IS NOT NULL
           )`,
      [
        identity.userID,
        scope,
        parsedRequestID,
        payloadHash,
        now,
        tokenHash,
        identity.authVersion,
      ],
    ),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1) {
    const raced = await loadRequestPlan(
      database,
      identity.userID,
      scope,
      parsedRequestID,
      payloadHash,
    );
    if (!raced) {
      const active = await createDatabase(database).get<{ count: number }>(
        parameterizedSQL(
          `SELECT count(*) AS count FROM shared_plan_members
           WHERE plan_id = ?1 AND revoked_at IS NULL`,
          [invitation.plan_id],
        ),
      );
      if ((active?.count ?? 0) >= maximumActivePlanMembers) {
        throw memberLimit();
      }
      throw invitationNotFound();
    }
    return replayedMutationResult(raced, parsedRequestID);
  }
  return mutationResult(
    await loadSharedPlan(database, identity, invitation.plan_id),
    parsedRequestID,
    false,
  );
}

export async function isValidInvitationToken(
  database: D1Database,
  token: string,
  tokenSecret: string,
  nowMilliseconds = Date.now(),
): Promise<boolean> {
  return (
    (await findValidInvitation(
      database,
      token,
      tokenSecret,
      nowMilliseconds,
    )) !== null
  );
}

async function findValidInvitation(
  database: D1Database,
  token: string,
  tokenSecret: string,
  nowMilliseconds: number,
): Promise<InvitationRow | null> {
  if (!/^[A-Za-z0-9_-]{12}$/.test(token)) return null;
  const tokenHash = await invitationDigest(token, tokenSecret);
  return createDatabase(database).get<InvitationRow>(
    parameterizedSQL(
      `SELECT invitation.id, invitation.plan_id,
              invitation.expires_at, invitation.revoked_at,
              invitation.created_at, plan.name AS plan_name, plan.comiket_no,
              creator.public_id AS created_by_public_id,
              creator.display_name AS created_by_display_name,
              creator.avatar_object_key AS created_by_avatar_object_key,
              creator.avatar_content_type AS created_by_avatar_content_type
       FROM shared_plan_invitations AS invitation
       JOIN shared_plans AS plan ON plan.id = invitation.plan_id
       JOIN users AS creator ON creator.id = invitation.created_by_user_id
       WHERE invitation.token_hash = ?1 AND invitation.revoked_at IS NULL
         AND invitation.expires_at > ?2 AND plan.archived_at IS NULL
         AND creator.deletion_pending_at IS NULL`,
      [tokenHash, Math.floor(nowMilliseconds / 1_000)],
    ),
  );
}

async function invitationDigest(
  token: string,
  secret: string,
): Promise<string> {
  if (secret.length < 32) {
    throw new ServiceError(
      "invitation_unavailable",
      503,
      "Invitation verification is not configured.",
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function loadPlanRow(
  database: D1Database,
  userID: number,
  planID: string,
): Promise<PlanRow | null> {
  return createDatabase(database).get<PlanRow>(
    parameterizedSQL(
      `SELECT plan.id, plan.name, plan.comiket_no, plan.owner_user_id,
              owner.public_id AS owner_public_id,
              member.role, plan.archived_at, plan.revision,
              plan.created_at, plan.updated_at
       FROM shared_plans AS plan
       JOIN shared_plan_members AS member ON member.plan_id = plan.id
       JOIN users AS owner ON owner.id = plan.owner_user_id
       WHERE plan.id = ?1 AND member.user_id = ?2
         AND member.revoked_at IS NULL`,
      [planID, userID],
    ),
  );
}

async function loadRequestPlan(
  database: D1Database,
  userID: number,
  scope: string,
  requestID: string,
  payloadHash: string,
): Promise<PlanReceiptReplay | null> {
  const receipt = await createDatabase(database).get<{ payload_hash: string }>(
    parameterizedSQL(
      `SELECT payload_hash FROM shared_plan_requests
       WHERE user_id = ?1 AND scope = ?2 AND request_id = ?3`,
      [userID, scope, requestID],
    ),
  );
  if (!receipt) return null;
  if (receipt.payload_hash !== payloadHash) throw idempotencyConflict();
  const row = await createDatabase(database).get<
    PlanRow & {
      result_revision: number | null;
      result_status: "active" | "archived" | null;
    }
  >(
    parameterizedSQL(
      `SELECT plan.id, plan.name, plan.comiket_no, plan.owner_user_id,
              owner.public_id AS owner_public_id,
              member.role, plan.archived_at, plan.revision,
              plan.created_at, plan.updated_at,
              request.result_revision, request.result_status
       FROM shared_plan_requests AS request
       JOIN shared_plans AS plan ON plan.id = request.resource_id
       JOIN shared_plan_members AS member
         ON member.plan_id = plan.id AND member.user_id = request.user_id
       JOIN users AS owner ON owner.id = plan.owner_user_id
       WHERE request.user_id = ?1 AND request.scope = ?2
         AND request.request_id = ?3 AND member.revoked_at IS NULL`,
      [userID, scope, requestID],
    ),
  );
  if (!row) return null;
  return {
    plan: serializePlan(row),
    resultRevision: row.result_revision ?? row.revision,
    resultStatus:
      row.result_status ?? (row.archived_at === null ? "active" : "archived"),
  };
}

function allocateSlotStatement(
  ownerUserID: number,
  comiketNo: number,
  planID: string,
  marker?: { scope: string; requestID: string; payloadHash: string },
): SQLWrapper {
  return parameterizedSQL(
    `INSERT INTO owned_plan_slots (owner_user_id, comiket_no, slot, plan_id)
       SELECT ?1, ?2, slots.slot, ?3
       FROM (
         WITH RECURSIVE generated(slot) AS (
           VALUES(0) UNION ALL SELECT slot + 1 FROM generated WHERE slot < 49
         ) SELECT slot FROM generated
       ) AS slots
       WHERE NOT EXISTS (
         SELECT 1 FROM owned_plan_slots AS used
         WHERE used.owner_user_id = ?1 AND used.comiket_no = ?2
           AND used.slot = slots.slot
       )
       AND (
         ?4 IS NULL OR EXISTS (
           SELECT 1 FROM shared_plans
           WHERE id = ?3 AND last_mutation_scope = ?4
             AND last_mutation_request_id = ?5
             AND last_mutation_payload_hash = ?6
         )
       )
       ORDER BY slots.slot LIMIT 1`,
    [
      ownerUserID,
      comiketNo,
      planID,
      marker?.scope ?? null,
      marker?.requestID ?? null,
      marker?.payloadHash ?? null,
    ],
  );
}

function requestStatement(
  userID: number,
  scope: string,
  requestID: string,
  operation: string,
  payloadHash: string,
  planID: string,
  now: number,
  expectedRevision: number,
  resourceID = planID,
): SQLWrapper {
  return parameterizedSQL(
    `INSERT INTO shared_plan_requests (
         user_id, scope, request_id, operation, payload_hash,
         resource_id, result_revision, result_status, created_at
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?9, plan.revision,
              CASE WHEN plan.archived_at IS NULL THEN 'active' ELSE 'archived' END,
              ?7
       FROM shared_plans AS plan
       WHERE plan.id = ?6 AND plan.revision = ?8
         AND plan.last_mutation_scope = ?2
         AND plan.last_mutation_request_id = ?3
         AND plan.last_mutation_payload_hash = ?5`,
    [
      userID,
      scope,
      requestID,
      operation,
      payloadHash,
      planID,
      now,
      expectedRevision,
      resourceID,
    ],
  );
}

async function payloadDigest(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(value));
}

type PlansCursor = {
  archived: 0 | 1;
  updatedAt: number;
  id: string;
};

type MembersCursor = {
  roleRank: 0 | 1;
  joinedAt: number;
  publicID: string;
};

type InvitationsCursor = { createdAt: number; id: string };

function encodeCursor(value: Record<string, unknown>): string {
  return base64URL(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeCursor(value: string | null): unknown {
  if (value === null) return null;
  if (value.length < 1 || value.length > 512) throw invalidPagination();
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64URL(value)));
  } catch {
    throw invalidPagination();
  }
}

function decodePlansCursor(value: string | null): PlansCursor | null {
  const cursor = decodeCursor(value);
  if (cursor === null) return null;
  if (
    !isRecord(cursor) ||
    cursor.v !== 1 ||
    cursor.kind !== "plans" ||
    (cursor.archived !== 0 && cursor.archived !== 1) ||
    !Number.isSafeInteger(cursor.updatedAt) ||
    typeof cursor.id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(cursor.id)
  ) {
    throw invalidPagination();
  }
  return {
    archived: cursor.archived,
    updatedAt: Number(cursor.updatedAt),
    id: cursor.id,
  };
}

function decodeMembersCursor(value: string | null): MembersCursor | null {
  const cursor = decodeCursor(value);
  if (cursor === null) return null;
  if (
    !isRecord(cursor) ||
    cursor.v !== 1 ||
    cursor.kind !== "members" ||
    (cursor.roleRank !== 0 && cursor.roleRank !== 1) ||
    !Number.isSafeInteger(cursor.joinedAt) ||
    typeof cursor.publicID !== "string" ||
    !/^[0-9a-f]{32}$/.test(cursor.publicID)
  ) {
    throw invalidPagination();
  }
  return {
    roleRank: cursor.roleRank,
    joinedAt: Number(cursor.joinedAt),
    publicID: cursor.publicID,
  };
}

function decodeInvitationsCursor(
  value: string | null,
): InvitationsCursor | null {
  const cursor = decodeCursor(value);
  if (cursor === null) return null;
  if (
    !isRecord(cursor) ||
    cursor.v !== 1 ||
    cursor.kind !== "invitations" ||
    !Number.isSafeInteger(cursor.createdAt) ||
    typeof cursor.id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(cursor.id)
  ) {
    throw invalidPagination();
  }
  return { createdAt: Number(cursor.createdAt), id: cursor.id };
}

function idempotencyConflict(): ServiceError {
  return new ServiceError(
    "idempotency_conflict",
    409,
    "This requestId was already used with a different payload in this scope.",
  );
}

function serializePlan(row: PlanRow): SharedPlan {
  return {
    id: row.id,
    name: row.name,
    comiketNo: row.comiket_no,
    role: row.role,
    status: row.archived_at === null ? "active" : "archived",
    revision: row.revision,
    createdAt: new Date(row.created_at * 1_000).toISOString(),
    updatedAt: new Date(row.updated_at * 1_000).toISOString(),
  };
}

function mutationResult(
  plan: SharedPlan,
  requestID: string,
  replayed: boolean,
): PlanMutationResult {
  return {
    plan,
    receipt: {
      requestId: requestID,
      replayed,
      resultRevision: plan.revision,
      resultStatus: plan.status,
    },
  };
}

function replayedMutationResult(
  replay: PlanReceiptReplay,
  requestID: string,
): PlanMutationResult {
  return {
    plan: replay.plan,
    receipt: {
      requestId: requestID,
      replayed: true,
      resultRevision: replay.resultRevision,
      resultStatus: replay.resultStatus,
    },
  };
}

function parseRequestID(value: unknown): string {
  return parseCanonicalRequestID(value);
}

function parsePlanName(value: unknown): string {
  if (typeof value !== "string") throw invalidPlan();
  const name = value.trim();
  const scalarCount = Array.from(name).length;
  if (scalarCount < 1 || scalarCount > 100) throw invalidPlan();
  return name;
}

function parseComiketNo(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > 10_000
  ) {
    throw invalidPlan();
  }
  return Number(value);
}

function invalidPlan(): ServiceError {
  return new ServiceError(
    "invalid_plan",
    400,
    "The Shared Plan request is invalid.",
  );
}

function invalidPagination(): ServiceError {
  return new ServiceError(
    "invalid_pagination",
    400,
    "Pagination limit must be between 1 and 100 and cursor must be valid.",
  );
}

function invalidInvitation(): ServiceError {
  return new ServiceError(
    "invalid_invitation",
    400,
    "The invitation request is invalid.",
  );
}

function invitationNotFound(): ServiceError {
  return new ServiceError(
    "invitation_unavailable",
    404,
    "This invitation is invalid or no longer available.",
  );
}

function planNotFound(): ServiceError {
  return new ServiceError(
    "plan_not_found",
    404,
    "The Shared Plan was not found.",
  );
}

function ownerRequired(): ServiceError {
  return new ServiceError(
    "plan_owner_required",
    403,
    "Only the plan owner can perform this action.",
  );
}

function memberLimit(): ServiceError {
  return new ServiceError(
    "member_limit",
    409,
    `A Shared Plan can have at most ${maximumActivePlanMembers} active members.`,
  );
}

function revisionConflict(currentPlan: SharedPlan): ServiceError {
  return new ServiceError(
    "plan_revision_conflict",
    409,
    "The Shared Plan changed on another device.",
    { currentRevision: currentPlan.revision, currentPlan },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
