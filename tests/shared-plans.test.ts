import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { apiErrorResponse, jsonResponse } from "../src/lib/server/api-response";
import type { CominaviIdentity } from "../src/lib/server/cominavi-auth";
import {
  acceptInvitation,
  createInvitation,
  createSharedPlan,
  listInvitations,
  listPlanMembers,
  listSharedPlans,
  parseCollectionPage,
  parseCreatePlan,
  parseInvitationCreate,
  parseMembershipMutation,
  parseOwnershipTransfer,
  parsePlanArchive,
  previewInvitation,
  revokeInvitation,
  setPlanMemberRevoked,
  transferPlanOwnership,
  updateSharedPlan,
} from "../src/lib/server/shared-plans";
import {
  hasPlanSyncAuthority,
  loadPlanSyncAuthoritySnapshot,
} from "../src/lib/server/plan-sync-authority";
import { SQLiteD1Database } from "./sqlite-d1";

const userColumns = `
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_provider_url TEXT,
  avatar_object_key TEXT,
  profile_revision INTEGER NOT NULL DEFAULT 1,
  auth_version INTEGER NOT NULL DEFAULT 1,
  deletion_pending_at INTEGER
`;

const schema = `
  CREATE TABLE users (${userColumns});
  CREATE TABLE shared_plans (
    id TEXT PRIMARY KEY,
    comiket_no INTEGER NOT NULL,
    name TEXT NOT NULL,
    owner_user_id INTEGER NOT NULL REFERENCES users(id),
    archived_at INTEGER,
    revision INTEGER NOT NULL,
    notification_epoch INTEGER NOT NULL DEFAULT 1,
    last_mutation_scope TEXT,
    last_mutation_request_id TEXT,
    last_mutation_payload_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE shared_plan_members (
    plan_id TEXT NOT NULL REFERENCES shared_plans(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    revoked_at INTEGER,
    notification_epoch INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (plan_id, user_id)
  );
  CREATE TABLE owned_plan_slots (
    owner_user_id INTEGER NOT NULL REFERENCES users(id),
    comiket_no INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    plan_id TEXT NOT NULL UNIQUE REFERENCES shared_plans(id) ON DELETE CASCADE,
    PRIMARY KEY (owner_user_id, comiket_no, slot)
  );
  CREATE TABLE shared_plan_requests (
    user_id INTEGER NOT NULL REFERENCES users(id),
    scope TEXT NOT NULL,
    request_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    result_revision INTEGER,
    result_status TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, scope, request_id)
  );
  CREATE TABLE shared_plan_invitations (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES shared_plans(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_by_user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE shared_plan_events (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES shared_plans(id) ON DELETE CASCADE
  );
  CREATE TABLE shared_plan_notification_deliveries (
    id INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES shared_plan_events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL,
    lease_expires_at INTEGER,
    last_error TEXT,
    updated_at INTEGER NOT NULL
  );
`;

test("50 concurrent plan creates allocate exactly 50 unique owner slots", async () => {
  const database = setup();
  const attempts = await Promise.allSettled(
    Array.from({ length: 51 }, (_, index) =>
      createSharedPlan(
        database.binding,
        identity(1),
        {
          requestID: `create-request-${index.toString().padStart(3, "0")}`,
          name: `Plan ${index}`,
          comiketNo: 108,
        },
        1_000_000 + index,
      ),
    ),
  );

  assert.equal(
    attempts.filter((item) => item.status === "fulfilled").length,
    50,
  );
  assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
  assert.deepEqual(
    database.rows("SELECT count(*) AS count FROM shared_plans"),
    [{ count: 50 }],
  );
  assert.deepEqual(
    database.rows(
      "SELECT count(*) AS count, count(DISTINCT slot) AS distinct_slots FROM owned_plan_slots",
    ),
    [{ count: 50, distinct_slots: 50 }],
  );
});

test("deletion fencing between authentication and commit prevents plan creation", async () => {
  const database = setup();
  database.beforeNextBatch = () => fenceUser(database, 1);
  await assert.rejects(() =>
    createSharedPlan(
      database.binding,
      identity(1),
      {
        requestID: "delete-fence-create",
        name: "Must not exist",
        comiketNo: 108,
      },
      1_000_000,
    ),
  );
  assert.deepEqual(database.rows("SELECT id FROM shared_plans"), []);
  assert.deepEqual(
    database.rows("SELECT request_id FROM shared_plan_requests"),
    [],
  );
  assert.deepEqual(database.rows("SELECT plan_id FROM owned_plan_slots"), []);
});

test("deletion fencing between ownership pre-read and commit rolls transfer back", async () => {
  const database = setup();
  const created = await createSharedPlan(
    database.binding,
    identity(1),
    { requestID: "transfer-fence-create", name: "Owned", comiketNo: 108 },
    1_000_000,
  );
  database.native
    .prepare(
      `INSERT INTO shared_plan_members
       (plan_id, user_id, role, joined_at, revoked_at, updated_at)
       VALUES (?, 2, 'editor', 1001, NULL, 1001)`,
    )
    .run(created.plan.id);
  database.beforeNextBatch = () => fenceUser(database, 1);
  await assert.rejects(() =>
    transferPlanOwnership(
      database.binding,
      identity(1),
      created.plan.id,
      {
        requestID: "transfer-fenced-request",
        baseRevision: 1,
        newOwnerUserID: identity(2).subject,
      },
      1_002_000,
    ),
  );
  assert.deepEqual(
    database.rows(
      `SELECT plan.owner_user_id, plan.revision, slot.owner_user_id AS slot_owner,
              (SELECT count(*) FROM shared_plan_requests
               WHERE request_id = 'transfer-fenced-request') AS receipts
       FROM shared_plans AS plan
       JOIN owned_plan_slots AS slot ON slot.plan_id = plan.id`,
    ),
    [{ owner_user_id: 1, revision: 1, slot_owner: 1, receipts: 0 }],
  );
  assert.deepEqual(
    database.rows(
      `SELECT user_id, role FROM shared_plan_members
       WHERE plan_id = '${created.plan.id}' ORDER BY user_id`,
    ),
    [
      { user_id: 1, role: "owner" },
      { user_id: 2, role: "editor" },
    ],
  );
});

test("ownership cannot transfer to a target whose deletion fence wins the batch", async () => {
  const database = setup();
  const created = await createSharedPlan(
    database.binding,
    identity(1),
    { requestID: "target-fence-create", name: "Owned", comiketNo: 108 },
    1_000_000,
  );
  database.native
    .prepare(
      `INSERT INTO shared_plan_members
       (plan_id, user_id, role, joined_at, revoked_at, updated_at)
       VALUES (?, 2, 'editor', 1001, NULL, 1001)`,
    )
    .run(created.plan.id);
  database.beforeNextBatch = () => fenceUser(database, 2);
  await assert.rejects(() =>
    transferPlanOwnership(
      database.binding,
      identity(1),
      created.plan.id,
      {
        requestID: "target-fenced-transfer",
        baseRevision: 1,
        newOwnerUserID: identity(2).subject,
      },
      1_002_000,
    ),
  );
  assert.deepEqual(
    database.rows(
      `SELECT plan.owner_user_id, plan.revision, slot.owner_user_id AS slot_owner,
              (SELECT count(*) FROM shared_plan_requests
               WHERE request_id = 'target-fenced-transfer') AS receipts
       FROM shared_plans AS plan
       JOIN owned_plan_slots AS slot ON slot.plan_id = plan.id`,
    ),
    [{ owner_user_id: 1, revision: 1, slot_owner: 1, receipts: 0 }],
  );
});

test("stale rename and archive conflicts include the current authorized plan", async () => {
  const database = setup();
  const created = await createSharedPlan(
    database.binding,
    identity(1),
    { requestID: "create-request-000", name: "Initial", comiketNo: 108 },
    1_000_000,
  );
  const first = await updateSharedPlan(
    database.binding,
    identity(1),
    created.plan.id,
    {
      requestID: "update-request-win",
      baseRevision: 1,
      name: "Winner",
    },
    1_001_000,
  );
  assert.equal(first.plan.revision, 2);
  database.native
    .prepare(
      `INSERT INTO shared_plan_invitations (
         id, plan_id, token_hash, created_by_user_id,
         expires_at, revoked_at, created_at
       ) VALUES ('stale-archive-invite', ?, 'stale-archive-token', 1,
                 2000, NULL, 1001)`,
    )
    .run(created.plan.id);

  const stale = () =>
    updateSharedPlan(
      database.binding,
      identity(1),
      created.plan.id,
      {
        requestID: "update-request-lose",
        baseRevision: 1,
        name: "Loser",
      },
      1_002_000,
    );
  await assert.rejects(stale, (error: unknown) => {
    assertPlanConflict(error, {
      id: created.plan.id,
      name: "Winner",
      revision: 2,
      status: "active",
      role: "owner",
    });
    return true;
  });
  await assert.rejects(stale, (error: unknown) =>
    hasCode(error, "plan_revision_conflict"),
  );
  await assert.rejects(
    () =>
      updateSharedPlan(
        database.binding,
        identity(1),
        created.plan.id,
        {
          requestID: "archive-request-stale",
          baseRevision: 1,
          archived: true,
        },
        1_003_000,
      ),
    (error: unknown) => {
      assertPlanConflict(error, {
        id: created.plan.id,
        name: "Winner",
        revision: 2,
        status: "active",
        role: "owner",
      });
      return true;
    },
  );
  assert.deepEqual(
    database.rows(
      `SELECT name, revision,
              (SELECT count(*) FROM shared_plan_requests
               WHERE request_id = 'update-request-lose') AS false_receipts,
              (SELECT count(*) FROM shared_plan_requests
               WHERE request_id = 'archive-request-stale') AS false_archive_receipts,
              (SELECT revoked_at FROM shared_plan_invitations
               WHERE id = 'stale-archive-invite') AS invitation_revoked_at,
              (SELECT count(*) FROM owned_plan_slots) AS slots
       FROM shared_plans`,
    ),
    [
      {
        name: "Winner",
        revision: 2,
        false_receipts: 0,
        false_archive_receipts: 0,
        invitation_revoked_at: null,
        slots: 1,
      },
    ],
  );
});

test("archive receipt replay preserves its immutable outcome after a later reopen", async () => {
  const database = setup();
  const created = await createSharedPlan(
    database.binding,
    identity(1),
    { requestID: "archive-plan-create", name: "Archive", comiketNo: 108 },
    1_000_000,
  );
  database.native
    .prepare(
      `INSERT INTO shared_plan_events (id, plan_id)
       VALUES ('archive-event', ?)`,
    )
    .run(created.plan.id);
  database.native.exec(
    `INSERT INTO shared_plan_notification_deliveries (
       id, event_id, user_id, status, updated_at
     ) VALUES (1, 'archive-event', 1, 'pending', 1000)`,
  );
  const archiveInput = {
    requestID: "archive-request-once",
    baseRevision: 1,
    archived: true as const,
  };
  const archived = await updateSharedPlan(
    database.binding,
    identity(1),
    created.plan.id,
    archiveInput,
    1_001_000,
  );
  assert.equal(archived.receipt.resultStatus, "archived");
  assert.deepEqual(
    database.rows(
      `SELECT plan.notification_epoch, delivery.status, delivery.last_error
       FROM shared_plans AS plan
       JOIN shared_plan_events AS event ON event.plan_id = plan.id
       JOIN shared_plan_notification_deliveries AS delivery
         ON delivery.event_id = event.id
       WHERE plan.id = '${created.plan.id}'`,
    ),
    [
      {
        notification_epoch: 2,
        status: "suppressed",
        last_error: "plan_archived",
      },
    ],
  );
  await updateSharedPlan(
    database.binding,
    identity(1),
    created.plan.id,
    {
      requestID: "reactivate-request-once",
      baseRevision: 2,
      archived: false,
    },
    1_002_000,
  );
  assert.deepEqual(
    database.rows(
      `SELECT notification_epoch FROM shared_plans
       WHERE id = '${created.plan.id}'`,
    ),
    [{ notification_epoch: 3 }],
  );

  const replay = await updateSharedPlan(
    database.binding,
    identity(1),
    created.plan.id,
    archiveInput,
    1_003_000,
  );
  assert.equal(replay.plan.status, "active");
  assert.equal(replay.plan.revision, 3);
  assert.deepEqual(replay.receipt, {
    requestId: "archive-request-once",
    replayed: true,
    resultRevision: 2,
    resultStatus: "archived",
  });
});

test("ownership transfer moves the existing slot and two concurrent requests preserve one owner", async () => {
  const database = setup();
  const created = await createSharedPlan(
    database.binding,
    identity(1),
    { requestID: "create-request-000", name: "Transfer", comiketNo: 108 },
    1_000_000,
  );
  database.native
    .prepare(
      `INSERT INTO shared_plan_members
       (plan_id, user_id, role, joined_at, revoked_at, updated_at)
       VALUES (?, 2, 'editor', 1000, NULL, 1000)`,
    )
    .run(created.plan.id);

  const attempts = await Promise.allSettled([
    transferPlanOwnership(
      database.binding,
      identity(1),
      created.plan.id,
      {
        requestID: "transfer-request-one",
        baseRevision: 1,
        newOwnerUserID: identity(2).subject,
      },
      1_001_000,
    ),
    transferPlanOwnership(
      database.binding,
      identity(1),
      created.plan.id,
      {
        requestID: "transfer-request-two",
        baseRevision: 1,
        newOwnerUserID: identity(2).subject,
      },
      1_001_000,
    ),
  ]);

  assert.equal(
    attempts.filter((item) => item.status === "fulfilled").length,
    1,
  );
  assert.deepEqual(
    database.rows(
      `SELECT plan.owner_user_id, slot.owner_user_id AS slot_owner,
              (SELECT count(*) FROM shared_plan_members
               WHERE plan_id = plan.id AND role = 'owner' AND revoked_at IS NULL) AS owners
       FROM shared_plans AS plan
       JOIN owned_plan_slots AS slot ON slot.plan_id = plan.id`,
    ),
    [{ owner_user_id: 2, slot_owner: 2, owners: 1 }],
  );
});

test("ownership transfer fails atomically when the target owns 50 active plans", async () => {
  const database = setup();
  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      createSharedPlan(
        database.binding,
        identity(2),
        {
          requestID: `target-create-${index.toString().padStart(4, "0")}`,
          name: `Target ${index}`,
          comiketNo: 108,
        },
        1_000_000 + index,
      ),
    ),
  );
  const source = await createSharedPlan(
    database.binding,
    identity(1),
    { requestID: "source-create-0000", name: "Source", comiketNo: 108 },
    1_001_000,
  );
  database.native
    .prepare(
      `INSERT INTO shared_plan_members
       (plan_id, user_id, role, joined_at, revoked_at, updated_at)
       VALUES (?, 2, 'editor', 1000, NULL, 1000)`,
    )
    .run(source.plan.id);

  await assert.rejects(
    () =>
      transferPlanOwnership(
        database.binding,
        identity(1),
        source.plan.id,
        {
          requestID: "transfer-full-target",
          baseRevision: 1,
          newOwnerUserID: identity(2).subject,
        },
        1_002_000,
      ),
    (error: unknown) => hasCode(error, "new_owner_active_plan_limit"),
  );
  assert.deepEqual(
    database.rows(
      `SELECT plan.owner_user_id, plan.revision,
              slot.owner_user_id AS slot_owner,
              (SELECT count(*) FROM shared_plan_requests
               WHERE request_id = 'transfer-full-target') AS false_receipts
       FROM shared_plans AS plan
       JOIN owned_plan_slots AS slot ON slot.plan_id = plan.id
       WHERE plan.id = '${source.plan.id}'`,
    ),
    [{ owner_user_id: 1, revision: 1, slot_owner: 1, false_receipts: 0 }],
  );
});

test("replayed member revocation does not fence an explicitly reinstated member", async () => {
  const database = setup();
  const owner = identity(1);
  const editor = identity(2);
  const created = await createSharedPlan(
    database.binding,
    owner,
    { requestID: "fence-replay-create", name: "Fence replay", comiketNo: 108 },
    1_000_000,
  );
  database.native
    .prepare(
      `INSERT INTO shared_plan_members
       (plan_id, user_id, role, joined_at, revoked_at, updated_at)
       VALUES (?, 2, 'editor', 1000, NULL, 1000)`,
    )
    .run(created.plan.id);
  database.native
    .prepare(
      `INSERT INTO shared_plan_events (id, plan_id)
       VALUES ('member-event', ?)`,
    )
    .run(created.plan.id);
  database.native.exec(
    `INSERT INTO shared_plan_notification_deliveries (
       id, event_id, user_id, status, updated_at
     ) VALUES (1, 'member-event', 2, 'retry', 1000)`,
  );
  const socketAuthority = {
    userID: editor.userID,
    userPublicID: editor.subject,
    planID: created.plan.id,
    authVersion: editor.authVersion,
  };
  const revokeInput = {
    requestID: "fence-replay-revoke",
    baseRevision: 1,
  };
  await setPlanMemberRevoked(
    database.binding,
    owner,
    created.plan.id,
    editor.subject,
    revokeInput,
    true,
    1_001_000,
  );
  assert.equal(
    await hasPlanSyncAuthority(database.binding, socketAuthority, true),
    false,
  );
  assert.deepEqual(
    database.rows(
      `SELECT member.notification_epoch, delivery.status, delivery.last_error
       FROM shared_plan_members AS member
       JOIN shared_plan_notification_deliveries AS delivery
         ON delivery.user_id = member.user_id
       WHERE member.plan_id = '${created.plan.id}' AND member.user_id = 2`,
    ),
    [
      {
        notification_epoch: 2,
        status: "suppressed",
        last_error: "membership_revoked",
      },
    ],
  );
  await setPlanMemberRevoked(
    database.binding,
    owner,
    created.plan.id,
    editor.subject,
    { requestID: "fence-replay-reinstate", baseRevision: 2 },
    false,
    1_002_000,
  );
  assert.equal(
    await hasPlanSyncAuthority(database.binding, socketAuthority, true),
    true,
  );
  assert.deepEqual(
    database.rows(
      `SELECT notification_epoch FROM shared_plan_members
       WHERE plan_id = '${created.plan.id}' AND user_id = 2`,
    ),
    [{ notification_epoch: 3 }],
  );
  const replay = await setPlanMemberRevoked(
    database.binding,
    owner,
    created.plan.id,
    editor.subject,
    revokeInput,
    true,
    1_003_000,
  );
  assert.equal(replay.receipt.replayed, true);
  assert.equal(
    await hasPlanSyncAuthority(database.binding, socketAuthority, true),
    true,
  );
});

test("sync mutation authority snapshots the exact active membership and auth epoch", async () => {
  const database = setup();
  const owner = identity(1);
  const created = await createSharedPlan(
    database.binding,
    owner,
    { requestID: "sync-authority-create", name: "Authority", comiketNo: 108 },
    1_000_000,
  );
  database.native
    .prepare(
      `INSERT INTO shared_plan_members (
         plan_id, user_id, role, joined_at, revoked_at, updated_at
       ) VALUES (?, 2, 'editor', 1000, NULL, 1000)`,
    )
    .run(created.plan.id);
  const authority = {
    userID: owner.userID,
    userPublicID: owner.subject,
    planID: created.plan.id,
    authVersion: owner.authVersion,
  };
  assert.deepEqual(
    await loadPlanSyncAuthoritySnapshot(database.binding, authority),
    {
      membershipEpoch: 1,
      planNotificationEpoch: 1,
      members: [
        {
          userID: 1,
          userPublicID: "00000000000000000000000000000001",
          authVersion: 1,
          notificationEpoch: 1,
        },
        {
          userID: 2,
          userPublicID: "00000000000000000000000000000002",
          authVersion: 1,
          notificationEpoch: 1,
        },
      ],
    },
  );
  fenceUser(database, 2);
  assert.deepEqual(
    (await loadPlanSyncAuthoritySnapshot(database.binding, authority))?.members,
    [
      {
        userID: 1,
        userPublicID: "00000000000000000000000000000001",
        authVersion: 1,
        notificationEpoch: 1,
      },
    ],
  );
  fenceUser(database, 1);
  assert.equal(
    await loadPlanSyncAuthoritySnapshot(database.binding, authority),
    null,
  );
});

test("invitation revoke is marker-causal and removed members cannot replay acceptance", async () => {
  const database = setup();
  const owner = identity(1);
  const editor = identity(2);
  const created = await createSharedPlan(
    database.binding,
    owner,
    { requestID: "invite-plan-create", name: "Invite", comiketNo: 108 },
    1_000_000,
  );
  const invitation = (await createInvitation(
    database.binding,
    owner,
    created.plan.id,
    {
      requestID: "invitation-create-00",
      baseRevision: 1,
      expiresAt: 2_000,
    },
    "secret-value-with-at-least-thirty-two-bytes",
    1_001_000,
  )) as { invitationID: string; token: string };
  const accepted = await acceptInvitation(
    database.binding,
    editor,
    invitation.token,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    "secret-value-with-at-least-thirty-two-bytes",
    1_002_000,
  );
  assert.equal((accepted as { plan: { role: string } }).plan.role, "editor");
  database.native
    .prepare(
      "UPDATE shared_plan_members SET revoked_at = 1003 WHERE plan_id = ? AND user_id = 2",
    )
    .run(created.plan.id);
  await assert.rejects(
    () =>
      acceptInvitation(
        database.binding,
        editor,
        invitation.token,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        "secret-value-with-at-least-thirty-two-bytes",
        1_003_000,
      ),
    (error: unknown) => hasCode(error, "plan_membership_revoked"),
  );

  const revoked = await revokeInvitation(
    database.binding,
    owner,
    created.plan.id,
    invitation.invitationID,
    { requestID: "invitation-revoke-00", baseRevision: 2 },
    1_004_000,
  );
  assert.equal(revoked.plan.revision, 3);
  await assert.rejects(
    () =>
      acceptInvitation(
        database.binding,
        editor,
        invitation.token,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        "secret-value-with-at-least-thirty-two-bytes",
        1_005_000,
      ),
    (error: unknown) => hasCode(error, "invitation_unavailable"),
  );
  assert.deepEqual(
    database.rows(
      `SELECT invitation.revoked_at, plan.revision,
              (SELECT count(*) FROM shared_plan_requests
               WHERE request_id = 'invitation-revoke-00') AS receipts
       FROM shared_plan_invitations AS invitation
       JOIN shared_plans AS plan ON plan.id = invitation.plan_id`,
    ),
    [{ revoked_at: 1_004, revision: 3, receipts: 1 }],
  );

  const racedInvitation = (await createInvitation(
    database.binding,
    owner,
    created.plan.id,
    {
      requestID: "invitation-race-create",
      baseRevision: 3,
      expiresAt: 2_000,
    },
    "secret-value-with-at-least-thirty-two-bytes",
    1_005_000,
  )) as { invitationID: string; token: string };
  database.beforeNextBatch = () => {
    database.native
      .prepare(
        "UPDATE shared_plan_invitations SET revoked_at = 1006 WHERE id = ?",
      )
      .run(racedInvitation.invitationID);
  };
  await assert.rejects(
    () =>
      acceptInvitation(
        database.binding,
        identity(3),
        racedInvitation.token,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        "secret-value-with-at-least-thirty-two-bytes",
        1_006_000,
      ),
    (error: unknown) => hasCode(error, "invitation_unavailable"),
  );
  assert.deepEqual(
    database.rows(
      `SELECT
         (SELECT count(*) FROM shared_plan_members WHERE user_id = 3) AS members,
         (SELECT count(*) FROM shared_plan_requests
          WHERE request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3') AS receipts`,
    ),
    [{ members: 0, receipts: 0 }],
  );
});

test("invitation revoke rechecks the caller role inside the authority batch", async () => {
  const database = setup();
  const owner = identity(1);
  const created = await createSharedPlan(
    database.binding,
    owner,
    { requestID: "role-race-plan-create", name: "Role race", comiketNo: 108 },
    1_000_000,
  );
  database.native
    .prepare(
      `INSERT INTO shared_plan_members
       (plan_id, user_id, role, joined_at, revoked_at, updated_at)
       VALUES (?, 2, 'editor', 1000, NULL, 1000)`,
    )
    .run(created.plan.id);
  const invitation = (await createInvitation(
    database.binding,
    owner,
    created.plan.id,
    { requestID: "role-race-invite-new", baseRevision: 1, expiresAt: 2_000 },
    "secret-value-with-at-least-thirty-two-bytes",
    1_001_000,
  )) as { invitationID: string };
  database.native
    .prepare(
      "UPDATE shared_plan_invitations SET created_by_user_id = 2 WHERE id = ?",
    )
    .run(invitation.invitationID);
  database.beforeNextBatch = () => {
    database.native.exec(`
      UPDATE shared_plan_members SET role = 'editor' WHERE user_id = 1;
      UPDATE shared_plan_members SET role = 'owner' WHERE user_id = 2;
    `);
  };

  await assert.rejects(
    () =>
      revokeInvitation(
        database.binding,
        owner,
        created.plan.id,
        invitation.invitationID,
        { requestID: "role-race-revoke-id", baseRevision: 2 },
        1_002_000,
      ),
    (error: unknown) => hasCode(error, "plan_revision_conflict"),
  );
  assert.deepEqual(
    database.rows(
      `SELECT revoked_at,
              (SELECT count(*) FROM shared_plan_requests
               WHERE request_id = 'role-race-revoke-id') AS false_receipts
       FROM shared_plan_invitations WHERE id = '${invitation.invitationID}'`,
    ),
    [{ revoked_at: null, false_receipts: 0 }],
  );
});

test("archived plans revoke invites while durable accepted receipts remain replayable", async () => {
  const database = setup();
  const owner = identity(1);
  const tokenSecret = "secret-value-with-at-least-thirty-two-bytes";
  const created = await createSharedPlan(
    database.binding,
    owner,
    {
      requestID: "archived-invite-plan",
      name: "Archived invite",
      comiketNo: 108,
    },
    1_000_000,
  );
  const invitation = (await createInvitation(
    database.binding,
    owner,
    created.plan.id,
    {
      requestID: "archived-invite-create",
      baseRevision: 1,
      expiresAt: 2_000,
    },
    tokenSecret,
    1_001_000,
  )) as { invitationID: string; token: string };
  database.native
    .prepare(
      `INSERT INTO shared_plan_invitations (
         id, plan_id, token_hash, created_by_user_id,
         expires_at, revoked_at, created_at
       ) VALUES ('archive-lifecycle-second', ?, 'archive-lifecycle-token', 1,
                 2000, NULL, 1001)`,
    )
    .run(created.plan.id);
  assert.equal(
    (
      await previewInvitation(
        database.binding,
        invitation.token,
        tokenSecret,
        1_002_000,
      )
    ).planID,
    created.plan.id,
  );
  const acceptRequestID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
  await acceptInvitation(
    database.binding,
    identity(2),
    invitation.token,
    acceptRequestID,
    tokenSecret,
    1_002_000,
  );
  await updateSharedPlan(
    database.binding,
    owner,
    created.plan.id,
    {
      requestID: "archived-invite-archive",
      baseRevision: 2,
      archived: true,
    },
    1_003_000,
  );
  assert.deepEqual(
    database.rows(
      `SELECT count(*) AS invitation_count,
              min(revoked_at) AS earliest_revocation,
              max(revoked_at) AS latest_revocation
       FROM shared_plan_invitations WHERE plan_id = '${created.plan.id}'`,
    ),
    [
      {
        invitation_count: 2,
        earliest_revocation: 1_003,
        latest_revocation: 1_003,
      },
    ],
  );
  await assert.rejects(
    () =>
      previewInvitation(
        database.binding,
        invitation.token,
        tokenSecret,
        1_004_000,
      ),
    (error: unknown) => hasCode(error, "invitation_unavailable"),
  );
  const archivedReplay = (await acceptInvitation(
    database.binding,
    identity(2),
    invitation.token,
    acceptRequestID,
    tokenSecret,
    1_004_000,
  )) as Awaited<ReturnType<typeof updateSharedPlan>>;
  assert.equal(archivedReplay.plan.status, "archived");
  assert.equal(archivedReplay.receipt.replayed, true);
  await assert.rejects(
    () =>
      acceptInvitation(
        database.binding,
        identity(3),
        invitation.token,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
        tokenSecret,
        1_004_000,
      ),
    (error: unknown) => hasCode(error, "invitation_unavailable"),
  );
  await updateSharedPlan(
    database.binding,
    owner,
    created.plan.id,
    {
      requestID: "archived-invite-reopen",
      baseRevision: 3,
      archived: false,
    },
    1_005_000,
  );
  assert.deepEqual(
    database.rows(
      `SELECT plan.archived_at, invitation.revoked_at
       FROM shared_plans AS plan
       JOIN shared_plan_invitations AS invitation ON invitation.plan_id = plan.id
       WHERE invitation.id = '${invitation.invitationID}'`,
    ),
    [{ archived_at: null, revoked_at: 1_003 }],
  );
  await assert.rejects(
    () =>
      previewInvitation(
        database.binding,
        invitation.token,
        tokenSecret,
        1_006_000,
      ),
    (error: unknown) => hasCode(error, "invitation_unavailable"),
  );
  const reopenedReplay = (await acceptInvitation(
    database.binding,
    identity(2),
    invitation.token,
    acceptRequestID,
    tokenSecret,
    1_006_000,
  )) as Awaited<ReturnType<typeof updateSharedPlan>>;
  assert.equal(reopenedReplay.plan.status, "active");
  assert.equal(reopenedReplay.receipt.replayed, true);

  const racedPlan = await createSharedPlan(
    database.binding,
    owner,
    { requestID: "archive-race-plan", name: "Archive race", comiketNo: 108 },
    1_007_000,
  );
  const racedInvitation = (await createInvitation(
    database.binding,
    owner,
    racedPlan.plan.id,
    {
      requestID: "archive-race-invite",
      baseRevision: 1,
      expiresAt: 2_000,
    },
    tokenSecret,
    1_008_000,
  )) as { token: string };
  database.beforeNextBatch = () => {
    database.native
      .prepare(
        "UPDATE shared_plans SET archived_at = 1009, revision = revision + 1 WHERE id = ?",
      )
      .run(racedPlan.plan.id);
  };
  await assert.rejects(
    () =>
      acceptInvitation(
        database.binding,
        identity(3),
        racedInvitation.token,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6",
        tokenSecret,
        1_009_000,
      ),
    (error: unknown) => hasCode(error, "invitation_unavailable"),
  );
  assert.deepEqual(
    database.rows(
      `SELECT
         (SELECT count(*) FROM shared_plan_members
          WHERE plan_id = '${racedPlan.plan.id}' AND user_id = 3) AS members,
         (SELECT count(*) FROM shared_plan_requests
          WHERE request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6') AS receipts`,
    ),
    [{ members: 0, receipts: 0 }],
  );
});

test("archive DELETE body parser accepts the frozen request-only shape", () => {
  assert.deepEqual(
    parsePlanArchive({
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      baseRevision: 7,
    }),
    {
      requestID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      baseRevision: 7,
      archived: true,
    },
  );
});

test("request IDs reject UUID case variants instead of splitting receipts", () => {
  const lower = parseCreatePlan({
    requestId: "abcdefab-cdef-4abc-8def-abcdefabcdef",
    name: "Canonical",
    comiketNo: 108,
  });
  assert.equal(lower.requestID, "abcdefab-cdef-4abc-8def-abcdefabcdef");
  assert.throws(
    () =>
      parseCreatePlan({
        requestId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
        name: "Canonical",
        comiketNo: 108,
      }),
    (error: unknown) => hasCode(error, "invalid_request_id"),
  );
});

test("plan names use Unicode scalar limits", () => {
  assert.equal(
    parseCreatePlan({
      requestId: "12345678-1234-4123-8123-123456789abc",
      comiketNo: 108,
      name: "😀".repeat(100),
    }).name,
    "😀".repeat(100),
  );
  assert.throws(() =>
    parseCreatePlan({
      requestId: "12345678-1234-4123-8123-123456789abc",
      comiketNo: 108,
      name: "😀".repeat(101),
    }),
  );
});

test("collection pagination defaults to 50 and caps requests at 100", () => {
  assert.deepEqual(
    parseCollectionPage(new Request("https://cominavi.net/api/v2/plans")),
    { limit: 50, cursor: null },
  );
  assert.deepEqual(
    parseCollectionPage(
      new Request("https://cominavi.net/api/v2/plans?limit=100&cursor=opaque"),
    ),
    { limit: 100, cursor: "opaque" },
  );
  assert.throws(
    () =>
      parseCollectionPage(
        new Request("https://cominavi.net/api/v2/plans?limit=101"),
      ),
    (error: unknown) => hasCode(error, "invalid_pagination"),
  );
});

test("reusable invitations and reinstatement atomically cap active members at 50", async () => {
  const database = setup();
  for (let userID = 4; userID <= 53; userID += 1) {
    database.native
      .prepare(
        `INSERT INTO users (id, public_id, display_name)
         VALUES (?, ?, ?)`,
      )
      .run(userID, userID.toString(16).padStart(32, "0"), `Member ${userID}`);
  }
  const owner = identity(1);
  const created = await createSharedPlan(
    database.binding,
    owner,
    { requestID: "member-cap-plan", name: "Member cap", comiketNo: 108 },
    1_000_000,
  );
  for (let userID = 4; userID <= 51; userID += 1) {
    database.native
      .prepare(
        `INSERT INTO shared_plan_members (
           plan_id, user_id, role, joined_at, revoked_at, updated_at
         ) VALUES (?, ?, 'editor', 1001, NULL, 1001)`,
      )
      .run(created.plan.id, userID);
  }
  database.native
    .prepare(
      `INSERT INTO shared_plan_members (
         plan_id, user_id, role, joined_at, revoked_at, updated_at
       ) VALUES (?, 52, 'editor', 1001, 1002, 1002)`,
    )
    .run(created.plan.id);
  const secret = "secret-value-with-at-least-thirty-two-bytes";
  const invitation = (await createInvitation(
    database.binding,
    owner,
    created.plan.id,
    { requestID: "member-cap-invite", baseRevision: 1, expiresAt: 2_000 },
    secret,
    1_003_000,
  )) as { token: string };

  const attempts = await Promise.allSettled([
    acceptInvitation(
      database.binding,
      identity(2),
      invitation.token,
      "22222222-2222-4222-8222-222222222222",
      secret,
      1_004_000,
    ),
    acceptInvitation(
      database.binding,
      identity(3),
      invitation.token,
      "33333333-3333-4333-8333-333333333333",
      secret,
      1_004_000,
    ),
  ]);
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1,
  );
  const rejection = attempts.find(
    (attempt): attempt is PromiseRejectedResult =>
      attempt.status === "rejected",
  );
  assert.ok(rejection && hasCode(rejection.reason, "member_limit"));
  assert.deepEqual(
    database.rows(
      `SELECT count(*) AS count FROM shared_plan_members
       WHERE plan_id = '${created.plan.id}' AND revoked_at IS NULL`,
    ),
    [{ count: 50 }],
  );
  const acceptedUser = database.rows(
    `SELECT user_id FROM shared_plan_members
     WHERE plan_id = '${created.plan.id}' AND user_id IN (2, 3)
       AND revoked_at IS NULL`,
  )[0] as { user_id: number };
  const reusable = (await acceptInvitation(
    database.binding,
    identity(acceptedUser.user_id),
    invitation.token,
    "44444444-4444-4444-8444-444444444444",
    secret,
    1_004_000,
  )) as Awaited<ReturnType<typeof updateSharedPlan>>;
  assert.equal(reusable.plan.id, created.plan.id);
  assert.deepEqual(
    database.rows(
      `SELECT count(*) AS count FROM shared_plan_members
       WHERE plan_id = '${created.plan.id}' AND revoked_at IS NULL`,
    ),
    [{ count: 50 }],
  );

  await assert.rejects(
    () =>
      setPlanMemberRevoked(
        database.binding,
        owner,
        created.plan.id,
        identity(52).subject,
        { requestID: "member-cap-reinstate", baseRevision: 2 },
        false,
        1_005_000,
      ),
    (error: unknown) => hasCode(error, "member_limit"),
  );
  assert.deepEqual(
    database.rows(
      `SELECT revoked_at FROM shared_plan_members
       WHERE plan_id = '${created.plan.id}' AND user_id = 52`,
    ),
    [{ revoked_at: 1_002 }],
  );
});

test("the Shared Plan REST fixture is emitted by live services, receipts, and error serializers", async (context) => {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/shared-plan-rest-v1.json", "utf8"),
  ) as SharedPlanRESTFixture;
  const database = setup();
  const owner = identity(1);
  const editor = identity(2);
  const planID = fixture.create.plan.id;
  database.native.exec(`
    UPDATE users SET avatar_object_key = 'fixture-editor-avatar' WHERE id = 2;
    INSERT INTO shared_plans (
      id, comiket_no, name, owner_user_id, archived_at, revision,
      created_at, updated_at
    ) VALUES (
      '${planID}', 108, '買い物リスト', 1, NULL, 1,
      1786276800, 1786276800
    );
    INSERT INTO shared_plan_members (
      plan_id, user_id, role, joined_at, revoked_at, updated_at
    ) VALUES
      ('${planID}', 1, 'owner', 1786276800, NULL, 1786276800),
      ('${planID}', 2, 'editor', 1786277100, NULL, 1786277100);
    INSERT INTO owned_plan_slots (owner_user_id, comiket_no, slot, plan_id)
    VALUES (1, 108, 0, '${planID}');
  `);

  const firstMembersPage = parseCollectionPage(
    new Request(
      `https://cominavi.net${fixture.members.firstPage.request.path}`,
    ),
  );
  assert.deepEqual(
    await listPlanMembers(database.binding, owner, planID, firstMembersPage),
    currentMemberPage(fixture.members.firstPage.response),
  );
  const nextMembersPage = parseCollectionPage(
    new Request(`https://cominavi.net${fixture.members.nextPage.request.path}`),
  );
  assert.deepEqual(
    await listPlanMembers(database.binding, owner, planID, nextMembersPage),
    currentMemberPage(fixture.members.nextPage.response),
  );

  const revocationInput = parseMembershipMutation(
    fixture.memberRevocation.request.body,
  );
  assert.deepEqual(
    await setPlanMemberRevoked(
      database.binding,
      owner,
      planID,
      editor.subject,
      revocationInput,
      true,
      1_786_277_400_000,
    ),
    fixture.memberRevocation.response,
  );
  assert.deepEqual(
    await setPlanMemberRevoked(
      database.binding,
      owner,
      planID,
      editor.subject,
      revocationInput,
      true,
      1_786_277_401_000,
    ),
    fixture.memberRevocation.exactReplayResponse,
  );

  const removedMembers = await listPlanMembers(
    database.binding,
    owner,
    planID,
    parseCollectionPage(
      new Request(
        `https://cominavi.net${fixture.members.afterRevocation.request.path}`,
      ),
    ),
  );
  assert.deepEqual(
    removedMembers,
    currentMemberPage(fixture.members.afterRevocation.response),
  );
  const removedMember = removedMembers.items.find(
    (item) => isFixtureRecord(item) && item.membershipStatus === "removed",
  );
  assert.ok(isFixtureRecord(removedMember));
  assert.equal(removedMember.userID, editor.subject);
  database.native
    .prepare(
      `INSERT INTO shared_plan_members (
         plan_id, user_id, role, joined_at, revoked_at, updated_at
       ) VALUES (?, 3, 'editor', 1786277410, NULL, 1786277410)`,
    )
    .run(planID);
  const editorView = await listPlanMembers(
    database.binding,
    identity(3),
    planID,
  );
  assert.equal(
    editorView.items.some(
      (item) => isFixtureRecord(item) && item.userID === removedMember.userID,
    ),
    false,
    "active editors cannot enumerate removed membership history",
  );
  assert.ok(
    editorView.items.every(
      (item) => isFixtureRecord(item) && item.membershipStatus === "active",
    ),
  );

  const reinstatementInput = parseMembershipMutation(
    fixture.memberReinstatement.request.body,
  );
  assert.deepEqual(
    await setPlanMemberRevoked(
      database.binding,
      owner,
      planID,
      String(removedMember.userID),
      reinstatementInput,
      false,
      1_786_277_460_000,
    ),
    fixture.memberReinstatement.response,
  );
  assert.deepEqual(
    await setPlanMemberRevoked(
      database.binding,
      owner,
      planID,
      String(removedMember.userID),
      reinstatementInput,
      false,
      1_786_277_461_000,
    ),
    fixture.memberReinstatement.exactReplayResponse,
  );

  const transferInput = parseOwnershipTransfer(
    fixture.ownershipTransfer.request.body,
  );
  assert.deepEqual(
    await transferPlanOwnership(
      database.binding,
      owner,
      planID,
      transferInput,
      1_786_277_520_000,
    ),
    fixture.ownershipTransfer.response,
  );
  assert.deepEqual(
    await transferPlanOwnership(
      database.binding,
      owner,
      planID,
      transferInput,
      1_786_277_521_000,
    ),
    fixture.ownershipTransfer.exactReplayResponse,
  );

  context.mock.method(
    globalThis.crypto,
    "randomUUID",
    () => fixture.invitations.create.response.invitationID,
  );
  context.mock.method(
    globalThis.crypto,
    "getRandomValues",
    (array: Uint8Array) => {
      array.fill(1);
      return array;
    },
  );
  const invitationInput = parseInvitationCreate(
    fixture.invitations.create.request.body,
  );
  const invitation = await createInvitation(
    database.binding,
    owner,
    planID,
    invitationInput,
    "secret-value-with-at-least-thirty-two-bytes",
    1_786_277_580_000,
  );
  assert.deepEqual(invitation, fixture.invitations.create.response);
  const serializedInvitation = jsonResponse(
    invitation,
    fixture.invitations.create.responseHTTPStatus,
  );
  assert.equal(serializedInvitation.status, 201);
  assert.deepEqual(
    await serializedInvitation.json(),
    fixture.invitations.create.response,
  );

  const lostCreateResponse = await serializedServiceError(() =>
    createInvitation(
      database.binding,
      owner,
      planID,
      invitationInput,
      "secret-value-with-at-least-thirty-two-bytes",
      1_786_277_581_000,
    ),
  );
  assert.equal(
    lostCreateResponse.httpStatus,
    fixture.invitations.create.lostResponseReplayHTTPStatus,
  );
  assert.deepEqual(
    lostCreateResponse.response,
    fixture.invitations.create.lostResponseReplay,
  );

  database.native
    .prepare(
      `INSERT INTO shared_plan_invitations (
         id, plan_id, token_hash, created_by_user_id,
         expires_at, revoked_at, created_at
       ) VALUES (?, ?, 'fixture-second-token-hash', 2, 1786882320, NULL, 1786277520)`,
    )
    .run("55555555-5555-4555-8555-555555555556", planID);
  const ownerInvitationsPage = parseCollectionPage(
    new Request(
      `https://cominavi.net${fixture.invitations.listAsOwner.request.path}`,
    ),
  );
  assert.deepEqual(
    await listInvitations(
      database.binding,
      editor,
      planID,
      ownerInvitationsPage,
    ),
    fixture.invitations.listAsOwner.response,
  );
  const editorInvitationsPage = parseCollectionPage(
    new Request(
      `https://cominavi.net${fixture.invitations.listAsEditor.request.path}`,
    ),
  );
  assert.deepEqual(
    await listInvitations(
      database.binding,
      owner,
      planID,
      editorInvitationsPage,
    ),
    fixture.invitations.listAsEditor.response,
  );

  const invitationRevocationInput = parseMembershipMutation(
    fixture.invitations.revoke.request.body,
  );
  assert.deepEqual(
    await revokeInvitation(
      database.binding,
      owner,
      planID,
      fixture.invitations.create.response.invitationID,
      invitationRevocationInput,
      1_786_277_640_000,
    ),
    fixture.invitations.revoke.response,
  );
  assert.deepEqual(
    await revokeInvitation(
      database.binding,
      owner,
      planID,
      fixture.invitations.create.response.invitationID,
      invitationRevocationInput,
      1_786_277_641_000,
    ),
    fixture.invitations.revoke.exactReplayResponse,
  );

  const ownerRequired = await serializedServiceError(() =>
    setPlanMemberRevoked(
      database.binding,
      owner,
      planID,
      editor.subject,
      {
        requestID: "66666666-6666-4666-8666-666666666661",
        baseRevision: 6,
      },
      true,
      1_786_277_700_000,
    ),
  );
  assert.deepEqual(ownerRequired, fixture.errors.ownerRequired);

  const revisionConflict = await serializedServiceError(() =>
    revokeInvitation(
      database.binding,
      owner,
      planID,
      fixture.invitations.create.response.invitationID,
      {
        requestID: "66666666-6666-4666-8666-666666666662",
        baseRevision: 5,
      },
      1_786_277_701_000,
    ),
  );
  assert.deepEqual(revisionConflict, fixture.errors.revisionConflict);
});

test("plan, member, and invitation pages use stable bounded cursors", async () => {
  const database = setup();
  const owner = identity(1);
  const first = await createSharedPlan(
    database.binding,
    owner,
    { requestID: "page-plan-create-one", name: "First", comiketNo: 108 },
    1_000_000,
  );
  await createSharedPlan(
    database.binding,
    owner,
    { requestID: "page-plan-create-two", name: "Second", comiketNo: 108 },
    1_001_000,
  );
  database.native
    .prepare(
      `INSERT INTO shared_plan_members
       (plan_id, user_id, role, joined_at, revoked_at, updated_at)
       VALUES (?, 2, 'editor', 1001, NULL, 1001)`,
    )
    .run(first.plan.id);
  const inviteOne = await createInvitation(
    database.binding,
    owner,
    first.plan.id,
    { requestID: "page-invite-create-one", baseRevision: 1, expiresAt: 2_000 },
    "secret-value-with-at-least-thirty-two-bytes",
    1_002_000,
  );
  await createInvitation(
    database.binding,
    owner,
    first.plan.id,
    { requestID: "page-invite-create-two", baseRevision: 2, expiresAt: 2_000 },
    "secret-value-with-at-least-thirty-two-bytes",
    1_003_000,
  );

  const plansOne = await listSharedPlans(database.binding, owner, {
    limit: 1,
    cursor: null,
  });
  assert.equal(plansOne.items.length, 1);
  assert.ok(plansOne.nextCursor);
  const plansTwo = await listSharedPlans(database.binding, owner, {
    limit: 1,
    cursor: plansOne.nextCursor,
  });
  assert.notEqual(plansOne.items[0]?.id, plansTwo.items[0]?.id);

  const membersOne = await listPlanMembers(
    database.binding,
    owner,
    first.plan.id,
    { limit: 1, cursor: null },
  );
  assert.ok(membersOne.nextCursor);
  const membersTwo = await listPlanMembers(
    database.binding,
    owner,
    first.plan.id,
    { limit: 1, cursor: membersOne.nextCursor },
  );
  assert.notDeepEqual(membersOne.items, membersTwo.items);

  const invitationsOne = await listInvitations(
    database.binding,
    owner,
    first.plan.id,
    { limit: 1, cursor: null },
  );
  assert.ok(invitationsOne.nextCursor);
  const invitationsTwo = await listInvitations(
    database.binding,
    owner,
    first.plan.id,
    { limit: 1, cursor: invitationsOne.nextCursor },
  );
  assert.notEqual(
    (invitationsOne.items[0] as { invitationID: string }).invitationID,
    (invitationsTwo.items[0] as { invitationID: string }).invitationID,
  );
  assert.equal(
    (invitationsOne.items[0] as { invitationID: string }).invitationID ===
      (inviteOne as { invitationID: string }).invitationID,
    false,
  );
  database.native
    .prepare(
      "UPDATE shared_plan_members SET revoked_at = 1004 WHERE plan_id = ? AND user_id = 2",
    )
    .run(first.plan.id);
  await assert.rejects(
    () =>
      listPlanMembers(database.binding, identity(2), first.plan.id, {
        limit: 1,
        cursor: null,
      }),
    (error: unknown) => hasCode(error, "plan_not_found"),
  );
  await assert.rejects(
    () =>
      listInvitations(database.binding, identity(2), first.plan.id, {
        limit: 1,
        cursor: null,
      }),
    (error: unknown) => hasCode(error, "plan_not_found"),
  );
});

interface SharedPlanRESTFixture {
  create: { plan: { id: string } };
  members: {
    firstPage: FixturePage;
    nextPage: FixturePage;
    afterRevocation: FixturePage;
  };
  memberRevocation: FixtureMutation;
  memberReinstatement: FixtureMutation;
  ownershipTransfer: FixtureMutation;
  invitations: {
    listAsOwner: FixturePage;
    listAsEditor: FixturePage;
    create: {
      request: { body: unknown };
      responseHTTPStatus: number;
      response: Record<string, unknown> & { invitationID: string };
      lostResponseReplayHTTPStatus: number;
      lostResponseReplay: Record<string, unknown>;
    };
    revoke: FixtureMutation;
  };
  errors: {
    ownerRequired: SerializedFixtureError;
    revisionConflict: SerializedFixtureError;
  };
}

interface FixturePage {
  request: { path: string };
  response: { items: unknown[]; nextCursor: string | null };
}

function currentMemberPage(
  page: FixturePage["response"],
): FixturePage["response"] {
  return {
    ...page,
    items: page.items.map((item) => {
      if (!isFixtureRecord(item) || typeof item.avatarURL !== "string") {
        return item;
      }
      return {
        ...item,
        avatarURL: `/api/v2/users/${String(item.userID)}/avatar`,
      };
    }),
  };
}

interface FixtureMutation {
  request: { body: unknown };
  response: unknown;
  exactReplayResponse: unknown;
}

interface SerializedFixtureError {
  httpStatus: number;
  response: unknown;
}

async function serializedServiceError(
  action: () => Promise<unknown>,
): Promise<SerializedFixtureError> {
  try {
    await action();
  } catch (error) {
    const response = apiErrorResponse(error);
    return { httpStatus: response.status, response: await response.json() };
  }
  assert.fail("Expected a serialized service error.");
}

function isFixtureRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function setup(): SQLiteD1Database {
  const database = new SQLiteD1Database(schema);
  database.native.exec(`
    INSERT INTO users (id, public_id, display_name)
    VALUES
      (1, '00000000000000000000000000000001', 'Owner'),
      (2, '00000000000000000000000000000002', 'Editor'),
      (3, '00000000000000000000000000000003', 'Recipient');
  `);
  return database;
}

function identity(userID: number): CominaviIdentity {
  return {
    subject: userID.toString(16).padStart(32, "0"),
    userID,
    authVersion: 1,
  };
}

function fenceUser(database: SQLiteD1Database, userID: number): void {
  database.native
    .prepare(
      `UPDATE users SET auth_version = auth_version + 1,
         deletion_pending_at = 1000 WHERE id = ?`,
    )
    .run(userID);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

function assertPlanConflict(
  error: unknown,
  expected: Pick<
    Awaited<ReturnType<typeof createSharedPlan>>["plan"],
    "id" | "name" | "revision" | "status" | "role"
  >,
): void {
  assert.ok(hasCode(error, "plan_revision_conflict"));
  if (typeof error !== "object" || error === null || !("details" in error)) {
    assert.fail("Plan conflict must include typed details.");
  }
  const details = (error as { details: Record<string, unknown> }).details;
  assert.equal(details.currentRevision, expected.revision);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(details.currentPlan as Record<string, unknown>).filter(
        ([key]) => key in expected,
      ),
    ),
    expected,
  );
}
