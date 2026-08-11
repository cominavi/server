import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { CominaviIdentity } from "../src/lib/server/cominavi-auth";
import {
  parseDeviceRegistration,
  registerPushDevice,
} from "../src/lib/server/push-devices";
import {
  enqueuePendingPushDeliveries,
  type PushQueueMessage,
} from "../src/lib/server/push-queue";
import { revokeAuthenticatedSessions } from "../src/lib/server/users";
import { processPushQueueMessage } from "../src/lib/server/apns";
import { createSession, logoutSession } from "../src/lib/server/auth-sessions";
import { fanoutSharedPlanOutboxEvent } from "../src/lib/server/plan-notifications";
import { SQLiteD1Database } from "./sqlite-d1";

test("logout advances the auth version exactly once", async () => {
  const database = new D1TestDatabase(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      public_id TEXT NOT NULL,
      auth_version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE auth_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      consumed_at INTEGER
    );
    INSERT INTO users (id, public_id, auth_version, updated_at)
    VALUES (1, '00000000000000000000000000000001', 1, 0);
    INSERT INTO auth_refresh_tokens (token_hash, user_id, consumed_at)
    VALUES ('family-a', 1, NULL), ('family-b', 1, NULL);
  `);

  await revokeAuthenticatedSessions(database.binding, identity(1), 1_000_000);

  assert.deepEqual(
    database.rows("SELECT auth_version, updated_at FROM users WHERE id = 1"),
    [{ auth_version: 2, updated_at: 1_000 }],
  );
  assert.deepEqual(
    database.rows(
      "SELECT token_hash, consumed_at FROM auth_refresh_tokens ORDER BY token_hash",
    ),
    [
      { token_hash: "family-a", consumed_at: 1_000 },
      { token_hash: "family-b", consumed_at: 1_000 },
    ],
  );
  await assert.rejects(() =>
    revokeAuthenticatedSessions(database.binding, identity(1), 1_001_000),
  );
});

test("an APNs token moves atomically to the newly authenticated installation", async () => {
  const database = new D1TestDatabase(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      public_id TEXT NOT NULL,
      auth_version INTEGER NOT NULL,
      deletion_pending_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE push_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      installation_id TEXT NOT NULL,
      token TEXT NOT NULL,
      token_sha256 TEXT NOT NULL,
      apns_environment TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      locale TEXT,
      time_zone TEXT,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_registered_at INTEGER NOT NULL,
      invalidated_at INTEGER,
      UNIQUE (user_id, installation_id),
      UNIQUE (apns_environment, bundle_id, token_sha256)
    );
    INSERT INTO users (id, public_id, auth_version, updated_at)
    VALUES (1, '${identity(1).subject}', 1, 0),
           (2, '${identity(2).subject}', 1, 0);
  `);
  const registration = parseDeviceRegistration(
    {
      token: "ab".repeat(32),
      apnsEnvironment: "sandbox",
      bundleID: "llc.mikunet.cominavi.debug",
      enabled: true,
    },
    "llc.mikunet.cominavi.debug",
  );

  await registerPushDevice(
    database.binding,
    identity(1),
    "11111111-1111-1111-1111-111111111111",
    registration,
    1_000_000,
  );
  await registerPushDevice(
    database.binding,
    identity(2),
    "22222222-2222-2222-2222-222222222222",
    registration,
    1_001_000,
  );

  assert.deepEqual(
    database.rows("SELECT user_id, installation_id FROM push_devices"),
    [
      {
        user_id: 2,
        installation_id: "22222222-2222-2222-2222-222222222222",
      },
    ],
  );
});

test("registration retains at most 20 installations, enables 10, and bounds plan fanout", async () => {
  const database = serviceDatabase();
  seedDelivery(database);
  await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      registerPushDevice(
        database.binding,
        identity(1),
        `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
        parseDeviceRegistration(
          {
            token: (index + 1).toString(16).padStart(64, "0"),
            apnsEnvironment: "sandbox",
            bundleID: "llc.mikunet.cominavi.debug",
            enabled: true,
          },
          "llc.mikunet.cominavi.debug",
        ),
        1_000_000 + index * 1_000,
      ),
    ),
  );
  assert.deepEqual(
    database.rows(
      `SELECT count(*) AS total, sum(enabled) AS enabled
       FROM push_devices WHERE user_id = 1`,
    ),
    [{ total: 20, enabled: 10 }],
  );
  assert.deepEqual(
    database.rows(
      `SELECT count(*) AS count FROM push_devices
       WHERE user_id = 1
         AND installation_id = '00000000-0000-4000-8000-000000000028'`,
    ),
    [{ count: 1 }],
  );
  database.native.exec(`
    INSERT INTO shared_plans (
      id, comiket_no, name, owner_user_id, revision, created_at, updated_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 108, 'Bounded', 1, 1, 1, 1
    );
    INSERT INTO shared_plan_members (
      plan_id, user_id, role, joined_at, updated_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 1, 'owner', 1, 1
    );
  `);
  const queued: number[] = [];
  await fanoutSharedPlanOutboxEvent(
    database.binding,
    {
      sendBatch: async (messages: Array<{ body: unknown }>) => {
        for (const message of messages) {
          const body = message.body as { sharedPlanDeliveryID?: number };
          if (body.sharedPlanDeliveryID) queued.push(body.sharedPlanDeliveryID);
        }
      },
    } as unknown as Queue<never>,
    {
      eventID: "1".repeat(64),
      planID: "11111111-1111-4111-8111-111111111111",
      sourceKind: "operation",
      sourceID: "2".repeat(64),
      actorUserID: null,
      eventType: "shared_plan.circle.memo.splice.v1",
      i18nKey: "shared_plan.circle.memo.splice",
      payloadVersion: 1,
      payloadJSON: '{"v":1}',
      membershipEpoch: 1,
      planNotificationEpoch: 1,
      createdAt: 1_020,
    },
    { userID: 1, membershipNotificationEpoch: 1 },
  );
  assert.deepEqual(
    database.rows(
      `SELECT count(*) AS count
       FROM shared_plan_notification_deliveries`,
    ),
    [{ count: 10 }],
  );
  assert.equal(queued.length, 10);
  assert.equal(new Set(queued).size, 10);
});

test("a deletion fence cannot let device registration delete another owner's token", async () => {
  const database = new D1TestDatabase(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      public_id TEXT NOT NULL,
      auth_version INTEGER NOT NULL,
      deletion_pending_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE push_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      installation_id TEXT NOT NULL,
      token TEXT NOT NULL,
      token_sha256 TEXT NOT NULL,
      apns_environment TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      locale TEXT,
      time_zone TEXT,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_registered_at INTEGER NOT NULL,
      invalidated_at INTEGER,
      UNIQUE (user_id, installation_id),
      UNIQUE (apns_environment, bundle_id, token_sha256)
    );
    INSERT INTO users (id, public_id, auth_version, updated_at)
    VALUES (1, '${identity(1).subject}', 1, 0),
           (2, '${identity(2).subject}', 1, 0);
  `);
  const registration = parseDeviceRegistration(
    {
      token: "ab".repeat(32),
      apnsEnvironment: "sandbox",
      bundleID: "llc.mikunet.cominavi.debug",
      enabled: true,
    },
    "llc.mikunet.cominavi.debug",
  );
  await registerPushDevice(
    database.binding,
    identity(2),
    "22222222-2222-2222-2222-222222222222",
    registration,
    1_000_000,
  );
  database.beforeNextBatch = () => {
    database.native.exec(
      "UPDATE users SET auth_version = 2, deletion_pending_at = 1001 WHERE id = 1",
    );
  };
  await assert.rejects(
    () =>
      registerPushDevice(
        database.binding,
        identity(1),
        "11111111-1111-1111-1111-111111111111",
        registration,
        1_001_000,
      ),
    (error: unknown) => hasCode(error, "invalid_token"),
  );
  assert.deepEqual(
    database.rows("SELECT user_id, installation_id FROM push_devices"),
    [
      {
        user_id: 2,
        installation_id: "22222222-2222-2222-2222-222222222222",
      },
    ],
  );
});

test("the scheduled scan recovers an expired processing lease", async () => {
  const database = new D1TestDatabase(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      deletion_pending_at INTEGER
    );
    CREATE TABLE push_devices (
      id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL
    );
    CREATE TABLE notification_deliveries (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      device_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      available_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE shared_plan_notification_deliveries (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      device_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      available_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO users (id, deletion_pending_at) VALUES (1, NULL);
    INSERT INTO push_devices (id, enabled) VALUES (1, 1);
    INSERT INTO notification_deliveries
      (id, user_id, device_id, status, available_at, lease_expires_at,
       last_error, updated_at)
    VALUES (7, 1, 1, 'processing', 800, 900, NULL, 800);
  `);
  const queue = new RecordingQueue();

  const count = await enqueuePendingPushDeliveries(
    database.binding,
    queue.binding,
    1_000_000,
  );

  assert.equal(count, 1);
  assert.deepEqual(queue.deliveryIDs, [7]);
  assert.deepEqual(
    database.rows(
      "SELECT status, available_at, lease_expires_at, last_error FROM notification_deliveries WHERE id = 7",
    ),
    [
      {
        status: "retry",
        available_at: 1_000,
        lease_expires_at: null,
        last_error: "processing_lease_expired",
      },
    ],
  );
});

test("logout after delivery load prevents the APNs request from starting", async () => {
  const database = serviceDatabase();
  seedDelivery(database);
  const jwtSecret = "test-jwt-secret-that-is-at-least-thirty-two-bytes";
  const session = await createSession(
    database.binding,
    identity(1),
    jwtSecret,
    1_000_000,
  );
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateKeyPEM = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  let fetched = 0;
  let acked = 0;
  await processPushQueueMessage(
    {
      body: { deliveryID: 1 },
      ack: () => {
        acked += 1;
      },
      retry: () => assert.fail("suppressed delivery must not retry"),
    } as unknown as Message<{ deliveryID: number }>,
    {
      COMINAVI_DB: database.binding,
      COMINAVI_APNS_KEY_ID: "KEYID",
      COMINAVI_APNS_TEAM_ID: "TEAMID",
      COMINAVI_APNS_PRIVATE_KEY: privateKeyPEM,
    },
    async () => {
      fetched += 1;
      return new Response(null, { status: 200 });
    },
    1_001_000,
    async () => {
      await logoutSession(
        database.binding,
        { subject: identity(1).subject, authVersion: 1 },
        {
          requestID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          refreshToken: session.refreshToken,
        },
        Buffer.from(new Uint8Array(32).fill(7)).toString("base64url"),
        true,
        1_001_000,
      );
    },
  );
  assert.equal(fetched, 0);
  assert.equal(acked, 1);
  assert.deepEqual(
    database.rows(
      `SELECT delivery.status, device.enabled
       FROM notification_deliveries AS delivery
       JOIN push_devices AS device ON device.id = delivery.device_id
       WHERE delivery.id = 1`,
    ),
    [{ status: "suppressed", enabled: 0 }],
  );
});

test("membership revocation after Shared Plan delivery load prevents APNs", async () => {
  const database = serviceDatabase();
  seedDelivery(database);
  database.native.exec(`
    INSERT INTO shared_plans (
      id, comiket_no, name, owner_user_id, revision, created_at, updated_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 108, 'Plan', 1, 1, 1, 1
    );
    INSERT INTO shared_plan_members (
      plan_id, user_id, role, joined_at, updated_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 1, 'owner', 1, 1
    );
    INSERT INTO shared_plan_events (
      id, plan_id, actor_user_id, event_type, i18n_key, payload_version,
      payload_json, created_at, source_kind, source_id, membership_epoch
    ) VALUES (
      '${"e".repeat(64)}', '11111111-1111-4111-8111-111111111111', NULL,
      'shared_plan.conflict.v1', 'shared_plan.conflict', 1, '{}', 1,
      'conflict', '${"f".repeat(64)}', 1
    );
    INSERT INTO shared_plan_notification_deliveries (
      id, event_id, user_id, device_id, urgency, status, attempt_count,
      available_at, created_at, updated_at
    ) VALUES (1, '${"e".repeat(64)}', 1, 1, 'conflict', 'pending', 0, 1, 1, 1);
  `);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  let fetched = 0;
  let acked = 0;
  await processPushQueueMessage(
    {
      body: { kind: "shared-plan", sharedPlanDeliveryID: 1 },
      ack: () => {
        acked += 1;
      },
      retry: () => assert.fail("suppressed delivery must not retry"),
    } as unknown as Message<PushQueueMessage>,
    {
      COMINAVI_DB: database.binding,
      COMINAVI_APNS_KEY_ID: "KEYID",
      COMINAVI_APNS_TEAM_ID: "TEAMID",
      COMINAVI_APNS_PRIVATE_KEY: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    },
    async () => {
      fetched += 1;
      return new Response(null, { status: 200 });
    },
    1_001_000,
    () => {
      database.native.exec(
        `UPDATE shared_plan_members
         SET revoked_at = 1001, notification_epoch = notification_epoch + 1
         WHERE plan_id = '11111111-1111-4111-8111-111111111111'
           AND user_id = 1`,
      );
    },
  );
  assert.equal(fetched, 0);
  assert.equal(acked, 1);
  assert.deepEqual(
    database.rows(
      `SELECT status, last_error
       FROM shared_plan_notification_deliveries WHERE id = 1`,
    ),
    [{ status: "suppressed", last_error: "plan_authority_changed" }],
  );
});

test("Shared Plan APNs carries the immutable inbox event ID", async () => {
  const database = serviceDatabase();
  seedDelivery(database);
  const sharedEventID = "e".repeat(64);
  database.native.exec(`
    INSERT INTO shared_plans (
      id, comiket_no, name, owner_user_id, revision, created_at, updated_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 108, 'Plan', 1, 1, 1, 1
    );
    INSERT INTO shared_plan_members (
      plan_id, user_id, role, joined_at, updated_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 1, 'owner', 1, 1
    );
    INSERT INTO shared_plan_events (
      id, plan_id, actor_user_id, event_type, i18n_key, payload_version,
      payload_json, created_at, source_kind, source_id, membership_epoch
    ) VALUES (
      '${sharedEventID}', '11111111-1111-4111-8111-111111111111', NULL,
      'shared_plan.conflict.v1', 'shared_plan.conflict', 1, '{"v":1}', 1,
      'conflict', '${"f".repeat(64)}', 1
    );
    INSERT INTO shared_plan_notification_deliveries (
      id, event_id, user_id, device_id, urgency, status, attempt_count,
      available_at, created_at, updated_at
    ) VALUES (1, '${sharedEventID}', 1, 1, 'conflict', 'pending', 0, 1, 1, 1);
  `);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  let body: Record<string, unknown> | undefined;
  let acked = 0;
  await processPushQueueMessage(
    {
      body: { kind: "shared-plan", sharedPlanDeliveryID: 1 },
      ack: () => {
        acked += 1;
      },
      retry: () => assert.fail("successful APNs delivery must not retry"),
    } as unknown as Message<PushQueueMessage>,
    {
      COMINAVI_DB: database.binding,
      COMINAVI_APNS_KEY_ID: "KEYID",
      COMINAVI_APNS_TEAM_ID: "TEAMID",
      COMINAVI_APNS_PRIVATE_KEY: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    },
    async (request) => {
      assert.ok(request instanceof Request);
      body = (await request.json()) as Record<string, unknown>;
      return new Response(null, {
        status: 200,
        headers: { "apns-id": "apns-fixture-id" },
      });
    },
    1_001_000,
  );
  assert.equal(acked, 1);
  assert.deepEqual(body?.cominavi, {
    version: 1,
    kind: "sharedPlanEvent",
    eventID: sharedEventID,
    planID: "11111111-1111-4111-8111-111111111111",
    eventType: "shared_plan.conflict.v1",
    payloadVersion: 1,
  });
  assert.deepEqual(
    database.rows(
      `SELECT status, apns_id FROM shared_plan_notification_deliveries
       WHERE id = 1`,
    ),
    [{ status: "delivered", apns_id: "apns-fixture-id" }],
  );
});

test("a transient Shared Plan APNs failure retries the delivery row", async () => {
  const database = serviceDatabase();
  seedDelivery(database);
  const sharedEventID = "e".repeat(64);
  database.native.exec(`
    INSERT INTO shared_plans (
      id, comiket_no, name, owner_user_id, revision, created_at, updated_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 108, 'Plan', 1, 1, 1, 1
    );
    INSERT INTO shared_plan_members (
      plan_id, user_id, role, joined_at, updated_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 1, 'owner', 1, 1
    );
    INSERT INTO shared_plan_events (
      id, plan_id, actor_user_id, event_type, i18n_key, payload_version,
      payload_json, created_at, source_kind, source_id, membership_epoch
    ) VALUES (
      '${sharedEventID}', '11111111-1111-4111-8111-111111111111', NULL,
      'shared_plan.conflict.v1', 'shared_plan.conflict', 1, '{"v":1}', 1,
      'conflict', '${"f".repeat(64)}', 1
    );
    INSERT INTO shared_plan_notification_deliveries (
      id, event_id, user_id, device_id, urgency, status, attempt_count,
      available_at, created_at, updated_at
    ) VALUES (1, '${sharedEventID}', 1, 1, 'conflict', 'pending', 0, 1, 1, 1);
  `);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  let retried = 0;
  await processPushQueueMessage(
    {
      body: { kind: "shared-plan", sharedPlanDeliveryID: 1 },
      ack: () => assert.fail("a transient APNs failure must retry"),
      retry: () => {
        retried += 1;
      },
    } as unknown as Message<PushQueueMessage>,
    {
      COMINAVI_DB: database.binding,
      COMINAVI_APNS_KEY_ID: "KEYID",
      COMINAVI_APNS_TEAM_ID: "TEAMID",
      COMINAVI_APNS_PRIVATE_KEY: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    },
    async () => new Response(null, { status: 500 }),
    1_001_000,
  );

  assert.equal(retried, 1);
  assert.deepEqual(
    database.rows(
      `SELECT id, status, attempt_count, lease_expires_at
       FROM shared_plan_notification_deliveries WHERE id = 1`,
    ),
    [{ id: 1, status: "retry", attempt_count: 1, lease_expires_at: null }],
  );
});

test("revocation/reinstate and archive/reopen never resurrect old Shared Plan APNs", async () => {
  for (const lifecycle of ["member", "plan"] as const) {
    const database = serviceDatabase();
    seedDelivery(database);
    database.native.exec(`
      INSERT INTO shared_plans (
        id, comiket_no, name, owner_user_id, revision, created_at, updated_at
      ) VALUES (
        '11111111-1111-4111-8111-111111111111', 108, 'Plan', 1, 1, 1, 1
      );
      INSERT INTO shared_plan_members (
        plan_id, user_id, role, joined_at, updated_at
      ) VALUES (
        '11111111-1111-4111-8111-111111111111', 1, 'owner', 1, 1
      );
      INSERT INTO shared_plan_events (
        id, plan_id, actor_user_id, event_type, i18n_key, payload_version,
        payload_json, created_at, source_kind, source_id, membership_epoch,
        plan_notification_epoch
      ) VALUES (
        '${"a".repeat(64)}', '11111111-1111-4111-8111-111111111111', NULL,
        'shared_plan.circle.memo.splice.v1', 'shared_plan.circle.memo.splice',
        1, '{}', 1, 'operation', '${"b".repeat(64)}', 1, 1
      );
      INSERT INTO shared_plan_notification_deliveries (
        id, event_id, user_id, device_id, urgency, status,
        plan_notification_epoch, membership_notification_epoch,
        attempt_count, available_at, created_at, updated_at
      ) VALUES (
        1, '${"a".repeat(64)}', 1, 1, 'routine', 'pending', 1, 1, 0, 1, 1, 1
      );
    `);
    if (lifecycle === "member") {
      database.native.exec(`
        UPDATE shared_plan_members
        SET revoked_at = 1001, notification_epoch = notification_epoch + 1;
        UPDATE shared_plan_members SET revoked_at = NULL;
      `);
    } else {
      database.native.exec(`
        UPDATE shared_plans
        SET archived_at = 1001, notification_epoch = notification_epoch + 1;
        UPDATE shared_plans SET archived_at = NULL;
      `);
    }
    let fetched = 0;
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    await processPushQueueMessage(
      {
        body: { kind: "shared-plan", sharedPlanDeliveryID: 1 },
        ack: () => undefined,
        retry: () => assert.fail("old generation must be suppressed"),
      } as unknown as Message<PushQueueMessage>,
      {
        COMINAVI_DB: database.binding,
        COMINAVI_APNS_KEY_ID: "KEYID",
        COMINAVI_APNS_TEAM_ID: "TEAMID",
        COMINAVI_APNS_PRIVATE_KEY: privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
      },
      async () => {
        fetched += 1;
        return new Response(null, { status: 200 });
      },
      1_002_000,
    );
    assert.equal(fetched, 0, lifecycle);
    assert.deepEqual(
      database.rows(
        `SELECT status, last_error
         FROM shared_plan_notification_deliveries WHERE id = 1`,
      ),
      [{ status: "suppressed", last_error: "plan_authority_changed" }],
    );
  }
});

function identity(userID: number): CominaviIdentity {
  return {
    subject: userID.toString(16).padStart(32, "0"),
    userID,
    authVersion: 1,
  };
}

class D1TestDatabase {
  readonly native = new DatabaseSync(":memory:");
  readonly binding: D1Database;
  beforeNextBatch: (() => void) | undefined;

  constructor(schema: string) {
    this.native.exec(schema);
    this.binding = {
      prepare: (query: string) =>
        new D1TestStatement(this.native.prepare(query)).binding,
      batch: async (statements: D1PreparedStatement[]) => {
        const beforeBatch = this.beforeNextBatch;
        this.beforeNextBatch = undefined;
        beforeBatch?.();
        this.native.exec("BEGIN IMMEDIATE");
        try {
          const results = [];
          for (const statement of statements)
            results.push(await statement.run());
          this.native.exec("COMMIT");
          return results;
        } catch (error) {
          this.native.exec("ROLLBACK");
          throw error;
        }
      },
    } as unknown as D1Database;
  }

  rows(query: string): Record<string, unknown>[] {
    return (this.native.prepare(query).all() as Record<string, unknown>[]).map(
      (row) => ({ ...row }),
    );
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

function serviceDatabase(): SQLiteD1Database {
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

function seedDelivery(database: SQLiteD1Database): void {
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${identity(1).subject}', 'Push User', 1, 1, 1, 1, 1);
    INSERT INTO circles (
      comiket_no, wc_id, circle_name, created_at, updated_at
    ) VALUES (108, 101, 'Circle', 1, 1);
    INSERT INTO ingest_batches (
      id, source, idempotency_key, payload_sha256, schema_version,
      observed_at, received_at, raw_payload_json
    ) VALUES (1, 'fixture', 'fixture', '${"a".repeat(64)}', 1, 1, 1, '{}');
    INSERT INTO social_posts (
      post_id, author_handle, text, occurred_at, latest_observed_at,
      raw_post_json
    ) VALUES ('post-1', 'circle', 'Update', 1, 1, '{}');
    INSERT INTO circle_update_events (
      id, event_key, ingest_batch_id, source, source_revision, post_id,
      update_kind, state_kind, state_value, confidence, occurred_at,
      notifiable, evidence_json, created_at
    ) VALUES (1, 'event-1', 1, 'fixture', 1, 'post-1',
              'presence_present', 'presence', 'present', 'high', 1, 1, '{}', 1);
    INSERT INTO circle_update_targets (update_event_id, comiket_no, wc_id)
      VALUES (1, 108, 101);
    INSERT INTO favorite_sets (user_id, comiket_no, revision, updated_at)
      VALUES (1, 108, 1, 1);
    INSERT INTO user_favorites (
      user_id, comiket_no, wc_id, color, notifications_enabled, active,
      snapshot_revision, created_at, updated_at
    ) VALUES (1, 108, 101, 1, 1, 1, 1, 1, 1);
    INSERT INTO push_devices (
      id, user_id, installation_id, token, token_sha256, apns_environment,
      bundle_id, enabled, created_at, updated_at, last_registered_at
    ) VALUES (1, 1, 'installation-1', '${"b".repeat(64)}', '${"c".repeat(64)}',
              'sandbox', 'llc.mikunet.cominavi.debug', 1, 1, 1, 1);
    INSERT INTO notification_deliveries (
      id, update_event_id, user_id, device_id, status, attempt_count,
      available_at, created_at, updated_at
    ) VALUES (1, 1, 1, 1, 'pending', 0, 1, 1, 1);
  `);
}

class D1TestStatement {
  readonly binding: D1PreparedStatement;
  private arguments: SQLiteValue[] = [];

  constructor(private readonly native: StatementSync) {
    this.binding = {
      bind: (...values: unknown[]) => {
        this.arguments = values as SQLiteValue[];
        return this.binding;
      },
      run: async () => {
        const result = this.native.run(...this.arguments);
        return {
          success: true,
          results: [],
          meta: { changes: Number(result.changes) },
        } as unknown as D1Result;
      },
      first: async <T>() =>
        (this.native.get(...this.arguments) as T | undefined) ?? null,
      all: async <T>() =>
        ({
          success: true,
          results: this.native.all(...this.arguments) as T[],
          meta: { changes: 0 },
        }) as unknown as D1Result<T>,
      raw: async (options?: { columnNames?: boolean }) => {
        const columns = (
          this.native as StatementSync & {
            columns(): Array<{ name: string }>;
          }
        )
          .columns()
          .map((column) => column.name);
        const rows = (
          this.native.all(...this.arguments) as Record<string, unknown>[]
        ).map((row) => columns.map((column) => row[column]));
        return options?.columnNames ? [columns, ...rows] : rows;
      },
    } as unknown as D1PreparedStatement;
  }
}

type SQLiteValue = null | number | bigint | string | Uint8Array;

class RecordingQueue {
  deliveryIDs: number[] = [];
  readonly binding = {
    sendBatch: async (
      messages: Iterable<MessageSendRequest<{ deliveryID: number }>>,
    ) => {
      this.deliveryIDs.push(
        ...Array.from(messages, (item) => item.body.deliveryID),
      );
    },
  } as unknown as Queue<{ deliveryID: number }>;
}
