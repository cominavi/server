import {
  and,
  asc,
  eq,
  exists,
  gt,
  isNull,
  isNotNull,
  lte,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";

import { parameterizedSQL, runDrizzleBatch } from "../db/batch";
import { createDatabase } from "../db/client";
import {
  appleAuthReceipts,
  appleAuthRequests,
  appleProviderCredentials,
  appleProviderRevocations,
  authRefreshTokens,
  deletedProviderIdentityTombstones,
  googleEntryGrants,
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
import {
  revokeAppleRefreshToken,
  type AppleAuthBindings,
  type AppleAuthorizationTokens,
  type AppleIdentity,
} from "./apple-auth";
import { appleEntryAudience } from "./apple-entry-grants";
import type { CominaviIdentity } from "./cominavi-auth";
import { ServiceError } from "./service-error";
import {
  assertProviderProofAfterDeletion,
  providerSubjectDigest,
} from "./provider-tombstones";
import { loadUserProfile, type UserProfile } from "./users";

export interface AppleAuthenticationResult {
  response: SessionResponse;
  identity: CominaviIdentity;
}

export interface AppleAuthenticationHooks {
  beforeFinalBatch?: () => Promise<void>;
}

interface StagedAppleAuthorization {
  apple: AppleIdentity;
  providerTokens: AppleAuthorizationTokens;
}

export async function authenticateAppleRequest(
  database: D1Database,
  input: {
    requestID: string;
    identityToken: string;
    authorizationCode: string;
    entryGrant: string;
    nonce: string;
    displayName?: string;
  },
  jwtSecret: string,
  encryptionKey: string,
  verifyIdentity: () => Promise<AppleIdentity>,
  exchangeAuthorizationCode: (
    identity: AppleIdentity,
  ) => Promise<AppleAuthorizationTokens>,
  nowMilliseconds = Date.now(),
  clock: () => number = () => Math.floor(Date.now() / 1_000),
  hooks: AppleAuthenticationHooks = {},
): Promise<AppleAuthenticationResult> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const payloadHash = await applePayloadHash(input);
  const replay = await loadAppleReplay(
    database,
    input.requestID,
    payloadHash,
    encryptionKey,
    now,
  );
  if (replay) return replay;
  const priorRequest = await loadAppleRequest(
    database,
    input.requestID,
    payloadHash,
    encryptionKey,
  );
  if (priorRequest) {
    if (priorRequest.state !== "staged" || !priorRequest.staged)
      throw indeterminateAppleAuthorization();
    return commitAppleAuthentication(
      database,
      priorRequest.staged.apple,
      priorRequest.staged.providerTokens,
      input,
      payloadHash,
      priorRequest.grantHash,
      priorRequest.nonceHash,
      jwtSecret,
      encryptionKey,
      nowMilliseconds,
      clock,
      hooks,
    );
  }
  const [grantHash, nonceHash] = await Promise.all([
    sha256Hex(input.entryGrant),
    sha256Hex(input.nonce),
  ]);
  const db = createDatabase(database);
  const validGrant = await db
    .select({ valid: sql<number>`1` })
    .from(googleEntryGrants)
    .where(
      and(
        eq(googleEntryGrants.grantHash, grantHash),
        eq(googleEntryGrants.nonceHash, nonceHash),
        eq(googleEntryGrants.audience, appleEntryAudience),
        gt(googleEntryGrants.expiresAt, now),
        isNull(googleEntryGrants.consumedAt),
      ),
    )
    .get();
  if (!validGrant) throw unavailableAppleGrant();
  const apple = await verifyIdentity();
  const subjectDigest = await providerSubjectDigest(
    "apple",
    "",
    apple.subject,
    encryptionKey,
  );
  await assertProviderProofAfterDeletion(
    database,
    "apple",
    "",
    subjectDigest,
    apple.issuedAt,
  );
  const observed = await db
    .select({
      user_id: users.id,
      auth_version: users.authVersion,
      deletion_pending_at: users.deletionPendingAt,
      last_auth_fenced_at: users.lastAuthFencedAt,
    })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userID))
    .where(
      and(
        eq(userIdentities.provider, "apple"),
        eq(userIdentities.providerEnvironment, ""),
        eq(userIdentities.providerSubject, apple.subject),
      ),
    )
    .get();
  if (observed && observed.deletion_pending_at !== null)
    throw unavailableAppleGrant();
  if (
    observed?.last_auth_fenced_at !== null &&
    observed?.last_auth_fenced_at !== undefined &&
    (apple.issuedAt === undefined ||
      apple.issuedAt <= observed.last_auth_fenced_at)
  ) {
    throw unavailableAppleGrant();
  }
  const claimNow = clock();
  await claimAppleRequest(
    database,
    input,
    payloadHash,
    grantHash,
    nonceHash,
    apple,
    subjectDigest,
    observed
      ? { userID: observed.user_id, authVersion: observed.auth_version }
      : null,
    claimNow,
  );
  let providerTokens: AppleAuthorizationTokens;
  try {
    providerTokens = await exchangeAuthorizationCode(apple);
  } catch (error) {
    await markAppleRequestIndeterminate(
      database,
      input.requestID,
      payloadHash,
      now,
    );
    throw error;
  }
  if (providerTokens.clientID !== apple.clientID) {
    await markAppleRequestIndeterminate(
      database,
      input.requestID,
      payloadHash,
      clock(),
    );
    throw unavailableAppleGrant();
  }
  await stageAppleAuthorization(
    database,
    input.requestID,
    payloadHash,
    { apple, providerTokens },
    encryptionKey,
    clock(),
  );
  return commitAppleAuthentication(
    database,
    apple,
    providerTokens,
    input,
    payloadHash,
    grantHash,
    nonceHash,
    jwtSecret,
    encryptionKey,
    nowMilliseconds,
    clock,
    hooks,
  );
}

async function claimAppleRequest(
  database: D1Database,
  input: {
    requestID: string;
    authorizationCode: string;
    displayName?: string;
  },
  payloadHash: string,
  grantHash: string,
  nonceHash: string,
  apple: AppleIdentity,
  subjectDigest: string,
  observed: { userID: number; authVersion: number } | null,
  now: number,
): Promise<void> {
  const codeHash = await sha256Hex(input.authorizationCode);
  try {
    await runDrizzleBatch(database, [
      parameterizedSQL(
        `INSERT INTO apple_auth_requests (
             request_id, payload_hash, grant_hash, nonce_hash,
             authorization_code_hash, state, apple_subject,
             apple_subject_digest, proof_issued_at, client_id,
             observed_user_id, observed_auth_version, provider_email,
             display_name, stage_nonce, stage_ciphertext,
             cleanup_lease_id, cleanup_lease_expires_at,
             cleanup_attempt_count, cleanup_available_at,
             created_at, updated_at, completed_at
           )
           SELECT ?1, ?2, grant.grant_hash, ?3, ?4, 'exchanging', ?5, ?6,
                  ?7, ?8, ?9, ?10, ?11, ?12, NULL, NULL,
                  NULL, NULL, 0, ?13, ?13, ?13, NULL
           FROM google_entry_grants AS grant
           WHERE grant.grant_hash = ?14 AND grant.nonce_hash = ?3
             AND grant.audience = ?15 AND grant.expires_at > ?13
             AND grant.consumed_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM deleted_provider_identity_tombstones AS tombstone
               WHERE tombstone.provider = 'apple'
                 AND tombstone.provider_environment = ''
                 AND tombstone.provider_subject_digest = ?6
                 AND (?7 IS NULL OR ?7 <= tombstone.deleted_at)
             )
             AND (
               (?9 IS NULL AND NOT EXISTS (
                 SELECT 1 FROM user_identities
                 WHERE provider = 'apple' AND provider_environment = ''
                   AND provider_subject = ?5
               ))
               OR (?9 IS NOT NULL AND EXISTS (
                 SELECT 1 FROM user_identities AS identity
                 JOIN users AS user ON user.id = identity.user_id
                 WHERE identity.provider = 'apple'
                   AND identity.provider_environment = ''
                   AND identity.provider_subject = ?5
                   AND user.id = ?9 AND user.auth_version = ?10
                   AND user.deletion_pending_at IS NULL
                   AND (user.last_auth_fenced_at IS NULL OR
                     (?7 IS NOT NULL AND ?7 > user.last_auth_fenced_at))
               ))
             )`,
        [
          input.requestID,
          payloadHash,
          nonceHash,
          codeHash,
          apple.subject,
          subjectDigest,
          apple.issuedAt ?? null,
          apple.clientID,
          observed?.userID ?? null,
          observed?.authVersion ?? null,
          apple.email ?? null,
          normalizedAppleDisplayName(input.displayName),
          now,
          grantHash,
          appleEntryAudience,
        ],
      ),
      parameterizedSQL(
        `UPDATE google_entry_grants SET consumed_at = ?1,
             consumed_request_id = ?2, consumed_payload_hash = ?3
           WHERE grant_hash = ?4 AND nonce_hash = ?5 AND audience = ?6
             AND expires_at > ?1 AND consumed_at IS NULL
             AND EXISTS (
               SELECT 1 FROM apple_auth_requests
               WHERE request_id = ?2 AND payload_hash = ?3
                 AND grant_hash = ?4 AND state = 'exchanging'
             )`,
        [
          now,
          input.requestID,
          payloadHash,
          grantHash,
          nonceHash,
          appleEntryAudience,
        ],
      ),
      parameterizedSQL(
        `INSERT INTO apple_auth_request_assertions (
             request_id, committed, created_at
           ) VALUES (
             ?1,
             CASE WHEN EXISTS (
               SELECT 1 FROM apple_auth_requests AS request
               JOIN google_entry_grants AS grant
                 ON grant.grant_hash = request.grant_hash
               WHERE request.request_id = ?1 AND request.payload_hash = ?2
                 AND request.state = 'exchanging'
                 AND grant.consumed_request_id = ?1
                 AND grant.consumed_payload_hash = ?2
             ) THEN 1 ELSE 0 END,
             ?3
           )`,
        [input.requestID, payloadHash, now],
      ),
    ]);
  } catch (error) {
    const existing = await loadAppleRequestMetadata(database, input.requestID);
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw idempotencyConflict();
      throw indeterminateAppleAuthorization();
    }
    throw error;
  }
}

async function stageAppleAuthorization(
  database: D1Database,
  requestID: string,
  payloadHash: string,
  staged: StagedAppleAuthorization,
  encryptionKey: string,
  now: number,
): Promise<void> {
  const encrypted = await encryptString(
    JSON.stringify(staged),
    encryptionKey,
    `apple-auth-stage:v1:${requestID}`,
  );
  const tombstoneExists = createDatabase(database)
    .select({ value: sql<number>`1` })
    .from(deletedProviderIdentityTombstones)
    .where(
      and(
        eq(deletedProviderIdentityTombstones.provider, "apple"),
        eq(deletedProviderIdentityTombstones.providerEnvironment, ""),
        eq(
          deletedProviderIdentityTombstones.providerSubjectDigest,
          appleAuthRequests.appleSubjectDigest,
        ),
        sql`(${appleAuthRequests.proofIssuedAt} IS NULL OR ${appleAuthRequests.proofIssuedAt} <= ${deletedProviderIdentityTombstones.deletedAt})`,
      ),
    );
  const result = await createDatabase(database)
    .update(appleAuthRequests)
    .set({
      state: "staged",
      stageNonce: encrypted.nonce,
      stageCiphertext: encrypted.ciphertext,
      cleanupAvailableAt: sql`CASE WHEN ${exists(tombstoneExists)} THEN ${now} ELSE ${now + 600} END`,
      updatedAt: now,
    })
    .where(
      and(
        eq(appleAuthRequests.requestID, requestID),
        eq(appleAuthRequests.payloadHash, payloadHash),
        eq(appleAuthRequests.state, "exchanging"),
      ),
    );
  if ((result.meta.changes ?? 0) !== 1) throw indeterminateAppleAuthorization();
}

async function markAppleRequestIndeterminate(
  database: D1Database,
  requestID: string,
  payloadHash: string,
  now: number,
): Promise<void> {
  await createDatabase(database)
    .update(appleAuthRequests)
    .set({ state: "indeterminate", updatedAt: now })
    .where(
      and(
        eq(appleAuthRequests.requestID, requestID),
        eq(appleAuthRequests.payloadHash, payloadHash),
        eq(appleAuthRequests.state, "exchanging"),
      ),
    );
}

async function loadAppleRequest(
  database: D1Database,
  requestID: string,
  payloadHash: string,
  encryptionKey: string,
): Promise<{
  state: string;
  grantHash: string;
  nonceHash: string;
  staged: StagedAppleAuthorization | null;
} | null> {
  const row = await loadAppleRequestMetadata(database, requestID);
  if (!row) return null;
  if (row.payload_hash !== payloadHash) throw idempotencyConflict();
  let staged: StagedAppleAuthorization | null = null;
  if (row.state === "staged" && row.stage_nonce && row.stage_ciphertext) {
    staged = JSON.parse(
      await decryptString(
        row.stage_nonce,
        row.stage_ciphertext,
        encryptionKey,
        `apple-auth-stage:v1:${requestID}`,
      ),
    ) as StagedAppleAuthorization;
  }
  return {
    state: row.state,
    grantHash: row.grant_hash,
    nonceHash: row.nonce_hash,
    staged,
  };
}

function loadAppleRequestMetadata(database: D1Database, requestID: string) {
  return createDatabase(database)
    .select({
      payload_hash: appleAuthRequests.payloadHash,
      grant_hash: appleAuthRequests.grantHash,
      nonce_hash: appleAuthRequests.nonceHash,
      state: appleAuthRequests.state,
      stage_nonce: appleAuthRequests.stageNonce,
      stage_ciphertext: appleAuthRequests.stageCiphertext,
    })
    .from(appleAuthRequests)
    .where(eq(appleAuthRequests.requestID, requestID))
    .get();
}

async function commitAppleAuthentication(
  database: D1Database,
  apple: AppleIdentity,
  providerTokens: AppleAuthorizationTokens,
  input: {
    requestID: string;
    identityToken: string;
    authorizationCode: string;
    entryGrant: string;
    nonce: string;
    displayName?: string;
  },
  payloadHash: string,
  grantHash: string,
  nonceHash: string,
  jwtSecret: string,
  encryptionKey: string,
  _nowMilliseconds: number,
  clock: () => number,
  hooks: AppleAuthenticationHooks,
): Promise<AppleAuthenticationResult> {
  const existing = await createDatabase(database)
    .select({
      identity_id: sql<number>`${userIdentities.id}`.as("identity_id"),
      user_id: sql<number>`${users.id}`.as("user_id"),
      public_id: users.publicID,
      auth_version: users.authVersion,
      display_name: users.displayName,
      profile_revision: users.profileRevision,
      credential_client_id: appleProviderCredentials.clientID,
      credential_nonce: appleProviderCredentials.nonce,
      credential_ciphertext: appleProviderCredentials.ciphertext,
      credential_revision: appleProviderCredentials.credentialRevision,
    })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userID))
    .leftJoin(
      appleProviderCredentials,
      eq(appleProviderCredentials.userIdentityID, userIdentities.id),
    )
    .where(
      and(
        eq(userIdentities.provider, "apple"),
        eq(userIdentities.providerEnvironment, ""),
        eq(userIdentities.providerSubject, apple.subject),
        isNull(users.deletionPendingAt),
      ),
    )
    .get();
  const createsUser = !existing;
  const userID = existing?.user_id ?? randomInternalID();
  const identityID = existing?.identity_id ?? randomInternalID();
  const identity: CominaviIdentity = {
    subject: existing?.public_id ?? randomPublicID(),
    userID,
    authVersion: existing?.auth_version ?? 1,
  };
  const displayName = createsUser
    ? (normalizedAppleDisplayName(input.displayName) ?? "Apple User")
    : existing.display_name;
  const profile = await appleProfile(
    database,
    identity,
    apple,
    createsUser,
    displayName,
  );
  const sessionNow = clock();
  const prepared = await prepareSessionForUser(
    identity,
    profile,
    jwtSecret,
    sessionNow * 1_000,
  );
  const encryptedResult = await encryptString(
    JSON.stringify(prepared.response),
    encryptionKey,
    `apple-auth-result:v1:${input.requestID}`,
  );
  const encryptedCredential = await encryptString(
    JSON.stringify({ refreshToken: providerTokens.refreshToken }),
    encryptionKey,
    `apple-provider-credential:v1:${identity.subject}:${apple.subject}`,
  );
  const displacedRevocation =
    existing?.credential_nonce &&
    existing.credential_ciphertext &&
    existing.credential_client_id
      ? await prepareDisplacedAppleCredential(
          existing,
          apple.subject,
          input.requestID,
          providerTokens.refreshToken,
          encryptionKey,
        )
      : null;
  const finalNow = clock();
  const statements: SQLWrapper[] = [];
  if (createsUser) {
    statements.push(
      parameterizedSQL(
        `INSERT INTO users (
             id, public_id, display_name, display_name_edited, avatar_edited,
             avatar_removed, profile_revision, auth_version, created_at,
             updated_at, last_authenticated_at
           )
           SELECT ?1, ?2, ?3, 0, 0, 0, 1, 1, ?4, ?4, ?4
           FROM apple_auth_requests AS request
           WHERE request.request_id = ?5 AND request.payload_hash = ?6
             AND request.grant_hash = ?7 AND request.state = 'staged'
             AND request.observed_user_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM user_identities
               WHERE provider = 'apple' AND provider_environment = ''
                 AND provider_subject = ?8
             )`,
        [
          userID,
          identity.subject,
          displayName,
          finalNow,
          input.requestID,
          payloadHash,
          grantHash,
          apple.subject,
        ],
      ),
    );
    statements.push(
      parameterizedSQL(
        `INSERT INTO user_identities (
             id, user_id, provider, provider_environment, provider_subject,
             provider_email, provider_display_name, created_at, updated_at,
             last_authenticated_at
           )
           SELECT ?1, user.id, 'apple', '', ?2, ?3, ?4, ?5, ?5, ?5
           FROM users AS user
           JOIN apple_auth_requests AS request ON request.request_id = ?6
           WHERE user.id = ?7 AND user.auth_version = 1
             AND user.deletion_pending_at IS NULL
             AND request.payload_hash = ?8 AND request.grant_hash = ?9
             AND request.state = 'staged'
             AND request.observed_user_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM user_identities
               WHERE provider = 'apple' AND provider_environment = ''
                 AND provider_subject = ?2
             )`,
        [
          identityID,
          apple.subject,
          apple.email ?? null,
          normalizedAppleDisplayName(input.displayName),
          finalNow,
          input.requestID,
          userID,
          payloadHash,
          grantHash,
        ],
      ),
    );
  } else {
    statements.push(
      parameterizedSQL(
        `UPDATE user_identities SET
             provider_email = CASE WHEN ?1 IS NULL THEN provider_email ELSE ?1 END,
             updated_at = ?2, last_authenticated_at = ?2
           WHERE id = ?3 AND user_id = ?4
             AND EXISTS (
               SELECT 1 FROM users
               WHERE id = ?4 AND auth_version = ?5
                 AND display_name = ?6 AND profile_revision = ?7
                 AND deletion_pending_at IS NULL
             )
             AND EXISTS (
               SELECT 1 FROM apple_auth_requests
               WHERE request_id = ?8 AND payload_hash = ?9
                 AND grant_hash = ?10 AND state = 'staged'
                 AND observed_user_id = ?4
                 AND observed_auth_version = ?5
             )`,
        [
          apple.email ?? null,
          finalNow,
          identityID,
          userID,
          identity.authVersion,
          displayName,
          existing.profile_revision,
          input.requestID,
          payloadHash,
          grantHash,
        ],
      ),
    );
  }
  if (displacedRevocation) {
    statements.push(
      parameterizedSQL(
        `INSERT INTO apple_provider_revocations (
             id, client_id, aad, nonce, ciphertext, state, attempt_count,
             lease_id, lease_expires_at, available_at, last_error,
             created_at, updated_at
           )
           SELECT ?1, ?2, ?3, ?4, ?5, 'queued', 0, NULL, NULL, ?6,
                  NULL, ?6, ?6
           FROM apple_provider_credentials AS credential
           JOIN users AS user ON user.id = ?7
           WHERE credential.user_identity_id = ?8
             AND credential.credential_revision = ?9
             AND user.deletion_pending_at IS NULL
           ON CONFLICT(id) DO NOTHING`,
        [
          displacedRevocation.id,
          displacedRevocation.clientID,
          displacedRevocation.aad,
          displacedRevocation.nonce,
          displacedRevocation.ciphertext,
          finalNow,
          userID,
          identityID,
          existing!.credential_revision,
        ],
      ),
    );
  }
  if (existing?.credential_revision == null) {
    statements.push(
      parameterizedSQL(
        `INSERT INTO apple_provider_credentials (
             user_identity_id, client_id, cipher_version, key_version, nonce,
             ciphertext, credential_revision, last_auth_request_id,
             created_at, updated_at
           )
           SELECT identity.id, ?1, 1, 1, ?2, ?3, 1, ?4, ?5, ?5
           FROM user_identities AS identity
           JOIN apple_auth_requests AS request ON request.request_id = ?6
           JOIN users AS user ON user.id = identity.user_id
           WHERE identity.id = ?7 AND identity.user_id = ?8
             AND user.deletion_pending_at IS NULL
             AND request.payload_hash = ?9 AND request.grant_hash = ?10
             AND request.state = 'staged'
             AND (
               (request.observed_user_id IS NULL AND user.created_at = ?5)
               OR (request.observed_user_id = user.id
                 AND request.observed_auth_version = user.auth_version)
             )
           ON CONFLICT(user_identity_id) DO NOTHING`,
        [
          apple.clientID,
          encryptedCredential.nonce,
          encryptedCredential.ciphertext,
          input.requestID,
          finalNow,
          input.requestID,
          identityID,
          userID,
          payloadHash,
          grantHash,
        ],
      ),
    );
  } else {
    statements.push(
      parameterizedSQL(
        `UPDATE apple_provider_credentials SET
             client_id = ?1, nonce = ?2, ciphertext = ?3,
             credential_revision = credential_revision + 1,
             last_auth_request_id = ?4, updated_at = ?5
           WHERE user_identity_id = ?6 AND credential_revision = ?7
             AND last_auth_request_id IS NOT ?4
             AND EXISTS (
               SELECT 1 FROM user_identities AS identity
               JOIN users AS user ON user.id = identity.user_id
               JOIN apple_auth_requests AS request ON request.request_id = ?8
               WHERE identity.id = ?6 AND identity.user_id = ?9
                 AND user.auth_version = ?10
                 AND user.deletion_pending_at IS NULL
                 AND request.payload_hash = ?11 AND request.grant_hash = ?12
                 AND request.state = 'staged'
                 AND request.observed_user_id = user.id
                 AND request.observed_auth_version = user.auth_version
             )`,
        [
          apple.clientID,
          encryptedCredential.nonce,
          encryptedCredential.ciphertext,
          input.requestID,
          finalNow,
          identityID,
          existing.credential_revision,
          input.requestID,
          userID,
          identity.authVersion,
          payloadHash,
          grantHash,
        ],
      ),
    );
  }
  statements.push(
    parameterizedSQL(
      `INSERT INTO auth_refresh_tokens (
           token_hash, user_id, family_id, auth_version, expires_at,
           consumed_at, replaced_by_hash, created_at
         )
         SELECT ?1, user.id, ?2, user.auth_version, ?3, NULL, NULL, ?4
         FROM users AS user
         JOIN apple_provider_credentials AS credential
           ON credential.user_identity_id = ?5
         WHERE user.id = ?6 AND user.auth_version = ?7
           AND user.deletion_pending_at IS NULL
           AND credential.last_auth_request_id = ?8`,
      [
        prepared.tokenHash,
        prepared.familyID,
        prepared.refreshExpiresAt,
        prepared.createdAt,
        identityID,
        userID,
        identity.authVersion,
        input.requestID,
      ],
    ),
  );
  statements.push(
    parameterizedSQL(
      `UPDATE apple_auth_requests SET state = 'completed',
           stage_nonce = NULL, stage_ciphertext = NULL,
           completed_at = ?1, updated_at = ?1
         WHERE request_id = ?2 AND payload_hash = ?3
           AND grant_hash = ?4 AND state = 'staged'
           AND cleanup_lease_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM deleted_provider_identity_tombstones AS tombstone
             WHERE tombstone.provider = 'apple'
               AND tombstone.provider_environment = ''
               AND tombstone.provider_subject_digest =
                 apple_auth_requests.apple_subject_digest
               AND (apple_auth_requests.proof_issued_at IS NULL
                 OR apple_auth_requests.proof_issued_at <= tombstone.deleted_at)
           )
           AND EXISTS (
             SELECT 1 FROM users AS user
             JOIN user_identities AS identity ON identity.user_id = user.id
             JOIN apple_provider_credentials AS credential
               ON credential.user_identity_id = identity.id
             JOIN auth_refresh_tokens AS refresh ON refresh.token_hash = ?5
             WHERE user.id = ?6 AND user.auth_version = ?7
               AND user.deletion_pending_at IS NULL
               AND identity.id = ?8 AND identity.provider_subject = ?9
               AND credential.last_auth_request_id = ?2
               AND refresh.user_id = user.id AND refresh.auth_version = ?7
               AND (
                 (apple_auth_requests.observed_user_id IS NULL
                   AND user.created_at = ?1)
                 OR (apple_auth_requests.observed_user_id = user.id
                   AND apple_auth_requests.observed_auth_version = user.auth_version)
               )
           )`,
      [
        finalNow,
        input.requestID,
        payloadHash,
        grantHash,
        prepared.tokenHash,
        userID,
        identity.authVersion,
        identityID,
        apple.subject,
      ],
    ),
  );
  statements.push(
    parameterizedSQL(
      `INSERT INTO apple_auth_receipts (
           request_id, payload_hash, grant_hash, authorization_code_hash,
           user_id, user_identity_id, result_auth_version, result_token_hash,
           result_nonce, result_ciphertext, replay_expires_at, created_at
         )
         SELECT ?1, ?2, ?3, ?4, user.id, identity.id, user.auth_version,
                ?5, ?6, ?7, ?8, ?9
         FROM users AS user
         JOIN user_identities AS identity ON identity.id = ?10
         JOIN auth_refresh_tokens AS refresh ON refresh.token_hash = ?5
         JOIN apple_provider_credentials AS credential
           ON credential.user_identity_id = identity.id
         JOIN apple_auth_requests AS request ON request.request_id = ?1
         WHERE user.id = ?11 AND identity.user_id = user.id
           AND user.auth_version = ?12
           AND user.deletion_pending_at IS NULL
           AND credential.last_auth_request_id = ?1
           AND request.payload_hash = ?2 AND request.state = 'completed'
           AND (
             (request.observed_user_id IS NULL AND user.created_at = ?9)
             OR (request.observed_user_id = user.id
               AND request.observed_auth_version = user.auth_version)
           )
           AND refresh.user_id = user.id AND refresh.auth_version = ?12`,
      [
        input.requestID,
        payloadHash,
        grantHash,
        await sha256Hex(input.authorizationCode),
        prepared.tokenHash,
        encryptedResult.nonce,
        encryptedResult.ciphertext,
        prepared.refreshExpiresAt,
        finalNow,
        identityID,
        userID,
        identity.authVersion,
      ],
    ),
  );
  statements.push(
    parameterizedSQL(
      `INSERT INTO apple_auth_atomic_assertions (
           request_id, committed, created_at
         ) VALUES (
           ?1,
           CASE WHEN EXISTS (
             SELECT 1 FROM apple_auth_receipts
             WHERE request_id = ?1 AND payload_hash = ?2
               AND result_token_hash = ?3
           ) AND (?4 IS NULL OR EXISTS (
             SELECT 1 FROM apple_provider_revocations WHERE id = ?4
           )) THEN 1 ELSE 0 END,
           ?5
         )`,
      [
        input.requestID,
        payloadHash,
        prepared.tokenHash,
        displacedRevocation?.id ?? null,
        finalNow,
      ],
    ),
  );
  await hooks.beforeFinalBatch?.();
  await runDrizzleBatch(database, statements as [SQLWrapper, ...SQLWrapper[]]);
  const stored = await loadAppleReplay(
    database,
    input.requestID,
    payloadHash,
    encryptionKey,
    finalNow,
  );
  if (!stored) throw unavailableAppleGrant();
  return stored;
}

export async function loadAppleRefreshCredential(
  database: D1Database,
  userIdentityID: number,
  publicID: string,
  providerSubject: string,
  encryptionKey: string,
): Promise<{ refreshToken: string; clientID: string } | null> {
  const row = await createDatabase(database)
    .select({
      client_id: appleProviderCredentials.clientID,
      nonce: appleProviderCredentials.nonce,
      ciphertext: appleProviderCredentials.ciphertext,
    })
    .from(appleProviderCredentials)
    .where(eq(appleProviderCredentials.userIdentityID, userIdentityID))
    .get();
  if (!row) return null;
  const value = JSON.parse(
    await decryptString(
      row.nonce,
      row.ciphertext,
      encryptionKey,
      `apple-provider-credential:v1:${publicID}:${providerSubject}`,
    ),
  ) as { refreshToken: string };
  return { refreshToken: value.refreshToken, clientID: row.client_id };
}

export async function processAppleRevocations(
  database: D1Database,
  bindings: AppleAuthBindings,
  encryptionKey: string,
  fetcher: typeof fetch = fetch,
  nowMilliseconds = Date.now(),
  revoke: typeof revokeAppleRefreshToken = revokeAppleRefreshToken,
): Promise<number> {
  const now = Math.floor(nowMilliseconds / 1_000);
  let completed = 0;
  const db = createDatabase(database);
  const queued = await db
    .select({
      id: appleProviderRevocations.id,
      client_id: appleProviderRevocations.clientID,
      aad: appleProviderRevocations.aad,
      nonce: appleProviderRevocations.nonce,
      ciphertext: appleProviderRevocations.ciphertext,
      attempt_count: appleProviderRevocations.attemptCount,
    })
    .from(appleProviderRevocations)
    .where(
      or(
        and(
          eq(appleProviderRevocations.state, "queued"),
          lte(appleProviderRevocations.availableAt, now),
        ),
        and(
          eq(appleProviderRevocations.state, "leased"),
          lte(appleProviderRevocations.leaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(
      asc(appleProviderRevocations.availableAt),
      asc(appleProviderRevocations.createdAt),
    )
    .limit(20);
  for (const item of queued) {
    const leaseID = crypto.randomUUID();
    const leased = await db
      .update(appleProviderRevocations)
      .set({
        state: "leased",
        leaseID,
        leaseExpiresAt: now + 60,
        updatedAt: now,
      })
      .where(
        and(
          eq(appleProviderRevocations.id, item.id),
          or(
            and(
              eq(appleProviderRevocations.state, "queued"),
              lte(appleProviderRevocations.availableAt, now),
            ),
            and(
              eq(appleProviderRevocations.state, "leased"),
              lte(appleProviderRevocations.leaseExpiresAt, now),
            ),
          ),
        ),
      );
    if ((leased.meta.changes ?? 0) !== 1) continue;
    try {
      const value = JSON.parse(
        await decryptString(
          item.nonce,
          item.ciphertext,
          encryptionKey,
          item.aad,
        ),
      ) as { refreshToken: string };
      await revoke(
        value.refreshToken,
        item.client_id,
        bindings,
        nowMilliseconds,
        fetcher,
      );
      await db
        .delete(appleProviderRevocations)
        .where(
          and(
            eq(appleProviderRevocations.id, item.id),
            eq(appleProviderRevocations.leaseID, leaseID),
          ),
        );
      completed += 1;
    } catch (error) {
      await db
        .update(appleProviderRevocations)
        .set({
          state: "queued",
          attemptCount: sql`${appleProviderRevocations.attemptCount} + 1`,
          leaseID: null,
          leaseExpiresAt: null,
          availableAt:
            now + Math.min(3_600, 60 * 2 ** Math.min(item.attempt_count, 5)),
          lastError: (error instanceof Error
            ? error.message
            : "revoke_failed"
          ).slice(0, 500),
          updatedAt: now,
        })
        .where(
          and(
            eq(appleProviderRevocations.id, item.id),
            eq(appleProviderRevocations.leaseID, leaseID),
          ),
        );
    }
  }

  const stages = await db
    .select({
      request_id: appleAuthRequests.requestID,
      client_id: appleAuthRequests.clientID,
      stage_nonce: appleAuthRequests.stageNonce,
      stage_ciphertext: appleAuthRequests.stageCiphertext,
      cleanup_attempt_count: appleAuthRequests.cleanupAttemptCount,
    })
    .from(appleAuthRequests)
    .where(
      and(
        eq(appleAuthRequests.state, "staged"),
        isNotNull(appleAuthRequests.stageNonce),
        isNotNull(appleAuthRequests.stageCiphertext),
        lte(appleAuthRequests.cleanupAvailableAt, now),
        or(
          isNull(appleAuthRequests.cleanupLeaseID),
          lte(appleAuthRequests.cleanupLeaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(
      asc(appleAuthRequests.cleanupAvailableAt),
      asc(appleAuthRequests.createdAt),
    )
    .limit(20);
  for (const item of stages) {
    if (!item.stage_nonce || !item.stage_ciphertext) continue;
    const leaseID = crypto.randomUUID();
    const leased = await db
      .update(appleAuthRequests)
      .set({
        cleanupLeaseID: leaseID,
        cleanupLeaseExpiresAt: now + 60,
        updatedAt: now,
      })
      .where(
        and(
          eq(appleAuthRequests.requestID, item.request_id),
          eq(appleAuthRequests.state, "staged"),
          lte(appleAuthRequests.cleanupAvailableAt, now),
          or(
            isNull(appleAuthRequests.cleanupLeaseID),
            lte(appleAuthRequests.cleanupLeaseExpiresAt, now),
          ),
        ),
      );
    if ((leased.meta.changes ?? 0) !== 1) continue;
    try {
      const staged = JSON.parse(
        await decryptString(
          item.stage_nonce,
          item.stage_ciphertext,
          encryptionKey,
          `apple-auth-stage:v1:${item.request_id}`,
        ),
      ) as StagedAppleAuthorization;
      await revoke(
        staged.providerTokens.refreshToken,
        item.client_id,
        bindings,
        nowMilliseconds,
        fetcher,
      );
      await db
        .delete(appleAuthRequests)
        .where(
          and(
            eq(appleAuthRequests.requestID, item.request_id),
            eq(appleAuthRequests.cleanupLeaseID, leaseID),
            eq(appleAuthRequests.state, "staged"),
          ),
        );
      completed += 1;
    } catch (error) {
      await db
        .update(appleAuthRequests)
        .set({
          cleanupLeaseID: null,
          cleanupLeaseExpiresAt: null,
          cleanupAttemptCount: sql`${appleAuthRequests.cleanupAttemptCount} + 1`,
          cleanupAvailableAt:
            now +
            Math.min(3_600, 60 * 2 ** Math.min(item.cleanup_attempt_count, 5)),
          updatedAt: now,
        })
        .where(
          and(
            eq(appleAuthRequests.requestID, item.request_id),
            eq(appleAuthRequests.cleanupLeaseID, leaseID),
          ),
        );
    }
  }
  return completed;
}

async function prepareDisplacedAppleCredential(
  existing: {
    public_id: string;
    identity_id: number;
    credential_client_id: string | null;
    credential_nonce: string | null;
    credential_ciphertext: string | null;
  },
  providerSubject: string,
  requestID: string,
  successorRefreshToken: string,
  encryptionKey: string,
) {
  const value = JSON.parse(
    await decryptString(
      existing.credential_nonce!,
      existing.credential_ciphertext!,
      encryptionKey,
      `apple-provider-credential:v1:${existing.public_id}:${providerSubject}`,
    ),
  ) as { refreshToken: string };
  if (await equalSecret(value.refreshToken, successorRefreshToken)) return null;
  const id = `reauth:${requestID}`;
  const aad = `apple-provider-revocation:v1:${id}`;
  const encrypted = await encryptString(
    JSON.stringify({ refreshToken: value.refreshToken }),
    encryptionKey,
    aad,
  );
  return {
    id,
    clientID: existing.credential_client_id!,
    aad,
    ...encrypted,
  };
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const [aBuffer, bBuffer] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const a = new Uint8Array(aBuffer);
  const b = new Uint8Array(bBuffer);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1)
    difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

async function loadAppleReplay(
  database: D1Database,
  requestID: string,
  payloadHash: string,
  encryptionKey: string,
  now: number,
): Promise<AppleAuthenticationResult | null> {
  const db = createDatabase(database);
  const row = await db
    .select({
      payload_hash: appleAuthReceipts.payloadHash,
      user_id: appleAuthReceipts.userID,
      result_auth_version: appleAuthReceipts.resultAuthVersion,
      result_token_hash: appleAuthReceipts.resultTokenHash,
      result_nonce: appleAuthReceipts.resultNonce,
      result_ciphertext: appleAuthReceipts.resultCiphertext,
      replay_expires_at: appleAuthReceipts.replayExpiresAt,
      public_id: users.publicID,
      consumed_at: authRefreshTokens.consumedAt,
      expires_at: authRefreshTokens.expiresAt,
    })
    .from(appleAuthReceipts)
    .innerJoin(users, eq(users.id, appleAuthReceipts.userID))
    .innerJoin(
      authRefreshTokens,
      eq(authRefreshTokens.tokenHash, appleAuthReceipts.resultTokenHash),
    )
    .where(
      and(
        eq(appleAuthReceipts.requestID, requestID),
        isNull(users.deletionPendingAt),
      ),
    )
    .get();
  if (!row) return null;
  if (row.payload_hash !== payloadHash) throw idempotencyConflict();
  const current = await db
    .select({ auth_version: users.authVersion })
    .from(users)
    .where(and(eq(users.id, row.user_id), isNull(users.deletionPendingAt)))
    .get();
  if (
    !current ||
    current.auth_version !== row.result_auth_version ||
    row.replay_expires_at <= now ||
    row.consumed_at !== null ||
    row.expires_at <= now
  ) {
    throw unavailableAppleGrant();
  }
  const response = JSON.parse(
    await decryptString(
      row.result_nonce,
      row.result_ciphertext,
      encryptionKey,
      `apple-auth-result:v1:${requestID}`,
    ),
  ) as SessionResponse;
  return {
    response,
    identity: {
      subject: row.public_id,
      userID: row.user_id,
      authVersion: row.result_auth_version,
    },
  };
}

async function appleProfile(
  database: D1Database,
  identity: CominaviIdentity,
  apple: AppleIdentity,
  createsUser: boolean,
  displayName: string,
): Promise<UserProfile> {
  const item = {
    provider: "apple" as const,
    ...(apple.email ? { email: apple.email } : {}),
  };
  if (createsUser) {
    return {
      id: identity.subject,
      displayName,
      avatarURL: null,
      revision: 1,
      identities: [item],
    };
  }
  const profile = await loadUserProfile(database, identity.userID);
  return {
    ...profile,
    identities: profile.identities.map((candidate) =>
      candidate.provider === "apple" ? item : candidate,
    ),
  };
}

function normalizedAppleDisplayName(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized ? Array.from(normalized).slice(0, 80).join("") : null;
}

async function applePayloadHash(input: {
  requestID: string;
  identityToken: string;
  authorizationCode: string;
  entryGrant: string;
  nonce: string;
  displayName?: string;
}): Promise<string> {
  if (
    input.identityToken.length > 16_384 ||
    input.authorizationCode.length < 1 ||
    input.authorizationCode.length > 4_096 ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.entryGrant) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.nonce)
  ) {
    throw unavailableAppleGrant();
  }
  return sha256Hex(
    JSON.stringify({
      v: 1,
      requestID: input.requestID,
      identityTokenHash: await sha256Hex(input.identityToken),
      authorizationCodeHash: await sha256Hex(input.authorizationCode),
      grantHash: await sha256Hex(input.entryGrant),
      nonceHash: await sha256Hex(input.nonce),
      displayName: normalizedAppleDisplayName(input.displayName),
    }),
  );
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
    throw unavailableAppleGrant();
  }
}

export function decryptAppleStoredValue(
  nonce: string,
  ciphertext: string,
  encodedKey: string,
  additionalData: string,
): Promise<string> {
  return decryptString(nonce, ciphertext, encodedKey, additionalData);
}

export function encryptAppleStoredValue(
  value: string,
  encodedKey: string,
  additionalData: string,
): Promise<{ nonce: string; ciphertext: string }> {
  return encryptString(value, encodedKey, additionalData);
}

async function replayCryptoKey(encoded: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(decodeBase64URL(encoded));
  if (bytes.byteLength !== 32) throw unavailableAppleGrant();
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function unavailableAppleGrant(): ServiceError {
  return new ServiceError(
    "invalid_entry_grant",
    401,
    "The Apple sign-in entry grant is invalid or has already been used.",
  );
}

function idempotencyConflict(): ServiceError {
  return new ServiceError(
    "idempotency_conflict",
    409,
    "This requestId was already used with a different Apple sign-in payload.",
  );
}

function indeterminateAppleAuthorization(): ServiceError {
  return new ServiceError(
    "apple_authorization_indeterminate",
    409,
    "Apple may have consumed this authorization code. Start a fresh Apple sign-in flow.",
  );
}
