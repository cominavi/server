import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateOpenAPIDocument } from "../src/api/openapi";
import {
  loadAccountDeletionReplay,
  parseAccountDeletion,
  processAccountDeletionJobs,
  requestAccountDeletion,
} from "../src/lib/server/account-deletion";
import { authenticateAppleRequest } from "../src/lib/server/apple-auth-flow";
import { issueAppleEntryGrant } from "../src/lib/server/apple-entry-grants";
import { SQLiteD1Database } from "./sqlite-d1";

const nonce = "n".repeat(43);
const requestID = "99999999-9999-4999-8999-999999999999";
const secret = "test-jwt-secret-that-is-at-least-thirty-two-bytes";

test("account deletion fences auth, tombstones owned plans, revokes Apple, and finalizes asynchronously", async () => {
  const database = setup();
  const grant = await issueAppleEntryGrant(database.binding, nonce, 100_000);
  const authenticated = await authenticateAppleRequest(
    database.binding,
    {
      requestID: "77777777-7777-4777-8777-777777777777",
      identityToken: "verified-apple-token",
      authorizationCode: "single-use-code",
      entryGrant: grant.entryGrant,
      nonce,
      displayName: "Delete Me",
    },
    secret,
    credentialKey(),
    async () => ({
      provider: "apple",
      environment: "",
      subject: "apple.delete.subject",
      clientID: "llc.mikunet.cominavi",
      email: "relay@privaterelay.appleid.com",
    }),
    async () => ({
      refreshToken: "apple-refresh-to-revoke",
      clientID: "llc.mikunet.cominavi",
    }),
    101_000,
    () => 101,
  );
  const userID = authenticated.identity.userID;
  seedPlans(database, userID);
  const followingSnapshotKey = `following-import/${authenticated.identity.subject}/snapshot`;
  database.native
    .prepare(
      `INSERT INTO following_imports (
         subject, twitter_username, status, lease_id, attempted_at,
         next_allowed_at, successful_at, snapshot_key, following_count
       ) VALUES (?1, 'owner', 'ready', 'lease', 1, 999, 1, ?2, 1)`,
    )
    .run(authenticated.identity.subject, followingSnapshotKey);
  const followingSnapshots = new DeletionKV([followingSnapshotKey]);
  const avatarObjectKey = `users/${authenticated.identity.subject}/avatar.png`;
  database.native
    .prepare(
      `UPDATE users SET avatar_object_key = ?1,
         avatar_content_type = 'image/png' WHERE id = ?2`,
    )
    .run(avatarObjectKey, userID);
  const avatars = new DeletionR2([avatarObjectKey]);
  const result = await requestAccountDeletion(
    database.binding,
    authenticated.identity,
    parseAccountDeletion({ requestId: requestID, confirmation: "DELETE" }),
    credentialKey(),
    102_000,
  );
  assert.deepEqual(result, {
    status: "deletion_pending",
    requestId: requestID,
    deletedOwnedPlanIDs: ["owned-plan-0000000001"],
  });
  assert.deepEqual(
    database.rows(`SELECT id FROM users WHERE id = ${userID}`),
    [],
  );
  assert.deepEqual(database.rows("SELECT id FROM shared_plans ORDER BY id"), [
    { id: "other-plan-0000000002" },
  ]);
  assert.deepEqual(
    database.rows("SELECT * FROM deleted_shared_plan_tombstones"),
    [
      {
        plan_id: "owned-plan-0000000001",
        comiket_no: 108,
        deleted_at: 102,
        reason: "owner_account_deleted",
      },
    ],
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM auth_refresh_tokens")[0]
      ?.count,
    0,
  );
  assert.equal(
    database.rows(
      `SELECT count(*) AS count FROM shared_plan_members
       WHERE plan_id = 'other-plan-0000000002' AND user_id = ${userID}`,
    )[0]?.count,
    0,
  );
  assert.equal(
    database.rows(
      `SELECT count(*) AS count FROM shared_plan_invitations
       WHERE created_by_user_id = ${userID}`,
    )[0]?.count,
    0,
  );
  assert.deepEqual(
    await loadAccountDeletionReplay(
      database.binding,
      {
        subject: authenticated.identity.subject,
        authVersion: authenticated.identity.authVersion,
      },
      parseAccountDeletion({ requestId: requestID, confirmation: "DELETE" }),
    ),
    result,
  );

  const purged: string[] = [];
  const planSync = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (input: RequestInfo | URL) => {
        purged.push(`${id}:${new URL(String(input)).pathname}`);
        return new Response(null, { status: 204 });
      },
    }),
  } as unknown as DurableObjectNamespace;
  const revoked: string[] = [];
  const completed = await processAccountDeletionJobs(
    database.binding,
    planSync,
    followingSnapshots as unknown as KVNamespace,
    avatars as unknown as R2Bucket,
    appleBindings(),
    credentialKey(),
    fetch,
    103_000,
    async (refreshToken, clientID) => {
      revoked.push(`${clientID}:${refreshToken}`);
    },
    () => 103,
  );
  assert.equal(completed, 1);
  assert.deepEqual(purged, ["owned-plan-0000000001:/purge"]);
  assert.deepEqual(revoked, ["llc.mikunet.cominavi:apple-refresh-to-revoke"]);
  assert.deepEqual(followingSnapshots.deleted, [followingSnapshotKey]);
  assert.deepEqual(avatars.deleted, [avatarObjectKey]);
  assert.equal(
    database.rows("SELECT count(*) AS count FROM following_imports")[0]?.count,
    0,
  );
  assert.equal(
    database.rows(`SELECT count(*) AS count FROM users WHERE id = ${userID}`)[0]
      ?.count,
    0,
  );
  assert.deepEqual(
    database.rows(
      "SELECT state, user_id, plan_ids_json, completed_at FROM account_deletion_jobs",
    ),
    [
      {
        state: "completed",
        user_id: null,
        plan_ids_json: '["owned-plan-0000000001"]',
        completed_at: 103,
      },
    ],
  );
  assert.equal(
    database.rows(
      `SELECT actor_user_id FROM shared_plan_events
       WHERE id = 'retained-event'`,
    )[0]?.actor_user_id,
    null,
  );
});

test("account deletion parser and v2 operation require canonical receipt input and predecessor proof", async () => {
  assert.throws(() =>
    parseAccountDeletion({
      requestId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
      confirmation: "DELETE",
    }),
  );
  assert.throws(() =>
    parseAccountDeletion({ requestId: requestID, confirmation: "delete" }),
  );
  const document = await generateOpenAPIDocument();
  const operation = document.paths?.["/api/v2/me"]?.delete;
  assert.equal(operation?.operationId, "deleteCurrentUserAccount");
  assert.deepEqual(operation?.security, [{ bearerAuth: [] }]);
  assert.ok(operation?.requestBody);
  assert.ok(operation?.responses?.["202"]);
});

test("the scheduled worker resumes D1 erasure after a crash immediately after the fence", async () => {
  const database = setup();
  const grant = await issueAppleEntryGrant(database.binding, nonce, 200_000);
  const authenticated = await authenticateAppleRequest(
    database.binding,
    {
      requestID: "88888888-8888-4888-8888-888888888888",
      identityToken: "verified-apple-token",
      authorizationCode: "single-use-code-after-fence-crash",
      entryGrant: grant.entryGrant,
      nonce,
      displayName: "Crash Safe",
    },
    secret,
    credentialKey(),
    async () => ({
      provider: "apple",
      environment: "",
      subject: "apple.crash-safe.subject",
      clientID: "llc.mikunet.cominavi",
    }),
    async () => ({
      refreshToken: "apple-refresh-after-fence-crash",
      clientID: "llc.mikunet.cominavi",
    }),
    201_000,
    () => 201,
  );
  const deletion = parseAccountDeletion({
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    confirmation: "DELETE",
  });
  await assert.rejects(
    () =>
      requestAccountDeletion(
        database.binding,
        authenticated.identity,
        deletion,
        credentialKey(),
        202_000,
        () => {
          throw new Error("simulated_isolate_exit");
        },
      ),
    /simulated_isolate_exit/,
  );
  assert.deepEqual(
    database.rows(
      `SELECT state, user_id FROM account_deletion_jobs
       WHERE request_id = '${deletion.requestID}'`,
    ),
    [{ state: "fenced", user_id: authenticated.identity.userID }],
  );
  assert.equal(
    database.rows(
      `SELECT deletion_pending_at FROM users
       WHERE id = ${authenticated.identity.userID}`,
    )[0]?.deletion_pending_at,
    202,
  );

  const revoked: string[] = [];
  const completed = await processAccountDeletionJobs(
    database.binding,
    {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => new Response(null, { status: 204 }),
      }),
    } as unknown as DurableObjectNamespace,
    new DeletionKV() as unknown as KVNamespace,
    new DeletionR2() as unknown as R2Bucket,
    appleBindings(),
    credentialKey(),
    fetch,
    203_000,
    async (refreshToken) => {
      revoked.push(refreshToken);
    },
    () => 203,
  );
  assert.equal(completed, 1);
  assert.deepEqual(revoked, ["apple-refresh-after-fence-crash"]);
  assert.equal(
    database.rows(
      `SELECT count(*) AS count FROM users
       WHERE id = ${authenticated.identity.userID}`,
    )[0]?.count,
    0,
  );
  assert.equal(
    database.rows(
      `SELECT state FROM account_deletion_jobs
       WHERE request_id = '${deletion.requestID}'`,
    )[0]?.state,
    "completed",
  );
});

function seedPlans(database: SQLiteD1Database, deletingUserID: number): void {
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (9000001, '${"b".repeat(32)}', 'Collaborator', 1, 1, 1, 1, 1);
    INSERT INTO shared_plans (
      id, comiket_no, name, owner_user_id, revision, created_at, updated_at
    ) VALUES ('owned-plan-0000000001', 108, 'Owned', ${deletingUserID}, 1, 1, 1),
             ('other-plan-0000000002', 108, 'Other', 9000001, 1, 1, 1);
    INSERT INTO shared_plan_members (
      plan_id, user_id, role, joined_at, updated_at
    ) VALUES ('owned-plan-0000000001', ${deletingUserID}, 'owner', 1, 1),
             ('owned-plan-0000000001', 9000001, 'editor', 1, 1),
             ('other-plan-0000000002', 9000001, 'owner', 1, 1),
             ('other-plan-0000000002', ${deletingUserID}, 'editor', 1, 1);
    INSERT INTO owned_plan_slots (owner_user_id, comiket_no, slot, plan_id)
      VALUES (${deletingUserID}, 108, 0, 'owned-plan-0000000001'),
             (9000001, 108, 0, 'other-plan-0000000002');
    INSERT INTO shared_plan_invitations (
      id, plan_id, token_hash, created_by_user_id, expires_at, created_at
    ) VALUES ('invite-00000000000001', 'other-plan-0000000002',
              '${"c".repeat(64)}', ${deletingUserID}, 999, 1);
    INSERT INTO shared_plan_events (
      id, plan_id, actor_user_id, event_type, i18n_key,
      payload_version, payload_json, created_at
    ) VALUES ('retained-event', 'other-plan-0000000002', ${deletingUserID},
              'plan.updated', 'plan.updated', 1, '{}', 1);
  `);
}

function appleBindings() {
  return {
    COMINAVI_APPLE_CLIENT_IDS: "llc.mikunet.cominavi",
    COMINAVI_APPLE_TEAM_ID: "F25GFFJL49",
    COMINAVI_APPLE_KEY_ID: "KEYID",
    COMINAVI_APPLE_PRIVATE_KEY_P8_BASE64URL: "unused-by-injected-revoke",
  };
}

function credentialKey(): string {
  return Buffer.from(
    Uint8Array.from({ length: 32 }, (_, index) => index),
  ).toString("base64url");
}

function setup(): SQLiteD1Database {
  return new SQLiteD1Database(
    [
      "migrations/0001_following_imports.sql",
      "migrations/0002_realtime_service.sql",
      "migrations/0003_accounts_shared_plans.sql",
      "migrations/0004_sanitized_catalog.sql",
      "migrations/0005_shared_plan_crdt_notifications.sql",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  );
}

class DeletionKV {
  private readonly values: Set<string>;
  readonly deleted: string[] = [];

  constructor(keys: string[] = []) {
    this.values = new Set(keys);
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.values.delete(key);
  }
}

class DeletionR2 {
  private readonly values: Set<string>;
  readonly deleted: string[] = [];

  constructor(keys: string[] = []) {
    this.values = new Set(keys);
  }

  readonly delete = async (key: string): Promise<void> => {
    this.deleted.push(key);
    this.values.delete(key);
  };
}
