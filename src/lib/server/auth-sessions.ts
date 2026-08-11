import { and, eq, exists, gt, inArray, isNull, sql } from "drizzle-orm";
import { createDatabase } from "../db/client";
import { runDrizzleBatch } from "../db/batch";
import {
  authLogoutReceipts,
  authRefreshTokens,
  notificationDeliveries,
  pushDevices,
  sharedPlanNotificationDeliveries,
  users,
} from "../db/schema";
import { AuthenticationError, issueCominaviJWT } from "./cominavi-auth";
import { loadUserProfile } from "./users";
import type { CominaviIdentity } from "./cominavi-auth";
import type { CominaviTokenIdentity } from "./cominavi-auth";
import { parseCanonicalRequestID } from "./request-id";
import { ServiceError } from "./service-error";

const refreshLifetimeSeconds = 30 * 24 * 60 * 60;

export interface SessionResponse {
  tokenType: "Bearer";
  authVersion: number;
  accessToken: string;
  expiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  user: Awaited<ReturnType<typeof loadUserProfile>>;
}

export interface LogoutReceipt {
  requestId: string;
  replayed: boolean;
  authVersion: number;
}

export interface LogoutRequest {
  requestID: string;
  refreshToken: string;
}

export interface PreparedSession {
  response: SessionResponse;
  tokenHash: string;
  familyID: string;
  authVersion: number;
  refreshExpiresAt: number;
  createdAt: number;
}

export async function createSession(
  database: D1Database,
  identity: CominaviIdentity,
  jwtSecret: string,
  nowMilliseconds = Date.now(),
): Promise<SessionResponse> {
  const prepared = await prepareSession(
    database,
    identity,
    jwtSecret,
    nowMilliseconds,
  );
  await insertPreparedSessionStatement(database, identity, prepared).run();
  return prepared.response;
}

export async function prepareSession(
  database: D1Database,
  identity: CominaviIdentity,
  jwtSecret: string,
  nowMilliseconds = Date.now(),
): Promise<PreparedSession> {
  return prepareSessionForUser(
    identity,
    await loadUserProfile(database, identity.userID),
    jwtSecret,
    nowMilliseconds,
  );
}

export async function prepareSessionForUser(
  identity: CominaviIdentity,
  user: Awaited<ReturnType<typeof loadUserProfile>>,
  jwtSecret: string,
  nowMilliseconds = Date.now(),
): Promise<PreparedSession> {
  const createdAt = Math.floor(nowMilliseconds / 1_000);
  const refreshToken = randomToken(32);
  const tokenHash = await sha256Hex(refreshToken);
  const familyID = crypto.randomUUID();
  const refreshExpiresAt = createdAt + refreshLifetimeSeconds;
  const access = await issueCominaviJWT(identity, jwtSecret, nowMilliseconds);
  return {
    response: {
      tokenType: "Bearer",
      authVersion: identity.authVersion,
      accessToken: access.token,
      expiresAt: access.expiresAt,
      refreshToken,
      refreshExpiresAt: new Date(refreshExpiresAt * 1_000).toISOString(),
      user,
    },
    tokenHash,
    familyID,
    authVersion: identity.authVersion,
    refreshExpiresAt,
    createdAt,
  };
}

export function insertPreparedSessionStatement(
  database: D1Database,
  identity: CominaviIdentity,
  prepared: PreparedSession,
) {
  return createDatabase(database).insert(authRefreshTokens).values({
    tokenHash: prepared.tokenHash,
    userID: identity.userID,
    familyID: prepared.familyID,
    authVersion: prepared.authVersion,
    expiresAt: prepared.refreshExpiresAt,
    consumedAt: null,
    replacedByHash: null,
    createdAt: prepared.createdAt,
  });
}

export async function rotateSession(
  database: D1Database,
  refreshToken: string,
  jwtSecret: string,
  nowMilliseconds = Date.now(),
): Promise<SessionResponse> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(refreshToken)) throw invalidRefreshToken();
  const now = Math.floor(nowMilliseconds / 1_000);
  const oldHash = await sha256Hex(refreshToken);
  const db = createDatabase(database);
  const existing = await db
    .select({
      userID: authRefreshTokens.userID,
      publicID: users.publicID,
      authVersion: sql<number>`${users.authVersion}`.as("current_auth_version"),
      familyID: authRefreshTokens.familyID,
      issuedAuthVersion: sql<number>`${authRefreshTokens.authVersion}`.as(
        "issued_auth_version",
      ),
      expiresAt: authRefreshTokens.expiresAt,
      consumedAt: authRefreshTokens.consumedAt,
    })
    .from(authRefreshTokens)
    .innerJoin(users, eq(users.id, authRefreshTokens.userID))
    .where(eq(authRefreshTokens.tokenHash, oldHash))
    .get();
  if (!existing || existing.expiresAt <= now) {
    throw invalidRefreshToken();
  }
  if (
    existing.consumedAt !== null ||
    existing.issuedAuthVersion !== existing.authVersion
  ) {
    await db
      .update(authRefreshTokens)
      .set({
        consumedAt: sql`coalesce(${authRefreshTokens.consumedAt}, ${now})`,
      })
      .where(eq(authRefreshTokens.familyID, existing.familyID))
      .run();
    throw invalidRefreshToken();
  }

  const nextToken = randomToken(32);
  const nextHash = await sha256Hex(nextToken);
  const nextExpiresAt = now + refreshLifetimeSeconds;
  const successor = db
    .select({
      tokenHash: sql<string>`${nextHash}`.as("token_hash"),
      userID: authRefreshTokens.userID,
      familyID: authRefreshTokens.familyID,
      authVersion: authRefreshTokens.authVersion,
      expiresAt: sql<number>`${nextExpiresAt}`.as("expires_at"),
      consumedAt: sql<null>`NULL`.as("consumed_at"),
      replacedByHash: sql<null>`NULL`.as("replaced_by_hash"),
      createdAt: sql<number>`${now}`.as("created_at"),
    })
    .from(authRefreshTokens)
    .where(
      and(
        eq(authRefreshTokens.tokenHash, oldHash),
        eq(authRefreshTokens.consumedAt, now),
        eq(authRefreshTokens.replacedByHash, nextHash),
      ),
    );
  const results = await db.batch([
    db
      .update(authRefreshTokens)
      .set({ consumedAt: now, replacedByHash: nextHash })
      .where(
        and(
          eq(authRefreshTokens.tokenHash, oldHash),
          isNull(authRefreshTokens.consumedAt),
          gt(authRefreshTokens.expiresAt, now),
        ),
      ),
    db.insert(authRefreshTokens).select(successor),
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    await db
      .update(authRefreshTokens)
      .set({
        consumedAt: sql`coalesce(${authRefreshTokens.consumedAt}, ${now})`,
      })
      .where(eq(authRefreshTokens.familyID, existing.familyID))
      .run();
    throw invalidRefreshToken();
  }

  return buildSessionResponse(
    database,
    {
      subject: existing.publicID,
      userID: existing.userID,
      authVersion: existing.authVersion,
    },
    jwtSecret,
    nextToken,
    nextExpiresAt,
    nowMilliseconds,
  );
}

async function buildSessionResponse(
  database: D1Database,
  identity: CominaviIdentity,
  jwtSecret: string,
  refreshToken: string,
  refreshExpiresAt: number,
  nowMilliseconds: number,
): Promise<SessionResponse> {
  const [access, user] = await Promise.all([
    issueCominaviJWT(identity, jwtSecret, nowMilliseconds),
    loadUserProfile(database, identity.userID),
  ]);
  return {
    tokenType: "Bearer",
    authVersion: identity.authVersion,
    accessToken: access.token,
    expiresAt: access.expiresAt,
    refreshToken,
    refreshExpiresAt: new Date(refreshExpiresAt * 1_000).toISOString(),
    user,
  };
}

export function parseLogoutRequest(value: unknown): LogoutRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("requestId" in value) ||
    !("refreshToken" in value) ||
    typeof value.refreshToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.refreshToken)
  ) {
    throw new ServiceError(
      "invalid_logout_request",
      400,
      "requestId and the current refresh token are required.",
    );
  }
  return {
    requestID: parseCanonicalRequestID(value.requestId),
    refreshToken: value.refreshToken,
  };
}

/**
 * Advances the account epoch once and consumes every refresh family. The
 * predecessor access JWT is only a signed subject/epoch binding here; a new
 * logout additionally requires either an unexpired access JWT or the exact
 * still-live refresh token. Receipt replay is checked first and grants no
 * access authority.
 */
export async function logoutSession(
  database: D1Database,
  tokenIdentity: CominaviTokenIdentity,
  input: LogoutRequest,
  receiptKey: string,
  accessTokenIsLive: boolean,
  nowMilliseconds = Date.now(),
): Promise<{ receipt: LogoutReceipt }> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const refreshHash = await sha256Hex(input.refreshToken);
  const payloadHash = await sha256Hex(
    JSON.stringify({ v: 1, refreshTokenHash: refreshHash }),
  );
  const subjectDigest = await keyedLogoutSubjectDigest(
    tokenIdentity.subject,
    receiptKey,
  );
  const replay = await loadLogoutReceipt(
    database,
    tokenIdentity,
    input.requestID,
    payloadHash,
    subjectDigest,
  );
  if (replay) return { receipt: replay };

  const db = createDatabase(database);
  const liveRefresh = db
    .select({ value: sql`1` })
    .from(authRefreshTokens)
    .where(
      and(
        eq(authRefreshTokens.tokenHash, refreshHash),
        eq(authRefreshTokens.userID, users.id),
        eq(authRefreshTokens.authVersion, tokenIdentity.authVersion),
        isNull(authRefreshTokens.consumedAt),
        gt(authRefreshTokens.expiresAt, now),
      ),
    );
  const authority = await db
    .select({
      id: users.id,
      authVersion: users.authVersion,
      refreshIsLive: sql<number>`cast(${exists(liveRefresh)} as integer)`,
    })
    .from(users)
    .where(
      and(
        eq(users.publicID, tokenIdentity.subject),
        eq(users.authVersion, tokenIdentity.authVersion),
        isNull(users.deletionPendingAt),
      ),
    )
    .get();
  if (!authority || (!accessTokenIsLive && authority.refreshIsLive !== 1)) {
    throw invalidLogoutCredentials();
  }

  const resultAuthVersion = tokenIdentity.authVersion + 1;
  const committedFence = db
    .select({ value: sql`1` })
    .from(users)
    .where(
      and(
        eq(users.id, authority.id),
        eq(users.authVersion, resultAuthVersion),
        eq(users.lastAuthFenceRequestID, input.requestID),
        eq(users.lastAuthFencePayloadHash, payloadHash),
      ),
    );
  const receiptSource = db
    .select({
      requestID: sql<string>`${input.requestID}`.as("request_id"),
      payloadHash: sql<string>`${payloadHash}`.as("payload_hash"),
      subjectDigest: sql<string>`${subjectDigest}`.as("subject_digest"),
      originalAuthVersion: sql<number>`${tokenIdentity.authVersion}`.as(
        "original_auth_version",
      ),
      resultAuthVersion: sql<number>`${resultAuthVersion}`.as(
        "result_auth_version",
      ),
      refreshTokenHash: sql<string>`${refreshHash}`.as("refresh_token_hash"),
      createdAt: sql<number>`${now}`.as("created_at"),
    })
    .from(users)
    .where(
      and(
        eq(users.id, authority.id),
        eq(users.publicID, tokenIdentity.subject),
        eq(users.authVersion, resultAuthVersion),
        eq(users.lastAuthFenceRequestID, input.requestID),
        eq(users.lastAuthFencePayloadHash, payloadHash),
      ),
    );
  await runDrizzleBatch(database, [
    db
      .update(users)
      .set({
        authVersion: resultAuthVersion,
        lastAuthFencedAt: now,
        lastAuthFenceRequestID: input.requestID,
        lastAuthFencePayloadHash: payloadHash,
        updatedAt: now,
      })
      .where(
        and(
          eq(users.id, authority.id),
          eq(users.publicID, tokenIdentity.subject),
          eq(users.authVersion, tokenIdentity.authVersion),
          isNull(users.deletionPendingAt),
        ),
      ),
    db
      .update(authRefreshTokens)
      .set({
        consumedAt: sql`coalesce(${authRefreshTokens.consumedAt}, ${now})`,
      })
      .where(
        and(eq(authRefreshTokens.userID, authority.id), exists(committedFence)),
      ),
    db
      .update(pushDevices)
      .set({ enabled: 0, invalidatedAt: now, updatedAt: now })
      .where(and(eq(pushDevices.userID, authority.id), exists(committedFence))),
    db
      .update(notificationDeliveries)
      .set({
        status: "suppressed",
        leaseExpiresAt: null,
        lastError: "account_logged_out",
        updatedAt: now,
      })
      .where(
        and(
          eq(notificationDeliveries.userID, authority.id),
          inArray(notificationDeliveries.status, [
            "pending",
            "processing",
            "retry",
          ]),
          exists(committedFence),
        ),
      ),
    db
      .update(sharedPlanNotificationDeliveries)
      .set({
        status: "suppressed",
        leaseExpiresAt: null,
        lastError: "account_logged_out",
        updatedAt: now,
      })
      .where(
        and(
          eq(sharedPlanNotificationDeliveries.userID, authority.id),
          inArray(sharedPlanNotificationDeliveries.status, [
            "pending",
            "processing",
            "retry",
          ]),
          exists(committedFence),
        ),
      ),
    db.insert(authLogoutReceipts).select(receiptSource).onConflictDoNothing(),
    sql`INSERT OR IGNORE INTO auth_logout_atomic_assertions (
           request_id, committed, created_at
         ) VALUES (
           ${input.requestID},
           CASE WHEN EXISTS (
             SELECT 1 FROM auth_logout_receipts AS receipt
             WHERE receipt.request_id = ${input.requestID}
               AND receipt.payload_hash = ${payloadHash}
               AND receipt.original_auth_version = ${tokenIdentity.authVersion}
               AND receipt.result_auth_version = ${resultAuthVersion}
               AND receipt.subject_digest = ${subjectDigest}
           ) THEN 1 ELSE 0 END,
           ${now}
         )`,
  ]);

  const committed = await loadLogoutReceipt(
    database,
    tokenIdentity,
    input.requestID,
    payloadHash,
    subjectDigest,
  );
  if (!committed) throw invalidLogoutCredentials();
  return { receipt: { ...committed, replayed: false } };
}

async function loadLogoutReceipt(
  database: D1Database,
  identity: CominaviTokenIdentity,
  requestID: string,
  payloadHash: string,
  subjectDigest: string,
): Promise<LogoutReceipt | null> {
  const row = await createDatabase(database)
    .select({
      payloadHash: authLogoutReceipts.payloadHash,
      subjectDigest: authLogoutReceipts.subjectDigest,
      originalAuthVersion: authLogoutReceipts.originalAuthVersion,
      resultAuthVersion: authLogoutReceipts.resultAuthVersion,
    })
    .from(authLogoutReceipts)
    .where(eq(authLogoutReceipts.requestID, requestID))
    .get();
  if (!row) return null;
  if (
    row.payloadHash !== payloadHash ||
    row.subjectDigest !== subjectDigest ||
    row.originalAuthVersion !== identity.authVersion
  ) {
    throw new ServiceError(
      "idempotency_conflict",
      409,
      "requestId was already used with a different logout request.",
    );
  }
  return {
    requestId: requestID,
    replayed: true,
    authVersion: row.resultAuthVersion,
  };
}

async function keyedLogoutSubjectDigest(
  subject: string,
  receiptKey: string,
): Promise<string> {
  let keyBytes: Uint8Array;
  try {
    keyBytes = decodeBase64URL(receiptKey);
  } catch {
    throw logoutReceiptConfigurationError();
  }
  if (keyBytes.byteLength !== 32) throw logoutReceiptConfigurationError();
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`logout-subject:v1:${subject}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function logoutReceiptConfigurationError(): AuthenticationError {
  return new AuthenticationError(
    "authentication_unavailable",
    503,
    "Logout receipt protection is not configured.",
  );
}

function invalidLogoutCredentials(): AuthenticationError {
  return new AuthenticationError(
    "invalid_logout_credentials",
    401,
    "The session can no longer authorize a new logout request.",
  );
}

function invalidRefreshToken(): AuthenticationError {
  return new AuthenticationError(
    "invalid_refresh_token",
    401,
    "The ComiNavi refresh token is invalid or has already been used.",
  );
}

function randomToken(bytes: number): string {
  return base64URL(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const input =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(input));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function base64URL(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeBase64URL(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value.");
  }
  const binary = atob(
    value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "="),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
