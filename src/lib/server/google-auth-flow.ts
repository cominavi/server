import { and, eq, isNull, sql, type SQLWrapper } from "drizzle-orm";
import { runDrizzleBatch } from "../db/batch";
import { createDatabase } from "../db/client";
import {
  authRefreshTokens,
  googleAuthReceipts,
  userIdentities,
  users,
} from "../db/schema";
import {
  base64URL,
  decodeBase64URL,
  prepareSessionForUser,
  sha256Hex,
  type SessionResponse,
} from "./auth-sessions";
import type { CominaviIdentity } from "./cominavi-auth";
import type { GoogleIdentity } from "./google-auth";
import { ServiceError } from "./service-error";
import {
  assertProviderProofAfterDeletion,
  providerSubjectDigest,
} from "./provider-tombstones";
import { loadUserProfile, type UserProfile } from "./users";

const entryAudience = "cominavi-ios-google-sign-in";

export interface GoogleAuthenticationResult {
  response: SessionResponse;
  identity: CominaviIdentity;
}

export async function authenticateGoogleRequest(
  database: D1Database,
  input: {
    idToken: string;
    entryGrant: string;
    nonce: string;
    requestID: string;
  },
  jwtSecret: string,
  replayKey: string,
  verifyIdentity: () => Promise<GoogleIdentity>,
  nowMilliseconds = Date.now(),
  clock: () => number = () => Math.floor(Date.now() / 1_000),
): Promise<GoogleAuthenticationResult> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const payloadHash = await googlePayloadHash(input);
  const replay = await loadGoogleReplay(
    database,
    input.requestID,
    payloadHash,
    replayKey,
    now,
  );
  if (replay) return replay;
  const google = await verifyIdentity();
  return completeGoogleAuthentication(
    database,
    google,
    input.idToken,
    input.entryGrant,
    input.nonce,
    input.requestID,
    jwtSecret,
    replayKey,
    nowMilliseconds,
    clock,
  );
}

export async function completeGoogleAuthentication(
  database: D1Database,
  google: GoogleIdentity,
  idToken: string,
  entryGrant: string,
  nonce: string,
  requestID: string,
  jwtSecret: string,
  replayKey: string,
  nowMilliseconds = Date.now(),
  clock: () => number = () => Math.floor(Date.now() / 1_000),
): Promise<GoogleAuthenticationResult> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(entryGrant)) throw unavailableGoogleGrant();
  const now = Math.floor(nowMilliseconds / 1_000);
  const grantHash = await sha256Hex(entryGrant);
  const nonceHash = await sha256Hex(nonce);
  const payloadHash = await googlePayloadHash({
    requestID,
    idToken,
    entryGrant,
    nonce,
  });
  const replay = await loadGoogleReplay(
    database,
    requestID,
    payloadHash,
    replayKey,
    now,
  );
  if (replay) return replay;
  const subjectDigest = await providerSubjectDigest(
    "google",
    "",
    google.subject,
    replayKey,
  );
  await assertProviderProofAfterDeletion(
    database,
    "google",
    "",
    subjectDigest,
    google.issuedAt,
  );

  const db = createDatabase(database);
  const existing = await db
    .select({
      identityID: sql<number>`${userIdentities.id}`.as("identity_id"),
      userID: sql<number>`${users.id}`.as("user_id"),
      publicID: users.publicID,
      authVersion: users.authVersion,
      displayName: users.displayName,
      displayNameEdited: users.displayNameEdited,
      profileRevision: users.profileRevision,
      lastAuthFencedAt: users.lastAuthFencedAt,
    })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userID))
    .where(
      and(
        eq(userIdentities.provider, "google"),
        eq(userIdentities.providerEnvironment, ""),
        eq(userIdentities.providerSubject, google.subject),
        isNull(users.deletionPendingAt),
      ),
    )
    .get();
  if (
    existing?.lastAuthFencedAt !== null &&
    existing?.lastAuthFencedAt !== undefined &&
    (google.issuedAt === undefined ||
      google.issuedAt <= existing.lastAuthFencedAt)
  ) {
    throw unavailableGoogleGrant();
  }
  const createsUser = !existing;
  const userID = existing?.userID ?? randomInternalID();
  const identityID = existing?.identityID ?? randomInternalID();
  const identity: CominaviIdentity = {
    subject: existing?.publicID ?? randomPublicID(),
    userID,
    authVersion: existing?.authVersion ?? 1,
  };
  const providerDisplayName = normalizedGoogleDisplayName(google);
  const refreshesDisplayName = Boolean(
    existing &&
    existing.displayNameEdited === 0 &&
    providerDisplayName &&
    providerDisplayName !== existing.displayName,
  );
  const profile = await googleProfile(
    database,
    identity,
    google,
    createsUser,
    refreshesDisplayName ? providerDisplayName : null,
  );
  // Session secrets are prepared only after every pre-commit read. The final
  // authority clock below is sampled again after WebCrypto work so an entry
  // grant that expires while preparation is suspended still rolls back.
  const sessionNow = clock();
  const prepared = await prepareSessionForUser(
    identity,
    profile,
    jwtSecret,
    sessionNow * 1_000,
  );
  const encryptedResult = await encryptString(
    JSON.stringify(prepared.response),
    replayKey,
    `google-auth-result:v1:${requestID}`,
  );
  const finalNow = clock();
  const statements: SQLWrapper[] = [];
  if (createsUser) {
    statements.push(
      sql`INSERT INTO users (
             id, public_id, display_name, avatar_provider_url,
             display_name_edited, avatar_edited, avatar_removed,
             profile_revision, auth_version, created_at, updated_at,
             last_authenticated_at
           )
           SELECT ${userID}, ${identity.subject}, ${googleDisplayName(google)},
                  ${google.avatarURL ?? null}, 0, 0, 0, 1, 1,
                  ${finalNow}, ${finalNow}, ${finalNow}
           FROM google_entry_grants AS grant
           WHERE grant.grant_hash = ${grantHash}
             AND grant.nonce_hash = ${nonceHash}
             AND grant.audience = ${entryAudience}
             AND grant.expires_at > ${finalNow}
             AND grant.consumed_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM user_identities
               WHERE provider = 'google' AND provider_environment = ''
                 AND provider_subject = ${google.subject}
             )`,
    );
    statements.push(
      sql`INSERT INTO user_identities (
             id, user_id, provider, provider_environment, provider_subject,
             provider_email, provider_display_name, provider_avatar_url,
             created_at, updated_at, last_authenticated_at
           )
           SELECT ${identityID}, user.id, 'google', '', ${google.subject},
                  ${google.email ?? null}, ${google.displayName ?? null},
                  ${google.avatarURL ?? null}, ${finalNow}, ${finalNow},
                  ${finalNow}
           FROM users AS user
           JOIN google_entry_grants AS grant
             ON grant.grant_hash = ${grantHash}
           WHERE user.id = ${userID} AND user.auth_version = 1
             AND grant.nonce_hash = ${nonceHash}
             AND grant.audience = ${entryAudience}
             AND grant.expires_at > ${finalNow}
             AND grant.consumed_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM user_identities
               WHERE provider = 'google' AND provider_environment = ''
                 AND provider_subject = ${google.subject}
             )`,
    );
  } else {
    statements.push(
      sql`UPDATE user_identities SET provider_email = ${google.email ?? null},
             provider_display_name = ${google.displayName ?? null},
             provider_avatar_url = ${google.avatarURL ?? null},
             updated_at = ${finalNow}, last_authenticated_at = ${finalNow}
           WHERE id = ${identityID} AND user_id = ${userID}
             AND EXISTS (
               SELECT 1 FROM users WHERE id = ${userID}
                 AND auth_version = ${identity.authVersion}
                 AND deletion_pending_at IS NULL
                 AND (last_auth_fenced_at IS NULL OR
                   (${google.issuedAt ?? null} IS NOT NULL
                     AND ${google.issuedAt ?? null} > last_auth_fenced_at))
             )
             AND EXISTS (
               SELECT 1 FROM google_entry_grants
               WHERE grant_hash = ${grantHash} AND nonce_hash = ${nonceHash}
                 AND audience = ${entryAudience}
                 AND expires_at > ${finalNow} AND consumed_at IS NULL
             )`,
    );
    statements.push(
      sql`UPDATE users SET
             display_name = CASE
               WHEN display_name_edited = 0 AND ${providerDisplayName} IS NOT NULL
                 THEN ${providerDisplayName}
               ELSE display_name
             END,
             profile_revision = profile_revision + CASE
               WHEN display_name_edited = 0 AND ${providerDisplayName} IS NOT NULL
                 AND display_name <> ${providerDisplayName} THEN 1
               ELSE 0
             END,
             avatar_provider_url = CASE
               WHEN avatar_edited = 0 AND ${google.avatarURL ?? null} IS NOT NULL
                 THEN ${google.avatarURL ?? null}
               ELSE avatar_provider_url
             END,
             updated_at = ${finalNow}, last_authenticated_at = ${finalNow}
           WHERE id = ${userID} AND public_id = ${identity.subject}
             AND auth_version = ${identity.authVersion}
             AND deletion_pending_at IS NULL
             AND (last_auth_fenced_at IS NULL OR
               (${google.issuedAt ?? null} IS NOT NULL
                 AND ${google.issuedAt ?? null} > last_auth_fenced_at))
             AND profile_revision = ${existing!.profileRevision}
             AND display_name_edited = ${existing!.displayNameEdited}
             AND display_name = ${existing!.displayName}
             AND EXISTS (
               SELECT 1 FROM google_entry_grants
               WHERE grant_hash = ${grantHash} AND nonce_hash = ${nonceHash}
                 AND audience = ${entryAudience}
                 AND expires_at > ${finalNow} AND consumed_at IS NULL
             )`,
    );
  }
  statements.push(
    sql`UPDATE google_entry_grants SET consumed_at = ${finalNow},
           consumed_request_id = ${requestID},
           consumed_payload_hash = ${payloadHash}
         WHERE grant_hash = ${grantHash} AND nonce_hash = ${nonceHash}
           AND audience = ${entryAudience} AND expires_at > ${finalNow}
           AND consumed_at IS NULL
           AND EXISTS (
             SELECT 1 FROM user_identities AS identity
             JOIN users AS user ON user.id = identity.user_id
             WHERE identity.id = ${identityID}
               AND identity.user_id = ${userID}
               AND identity.provider = 'google'
               AND identity.provider_subject = ${google.subject}
               AND user.auth_version = ${identity.authVersion}
               AND user.deletion_pending_at IS NULL
               AND (user.last_auth_fenced_at IS NULL OR
                 (${google.issuedAt ?? null} IS NOT NULL
                   AND ${google.issuedAt ?? null} > user.last_auth_fenced_at))
               AND user.profile_revision = ${profile.revision}
               AND user.display_name = ${profile.displayName}
           )`,
  );
  statements.push(
    sql`INSERT INTO provider_avatar_import_jobs (
           user_identity_id, provider_avatar_url, job_revision,
           state, attempt_count,
           lease_id, lease_expires_at, available_at, last_error,
           created_at, updated_at
         )
         SELECT identity.id, ${google.avatarURL ?? null}, 1, 'queued', 0,
                NULL, NULL, ${finalNow}, NULL, ${finalNow}, ${finalNow}
         FROM user_identities AS identity
         JOIN google_entry_grants AS grant ON grant.grant_hash = ${grantHash}
         WHERE ${google.avatarURL ?? null} IS NOT NULL
           AND identity.id = ${identityID} AND identity.user_id = ${userID}
           AND identity.provider = 'google'
           AND identity.provider_subject = ${google.subject}
           AND EXISTS (
             SELECT 1 FROM users WHERE id = ${userID}
               AND deletion_pending_at IS NULL
           )
           AND grant.consumed_request_id = ${requestID}
           AND grant.consumed_payload_hash = ${payloadHash}
         ON CONFLICT(user_identity_id) DO UPDATE SET
           provider_avatar_url = excluded.provider_avatar_url,
           job_revision = provider_avatar_import_jobs.job_revision + 1,
           state = 'queued', attempt_count = 0, lease_id = NULL,
           lease_expires_at = NULL, available_at = excluded.available_at,
           last_error = NULL, updated_at = excluded.updated_at`,
  );
  statements.push(
    sql`INSERT INTO auth_refresh_tokens (
           token_hash, user_id, family_id, auth_version, expires_at,
           consumed_at, replaced_by_hash, created_at
         )
         SELECT ${prepared.tokenHash}, user.id, ${prepared.familyID},
                user.auth_version, ${prepared.refreshExpiresAt}, NULL, NULL,
                ${prepared.createdAt}
         FROM users AS user
         JOIN google_entry_grants AS grant ON grant.grant_hash = ${grantHash}
         WHERE user.id = ${userID}
           AND user.auth_version = ${identity.authVersion}
           AND user.deletion_pending_at IS NULL
           AND grant.consumed_request_id = ${requestID}
           AND grant.consumed_payload_hash = ${payloadHash}`,
  );
  statements.push(
    sql`INSERT INTO google_auth_receipts (
           request_id, payload_hash, grant_hash, user_id, user_identity_id,
           result_auth_version, result_token_hash, result_nonce,
           result_ciphertext, replay_expires_at, created_at
         )
         SELECT ${requestID}, ${payloadHash}, grant.grant_hash, user.id,
                identity.id, user.auth_version, ${prepared.tokenHash},
                ${encryptedResult.nonce}, ${encryptedResult.ciphertext},
                ${prepared.refreshExpiresAt}, ${finalNow}
         FROM google_entry_grants AS grant
         JOIN users AS user ON user.id = ${userID}
         JOIN user_identities AS identity ON identity.id = ${identityID}
         JOIN auth_refresh_tokens AS refresh
           ON refresh.token_hash = ${prepared.tokenHash}
         WHERE grant.grant_hash = ${grantHash}
           AND grant.consumed_request_id = ${requestID}
           AND grant.consumed_payload_hash = ${payloadHash}
           AND identity.user_id = user.id
           AND user.auth_version = ${identity.authVersion}
           AND user.deletion_pending_at IS NULL
           AND refresh.user_id = user.id
           AND refresh.auth_version = ${identity.authVersion}`,
  );
  statements.push(
    sql`INSERT INTO google_auth_atomic_assertions (
           request_id, committed, created_at
         ) VALUES (
           ${requestID},
           CASE WHEN EXISTS (
             SELECT 1 FROM google_auth_receipts
             WHERE request_id = ${requestID} AND payload_hash = ${payloadHash}
               AND result_token_hash = ${prepared.tokenHash}
           ) AND (
             ${google.avatarURL ?? null} IS NULL OR EXISTS (
               SELECT 1 FROM provider_avatar_import_jobs
               WHERE user_identity_id = ${identityID}
                 AND provider_avatar_url = ${google.avatarURL ?? null}
             )
           ) AND NOT EXISTS (
             SELECT 1 FROM deleted_provider_identity_tombstones
             WHERE provider = 'google' AND provider_environment = ''
               AND provider_subject_digest = ${subjectDigest}
               AND (${google.issuedAt ?? null} IS NULL
                 OR ${google.issuedAt ?? null} <= deleted_at)
           ) THEN 1 ELSE 0 END,
           ${finalNow}
         )`,
  );
  await runDrizzleBatch(database, statements as [SQLWrapper, ...SQLWrapper[]]);
  const stored = await loadGoogleReplay(
    database,
    requestID,
    payloadHash,
    replayKey,
    finalNow,
  );
  if (!stored) throw unavailableGoogleGrant();
  return stored;
}

async function loadGoogleReplay(
  database: D1Database,
  requestID: string,
  payloadHash: string,
  replayKey: string,
  now: number,
): Promise<GoogleAuthenticationResult | null> {
  const db = createDatabase(database);
  const row = await db
    .select({
      payloadHash: googleAuthReceipts.payloadHash,
      userID: googleAuthReceipts.userID,
      resultAuthVersion: googleAuthReceipts.resultAuthVersion,
      resultTokenHash: googleAuthReceipts.resultTokenHash,
      resultNonce: googleAuthReceipts.resultNonce,
      resultCiphertext: googleAuthReceipts.resultCiphertext,
      replayExpiresAt: googleAuthReceipts.replayExpiresAt,
      publicID: users.publicID,
      consumedAt: authRefreshTokens.consumedAt,
      expiresAt: authRefreshTokens.expiresAt,
    })
    .from(googleAuthReceipts)
    .innerJoin(users, eq(users.id, googleAuthReceipts.userID))
    .innerJoin(
      authRefreshTokens,
      eq(authRefreshTokens.tokenHash, googleAuthReceipts.resultTokenHash),
    )
    .where(
      and(
        eq(googleAuthReceipts.requestID, requestID),
        isNull(users.deletionPendingAt),
      ),
    )
    .get();
  if (!row) return null;
  if (row.payloadHash !== payloadHash) throw idempotencyConflict();
  const current = await db
    .select({ authVersion: users.authVersion })
    .from(users)
    .where(and(eq(users.id, row.userID), isNull(users.deletionPendingAt)))
    .get();
  if (
    !current ||
    current.authVersion !== row.resultAuthVersion ||
    row.replayExpiresAt <= now ||
    row.consumedAt !== null ||
    row.expiresAt <= now
  ) {
    throw unavailableGoogleGrant();
  }
  const response = JSON.parse(
    await decryptString(
      row.resultNonce,
      row.resultCiphertext,
      replayKey,
      `google-auth-result:v1:${requestID}`,
    ),
  ) as SessionResponse;
  return {
    response,
    identity: {
      subject: row.publicID,
      userID: row.userID,
      authVersion: row.resultAuthVersion,
    },
  };
}

async function googleProfile(
  database: D1Database,
  identity: CominaviIdentity,
  google: GoogleIdentity,
  createsUser: boolean,
  refreshedDisplayName: string | null,
): Promise<UserProfile> {
  const googleItem = {
    provider: "google" as const,
    ...(google.email ? { email: google.email } : {}),
  };
  if (createsUser) {
    return {
      id: identity.subject,
      displayName: googleDisplayName(google),
      avatarURL: null,
      revision: 1,
      identities: [googleItem],
    };
  }
  const profile = await loadUserProfile(database, identity.userID);
  return {
    ...profile,
    ...(refreshedDisplayName
      ? {
          displayName: refreshedDisplayName,
          revision: profile.revision + 1,
        }
      : {}),
    identities: profile.identities.map((item) =>
      item.provider === "google" ? googleItem : item,
    ),
  };
}

function googleDisplayName(google: GoogleIdentity): string {
  return normalizedGoogleDisplayName(google) ?? "ComiNavi User";
}

function normalizedGoogleDisplayName(google: GoogleIdentity): string | null {
  const trimmed = google.displayName?.trim() ?? "";
  return trimmed ? Array.from(trimmed).slice(0, 80).join("") : null;
}

function randomInternalID(): number {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value || 1;
}

function randomPublicID(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function encryptString(
  value: string,
  encodedKey: string,
  additionalData: string,
): Promise<{ nonce: string; ciphertext: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode(additionalData),
    },
    await replayCryptoKey(encodedKey),
    new TextEncoder().encode(value),
  );
  return {
    nonce: base64URL(nonce),
    ciphertext: base64URL(new Uint8Array(ciphertext)),
  };
}

async function decryptString(
  nonce: string,
  ciphertext: string,
  encodedKey: string,
  additionalData: string,
): Promise<string> {
  try {
    return new TextDecoder().decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Uint8Array.from(decodeBase64URL(nonce)),
          additionalData: new TextEncoder().encode(additionalData),
        },
        await replayCryptoKey(encodedKey),
        Uint8Array.from(decodeBase64URL(ciphertext)),
      ),
    );
  } catch {
    throw unavailableGoogleGrant();
  }
}

async function replayCryptoKey(encoded: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(decodeBase64URL(encoded));
  if (bytes.byteLength !== 32) throw unavailableGoogleGrant();
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function unavailableGoogleGrant(): ServiceError {
  return new ServiceError(
    "invalid_entry_grant",
    401,
    "The Google sign-in entry grant is invalid or has already been used.",
  );
}

function idempotencyConflict(): ServiceError {
  return new ServiceError(
    "idempotency_conflict",
    409,
    "This requestId was already used with a different Google sign-in payload.",
  );
}

async function googlePayloadHash(input: {
  requestID: string;
  idToken: string;
  entryGrant: string;
  nonce: string;
}): Promise<string> {
  if (
    input.idToken.length > 16_384 ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.entryGrant)
  ) {
    throw unavailableGoogleGrant();
  }
  return sha256Hex(
    JSON.stringify({
      v: 1,
      requestID: input.requestID,
      idTokenHash: await sha256Hex(input.idToken),
      grantHash: await sha256Hex(input.entryGrant),
      nonceHash: await sha256Hex(input.nonce),
    }),
  );
}
