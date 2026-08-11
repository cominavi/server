import type { SQLWrapper } from "drizzle-orm";
import { parameterizedSQL, runDrizzleBatch } from "../db/batch";
import { createDatabase } from "../db/client";
import type { AppleAuthBindings } from "./apple-auth";
import { revokeAppleRefreshToken } from "./apple-auth";
import {
  decryptAppleStoredValue,
  encryptAppleStoredValue,
} from "./apple-auth-flow";
import { sha256Hex } from "./auth-sessions";
import type { CominaviIdentity } from "./cominavi-auth";
import type { CominaviTokenIdentity } from "./cominavi-auth";
import { parseCanonicalRequestID } from "./request-id";
import { providerSubjectDigest } from "./provider-tombstones";
import { ServiceError } from "./service-error";

export interface AccountDeletionResult {
  status: "deletion_pending";
  requestId: string;
  deletedOwnedPlanIDs: string[];
}

export function parseAccountDeletion(value: unknown): {
  requestID: string;
  confirmation: "DELETE";
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("requestId" in value) ||
    !("confirmation" in value) ||
    value.confirmation !== "DELETE"
  ) {
    throw invalidDeletion();
  }
  return {
    requestID: parseCanonicalRequestID(value.requestId),
    confirmation: "DELETE",
  };
}

export async function requestAccountDeletion(
  database: D1Database,
  identity: CominaviIdentity,
  input: ReturnType<typeof parseAccountDeletion>,
  encryptionKey: string,
  nowMilliseconds = Date.now(),
  afterFence?: () => void,
): Promise<AccountDeletionResult> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const payloadHash = await sha256Hex(
    JSON.stringify({ v: 1, confirmation: input.confirmation }),
  );
  const replay = await loadAccountDeletionReplay(database, identity, input);
  const phaseOneNeeded = replay === null;
  const current = await createDatabase(database).get<{
    auth_version: number;
    deletion_pending_at: number | null;
    deletion_request_id: string | null;
    deletion_payload_hash: string | null;
  }>(
    parameterizedSQL(
      `SELECT auth_version, deletion_pending_at, deletion_request_id,
              deletion_payload_hash
       FROM users WHERE id = ?1 AND public_id = ?2`,
      [identity.userID, identity.subject],
    ),
  );
  if (!current) {
    if (replay) return replay;
    throw deletionUnavailable();
  }
  if (phaseOneNeeded) {
    if (
      current.deletion_pending_at !== null ||
      current.auth_version !== identity.authVersion
    ) {
      throw deletionUnavailable();
    }
    await runDrizzleBatch(database, [
      parameterizedSQL(
        `UPDATE users SET deletion_pending_at = ?1,
             deletion_request_id = ?2, deletion_payload_hash = ?3,
             auth_version = auth_version + 1, last_auth_fenced_at = ?1,
             last_auth_fence_request_id = ?2,
             last_auth_fence_payload_hash = ?3, updated_at = ?1
           WHERE id = ?4 AND public_id = ?5 AND auth_version = ?6
             AND deletion_pending_at IS NULL`,
        [
          now,
          input.requestID,
          payloadHash,
          identity.userID,
          identity.subject,
          identity.authVersion,
        ],
      ),
      parameterizedSQL(
        `INSERT INTO account_deletion_jobs (
             request_id, payload_hash, original_subject_hash,
             original_auth_version, user_id, plan_ids_json, state,
             following_snapshot_key, avatar_object_key,
             attempt_count, lease_id, lease_expires_at, available_at,
             last_error, created_at, updated_at, completed_at
           )
           SELECT ?1, ?2, ?3, ?4, user.id,
                  COALESCE((
                    SELECT json_group_array(id) FROM (
                      SELECT id FROM shared_plans
                      WHERE owner_user_id = user.id ORDER BY id
                    )
                  ), '[]'),
                  'fenced',
                  (SELECT snapshot_key FROM following_imports
                   WHERE subject = user.public_id),
                  user.avatar_object_key,
                  0, NULL, NULL, ?5, NULL, ?5, ?5, NULL
           FROM users AS user
           WHERE user.id = ?6 AND user.deletion_request_id = ?1
             AND user.deletion_payload_hash = ?2
             AND user.deletion_pending_at = ?5`,
        [
          input.requestID,
          payloadHash,
          await sha256Hex(identity.subject),
          identity.authVersion,
          now,
          identity.userID,
        ],
      ),
      parameterizedSQL(
        `UPDATE auth_refresh_tokens SET consumed_at = ?1
           WHERE user_id = ?2 AND consumed_at IS NULL
             AND EXISTS (
               SELECT 1 FROM users WHERE id = ?2 AND deletion_request_id = ?3
                 AND deletion_payload_hash = ?4
             )`,
        [now, identity.userID, input.requestID, payloadHash],
      ),
      parameterizedSQL(
        `UPDATE push_devices SET enabled = 0, invalidated_at = ?1,
             updated_at = ?1 WHERE user_id = ?2`,
        [now, identity.userID],
      ),
      parameterizedSQL(
        `UPDATE notification_deliveries SET status = 'suppressed',
             lease_expires_at = NULL, updated_at = ?1
           WHERE user_id = ?2 AND status IN ('pending', 'processing', 'retry')`,
        [now, identity.userID],
      ),
      parameterizedSQL(
        `UPDATE shared_plan_notification_deliveries
           SET status = 'suppressed', lease_expires_at = NULL,
               last_error = 'account_deletion_pending', updated_at = ?1
           WHERE user_id = ?2
             AND status IN ('pending', 'processing', 'retry')`,
        [now, identity.userID],
      ),
      parameterizedSQL(`DELETE FROM favorite_sets WHERE user_id = ?1`, [
        identity.userID,
      ]),
      parameterizedSQL(
        `DELETE FROM provider_avatar_import_jobs
           WHERE user_identity_id IN (
             SELECT id FROM user_identities WHERE user_id = ?1
           )`,
        [identity.userID],
      ),
      parameterizedSQL(
        `INSERT INTO account_deletion_fence_assertions (
             request_id, committed, created_at
           ) VALUES (
             ?1,
             CASE WHEN EXISTS (
               SELECT 1 FROM users AS user
               JOIN account_deletion_jobs AS job ON job.user_id = user.id
               WHERE user.id = ?2 AND user.deletion_request_id = ?1
                 AND user.deletion_payload_hash = ?3
                 AND user.auth_version = ?4
                 AND job.payload_hash = ?3
             ) THEN 1 ELSE 0 END,
             ?5
           )`,
        [
          input.requestID,
          identity.userID,
          payloadHash,
          identity.authVersion + 1,
          now,
        ],
      ),
    ]);
    afterFence?.();
  } else if (
    current.deletion_request_id !== input.requestID ||
    current.deletion_payload_hash !== payloadHash ||
    current.deletion_pending_at === null ||
    current.auth_version !== identity.authVersion + 1
  ) {
    return replay;
  }
  const providerIdentities = await createDatabase(database).all<{
    id: number;
    provider: "circlems" | "google" | "apple";
    provider_environment: string;
    provider_subject: string;
  }>(
    parameterizedSQL(
      `SELECT id, provider, provider_environment, provider_subject
       FROM user_identities WHERE user_id = ?1 ORDER BY id`,
      [identity.userID],
    ),
  );
  const tombstones = await Promise.all(
    providerIdentities.map(async (item) => ({
      ...item,
      digest: await providerSubjectDigest(
        item.provider,
        item.provider_environment,
        item.provider_subject,
        encryptionKey,
      ),
    })),
  );
  const appleRevocations = await prepareAppleDeletionRevocations(
    database,
    identity,
    input.requestID,
    encryptionKey,
  );
  const tombstoneStatements = tombstones.map((item) =>
    parameterizedSQL(
      `INSERT INTO deleted_provider_identity_tombstones (
           provider, provider_environment, provider_subject_digest, deleted_at
         )
         SELECT ?1, ?2, ?3, ?4 FROM users
         WHERE id = ?5 AND deletion_request_id = ?6
           AND deletion_payload_hash = ?7
         ON CONFLICT(provider, provider_environment, provider_subject_digest)
         DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)`,
      [
        item.provider,
        item.provider_environment,
        item.digest,
        now,
        identity.userID,
        input.requestID,
        payloadHash,
      ],
    ),
  );
  const revocationStatements = appleRevocations.map((item) =>
    parameterizedSQL(
      `INSERT INTO account_deletion_apple_revocations (
           deletion_request_id, item_id, client_id, payload_kind, aad,
           nonce, ciphertext, created_at
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM users
         WHERE id = ?9 AND deletion_request_id = ?1
           AND deletion_payload_hash = ?10
         ON CONFLICT(deletion_request_id, item_id) DO NOTHING`,
      [
        input.requestID,
        item.itemID,
        item.clientID,
        item.payloadKind,
        item.aad,
        item.nonce,
        item.ciphertext,
        now,
        identity.userID,
        payloadHash,
      ],
    ),
  );
  const appleRequestEraseStatements = [
    ...appleRevocations
      .filter((item) => item.payloadKind === "stage")
      .map((item) =>
        parameterizedSQL(
          `DELETE FROM apple_auth_requests
             WHERE request_id = ?1 AND state = 'staged' AND EXISTS (
               SELECT 1 FROM account_deletion_apple_revocations
               WHERE deletion_request_id = ?2 AND item_id = ?3
             )`,
          [item.itemID.slice("stage:".length), input.requestID, item.itemID],
        ),
      ),
    ...tombstones
      .filter((item) => item.provider === "apple")
      .map((item) =>
        parameterizedSQL(
          `DELETE FROM apple_auth_requests
           WHERE apple_subject_digest = ?1
             AND state IN ('completed', 'indeterminate')
             AND EXISTS (
             SELECT 1 FROM users WHERE id = ?2 AND deletion_request_id = ?3
               AND deletion_payload_hash = ?4
           )`,
          [item.digest, identity.userID, input.requestID, payloadHash],
        ),
      ),
  ];
  const statements = [
    ...tombstoneStatements,
    ...revocationStatements,
    ...appleRequestEraseStatements,
    parameterizedSQL(
      `INSERT INTO deleted_shared_plan_tombstones (
           plan_id, comiket_no, deleted_at, reason
         )
         SELECT plan.id, plan.comiket_no, ?1, 'owner_account_deleted'
         FROM shared_plans AS plan
         JOIN users AS user ON user.id = plan.owner_user_id
         WHERE user.id = ?2 AND user.deletion_request_id = ?3
           AND user.deletion_payload_hash = ?4
         ON CONFLICT(plan_id) DO NOTHING`,
      [now, identity.userID, input.requestID, payloadHash],
    ),
    parameterizedSQL(
      `UPDATE shared_plan_members SET revoked_at = ?1, updated_at = ?1
         WHERE user_id = ?2 AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM users WHERE id = ?2 AND deletion_request_id = ?3
               AND deletion_payload_hash = ?4
           )`,
      [now, identity.userID, input.requestID, payloadHash],
    ),
    parameterizedSQL(
      `DELETE FROM shared_plan_invitations
         WHERE created_by_user_id = ?1 AND EXISTS (
           SELECT 1 FROM users WHERE id = ?1 AND deletion_request_id = ?2
             AND deletion_payload_hash = ?3
         )`,
      [identity.userID, input.requestID, payloadHash],
    ),
    parameterizedSQL(
      `UPDATE apple_auth_requests SET apple_subject = apple_subject_digest,
           provider_email = NULL, display_name = NULL, updated_at = ?1
         WHERE state = 'exchanging' AND apple_subject IN (
           SELECT identity.provider_subject
           FROM user_identities AS identity
           JOIN users AS user ON user.id = identity.user_id
           WHERE user.id = ?2 AND user.deletion_request_id = ?3
             AND user.deletion_payload_hash = ?4
             AND identity.provider = 'apple'
         )`,
      [now, identity.userID, input.requestID, payloadHash],
    ),
    parameterizedSQL(
      `DELETE FROM following_imports
         WHERE subject = ?1 AND EXISTS (
           SELECT 1 FROM users WHERE id = ?2 AND public_id = ?1
             AND deletion_request_id = ?3 AND deletion_payload_hash = ?4
         )`,
      [identity.subject, identity.userID, input.requestID, payloadHash],
    ),
    parameterizedSQL(
      `DELETE FROM shared_plans
         WHERE owner_user_id = ?1 AND EXISTS (
           SELECT 1 FROM users WHERE id = ?1 AND deletion_request_id = ?2
             AND deletion_payload_hash = ?3
         )`,
      [identity.userID, input.requestID, payloadHash],
    ),
    parameterizedSQL(
      `DELETE FROM users
         WHERE id = ?1 AND public_id = ?2 AND deletion_request_id = ?3
           AND deletion_payload_hash = ?4
           AND auth_version = ?5
           AND NOT EXISTS (
             SELECT 1 FROM shared_plans WHERE owner_user_id = ?1
           )`,
      [
        identity.userID,
        identity.subject,
        input.requestID,
        payloadHash,
        identity.authVersion + 1,
      ],
    ),
    parameterizedSQL(
      `UPDATE account_deletion_jobs SET user_id = NULL,
           state = 'external_cleanup', updated_at = ?1
         WHERE request_id = ?2 AND payload_hash = ?3 AND user_id = ?4
           AND NOT EXISTS (SELECT 1 FROM users WHERE id = ?4)`,
      [now, input.requestID, payloadHash, identity.userID],
    ),
    parameterizedSQL(
      `INSERT INTO account_deletion_atomic_assertions (
           request_id, committed, created_at
         ) VALUES (
           ?1,
           CASE WHEN EXISTS (
             SELECT 1 FROM account_deletion_jobs AS job
             WHERE job.request_id = ?1 AND job.payload_hash = ?2
               AND job.original_auth_version = ?3 AND job.user_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM users WHERE id = ?5)
               AND (
                 SELECT count(*) FROM account_deletion_apple_revocations
                 WHERE deletion_request_id = ?1
               ) = ?6
           ) THEN 1 ELSE 0 END,
           ?4
         )`,
      [
        input.requestID,
        payloadHash,
        identity.authVersion,
        now,
        identity.userID,
        appleRevocations.length,
      ],
    ),
  ];
  await runDrizzleBatch(database, statements as [SQLWrapper, ...SQLWrapper[]]);
  return loadDeletionResult(database, input.requestID);
}

export async function loadAccountDeletionReplay(
  database: D1Database,
  identity: CominaviTokenIdentity,
  input: ReturnType<typeof parseAccountDeletion>,
): Promise<AccountDeletionResult | null> {
  const [payloadHash, subjectHash] = await Promise.all([
    sha256Hex(JSON.stringify({ v: 1, confirmation: input.confirmation })),
    sha256Hex(identity.subject),
  ]);
  const row = await createDatabase(database).get<{
    payload_hash: string;
    original_subject_hash: string;
    original_auth_version: number;
  }>(
    parameterizedSQL(
      `SELECT payload_hash, original_subject_hash, original_auth_version
       FROM account_deletion_jobs WHERE request_id = ?1`,
      [input.requestID],
    ),
  );
  if (!row) return null;
  if (row.payload_hash !== payloadHash) throw idempotencyConflict();
  if (
    row.original_subject_hash !== subjectHash ||
    row.original_auth_version !== identity.authVersion
  ) {
    throw deletionUnavailable();
  }
  return loadDeletionResult(database, input.requestID);
}

export async function processAccountDeletionJobs(
  database: D1Database,
  planSync: DurableObjectNamespace,
  followingSnapshots: KVNamespace,
  avatars: R2Bucket,
  appleBindings: AppleAuthBindings,
  encryptionKey: string,
  fetcher: typeof fetch = fetch,
  nowMilliseconds = Date.now(),
  revokeApple: typeof revokeAppleRefreshToken = revokeAppleRefreshToken,
  clock: () => number = () => Math.floor(Date.now() / 1_000),
): Promise<number> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const fenced = await createDatabase(database).all<{
    request_id: string;
    original_auth_version: number;
    user_id: number;
    public_id: string;
  }>(
    parameterizedSQL(
      `SELECT job.request_id, job.original_auth_version, job.user_id,
              user.public_id
       FROM account_deletion_jobs AS job
       JOIN users AS user ON user.id = job.user_id
       WHERE job.state = 'fenced' AND job.available_at <= ?1
       ORDER BY job.created_at LIMIT 10`,
      [now],
    ),
  );
  for (const job of fenced) {
    try {
      await requestAccountDeletion(
        database,
        {
          subject: job.public_id,
          userID: job.user_id,
          authVersion: job.original_auth_version,
        },
        { requestID: job.request_id, confirmation: "DELETE" },
        encryptionKey,
        nowMilliseconds,
      );
    } catch (error) {
      await createDatabase(database).run(
        parameterizedSQL(
          `UPDATE account_deletion_jobs SET attempt_count = attempt_count + 1,
             available_at = ?1, last_error = ?2, updated_at = ?3
           WHERE request_id = ?4 AND state = 'fenced'`,
          [
            now + 60,
            (error instanceof Error ? error.message : "d1_erase_failed").slice(
              0,
              500,
            ),
            now,
            job.request_id,
          ],
        ),
      );
    }
  }
  const jobs = await createDatabase(database).all<{
    request_id: string;
    payload_hash: string;
    plan_ids_json: string;
    following_snapshot_key: string | null;
    avatar_object_key: string | null;
    attempt_count: number;
  }>(
    parameterizedSQL(
      `SELECT request_id, payload_hash, plan_ids_json, following_snapshot_key,
              avatar_object_key, attempt_count
       FROM account_deletion_jobs
       WHERE (state = 'external_cleanup' AND available_at <= ?1)
          OR (state = 'leased' AND lease_expires_at <= ?1)
       ORDER BY available_at, created_at LIMIT 10`,
      [now],
    ),
  );
  let completed = 0;
  for (const job of jobs) {
    const leaseID = crypto.randomUUID();
    const leased = await createDatabase(database).run(
      parameterizedSQL(
        `UPDATE account_deletion_jobs SET state = 'leased', lease_id = ?1,
           lease_expires_at = ?2, updated_at = ?3
         WHERE request_id = ?4 AND (
           (state = 'external_cleanup' AND available_at <= ?3) OR
           (state = 'leased' AND lease_expires_at <= ?3)
         )`,
        [leaseID, now + 60, now, job.request_id],
      ),
    );
    if ((leased.meta.changes ?? 0) !== 1) continue;
    try {
      const appleRows = await createDatabase(database).all<{
        item_id: string;
        client_id: string;
        payload_kind: "credential" | "stage";
        aad: string;
        nonce: string;
        ciphertext: string;
      }>(
        parameterizedSQL(
          `SELECT item_id, client_id, payload_kind, aad, nonce, ciphertext
           FROM account_deletion_apple_revocations
           WHERE deletion_request_id = ?1 ORDER BY item_id`,
          [job.request_id],
        ),
      );
      for (const row of appleRows) {
        const value = JSON.parse(
          await decryptAppleStoredValue(
            row.nonce,
            row.ciphertext,
            encryptionKey,
            row.aad,
          ),
        ) as {
          refreshToken?: string;
        };
        const refreshToken = value.refreshToken;
        if (!refreshToken) throw new Error("apple_revocation_payload_invalid");
        await revokeApple(
          refreshToken,
          row.client_id,
          appleBindings,
          nowMilliseconds,
          fetcher,
        );
        await createDatabase(database).run(
          parameterizedSQL(
            `DELETE FROM account_deletion_apple_revocations
             WHERE deletion_request_id = ?1 AND item_id = ?2`,
            [job.request_id, row.item_id],
          ),
        );
        if (row.payload_kind === "stage" && row.item_id.startsWith("stage:")) {
          await createDatabase(database).run(
            parameterizedSQL(
              `DELETE FROM apple_auth_requests
               WHERE request_id = ?1 AND state = 'indeterminate'`,
              [row.item_id.slice("stage:".length)],
            ),
          );
        }
      }
      if (job.following_snapshot_key) {
        await followingSnapshots.delete(job.following_snapshot_key);
      }
      if (job.avatar_object_key) {
        await avatars.delete(job.avatar_object_key);
      }
      const planIDs = JSON.parse(job.plan_ids_json) as string[];
      for (const planID of planIDs) {
        const response = await planSync
          .get(planSync.idFromName(planID))
          .fetch("https://plan-sync.internal/purge", { method: "POST" });
        if (!response.ok) throw new Error("plan_sync_purge_failed");
      }
      const finalNow = clock();
      const results = await runDrizzleBatch(database, [
        parameterizedSQL(
          `UPDATE account_deletion_jobs SET state = 'completed',
               lease_id = NULL, lease_expires_at = NULL,
               last_error = NULL, completed_at = ?1, updated_at = ?1
             WHERE request_id = ?2 AND lease_id = ?3
               AND lease_expires_at > ?1
               AND NOT EXISTS (
                 SELECT 1 FROM account_deletion_apple_revocations
                 WHERE deletion_request_id = ?2
               )`,
          [finalNow, job.request_id, leaseID],
        ),
      ]);
      if ((results[0]?.meta.changes ?? 0) !== 1) {
        throw new Error("account_deletion_finalize_conflict");
      }
      completed += 1;
    } catch (error) {
      await createDatabase(database).run(
        parameterizedSQL(
          `UPDATE account_deletion_jobs SET state = 'external_cleanup',
             attempt_count = attempt_count + 1, lease_id = NULL,
             lease_expires_at = NULL, available_at = ?1,
             last_error = ?2, updated_at = ?3
           WHERE request_id = ?4 AND lease_id = ?5`,
          [
            now + Math.min(3_600, 60 * 2 ** Math.min(job.attempt_count, 5)),
            (error instanceof Error ? error.message : "deletion_failed").slice(
              0,
              500,
            ),
            now,
            job.request_id,
            leaseID,
          ],
        ),
      );
    }
  }
  return completed;
}

async function loadDeletionResult(
  database: D1Database,
  requestID: string,
): Promise<AccountDeletionResult> {
  const row = await createDatabase(database).get<{ plan_ids_json: string }>(
    parameterizedSQL(
      `SELECT plan_ids_json FROM account_deletion_jobs WHERE request_id = ?1`,
      [requestID],
    ),
  );
  if (!row) throw deletionUnavailable();
  return {
    status: "deletion_pending",
    requestId: requestID,
    deletedOwnedPlanIDs: JSON.parse(row.plan_ids_json) as string[],
  };
}

async function prepareAppleDeletionRevocations(
  database: D1Database,
  identity: CominaviIdentity,
  requestID: string,
  encryptionKey: string,
): Promise<
  Array<{
    itemID: string;
    clientID: string;
    payloadKind: "credential" | "stage";
    aad: string;
    nonce: string;
    ciphertext: string;
  }>
> {
  const credentials = await createDatabase(database).all<{
    id: number;
    provider_subject: string;
    client_id: string;
    nonce: string;
    ciphertext: string;
  }>(
    parameterizedSQL(
      `SELECT identity.id, identity.provider_subject, credential.client_id,
              credential.nonce, credential.ciphertext
       FROM user_identities AS identity
       JOIN apple_provider_credentials AS credential
         ON credential.user_identity_id = identity.id
       WHERE identity.user_id = ?1 AND identity.provider = 'apple'`,
      [identity.userID],
    ),
  );
  const stages = await createDatabase(database).all<{
    request_id: string;
    client_id: string;
    stage_nonce: string;
    stage_ciphertext: string;
  }>(
    parameterizedSQL(
      `SELECT request.request_id, request.client_id, request.stage_nonce,
              request.stage_ciphertext
       FROM apple_auth_requests AS request
       WHERE request.state = 'staged' AND request.stage_nonce IS NOT NULL
         AND request.stage_ciphertext IS NOT NULL
         AND (
           request.observed_user_id = ?1 OR EXISTS (
             SELECT 1 FROM user_identities AS identity
             WHERE identity.user_id = ?1 AND identity.provider = 'apple'
               AND identity.provider_subject = request.apple_subject
           )
         )`,
      [identity.userID],
    ),
  );
  const output: Array<{
    itemID: string;
    clientID: string;
    payloadKind: "credential" | "stage";
    aad: string;
    nonce: string;
    ciphertext: string;
  }> = [];
  for (const row of credentials) {
    const value = JSON.parse(
      await decryptAppleStoredValue(
        row.nonce,
        row.ciphertext,
        encryptionKey,
        `apple-provider-credential:v1:${identity.subject}:${row.provider_subject}`,
      ),
    ) as { refreshToken: string };
    output.push(
      await deletionRevocationItem(
        requestID,
        `credential:${row.id}`,
        row.client_id,
        "credential",
        value.refreshToken,
        encryptionKey,
      ),
    );
  }
  for (const row of stages) {
    const value = JSON.parse(
      await decryptAppleStoredValue(
        row.stage_nonce,
        row.stage_ciphertext,
        encryptionKey,
        `apple-auth-stage:v1:${row.request_id}`,
      ),
    ) as { providerTokens: { refreshToken: string } };
    output.push(
      await deletionRevocationItem(
        requestID,
        `stage:${row.request_id}`,
        row.client_id,
        "stage",
        value.providerTokens.refreshToken,
        encryptionKey,
      ),
    );
  }
  return output;
}

async function deletionRevocationItem(
  requestID: string,
  itemID: string,
  clientID: string,
  payloadKind: "credential" | "stage",
  refreshToken: string,
  encryptionKey: string,
) {
  const aad = `account-deletion-apple:v1:${requestID}:${itemID}`;
  const encrypted = await encryptAppleStoredValue(
    JSON.stringify({ refreshToken }),
    encryptionKey,
    aad,
  );
  return { itemID, clientID, payloadKind, aad, ...encrypted };
}

function invalidDeletion(): ServiceError {
  return new ServiceError(
    "invalid_account_deletion",
    400,
    'Account deletion requires confirmation exactly equal to "DELETE".',
  );
}

function deletionUnavailable(): ServiceError {
  return new ServiceError(
    "account_deletion_unavailable",
    409,
    "The account could not be deleted from its current state.",
  );
}

function idempotencyConflict(): ServiceError {
  return new ServiceError(
    "idempotency_conflict",
    409,
    "This requestId was already used for a different account deletion.",
  );
}
