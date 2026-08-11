import {
  and,
  eq,
  exists,
  gt,
  isNull,
  lte,
  notExists,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { runDrizzleBatch } from "../db/batch";
import { createDatabase } from "../db/client";
import {
  authRefreshTokens,
  circlemsOAuthCompletions,
  circlemsOAuthStarts,
  providerCredentials,
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
  authenticateCirclems,
  type CirclemsEnvironment,
  type CominaviAuthBindings,
  type CominaviIdentity,
} from "./cominavi-auth";
import {
  circlemsAuthorizationURL,
  exchangeCirclemsAuthorizationCode,
  type CirclemsEnvironmentBindings,
} from "./circlems-oauth";
import {
  encryptCircleCredentialForOwner,
  type CircleCredential,
} from "./provider-credentials";
import { parseCanonicalRequestID } from "./request-id";
import { ServiceError } from "./service-error";
import {
  assertProviderProofAfterDeletion,
  providerSubjectDigest,
} from "./provider-tombstones";
import { loadUserProfile, type UserProfile } from "./users";

const startLifetimeSeconds = 10 * 60;
const completionLifetimeSeconds = 2 * 60;
const processingRecoverySeconds = 60;
const canonicalPKCE = /^[A-Za-z0-9_-]{43}$/;
const canonicalVerifier = /^[A-Za-z0-9._~-]{43,128}$/;

export interface CirclemsOAuthFlowBindings
  extends CirclemsEnvironmentBindings, CominaviAuthBindings {
  COMINAVI_DB: D1Database;
  COMINAVI_PROVIDER_CREDENTIAL_KEY_V1: string;
}

export interface CirclemsOAuthStartInput {
  requestId: string;
  clientInstanceID: string;
  environment: CirclemsEnvironment;
  codeChallenge: string;
}

export interface CirclemsOAuthStartResponse {
  authorizationURL: string;
  expiresAt: string;
}

export interface CirclemsOAuthCompleteInput {
  requestId: string;
  clientInstanceID: string;
  completionCode: string;
  codeVerifier: string;
}

export interface CirclemsOAuthCredentialReceipt {
  requestId: string;
  clientInstanceID: string;
  provider: "circlems";
  environment: CirclemsEnvironment;
  subject: string;
  credentialRevision: number;
}

export type CirclemsAuthenticationCompletion = SessionResponse & {
  credentialReceipt: CirclemsOAuthCredentialReceipt;
};

export interface CirclemsLinkCompletion {
  user: UserProfile;
  credentialReceipt: CirclemsOAuthCredentialReceipt;
}

type Purpose = "authenticate" | "link";

interface StartRow {
  id: string;
  purpose: Purpose;
  request_id: string;
  client_instance_id: string;
  environment: CirclemsEnvironment;
  code_challenge: string;
  payload_hash: string;
  state_nonce: string | null;
  state_ciphertext: string | null;
  link_user_id: number | null;
  link_auth_version: number | null;
  expires_at: number;
  callback_lease_id: string | null;
  completion_code_hash: string | null;
  completion_code_nonce: string | null;
  completion_code_ciphertext: string | null;
  callback_completed_at: number | null;
  created_at: number;
}

interface CompletionRow extends StartRow {
  code_hash: string;
  provider_subject: string | null;
  provider_subject_digest: string;
  proof_issued_at: number;
  provider_user_id: number | null;
  provider_display_name: string | null;
  credential_nonce: string | null;
  credential_ciphertext: string | null;
  completion_expires_at: number;
  completion_request_id: string | null;
  completion_payload_hash: string | null;
  processing_lease_id: string | null;
  processing_started_at: number | null;
  user_id: number | null;
  user_identity_id: number | null;
  result_auth_version: number | null;
  result_token_hash: string | null;
  result_nonce: string | null;
  result_ciphertext: string | null;
  credential_revision: number | null;
  completed_at: number | null;
}

const startSelection = {
  id: circlemsOAuthStarts.id,
  purpose: circlemsOAuthStarts.purpose,
  request_id: circlemsOAuthStarts.requestID,
  client_instance_id: circlemsOAuthStarts.clientInstanceID,
  environment: circlemsOAuthStarts.environment,
  code_challenge: circlemsOAuthStarts.codeChallenge,
  payload_hash: circlemsOAuthStarts.payloadHash,
  state_nonce: circlemsOAuthStarts.stateNonce,
  state_ciphertext: circlemsOAuthStarts.stateCiphertext,
  link_user_id: circlemsOAuthStarts.linkUserID,
  link_auth_version: circlemsOAuthStarts.linkAuthVersion,
  expires_at: circlemsOAuthStarts.expiresAt,
  callback_lease_id: circlemsOAuthStarts.callbackLeaseID,
  completion_code_hash: circlemsOAuthStarts.completionCodeHash,
  completion_code_nonce: circlemsOAuthStarts.completionCodeNonce,
  completion_code_ciphertext: circlemsOAuthStarts.completionCodeCiphertext,
  callback_completed_at: circlemsOAuthStarts.callbackCompletedAt,
  created_at: circlemsOAuthStarts.createdAt,
};

const completionSelection = {
  code_hash: circlemsOAuthCompletions.codeHash,
  provider_subject: circlemsOAuthCompletions.providerSubject,
  provider_subject_digest: circlemsOAuthCompletions.providerSubjectDigest,
  proof_issued_at: circlemsOAuthCompletions.proofIssuedAt,
  provider_user_id: circlemsOAuthCompletions.providerUserID,
  provider_display_name: circlemsOAuthCompletions.providerDisplayName,
  credential_nonce: circlemsOAuthCompletions.credentialNonce,
  credential_ciphertext: circlemsOAuthCompletions.credentialCiphertext,
  completion_expires_at: sql<number>`${circlemsOAuthCompletions.expiresAt}`.as(
    "completion_expires_at",
  ),
  completion_request_id: circlemsOAuthCompletions.completionRequestID,
  completion_payload_hash: circlemsOAuthCompletions.completionPayloadHash,
  processing_lease_id: circlemsOAuthCompletions.processingLeaseID,
  processing_started_at: circlemsOAuthCompletions.processingStartedAt,
  user_id: circlemsOAuthCompletions.userID,
  user_identity_id: circlemsOAuthCompletions.userIdentityID,
  result_auth_version: circlemsOAuthCompletions.resultAuthVersion,
  result_token_hash: circlemsOAuthCompletions.resultTokenHash,
  result_nonce: circlemsOAuthCompletions.resultNonce,
  result_ciphertext: circlemsOAuthCompletions.resultCiphertext,
  credential_revision: circlemsOAuthCompletions.credentialRevision,
  completed_at: circlemsOAuthCompletions.completedAt,
  ...startSelection,
};

export function parseCirclemsOAuthStartInput(
  value: Record<string, unknown>,
): CirclemsOAuthStartInput {
  const requestId = parseCanonicalRequestID(value.requestId);
  const clientInstanceID = parseCanonicalRequestID(value.clientInstanceID);
  if (
    (value.environment !== "production" && value.environment !== "sandbox") ||
    typeof value.codeChallenge !== "string" ||
    !canonicalPKCE.test(value.codeChallenge)
  ) {
    throw invalidFlow();
  }
  return {
    requestId,
    clientInstanceID,
    environment: value.environment,
    codeChallenge: value.codeChallenge,
  };
}

export function parseCirclemsOAuthCompleteInput(
  value: Record<string, unknown>,
): CirclemsOAuthCompleteInput {
  const requestId = parseCanonicalRequestID(value.requestId);
  const clientInstanceID = parseCanonicalRequestID(value.clientInstanceID);
  if (
    typeof value.completionCode !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.completionCode) ||
    typeof value.codeVerifier !== "string" ||
    !canonicalVerifier.test(value.codeVerifier)
  ) {
    throw invalidFlow();
  }
  return {
    requestId,
    clientInstanceID,
    completionCode: value.completionCode,
    codeVerifier: value.codeVerifier,
  };
}

export async function startCirclemsOAuth(
  bindings: CirclemsOAuthFlowBindings,
  purpose: Purpose,
  input: CirclemsOAuthStartInput,
  linkIdentity?: CominaviIdentity,
  now = Math.floor(Date.now() / 1_000),
): Promise<CirclemsOAuthStartResponse> {
  if ((purpose === "link") !== Boolean(linkIdentity)) throw invalidFlow();
  const payloadHash = await sha256Hex(
    JSON.stringify({
      v: 1,
      purpose,
      ...input,
      linkUserID: linkIdentity?.userID ?? null,
      linkAuthVersion: linkIdentity?.authVersion ?? null,
    }),
  );
  let stored = await loadStartByRequest(
    bindings.COMINAVI_DB,
    purpose,
    input.requestId,
  );
  if (!stored) {
    const startID = crypto.randomUUID();
    const state = randomToken();
    const encryptedState = await encryptString(
      state,
      bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
      `circlems-oauth-state:v1:${startID}`,
    );
    const db = createDatabase(bindings.COMINAVI_DB);
    await db
      .insert(circlemsOAuthStarts)
      .values({
        id: startID,
        purpose,
        requestID: input.requestId,
        clientInstanceID: input.clientInstanceID,
        environment: input.environment,
        codeChallenge: input.codeChallenge,
        payloadHash,
        stateHash: await sha256Hex(state),
        stateNonce: encryptedState.nonce,
        stateCiphertext: encryptedState.ciphertext,
        linkUserID: linkIdentity?.userID ?? null,
        linkAuthVersion: linkIdentity?.authVersion ?? null,
        expiresAt: now + startLifetimeSeconds,
        createdAt: now,
      })
      .onConflictDoNothing({
        target: [circlemsOAuthStarts.purpose, circlemsOAuthStarts.requestID],
      })
      .run();
    stored = await loadStartByRequest(
      bindings.COMINAVI_DB,
      purpose,
      input.requestId,
    );
  }
  if (!stored || stored.payload_hash !== payloadHash)
    throw idempotencyConflict();
  if (stored.expires_at <= now) throw unavailableFlow();
  if (
    purpose === "link" &&
    (stored.link_user_id !== linkIdentity?.userID ||
      stored.link_auth_version !== linkIdentity.authVersion)
  ) {
    throw unavailableFlow();
  }
  if (!stored.state_nonce || !stored.state_ciphertext) throw unavailableFlow();
  const state = await decryptString(
    stored.state_nonce,
    stored.state_ciphertext,
    bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
    `circlems-oauth-state:v1:${stored.id}`,
  );
  return {
    authorizationURL: circlemsAuthorizationURL(
      stored.environment,
      state,
      bindings,
    ).toString(),
    expiresAt: new Date(stored.expires_at * 1_000).toISOString(),
  };
}

export async function finishCirclemsOAuthCallback(
  bindings: CirclemsOAuthFlowBindings,
  state: string,
  authorizationCode: string,
  fetcher: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1_000),
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw unavailableFlow();
  const stateHash = await sha256Hex(state);
  const db = createDatabase(bindings.COMINAVI_DB);
  const start = await db
    .select(startSelection)
    .from(circlemsOAuthStarts)
    .where(eq(circlemsOAuthStarts.stateHash, stateHash))
    .get();
  if (!start || start.expires_at <= now) {
    throw unavailableFlow();
  }
  if (
    start.callback_completed_at !== null &&
    start.completion_code_nonce &&
    start.completion_code_ciphertext
  ) {
    const completion = await db
      .select({ expiresAt: circlemsOAuthCompletions.expiresAt })
      .from(circlemsOAuthCompletions)
      .where(eq(circlemsOAuthCompletions.startID, start.id))
      .get();
    if (!completion || completion.expiresAt <= now) throw unavailableFlow();
    return decryptString(
      start.completion_code_nonce,
      start.completion_code_ciphertext,
      bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
      `circlems-oauth-completion-code:v1:${start.id}`,
    );
  }
  const leaseID = crypto.randomUUID();
  const claimed = await db
    .update(circlemsOAuthStarts)
    .set({ callbackLeaseID: leaseID, callbackClaimedAt: now })
    .where(
      and(
        eq(circlemsOAuthStarts.id, start.id),
        isNull(circlemsOAuthStarts.callbackLeaseID),
        isNull(circlemsOAuthStarts.callbackCompletedAt),
        gt(circlemsOAuthStarts.expiresAt, now),
      ),
    )
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) throw unavailableFlow();
  try {
    const token = await exchangeCirclemsAuthorizationCode(
      authorizationCode,
      start.environment,
      bindings,
      fetcher,
    );
    const identity = await authenticateCirclems(
      token.access_token,
      start.environment,
      bindings,
      fetcher,
    );
    const subjectDigest = await providerSubjectDigest(
      "circlems",
      start.environment,
      String(identity.circlemsUserID),
      bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
    );
    await assertProviderProofAfterDeletion(
      bindings.COMINAVI_DB,
      "circlems",
      start.environment,
      subjectDigest,
      start.created_at,
    );
    const expiresIn = Number(token.expires_in);
    const credential: CircleCredential = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessExpiresAt:
        Number.isSafeInteger(expiresIn) && expiresIn > 0
          ? now + expiresIn
          : null,
      scopes: [],
    };
    const encryptedCredential = await encryptString(
      JSON.stringify(credential),
      bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
      `circlems-oauth-staged-credential:v1:${start.id}`,
    );
    const completionCode = randomToken();
    const completionCodeHash = await sha256Hex(completionCode);
    const encryptedCompletionCode = await encryptString(
      completionCode,
      bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
      `circlems-oauth-completion-code:v1:${start.id}`,
    );
    const results = await runDrizzleBatch(bindings.COMINAVI_DB, [
      sql`INSERT INTO circlems_oauth_completions (
           code_hash, start_id, provider_subject, provider_subject_digest,
           proof_issued_at, provider_user_id,
           provider_display_name, credential_nonce, credential_ciphertext,
           expires_at, created_at
         )
         SELECT ${completionCodeHash}, id, ${String(identity.circlemsUserID)},
                ${subjectDigest}, ${start.created_at}, ${identity.circlemsUserID},
                ${identity.nickname ?? null}, ${encryptedCredential.nonce},
                ${encryptedCredential.ciphertext},
                ${now + completionLifetimeSeconds}, ${now}
         FROM circlems_oauth_starts
         WHERE id = ${start.id} AND callback_lease_id = ${leaseID}
           AND callback_completed_at IS NULL AND expires_at > ${now}
           AND NOT EXISTS (
             SELECT 1 FROM deleted_provider_identity_tombstones AS tombstone
             WHERE tombstone.provider = 'circlems'
               AND tombstone.provider_environment = ${start.environment}
               AND tombstone.provider_subject_digest = ${subjectDigest}
               AND ${start.created_at} <= tombstone.deleted_at
           )
           AND NOT EXISTS (
             SELECT 1 FROM user_identities AS identity
             JOIN users AS user ON user.id = identity.user_id
             WHERE identity.provider = 'circlems'
               AND identity.provider_environment = ${start.environment}
               AND identity.provider_subject = ${String(identity.circlemsUserID)}
               AND user.last_auth_fenced_at IS NOT NULL
               AND ${start.created_at} <= user.last_auth_fenced_at
           )`,
      sql`UPDATE circlems_oauth_starts SET
           completion_code_hash = ${completionCodeHash},
           completion_code_nonce = ${encryptedCompletionCode.nonce},
           completion_code_ciphertext = ${encryptedCompletionCode.ciphertext},
           callback_completed_at = ${now}
         WHERE id = ${start.id} AND callback_lease_id = ${leaseID}
           AND callback_completed_at IS NULL
           AND EXISTS (
             SELECT 1 FROM circlems_oauth_completions
             WHERE start_id = ${start.id} AND code_hash = ${completionCodeHash}
           )`,
    ]);
    if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw unavailableFlow();
    }
    return completionCode;
  } catch (error) {
    await db
      .update(circlemsOAuthStarts)
      .set({ callbackLeaseID: null, callbackClaimedAt: null })
      .where(
        and(
          eq(circlemsOAuthStarts.id, start.id),
          eq(circlemsOAuthStarts.callbackLeaseID, leaseID),
          isNull(circlemsOAuthStarts.callbackCompletedAt),
        ),
      )
      .run();
    throw error;
  }
}

export async function completeCirclemsAuthentication(
  bindings: CirclemsOAuthFlowBindings,
  input: CirclemsOAuthCompleteInput,
  nowMilliseconds = Date.now(),
  clock: () => number = () => Math.floor(Date.now() / 1_000),
): Promise<CirclemsAuthenticationCompletion> {
  return completeCirclemsOAuth(
    bindings,
    "authenticate",
    input,
    undefined,
    nowMilliseconds,
    clock,
  ) as Promise<CirclemsAuthenticationCompletion>;
}

export async function completeCirclemsLink(
  bindings: CirclemsOAuthFlowBindings,
  input: CirclemsOAuthCompleteInput,
  linkIdentity: CominaviIdentity,
  nowMilliseconds = Date.now(),
  clock: () => number = () => Math.floor(Date.now() / 1_000),
): Promise<CirclemsLinkCompletion> {
  return completeCirclemsOAuth(
    bindings,
    "link",
    input,
    linkIdentity,
    nowMilliseconds,
    clock,
  ) as Promise<CirclemsLinkCompletion>;
}

async function completeCirclemsOAuth(
  bindings: CirclemsOAuthFlowBindings,
  purpose: Purpose,
  input: CirclemsOAuthCompleteInput,
  linkIdentity: CominaviIdentity | undefined,
  nowMilliseconds: number,
  clock: () => number,
): Promise<CirclemsAuthenticationCompletion | CirclemsLinkCompletion> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const codeHash = await sha256Hex(input.completionCode);
  let row = await loadCompletion(bindings.COMINAVI_DB, codeHash);
  if (!row || row.purpose !== purpose) throw unavailableFlow();
  if (
    row.request_id !== input.requestId ||
    row.client_instance_id !== input.clientInstanceID
  ) {
    throw unavailableFlow();
  }
  const verifierChallenge = await sha256Base64URL(input.codeVerifier);
  if (!constantTimeEqual(verifierChallenge, row.code_challenge)) {
    throw unavailableFlow();
  }
  const payloadHash = await sha256Hex(
    JSON.stringify({
      v: 1,
      purpose,
      requestId: input.requestId,
      clientInstanceID: input.clientInstanceID,
      completionCodeHash: codeHash,
      verifierHash: await sha256Hex(input.codeVerifier),
    }),
  );
  const replay = await loadCompletionReplay(
    bindings,
    row,
    payloadHash,
    linkIdentity,
    now,
  );
  if (replay) return replay;
  if (row.completion_expires_at <= now) throw unavailableFlow();
  if (
    row.completion_request_id &&
    row.completion_payload_hash !== payloadHash
  ) {
    throw idempotencyConflict();
  }
  const processingLeaseID = crypto.randomUUID();
  const db = createDatabase(bindings.COMINAVI_DB);
  const claimed = await db
    .update(circlemsOAuthCompletions)
    .set({
      completionRequestID: input.requestId,
      completionPayloadHash: payloadHash,
      processingLeaseID,
      processingStartedAt: now,
    })
    .where(
      and(
        eq(circlemsOAuthCompletions.codeHash, codeHash),
        isNull(circlemsOAuthCompletions.resultCiphertext),
        gt(circlemsOAuthCompletions.expiresAt, now),
        or(
          isNull(circlemsOAuthCompletions.completionRequestID),
          lte(
            circlemsOAuthCompletions.processingStartedAt,
            now - processingRecoverySeconds,
          ),
        ),
      ),
    )
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) throw completionInProgress();
  row = (await loadCompletion(bindings.COMINAVI_DB, codeHash))!;
  if (row.processing_lease_id !== processingLeaseID)
    throw completionInProgress();
  if (
    !row.provider_subject ||
    !row.provider_user_id ||
    !row.credential_nonce ||
    !row.credential_ciphertext
  ) {
    throw unavailableFlow();
  }
  if (purpose === "link") {
    if (
      !linkIdentity ||
      row.link_user_id !== linkIdentity.userID ||
      row.link_auth_version !== linkIdentity.authVersion
    ) {
      throw unavailableFlow();
    }
  }
  const credential = JSON.parse(
    await decryptString(
      row.credential_nonce,
      row.credential_ciphertext,
      bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
      `circlems-oauth-staged-credential:v1:${row.id}`,
    ),
  ) as CircleCredential;
  const existing = await db
    .select({
      identity_id: sql<number>`${userIdentities.id}`.as("identity_id"),
      user_id: sql<number>`${users.id}`.as("user_id"),
      public_id: users.publicID,
      auth_version: users.authVersion,
      credential_revision: providerCredentials.credentialRevision,
      last_oauth_flow_id: providerCredentials.lastOAuthFlowID,
      last_auth_fenced_at: users.lastAuthFencedAt,
    })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userID))
    .leftJoin(
      providerCredentials,
      eq(providerCredentials.userIdentityID, userIdentities.id),
    )
    .where(
      and(
        eq(userIdentities.provider, "circlems"),
        eq(userIdentities.providerEnvironment, row.environment),
        eq(userIdentities.providerSubject, row.provider_subject),
        isNull(users.deletionPendingAt),
      ),
    )
    .get();
  if (
    existing?.last_auth_fenced_at !== null &&
    existing?.last_auth_fenced_at !== undefined &&
    row.proof_issued_at <= existing.last_auth_fenced_at
  ) {
    throw unavailableFlow();
  }
  if (linkIdentity && existing && existing.user_id !== linkIdentity.userID) {
    throw new ServiceError(
      "identity_already_linked",
      409,
      "This Circle.ms identity already belongs to another ComiNavi account.",
    );
  }
  const createsUser = !existing && purpose === "authenticate";
  const createsIdentity = !existing;
  const userID =
    existing?.user_id ?? linkIdentity?.userID ?? randomInternalID();
  const identityID = existing?.identity_id ?? randomInternalID();
  const publicID =
    existing?.public_id ?? linkIdentity?.subject ?? randomPublicID();
  const authVersion = existing?.auth_version ?? linkIdentity?.authVersion ?? 1;
  const identity: CominaviIdentity = {
    subject: publicID,
    userID,
    authVersion,
  };
  if (
    linkIdentity &&
    (userID !== linkIdentity.userID || authVersion !== linkIdentity.authVersion)
  ) {
    throw unavailableFlow();
  }
  const encryptedCredential = await encryptCircleCredentialForOwner(
    credential,
    userID,
    identityID,
    bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
  );
  const credentialRevision =
    existing?.last_oauth_flow_id === row.id
      ? (existing.credential_revision ?? 1)
      : (existing?.credential_revision ?? 0) + 1;
  const profile = await completionProfile(
    bindings.COMINAVI_DB,
    identity,
    row,
    createsUser,
    createsIdentity,
  );
  const receipt: CirclemsOAuthCredentialReceipt = {
    requestId: input.requestId,
    clientInstanceID: input.clientInstanceID,
    provider: "circlems",
    environment: row.environment,
    subject: row.provider_subject,
    credentialRevision,
  };
  const prepared =
    purpose === "authenticate"
      ? await prepareSessionForUser(
          identity,
          profile,
          bindings.COMINAVI_JWT_SECRET,
          nowMilliseconds,
        )
      : null;
  const finalResponse = prepared
    ? { ...prepared.response, credentialReceipt: receipt }
    : { user: profile, credentialReceipt: receipt };
  const encryptedResult = await encryptString(
    JSON.stringify(finalResponse),
    bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
    `circlems-oauth-result:v1:${row.id}`,
  );
  const finalNow = clock();
  if (row.completion_expires_at <= finalNow) {
    await resetCompletionClaim(
      bindings.COMINAVI_DB,
      codeHash,
      input.requestId,
      payloadHash,
      processingLeaseID,
    );
    throw unavailableFlow();
  }
  const statements: SQLWrapper[] = [];
  if (createsUser) {
    statements.push(
      sql`INSERT INTO users (
           id, public_id, display_name, avatar_provider_url,
           display_name_edited, avatar_edited, avatar_removed,
           profile_revision, auth_version, created_at, updated_at,
           last_authenticated_at
         )
         SELECT ${userID}, ${publicID}, ${providerDisplayName(row)}, NULL,
                0, 0, 0, 1, 1, ${now}, ${now}, ${now}
         FROM circlems_oauth_completions AS completion
         WHERE completion.code_hash = ${codeHash}
           AND completion.completion_request_id = ${input.requestId}
           AND completion.completion_payload_hash = ${payloadHash}
           AND completion.processing_lease_id = ${processingLeaseID}
           AND completion.result_ciphertext IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM user_identities
             WHERE provider = 'circlems'
               AND provider_environment = ${row.environment}
               AND provider_subject = ${row.provider_subject}
           )`,
    );
  }
  if (createsIdentity) {
    statements.push(
      sql`INSERT INTO user_identities (
           id, user_id, provider, provider_environment, provider_subject,
           provider_user_id, provider_display_name, created_at, updated_at,
           last_authenticated_at
         )
         SELECT ${identityID}, user.id, 'circlems', ${row.environment},
                ${row.provider_subject}, ${row.provider_user_id},
                ${row.provider_display_name}, ${now}, ${now}, ${now}
         FROM users AS user
         JOIN circlems_oauth_completions AS completion
           ON completion.code_hash = ${codeHash}
         WHERE user.id = ${userID} AND user.auth_version = ${authVersion}
           AND user.deletion_pending_at IS NULL
           AND completion.completion_request_id = ${input.requestId}
           AND completion.completion_payload_hash = ${payloadHash}
           AND completion.processing_lease_id = ${processingLeaseID}
           AND completion.result_ciphertext IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM user_identities
             WHERE provider = 'circlems'
               AND provider_environment = ${row.environment}
               AND provider_subject = ${row.provider_subject}
           )`,
    );
  } else {
    statements.push(
      sql`UPDATE user_identities SET
           provider_user_id = ${row.provider_user_id},
           provider_display_name = ${row.provider_display_name},
           updated_at = ${now}, last_authenticated_at = ${now}
         WHERE id = ${identityID} AND user_id = ${userID}
           AND EXISTS (
             SELECT 1 FROM users WHERE id = ${userID}
               AND auth_version = ${authVersion}
               AND deletion_pending_at IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM circlems_oauth_completions
             WHERE code_hash = ${codeHash}
               AND completion_request_id = ${input.requestId}
               AND completion_payload_hash = ${payloadHash}
               AND processing_lease_id = ${processingLeaseID}
               AND result_ciphertext IS NULL
           )`,
    );
  }
  statements.push(
    sql`INSERT INTO provider_credentials (
         user_identity_id, cipher_version, key_version, nonce, ciphertext,
         access_expires_at, scopes_json, credential_revision,
         handoff_completed_at, last_oauth_flow_id,
         refresh_lease_id, refresh_lease_expires_at, created_at, updated_at
       )
       SELECT identity.id, 1, 1, ${encryptedCredential.nonce},
              ${encryptedCredential.ciphertext},
              ${encryptedCredential.accessExpiresAt},
              ${encryptedCredential.scopesJSON}, 1, ${now}, ${row.id},
              NULL, NULL, ${now}, ${now}
       FROM user_identities AS identity
       JOIN users AS user ON user.id = identity.user_id
       JOIN circlems_oauth_completions AS completion
         ON completion.code_hash = ${codeHash}
       WHERE identity.id = ${identityID} AND identity.user_id = ${userID}
         AND user.auth_version = ${authVersion}
         AND user.deletion_pending_at IS NULL
         AND completion.completion_request_id = ${input.requestId}
         AND completion.completion_payload_hash = ${payloadHash}
         AND completion.processing_lease_id = ${processingLeaseID}
         AND completion.result_ciphertext IS NULL
       ON CONFLICT(user_identity_id) DO UPDATE SET
         cipher_version = excluded.cipher_version,
         key_version = excluded.key_version,
         nonce = excluded.nonce, ciphertext = excluded.ciphertext,
         access_expires_at = excluded.access_expires_at,
         scopes_json = excluded.scopes_json,
         credential_revision = provider_credentials.credential_revision + 1,
         handoff_completed_at = excluded.handoff_completed_at,
         last_oauth_flow_id = excluded.last_oauth_flow_id,
         refresh_lease_id = NULL, refresh_lease_expires_at = NULL,
         updated_at = excluded.updated_at
       WHERE provider_credentials.last_oauth_flow_id IS NOT ${row.id}
         AND (provider_credentials.refresh_lease_id IS NULL
           OR provider_credentials.refresh_lease_expires_at <= ${now})`,
  );
  if (prepared) {
    statements.push(
      sql`INSERT INTO auth_refresh_tokens (
           token_hash, user_id, family_id, auth_version, expires_at,
           consumed_at, replaced_by_hash, created_at
         )
         SELECT ${prepared.tokenHash}, user.id, ${prepared.familyID},
                user.auth_version, ${prepared.refreshExpiresAt}, NULL, NULL,
                ${prepared.createdAt}
         FROM circlems_oauth_completions AS completion
         JOIN users AS user ON user.id = ${identity.userID}
         WHERE completion.code_hash = ${codeHash}
           AND completion.completion_request_id = ${input.requestId}
           AND completion.completion_payload_hash = ${payloadHash}
           AND completion.processing_lease_id = ${processingLeaseID}
           AND completion.result_ciphertext IS NULL
           AND user.auth_version = ${identity.authVersion}
           AND user.deletion_pending_at IS NULL
           AND EXISTS (
             SELECT 1 FROM provider_credentials
             WHERE user_identity_id = ${identityID}
               AND last_oauth_flow_id = ${row.id}
               AND credential_revision = ${credentialRevision}
           )`,
    );
  }
  statements.push(
    sql`UPDATE circlems_oauth_completions SET
         user_id = ${identity.userID},
         user_identity_id = (
           SELECT id FROM user_identities
           WHERE user_id = ${identity.userID} AND provider = 'circlems'
             AND provider_environment = ${row.environment}
             AND provider_subject = ${row.provider_subject}
         ),
         result_auth_version = ${identity.authVersion},
         result_token_hash = ${prepared?.tokenHash ?? null},
         result_nonce = ${encryptedResult.nonce},
         result_ciphertext = ${encryptedResult.ciphertext},
         credential_revision = ${credentialRevision}, completed_at = ${finalNow},
         provider_subject = NULL, provider_user_id = NULL,
         provider_display_name = NULL, credential_nonce = NULL,
         credential_ciphertext = NULL
       WHERE code_hash = ${codeHash}
         AND completion_request_id = ${input.requestId}
         AND completion_payload_hash = ${payloadHash}
         AND processing_lease_id = ${processingLeaseID}
         AND result_ciphertext IS NULL
         AND expires_at > ${finalNow}
         AND EXISTS (
           SELECT 1 FROM users
           WHERE id = ${identity.userID}
             AND auth_version = ${identity.authVersion}
             AND deletion_pending_at IS NULL
             AND (last_auth_fenced_at IS NULL OR
               ${row.proof_issued_at} > last_auth_fenced_at)
         )
         AND EXISTS (
           SELECT 1 FROM provider_credentials AS credential
           WHERE credential.user_identity_id = ${identityID}
             AND credential.last_oauth_flow_id = ${row.id}
             AND credential.credential_revision = ${credentialRevision}
         )
         AND (${prepared?.tokenHash ?? null} IS NULL OR EXISTS (
           SELECT 1 FROM auth_refresh_tokens
           WHERE token_hash = ${prepared?.tokenHash ?? null}
             AND user_id = ${identity.userID}
             AND auth_version = ${identity.authVersion}
         ))`,
  );
  statements.push(
    sql`UPDATE circlems_oauth_starts SET state_nonce = NULL,
         state_ciphertext = NULL, completion_code_nonce = NULL,
         completion_code_ciphertext = NULL
       WHERE id = ${row.id} AND EXISTS (
         SELECT 1 FROM circlems_oauth_completions
         WHERE start_id = ${row.id} AND code_hash = ${codeHash}
           AND completion_request_id = ${input.requestId}
           AND completion_payload_hash = ${payloadHash}
           AND processing_lease_id = ${processingLeaseID}
           AND completed_at = ${finalNow} AND credential_ciphertext IS NULL
       )`,
  );
  statements.push(
    sql`INSERT INTO circlems_oauth_atomic_assertions (
         start_id, committed, created_at
       ) VALUES (
         ${row.id},
         CASE WHEN EXISTS (
           SELECT 1 FROM circlems_oauth_completions
             WHERE start_id = ${row.id} AND code_hash = ${codeHash}
             AND completion_request_id = ${input.requestId}
             AND completion_payload_hash = ${payloadHash}
             AND processing_lease_id = ${processingLeaseID}
             AND result_ciphertext IS NOT NULL AND completed_at = ${finalNow}
             AND provider_subject IS NULL AND provider_user_id IS NULL
             AND credential_nonce IS NULL AND credential_ciphertext IS NULL
             AND EXISTS (
               SELECT 1 FROM circlems_oauth_starts
               WHERE id = ${row.id} AND state_nonce IS NULL
                 AND state_ciphertext IS NULL
                 AND completion_code_nonce IS NULL
                 AND completion_code_ciphertext IS NULL
             )
             AND NOT EXISTS (
               SELECT 1 FROM deleted_provider_identity_tombstones AS tombstone
               WHERE tombstone.provider = 'circlems'
                 AND tombstone.provider_environment =
                   (SELECT environment FROM circlems_oauth_starts
                    WHERE id = ${row.id})
                 AND tombstone.provider_subject_digest =
                   circlems_oauth_completions.provider_subject_digest
                 AND circlems_oauth_completions.proof_issued_at <=
                   tombstone.deleted_at
             )
         ) THEN 1 ELSE 0 END,
         ${finalNow}
       )`,
  );
  try {
    const results = await runDrizzleBatch(
      bindings.COMINAVI_DB,
      statements as [SQLWrapper, ...SQLWrapper[]],
    );
    const providerIndex = createsUser ? 2 : 1;
    const finalIndex = results.length - 2;
    if (
      results
        .filter((_, index) => index !== providerIndex)
        .some((result) => (result.meta.changes ?? 0) !== 1) ||
      ![0, 1].includes(results[providerIndex]?.meta.changes ?? -1) ||
      (results[finalIndex]?.meta.changes ?? 0) !== 1
    ) {
      throw unavailableFlow();
    }
  } catch (error) {
    await resetCompletionClaim(
      bindings.COMINAVI_DB,
      codeHash,
      input.requestId,
      payloadHash,
      processingLeaseID,
    );
    throw error;
  }
  return finalResponse;
}

async function loadCompletionReplay(
  bindings: CirclemsOAuthFlowBindings,
  row: CompletionRow,
  payloadHash: string,
  linkIdentity: CominaviIdentity | undefined,
  now: number,
): Promise<CirclemsAuthenticationCompletion | CirclemsLinkCompletion | null> {
  if (!row.result_ciphertext) return null;
  if (
    row.completion_request_id !== row.request_id ||
    row.completion_payload_hash !== payloadHash ||
    !row.user_id ||
    !row.result_auth_version
  ) {
    throw idempotencyConflict();
  }
  const db = createDatabase(bindings.COMINAVI_DB);
  const current = await db
    .select({ authVersion: users.authVersion })
    .from(users)
    .where(and(eq(users.id, row.user_id), isNull(users.deletionPendingAt)))
    .get();
  if (!current || current.authVersion !== row.result_auth_version) {
    throw unavailableFlow();
  }
  if (
    row.purpose === "link" &&
    (!linkIdentity ||
      linkIdentity.userID !== row.user_id ||
      linkIdentity.authVersion !== row.result_auth_version)
  ) {
    throw unavailableFlow();
  }
  if (row.result_token_hash) {
    const refresh = await db
      .select({ tokenHash: authRefreshTokens.tokenHash })
      .from(authRefreshTokens)
      .where(
        and(
          eq(authRefreshTokens.tokenHash, row.result_token_hash),
          eq(authRefreshTokens.userID, row.user_id),
          eq(authRefreshTokens.authVersion, row.result_auth_version),
          isNull(authRefreshTokens.consumedAt),
          gt(authRefreshTokens.expiresAt, now),
        ),
      )
      .get();
    if (!refresh) throw unavailableFlow();
  } else if (row.purpose === "link") {
    const credential = await db
      .select({ userIdentityID: providerCredentials.userIdentityID })
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.userIdentityID, row.user_identity_id!),
          eq(providerCredentials.lastOAuthFlowID, row.id),
          eq(providerCredentials.credentialRevision, row.credential_revision!),
        ),
      )
      .get();
    if (!credential) throw unavailableFlow();
  }
  return JSON.parse(
    await decryptString(
      row.result_nonce!,
      row.result_ciphertext,
      bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
      `circlems-oauth-result:v1:${row.id}`,
    ),
  ) as CirclemsAuthenticationCompletion | CirclemsLinkCompletion;
}

async function completionProfile(
  database: D1Database,
  identity: CominaviIdentity,
  row: CompletionRow,
  createsUser: boolean,
  createsIdentity: boolean,
): Promise<UserProfile> {
  if (!row.provider_user_id) throw unavailableFlow();
  const circleIdentity = {
    provider: "circlems" as const,
    environment: row.environment,
    providerUserID: row.provider_user_id,
  };
  if (createsUser) {
    return {
      id: identity.subject,
      displayName: providerDisplayName(row),
      avatarURL: null,
      revision: 1,
      identities: [circleIdentity],
    };
  }
  const profile = await loadUserProfile(database, identity.userID);
  if (
    createsIdentity &&
    !profile.identities.some(
      (item) =>
        item.provider === "circlems" &&
        item.environment === row.environment &&
        item.providerUserID === row.provider_user_id,
    )
  ) {
    return { ...profile, identities: [...profile.identities, circleIdentity] };
  }
  return profile;
}

function providerDisplayName(
  row: Pick<CompletionRow, "provider_display_name" | "provider_user_id">,
): string {
  const trimmed = row.provider_display_name?.trim() ?? "";
  return trimmed
    ? Array.from(trimmed).slice(0, 80).join("")
    : `Circle.ms User ${row.provider_user_id}`;
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

async function resetCompletionClaim(
  database: D1Database,
  codeHash: string,
  requestID: string,
  payloadHash: string,
  processingLeaseID: string,
): Promise<void> {
  await createDatabase(database)
    .update(circlemsOAuthCompletions)
    .set({
      completionRequestID: null,
      completionPayloadHash: null,
      processingLeaseID: null,
      processingStartedAt: null,
    })
    .where(
      and(
        eq(circlemsOAuthCompletions.codeHash, codeHash),
        eq(circlemsOAuthCompletions.completionRequestID, requestID),
        eq(circlemsOAuthCompletions.completionPayloadHash, payloadHash),
        eq(circlemsOAuthCompletions.processingLeaseID, processingLeaseID),
        isNull(circlemsOAuthCompletions.resultCiphertext),
      ),
    )
    .run();
}

async function loadStartByRequest(
  database: D1Database,
  purpose: Purpose,
  requestID: string,
): Promise<StartRow | null> {
  return (
    (await createDatabase(database)
      .select(startSelection)
      .from(circlemsOAuthStarts)
      .where(
        and(
          eq(circlemsOAuthStarts.purpose, purpose),
          eq(circlemsOAuthStarts.requestID, requestID),
        ),
      )
      .get()) ?? null
  );
}

async function loadCompletion(
  database: D1Database,
  codeHash: string,
): Promise<CompletionRow | null> {
  return (
    (await createDatabase(database)
      .select(completionSelection)
      .from(circlemsOAuthCompletions)
      .innerJoin(
        circlemsOAuthStarts,
        eq(circlemsOAuthStarts.id, circlemsOAuthCompletions.startID),
      )
      .where(eq(circlemsOAuthCompletions.codeHash, codeHash))
      .get()) ?? null
  );
}

async function sha256Base64URL(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64URL(new Uint8Array(digest));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function randomToken(): string {
  return base64URL(crypto.getRandomValues(new Uint8Array(32)));
}

export async function processExpiredCirclemsOAuth(
  database: D1Database,
  nowMilliseconds = Date.now(),
): Promise<number> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const db = createDatabase(database);
  const deleted = await db
    .delete(circlemsOAuthStarts)
    .where(
      or(
        and(
          lte(circlemsOAuthStarts.expiresAt, now),
          notExists(
            db
              .select({ codeHash: circlemsOAuthCompletions.codeHash })
              .from(circlemsOAuthCompletions)
              .where(
                eq(circlemsOAuthCompletions.startID, circlemsOAuthStarts.id),
              ),
          ),
        ),
        exists(
          db
            .select({ codeHash: circlemsOAuthCompletions.codeHash })
            .from(circlemsOAuthCompletions)
            .where(
              and(
                eq(circlemsOAuthCompletions.startID, circlemsOAuthStarts.id),
                isNull(circlemsOAuthCompletions.resultCiphertext),
                lte(circlemsOAuthCompletions.expiresAt, now),
              ),
            ),
        ),
      ),
    )
    .run();
  return deleted.meta.changes ?? 0;
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
    await oauthKey(encodedKey),
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
        await oauthKey(encodedKey),
        Uint8Array.from(decodeBase64URL(ciphertext)),
      ),
    );
  } catch {
    throw unavailableFlow();
  }
}

async function oauthKey(encoded: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(decodeBase64URL(encoded));
  if (bytes.byteLength !== 32) throw unavailableFlow();
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function invalidFlow(): ServiceError {
  return new ServiceError(
    "invalid_circlems_oauth_flow",
    400,
    "The Circle.ms authorization flow is invalid.",
  );
}

function unavailableFlow(): ServiceError {
  return new ServiceError(
    "circlems_oauth_unavailable",
    404,
    "The Circle.ms authorization flow is unavailable.",
  );
}

function idempotencyConflict(): ServiceError {
  return new ServiceError(
    "idempotency_conflict",
    409,
    "This requestId was already used with a different Circle.ms flow.",
  );
}

function completionInProgress(): ServiceError {
  return new ServiceError(
    "circlems_oauth_completion_in_progress",
    409,
    "The Circle.ms authorization completion is already in progress.",
  );
}
