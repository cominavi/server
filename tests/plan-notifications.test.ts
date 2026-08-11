import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  fanoutSharedPlanOutboxEvent,
  notificationOutboxFitsBounds,
  type SharedPlanOutboxEvent,
} from "../src/lib/server/plan-notifications";
import {
  compactSerializedJSONValues,
  targetCompactJSONBatchBytes,
} from "../src/lib/server/compact-json-batches";
import { SQLiteD1Database } from "./sqlite-d1";

test("Shared Plan fanout is idempotent, inboxes the actor, and alerts peers only", async () => {
  const database = setup();
  seedPlan(database);
  const queued: number[] = [];
  const queue = fakeQueue(queued);
  const base: SharedPlanOutboxEvent = {
    eventID: "a".repeat(64),
    planID: "11111111-1111-4111-8111-111111111111",
    sourceKind: "operation",
    sourceID: "33333333-3333-4333-8333-333333333333",
    actorUserID: 1,
    eventType: "shared_plan.circle.memo.splice.v1",
    i18nKey: "shared_plan.circle.memo.splice",
    payloadVersion: 1,
    payloadJSON: '{"operationID":"33333333-3333-4333-8333-333333333333","v":1}',
    membershipEpoch: 1,
    planNotificationEpoch: 1,
    createdAt: 100,
  };
  await fanoutSharedPlanOutboxEvent(database.binding, queue, base, {
    userID: 1,
    membershipNotificationEpoch: 1,
  });
  await fanoutSharedPlanOutboxEvent(database.binding, queue, base, {
    userID: 2,
    membershipNotificationEpoch: 1,
  });
  await fanoutSharedPlanOutboxEvent(database.binding, queue, base, {
    userID: 2,
    membershipNotificationEpoch: 1,
  });
  assert.deepEqual(
    database.rows(
      `SELECT event_id, user_id, event_created_at
       FROM shared_plan_event_recipients
       ORDER BY user_id`,
    ),
    [
      { event_id: "a".repeat(64), user_id: 1, event_created_at: 100 },
      { event_id: "a".repeat(64), user_id: 2, event_created_at: 100 },
    ],
  );
  assert.deepEqual(
    database.rows(
      `SELECT user_id, urgency, collapse_key
       FROM shared_plan_notification_deliveries`,
    ),
    [
      {
        user_id: 2,
        urgency: "routine",
        collapse_key: "shared-plan:11111111-1111-4111-8111-111111111111",
      },
    ],
  );
  assert.equal(queued.length, 1);
  assert.equal(new Set(queued).size, 1);

  await assert.rejects(
    fanoutSharedPlanOutboxEvent(
      database.binding,
      queue,
      { ...base, payloadJSON: '{"changed":true,"v":1}' },
      { userID: 1, membershipNotificationEpoch: 1 },
    ),
    /shared_plan_event_idempotency_conflict/,
  );
  await assert.rejects(
    fanoutSharedPlanOutboxEvent(
      database.binding,
      queue,
      { ...base, createdAt: 101 },
      { userID: 1, membershipNotificationEpoch: 1 },
    ),
    /shared_plan_event_idempotency_conflict/,
  );
});

test("conflict fanout is immediate and has no collapse key", async () => {
  const database = setup();
  seedPlan(database);
  await fanoutSharedPlanOutboxEvent(
    database.binding,
    fakeQueue([]),
    {
      eventID: "b".repeat(64),
      planID: "11111111-1111-4111-8111-111111111111",
      sourceKind: "conflict",
      sourceID: "c".repeat(64),
      actorUserID: 1,
      eventType: "shared_plan.conflict.v1",
      i18nKey: "shared_plan.conflict",
      payloadVersion: 1,
      payloadJSON: '{"conflictID":"cccc","v":1}',
      membershipEpoch: 2,
      planNotificationEpoch: 1,
      createdAt: 101,
    },
    { userID: 2, membershipNotificationEpoch: 1 },
  );
  assert.deepEqual(
    database.rows(
      `SELECT urgency, collapse_key
       FROM shared_plan_notification_deliveries`,
    ),
    [{ urgency: "conflict", collapse_key: null }],
  );
});

test("a maximum memo is stored once and compact audience fanout is bounded", () => {
  const event = {
    eventID: "d".repeat(64),
    planID: "11111111-1111-4111-8111-111111111111",
    sourceKind: "operation" as const,
    sourceID: "44444444-4444-4444-8444-444444444444",
    actorUserID: 1,
    eventType: "shared_plan.circle.memo.splice.v1",
    i18nKey: "shared_plan.circle.memo.splice",
    payloadVersion: 1 as const,
    payloadJSON: JSON.stringify({ v: 1, text: "あ".repeat(21_845) }),
    membershipEpoch: 1,
    planNotificationEpoch: 1,
    createdAt: 100,
  };
  assert.equal(notificationOutboxFitsBounds([event], 50), true);
  assert.equal(notificationOutboxFitsBounds(Array(21).fill(event), 50), true);
  assert.equal(
    notificationOutboxFitsBounds(Array(10_000).fill(event), 50),
    true,
  );
  assert.equal(notificationOutboxFitsBounds([event], 51), false);
  assert.equal(notificationOutboxFitsBounds([], 1), false);

  const batches = compactSerializedJSONValues(
    Array.from({ length: 10_000 }, (_, index) =>
      JSON.stringify({
        ...event,
        eventID: index.toString(16).padStart(64, "0"),
      }),
    ),
  );
  assert.ok(batches.length > 1);
  assert.equal(
    batches.reduce(
      (count, batch) => count + (JSON.parse(batch) as unknown[]).length,
      0,
    ),
    10_000,
  );
  assert.ok(
    batches.every(
      (batch) =>
        new TextEncoder().encode(batch).byteLength <=
        targetCompactJSONBatchBytes,
    ),
  );
});

test("delayed fanout keeps inbox history but cannot alert a reinstated or reopened generation", async () => {
  for (const lifecycle of ["member", "plan"] as const) {
    const database = setup();
    seedPlan(database);
    if (lifecycle === "member") {
      database.native.exec(`
        UPDATE shared_plan_members
        SET revoked_at = 110, notification_epoch = notification_epoch + 1
        WHERE user_id = 2;
        UPDATE shared_plan_members SET revoked_at = NULL WHERE user_id = 2;
      `);
    } else {
      database.native.exec(`
        UPDATE shared_plans
        SET archived_at = 110, notification_epoch = notification_epoch + 1;
        UPDATE shared_plans SET archived_at = NULL;
      `);
    }
    await fanoutSharedPlanOutboxEvent(
      database.binding,
      fakeQueue([]),
      {
        eventID: (lifecycle === "member" ? "6" : "7").repeat(64),
        planID: "11111111-1111-4111-8111-111111111111",
        sourceKind: "operation",
        sourceID: (lifecycle === "member" ? "8" : "9").repeat(64),
        actorUserID: 1,
        eventType: "shared_plan.circle.memo.splice.v1",
        i18nKey: "shared_plan.circle.memo.splice",
        payloadVersion: 1,
        payloadJSON: '{"v":1}',
        membershipEpoch: 1,
        planNotificationEpoch: 1,
        createdAt: 100,
      },
      { userID: 2, membershipNotificationEpoch: 1 },
    );
    assert.deepEqual(
      database.rows(`SELECT user_id FROM shared_plan_event_recipients`),
      [{ user_id: 2 }],
    );
    assert.deepEqual(
      database.rows(`SELECT id FROM shared_plan_notification_deliveries`),
      [],
    );
  }
});

test("20 events at the 50-member cap enqueue each peer delivery exactly once", async () => {
  const database = setup();
  seedPlan(database);
  for (let userID = 3; userID <= 50; userID += 1) {
    database.native
      .prepare(
        `INSERT INTO users (
           id, public_id, display_name, profile_revision, auth_version,
           created_at, updated_at, last_authenticated_at
         ) VALUES (?, ?, ?, 1, 1, 1, 1, 1)`,
      )
      .run(userID, userID.toString(16).padStart(32, "0"), `Peer ${userID}`);
    database.native
      .prepare(
        `INSERT INTO shared_plan_members (
           plan_id, user_id, role, joined_at, updated_at
         ) VALUES (
           '11111111-1111-4111-8111-111111111111', ?, 'editor', 1, 1
         )`,
      )
      .run(userID);
    database.native
      .prepare(
        `INSERT INTO push_devices (
           user_id, installation_id, token, token_sha256, apns_environment,
           bundle_id, enabled, created_at, updated_at, last_registered_at
         ) VALUES (?, ?, ?, ?, 'sandbox',
                   'llc.mikunet.cominavi.debug', 1, 1, 1, 1)`,
      )
      .run(
        userID,
        `installation-${userID}`,
        userID.toString(16).padStart(64, "0"),
        (userID + 100).toString(16).padStart(64, "0"),
      );
  }
  const queued: number[] = [];
  const queue = fakeQueue(queued);
  for (let eventNumber = 1; eventNumber <= 20; eventNumber += 1) {
    const event: SharedPlanOutboxEvent = {
      eventID: eventNumber.toString(16).padStart(64, "0"),
      planID: "11111111-1111-4111-8111-111111111111",
      sourceKind: "operation",
      sourceID: (eventNumber + 100).toString(16).padStart(64, "0"),
      actorUserID: 1,
      eventType: "shared_plan.circle.memo.splice.v1",
      i18nKey: "shared_plan.circle.memo.splice",
      payloadVersion: 1,
      payloadJSON: `{"event":${eventNumber},"v":1}`,
      membershipEpoch: 1,
      planNotificationEpoch: 1,
      createdAt: 100 + eventNumber,
    };
    for (let userID = 1; userID <= 50; userID += 1) {
      await fanoutSharedPlanOutboxEvent(database.binding, queue, event, {
        userID,
        membershipNotificationEpoch: 1,
      });
    }
  }
  assert.deepEqual(
    database.rows(
      `SELECT
         (SELECT count(*) FROM shared_plan_event_recipients) AS recipients,
         (SELECT count(*) FROM shared_plan_notification_deliveries) AS deliveries`,
    ),
    [{ recipients: 1_000, deliveries: 980 }],
  );
  assert.equal(queued.length, 980);
  assert.equal(new Set(queued).size, 980);
});

function setup(): SQLiteD1Database {
  return new SQLiteD1Database(
    [
      "migrations/0001_following_imports.sql",
      "migrations/0002_realtime_service.sql",
      "migrations/0003_accounts_shared_plans.sql",
      "migrations/0004_sanitized_catalog.sql",
      "migrations/0005_shared_plan_crdt_notifications.sql",
      "migrations/0006_notification_inbox.sql",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  );
}

function seedPlan(database: SQLiteD1Database): void {
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES
      (1, '${"1".repeat(32)}', 'Actor', 1, 1, 1, 1, 1),
      (2, '${"2".repeat(32)}', 'Peer', 1, 1, 1, 1, 1);
    INSERT INTO shared_plans (
      id, comiket_no, name, owner_user_id, revision, created_at, updated_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 108, 'Fixture Plan', 1, 1, 1, 1
    );
    INSERT INTO shared_plan_members (
      plan_id, user_id, role, joined_at, updated_at
    ) VALUES
      ('11111111-1111-4111-8111-111111111111', 1, 'owner', 1, 1),
      ('11111111-1111-4111-8111-111111111111', 2, 'editor', 1, 1);
    INSERT INTO push_devices (
      id, user_id, installation_id, token, token_sha256, apns_environment,
      bundle_id, enabled, created_at, updated_at, last_registered_at
    ) VALUES
      (1, 1, 'installation-1', '${"a".repeat(64)}', '${"b".repeat(64)}',
       'sandbox', 'llc.mikunet.cominavi.debug', 1, 1, 1, 1),
      (2, 2, 'installation-2', '${"c".repeat(64)}', '${"d".repeat(64)}',
       'sandbox', 'llc.mikunet.cominavi.debug', 1, 1, 1, 1);
  `);
}

function fakeQueue(queued: number[]): Queue<never> {
  return {
    sendBatch: async (messages: Array<{ body: unknown }>) => {
      for (const message of messages) {
        const body = message.body as { sharedPlanDeliveryID?: number };
        if (body.sharedPlanDeliveryID) queued.push(body.sharedPlanDeliveryID);
      }
    },
  } as unknown as Queue<never>;
}
