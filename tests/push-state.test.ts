import assert from "node:assert/strict";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";

import type { CominaviIdentity } from "../src/lib/server/cominavi-auth";
import {
  parseDeviceRegistration,
  registerPushDevice,
} from "../src/lib/server/push-devices";
import { enqueuePendingPushDeliveries } from "../src/lib/server/push-queue";
import { revokeAuthenticatedSessions } from "../src/lib/server/users";

test("logout advances the auth version exactly once", async () => {
  const database = new D1TestDatabase(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      subject TEXT NOT NULL,
      auth_version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO users (id, subject, auth_version, updated_at)
    VALUES (1, 'circlems:production:1', 1, 0);
  `);

  await revokeAuthenticatedSessions(database.binding, identity(1), 1_000_000);

  assert.deepEqual(
    database.rows("SELECT auth_version, updated_at FROM users WHERE id = 1"),
    [{ auth_version: 2, updated_at: 1_000 }],
  );
  await assert.rejects(() =>
    revokeAuthenticatedSessions(database.binding, identity(1), 1_001_000),
  );
});

test("an APNs token moves atomically to the newly authenticated installation", async () => {
  const database = new D1TestDatabase(`
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

test("the scheduled scan recovers an expired processing lease", async () => {
  const database = new D1TestDatabase(`
    CREATE TABLE notification_deliveries (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      available_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO notification_deliveries
      (id, status, available_at, lease_expires_at, last_error, updated_at)
    VALUES (7, 'processing', 800, 900, NULL, 800);
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

function identity(userID: number): CominaviIdentity {
  return {
    subject: `circlems:production:${userID}`,
    circlemsEnvironment: "production",
    circlemsUserID: userID,
    userID,
    authVersion: 1,
  };
}

class D1TestDatabase {
  readonly native = new DatabaseSync(":memory:");
  readonly binding: D1Database;

  constructor(schema: string) {
    this.native.exec(schema);
    this.binding = {
      prepare: (query: string) =>
        new D1TestStatement(this.native.prepare(query)).binding,
      batch: async (statements: D1PreparedStatement[]) => {
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
