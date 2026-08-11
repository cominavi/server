import { and, asc, eq, exists, isNull, sql } from "drizzle-orm";
import { createDatabase } from "../db/client";
import { runDrizzleBatch } from "../db/batch";
import {
  authRefreshTokens,
  sharedPlanRequests,
  userIdentities,
  users,
} from "../db/schema";
import {
  AuthenticationError,
  type CirclemsIdentity,
  type CominaviIdentity,
  type CominaviTokenIdentity,
} from "./cominavi-auth";
import { ServiceError } from "./service-error";
import { parseCanonicalRequestID } from "./request-id";

export interface ExternalIdentity {
  provider: "circlems" | "google" | "apple";
  environment: "production" | "sandbox" | "";
  subject: string;
  providerUserID?: number;
  email?: string;
  displayName?: string;
  avatarURL?: string;
}

export interface UserProfile {
  id: string;
  displayName: string;
  avatarURL: string | null;
  revision: number;
  identities: Array<{
    provider: "circlems" | "google" | "apple";
    environment?: "production" | "sandbox";
    providerUserID?: number;
    email?: string;
  }>;
}

interface UserRow {
  id: number;
  public_id: string;
  auth_version: number;
}

export async function upsertAuthenticatedUser(
  database: D1Database,
  identity: CirclemsIdentity,
  nowMilliseconds = Date.now(),
): Promise<CominaviIdentity> {
  return upsertExternalIdentity(
    database,
    {
      provider: "circlems",
      environment: identity.circlemsEnvironment,
      subject: String(identity.circlemsUserID),
      providerUserID: identity.circlemsUserID,
      displayName: identity.nickname,
    },
    undefined,
    nowMilliseconds,
  );
}

export async function upsertExternalIdentity(
  database: D1Database,
  external: ExternalIdentity,
  linkToUserID?: number,
  nowMilliseconds = Date.now(),
): Promise<CominaviIdentity> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const existing = await findIdentity(database, external);
  if (existing) {
    if (linkToUserID !== undefined && existing.id !== linkToUserID) {
      throw new ServiceError(
        "identity_already_linked",
        409,
        "This identity already belongs to another ComiNavi account.",
      );
    }
    await refreshProviderProfile(database, existing.id, external, now);
    return canonicalIdentity(
      existing.id,
      existing.public_id,
      existing.auth_version,
    );
  }

  if (linkToUserID !== undefined) {
    const db = createDatabase(database);
    const linked = await db.run(sql`INSERT INTO user_identities (
           user_id, provider, provider_environment, provider_subject,
           provider_user_id, provider_email, provider_display_name,
           provider_avatar_url, created_at, updated_at, last_authenticated_at
         )
         SELECT ${linkToUserID}, ${external.provider}, ${external.environment},
                ${external.subject}, ${external.providerUserID ?? null},
                ${external.email ?? null},
                ${normalizedOptionalName(external.displayName)},
                ${normalizedProviderAvatar(external.avatarURL)},
                ${now}, ${now}, ${now}
         WHERE EXISTS (
           SELECT 1 FROM users
           WHERE id = ${linkToUserID} AND deletion_pending_at IS NULL
         )
         ON CONFLICT(provider, provider_environment, provider_subject)
           DO NOTHING`);
    if ((linked.meta.changes ?? 0) !== 1) {
      const conflict = await findIdentity(database, external);
      if (conflict?.id !== linkToUserID) {
        throw new ServiceError(
          "identity_already_linked",
          409,
          "This identity already belongs to another ComiNavi account.",
        );
      }
    }
    await refreshProviderProfile(database, linkToUserID, external, now);
    const row = await db
      .select({
        id: users.id,
        publicID: users.publicID,
        authVersion: users.authVersion,
      })
      .from(users)
      .where(and(eq(users.id, linkToUserID), isNull(users.deletionPendingAt)))
      .get();
    if (!row) throw accountUnavailable();
    return canonicalIdentity(row.id, row.publicID, row.authVersion);
  }

  const displayName =
    normalizedOptionalName(external.displayName) ??
    defaultDisplayName(external);
  const publicID = randomPublicID();
  try {
    const results = await runDrizzleBatch(database, [
      sql`INSERT INTO users (
           public_id, display_name, avatar_provider_url, avatar_object_key,
           avatar_content_type, display_name_edited, avatar_edited,
           avatar_removed, profile_revision, auth_version, created_at,
           updated_at, last_authenticated_at
         ) VALUES (
           ${publicID}, ${displayName},
           ${normalizedProviderAvatar(external.avatarURL)}, NULL, NULL,
           0, 0, 0, 1, 1, ${now}, ${now}, ${now}
         )`,
      sql`INSERT INTO user_identities (
             user_id, provider, provider_environment, provider_subject,
             provider_user_id, provider_email, provider_display_name,
             provider_avatar_url, created_at, updated_at,
             last_authenticated_at
           )
           SELECT id, ${external.provider}, ${external.environment},
                  ${external.subject}, ${external.providerUserID ?? null},
                  ${external.email ?? null},
                  ${normalizedOptionalName(external.displayName)},
                  ${normalizedProviderAvatar(external.avatarURL)},
                  ${now}, ${now}, ${now}
           FROM users WHERE public_id = ${publicID}`,
    ]);
    if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new Error("Atomic account creation did not persist both rows.");
    }
  } catch {
    const raced = await findIdentity(database, external);
    if (!raced) throw accountUnavailable();
    await refreshProviderProfile(database, raced.id, external, now);
  }

  const created = await findIdentity(database, external);
  if (!created) throw accountUnavailable();
  return canonicalIdentity(created.id, created.public_id, created.auth_version);
}

export async function loadUserProfile(
  database: D1Database,
  userID: number,
): Promise<UserProfile> {
  const db = createDatabase(database);
  const [profile, identities] = await Promise.all([
    db
      .select({
        id: users.id,
        publicID: users.publicID,
        displayName: users.displayName,
        avatarProviderURL: users.avatarProviderURL,
        avatarObjectKey: users.avatarObjectKey,
        profileRevision: users.profileRevision,
      })
      .from(users)
      .where(eq(users.id, userID))
      .get(),
    db
      .select({
        provider: userIdentities.provider,
        providerEnvironment: userIdentities.providerEnvironment,
        providerUserID: userIdentities.providerUserID,
        providerEmail: userIdentities.providerEmail,
      })
      .from(userIdentities)
      .where(eq(userIdentities.userID, userID))
      .orderBy(asc(userIdentities.id)),
  ]);
  if (!profile) throw accountUnavailable();
  return {
    id: profile.publicID,
    displayName: profile.displayName,
    avatarURL: profile.avatarObjectKey
      ? `/api/v2/users/${profile.publicID}/avatar`
      : null,
    revision: profile.profileRevision,
    identities: identities.map((identity) => ({
      provider: identity.provider,
      ...(identity.providerEnvironment
        ? { environment: identity.providerEnvironment }
        : {}),
      ...(identity.providerUserID
        ? { providerUserID: identity.providerUserID }
        : {}),
      ...(identity.providerEmail ? { email: identity.providerEmail } : {}),
    })),
  };
}

export function parseProfileUpdate(value: unknown): {
  requestID: string;
  baseRevision: number;
  displayName: string;
} {
  if (!isRecord(value) || !Number.isSafeInteger(value.baseRevision)) {
    throw invalidProfile();
  }
  const displayName = normalizeRequiredName(value.displayName);
  return {
    requestID: parseCanonicalRequestID(value.requestId),
    baseRevision: Number(value.baseRevision),
    displayName,
  };
}

export async function updateUserProfile(
  database: D1Database,
  identity: CominaviIdentity,
  input: ReturnType<typeof parseProfileUpdate>,
  nowMilliseconds = Date.now(),
): Promise<UserProfile> {
  const userID = identity.userID;
  const scope = `users:${userID}:profile`;
  const payloadHash = await digestText(
    JSON.stringify({
      baseRevision: input.baseRevision,
      displayName: input.displayName,
    }),
  );
  const db = createDatabase(database);
  const receipt = await db
    .select({ payloadHash: sharedPlanRequests.payloadHash })
    .from(sharedPlanRequests)
    .where(
      and(
        eq(sharedPlanRequests.userID, userID),
        eq(sharedPlanRequests.scope, scope),
        eq(sharedPlanRequests.requestID, input.requestID),
      ),
    )
    .get();
  if (receipt) {
    if (receipt.payloadHash !== payloadHash) {
      throw new ServiceError(
        "idempotency_conflict",
        409,
        "This requestId was already used with a different profile payload.",
      );
    }
    return loadUserProfile(database, userID);
  }
  const now = Math.floor(nowMilliseconds / 1_000);
  const profile = await db
    .select({ publicID: users.publicID })
    .from(users)
    .where(eq(users.id, userID))
    .get();
  if (!profile) throw accountUnavailable();
  const results = await runDrizzleBatch(database, [
    db
      .update(users)
      .set({
        displayName: input.displayName,
        displayNameEdited: 1,
        profileRevision: sql`${users.profileRevision} + 1`,
        updatedAt: now,
        lastMutationScope: scope,
        lastMutationRequestID: input.requestID,
        lastMutationPayloadHash: payloadHash,
      })
      .where(
        and(
          eq(users.id, userID),
          eq(users.profileRevision, input.baseRevision),
          eq(users.authVersion, identity.authVersion),
          isNull(users.deletionPendingAt),
        ),
      ),
    sql`INSERT INTO shared_plan_requests (
           user_id, scope, request_id, operation, payload_hash,
           resource_id, created_at
         )
         SELECT ${userID}, ${scope}, ${input.requestID}, 'profile',
                ${payloadHash}, ${profile.publicID}, ${now}
         WHERE EXISTS (
           SELECT 1 FROM users WHERE id = ${userID}
             AND last_mutation_scope = ${scope}
             AND last_mutation_request_id = ${input.requestID}
             AND last_mutation_payload_hash = ${payloadHash}
         )`,
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    const profile = await loadUserProfile(database, userID);
    throw profileRevisionConflict(profile);
  }
  return loadUserProfile(database, userID);
}

async function digestText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function setUserAvatar(
  database: D1Database,
  identity: CominaviIdentity,
  baseRevision: number,
  objectKey: string | null,
  contentType: string | null,
  receipt: {
    scope: string;
    requestID: string;
    payloadHash: string;
    prewriteObjectKey?: string;
  },
  nowMilliseconds = Date.now(),
): Promise<{
  profile: UserProfile;
  previousObjectKey: string | null;
  replayed: boolean;
}> {
  const userID = identity.userID;
  const db = createDatabase(database);
  const priorReceipt = await db
    .select({ payloadHash: sharedPlanRequests.payloadHash })
    .from(sharedPlanRequests)
    .where(
      and(
        eq(sharedPlanRequests.userID, userID),
        eq(sharedPlanRequests.scope, receipt.scope),
        eq(sharedPlanRequests.requestID, receipt.requestID),
      ),
    )
    .get();
  if (priorReceipt) {
    if (priorReceipt.payloadHash !== receipt.payloadHash) {
      throw new ServiceError(
        "idempotency_conflict",
        409,
        "This Idempotency-Key was already used with different avatar bytes.",
      );
    }
    return {
      profile: await loadUserProfile(database, userID),
      previousObjectKey: null,
      replayed: true,
    };
  }
  const previous = await db
    .select({
      publicID: users.publicID,
      avatarObjectKey: users.avatarObjectKey,
    })
    .from(users)
    .where(and(eq(users.id, userID), eq(users.profileRevision, baseRevision)))
    .get();
  if (!previous) {
    const profile = await loadUserProfile(database, userID);
    throw profileRevisionConflict(profile);
  }
  const now = Math.floor(nowMilliseconds / 1_000);
  const statements = [
    sql`UPDATE users
         SET avatar_provider_url = NULL, avatar_object_key = ${objectKey},
             avatar_content_type = ${contentType}, avatar_edited = 1,
             avatar_removed = CASE WHEN ${objectKey} IS NULL THEN 1 ELSE 0 END,
             profile_revision = profile_revision + 1, updated_at = ${now},
             last_mutation_scope = ${receipt.scope},
             last_mutation_request_id = ${receipt.requestID},
             last_mutation_payload_hash = ${receipt.payloadHash}
         WHERE id = ${userID} AND profile_revision = ${baseRevision}
           AND auth_version = ${identity.authVersion}
           AND deletion_pending_at IS NULL
           AND (${receipt.prewriteObjectKey ?? null} IS NULL OR
             (${receipt.prewriteObjectKey ?? null} = ${objectKey} AND EXISTS (
             SELECT 1 FROM avatar_object_cleanup
             WHERE object_key = ${receipt.prewriteObjectKey ?? null}
               AND state = 'queued'
           )))`,
  ];
  if (receipt.prewriteObjectKey) {
    statements.push(
      sql`DELETE FROM avatar_object_cleanup
           WHERE object_key = ${receipt.prewriteObjectKey}
             AND state = 'queued' AND EXISTS (
             SELECT 1 FROM users WHERE id = ${userID}
               AND avatar_object_key = ${receipt.prewriteObjectKey}
               AND last_mutation_scope = ${receipt.scope}
               AND last_mutation_request_id = ${receipt.requestID}
               AND last_mutation_payload_hash = ${receipt.payloadHash}
           )`,
    );
  }
  statements.push(
    sql`INSERT INTO shared_plan_requests (
           user_id, scope, request_id, operation, payload_hash,
           resource_id, created_at
         )
         SELECT ${userID}, ${receipt.scope}, ${receipt.requestID}, 'avatar',
                ${receipt.payloadHash}, ${previous.publicID}, ${now}
         WHERE EXISTS (
           SELECT 1 FROM users WHERE id = ${userID}
             AND last_mutation_scope = ${receipt.scope}
             AND last_mutation_request_id = ${receipt.requestID}
             AND last_mutation_payload_hash = ${receipt.payloadHash}
         )`,
  );
  if (previous.avatarObjectKey && previous.avatarObjectKey !== objectKey) {
    statements.push(
      sql`INSERT INTO avatar_object_cleanup (
             id, object_key, state, attempt_count, lease_id, lease_expires_at,
             available_at, last_error, created_at, updated_at
           )
           SELECT ${crypto.randomUUID()}, ${previous.avatarObjectKey},
                  'queued', 0, NULL, NULL, ${now}, NULL, ${now}, ${now}
           FROM users WHERE id = ${userID}
             AND last_mutation_scope = ${receipt.scope}
             AND last_mutation_request_id = ${receipt.requestID}
             AND last_mutation_payload_hash = ${receipt.payloadHash}`,
    );
  }
  const results = await runDrizzleBatch(
    database,
    statements as [
      (typeof statements)[number],
      ...(typeof statements)[number][],
    ],
  );
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    const profile = await loadUserProfile(database, userID);
    throw profileRevisionConflict(profile);
  }
  return {
    profile: await loadUserProfile(database, userID),
    previousObjectKey: previous.avatarObjectKey,
    replayed: false,
  };
}

export async function resolveAuthenticatedUser(
  database: D1Database,
  identity: CominaviTokenIdentity,
): Promise<CominaviIdentity> {
  const current = await createDatabase(database)
    .select({ id: users.id, authVersion: users.authVersion })
    .from(users)
    .where(
      and(
        eq(users.publicID, identity.subject),
        isNull(users.deletionPendingAt),
      ),
    )
    .get();
  if (!current || current.authVersion !== identity.authVersion) {
    throw new AuthenticationError(
      "invalid_token",
      401,
      "The ComiNavi session is no longer valid.",
    );
  }
  return {
    subject: identity.subject,
    userID: current.id,
    authVersion: current.authVersion,
  };
}

export async function revokeAuthenticatedSessions(
  database: D1Database,
  identity: CominaviIdentity,
  nowMilliseconds = Date.now(),
): Promise<void> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const db = createDatabase(database);
  const advancedUser = db
    .select({ value: sql`1` })
    .from(users)
    .where(
      and(
        eq(users.id, identity.userID),
        eq(users.authVersion, identity.authVersion + 1),
      ),
    );
  const results = await db.batch([
    db
      .update(users)
      .set({
        authVersion: sql`${users.authVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(users.id, identity.userID),
          eq(users.publicID, identity.subject),
          eq(users.authVersion, identity.authVersion),
        ),
      ),
    db
      .update(authRefreshTokens)
      .set({
        consumedAt: sql`coalesce(${authRefreshTokens.consumedAt}, ${now})`,
      })
      .where(
        and(
          eq(authRefreshTokens.userID, identity.userID),
          exists(advancedUser),
        ),
      ),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new AuthenticationError(
      "invalid_token",
      401,
      "The ComiNavi session is no longer valid.",
    );
  }
}

async function findIdentity(
  database: D1Database,
  identity: ExternalIdentity,
): Promise<UserRow | null> {
  const row = await createDatabase(database)
    .select({
      id: users.id,
      publicID: users.publicID,
      authVersion: users.authVersion,
    })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userID))
    .where(
      and(
        eq(userIdentities.provider, identity.provider),
        eq(userIdentities.providerEnvironment, identity.environment),
        eq(userIdentities.providerSubject, identity.subject),
        isNull(users.deletionPendingAt),
      ),
    )
    .get();
  return row
    ? { id: row.id, public_id: row.publicID, auth_version: row.authVersion }
    : null;
}

async function refreshProviderProfile(
  database: D1Database,
  userID: number,
  identity: ExternalIdentity,
  now: number,
): Promise<void> {
  const db = createDatabase(database);
  const activeUser = db
    .select({ value: sql`1` })
    .from(users)
    .where(and(eq(users.id, userID), isNull(users.deletionPendingAt)));
  const displayName = normalizedOptionalName(identity.displayName);
  const avatarURL = normalizedProviderAvatar(identity.avatarURL);
  await runDrizzleBatch(database, [
    db
      .update(userIdentities)
      .set({
        providerUserID: identity.providerUserID ?? null,
        providerEmail: identity.email ?? null,
        providerDisplayName: displayName,
        providerAvatarURL: avatarURL,
        updatedAt: now,
        lastAuthenticatedAt: now,
      })
      .where(
        and(
          eq(userIdentities.userID, userID),
          eq(userIdentities.provider, identity.provider),
          eq(userIdentities.providerEnvironment, identity.environment),
          eq(userIdentities.providerSubject, identity.subject),
          exists(activeUser),
        ),
      ),
    sql`UPDATE users
         SET display_name = CASE
               WHEN display_name_edited = 0 AND ${displayName} IS NOT NULL
                 THEN ${displayName}
               ELSE display_name
             END,
             profile_revision = profile_revision + CASE
               WHEN display_name_edited = 0 AND ${displayName} IS NOT NULL
                 AND display_name <> ${displayName} THEN 1
               ELSE 0
             END,
             avatar_provider_url = CASE
               WHEN avatar_edited = 0 AND ${avatarURL} IS NOT NULL
                 THEN ${avatarURL}
               ELSE avatar_provider_url
             END,
             updated_at = ${now}, last_authenticated_at = ${now}
         WHERE id = ${userID} AND deletion_pending_at IS NULL`,
  ]);
}

function profileRevisionConflict(currentUser: UserProfile): ServiceError {
  return new ServiceError(
    "profile_revision_conflict",
    409,
    "The profile changed on another device.",
    { currentRevision: currentUser.revision, currentUser },
  );
}

function canonicalIdentity(
  userID: number,
  publicID: string,
  authVersion: number,
): CominaviIdentity {
  return { subject: publicID, userID, authVersion };
}

function randomPublicID(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function normalizeRequiredName(value: unknown): string {
  if (typeof value !== "string") throw invalidProfile();
  const normalized = value.trim();
  const scalarCount = Array.from(normalized).length;
  if (scalarCount < 1 || scalarCount > 80) throw invalidProfile();
  return normalized;
}

function normalizedOptionalName(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? Array.from(normalized).slice(0, 80).join("") : null;
}

function normalizedProviderAvatar(value: string | undefined): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && isGoogleImageHost(url.hostname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function isGoogleImageHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "googleusercontent.com" ||
    normalized.endsWith(".googleusercontent.com")
  );
}

function defaultDisplayName(identity: ExternalIdentity): string {
  if (identity.provider === "circlems") return "Circle.ms User";
  return identity.provider === "apple" ? "Apple User" : "Google User";
}

function invalidProfile(): ServiceError {
  return new ServiceError(
    "invalid_profile",
    400,
    "displayName must contain between 1 and 80 characters.",
  );
}

function accountUnavailable(): AuthenticationError {
  return new AuthenticationError(
    "account_unavailable",
    503,
    "The ComiNavi account could not be prepared.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
