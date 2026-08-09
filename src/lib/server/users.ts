import {
  AuthenticationError,
  type CirclemsIdentity,
  type CominaviIdentity,
} from "./cominavi-auth";

interface UserRow {
  id: number;
  auth_version: number;
}

export async function upsertAuthenticatedUser(
  database: D1Database,
  identity: CirclemsIdentity,
  nowMilliseconds = Date.now(),
): Promise<CominaviIdentity> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const row = await database
    .prepare(
      `INSERT INTO users (
         subject, circlems_environment, circlems_user_id, nickname,
         created_at, updated_at, last_authenticated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5)
       ON CONFLICT(circlems_environment, circlems_user_id) DO UPDATE SET
         subject = excluded.subject,
         nickname = excluded.nickname,
         updated_at = excluded.updated_at,
         last_authenticated_at = excluded.last_authenticated_at
       RETURNING id, auth_version`,
    )
    .bind(
      identity.subject,
      identity.circlemsEnvironment,
      identity.circlemsUserID,
      identity.nickname ?? null,
      now,
    )
    .first<UserRow>();

  if (
    !row ||
    !Number.isSafeInteger(row.id) ||
    row.id <= 0 ||
    !Number.isSafeInteger(row.auth_version) ||
    row.auth_version <= 0
  ) {
    throw new AuthenticationError(
      "user_upsert_failed",
      503,
      "The ComiNavi user account could not be prepared.",
    );
  }

  return {
    ...identity,
    userID: row.id,
    authVersion: row.auth_version,
  };
}

export async function assertCurrentAuthVersion(
  database: D1Database,
  identity: CominaviIdentity,
): Promise<void> {
  const current = await database
    .prepare(
      `SELECT auth_version
       FROM users
       WHERE id = ?1 AND subject = ?2`,
    )
    .bind(identity.userID, identity.subject)
    .first<{ auth_version: number }>();
  if (!current || current.auth_version !== identity.authVersion) {
    throw new AuthenticationError(
      "invalid_token",
      401,
      "The ComiNavi session is no longer valid.",
    );
  }
}

export async function revokeAuthenticatedSessions(
  database: D1Database,
  identity: CominaviIdentity,
  nowMilliseconds = Date.now(),
): Promise<void> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const row = await database
    .prepare(
      `UPDATE users
       SET auth_version = auth_version + 1, updated_at = ?1
       WHERE id = ?2 AND subject = ?3 AND auth_version = ?4
       RETURNING auth_version`,
    )
    .bind(now, identity.userID, identity.subject, identity.authVersion)
    .first<{ auth_version: number }>();
  if (!row) {
    throw new AuthenticationError(
      "invalid_token",
      401,
      "The ComiNavi session is no longer valid.",
    );
  }
}
