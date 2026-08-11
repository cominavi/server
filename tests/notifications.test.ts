import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { generateOpenAPIDocument } from "../src/api/openapi";
import type { CominaviIdentity } from "../src/lib/server/cominavi-auth";
import { apiErrorResponse } from "../src/lib/server/api-response";
import {
  listNotifications,
  markNotificationRead,
  parseNotificationEventID,
  parseNotificationPage,
} from "../src/lib/server/notifications";
import {
  fanoutSharedPlanOutboxEvent,
  type SharedPlanOutboxEvent,
} from "../src/lib/server/plan-notifications";
import { SQLiteD1Database } from "./sqlite-d1";

const planID = "11111111-1111-4111-8111-111111111111";
const operationTypes = [
  "shared_plan.circle.presence.v1",
  "shared_plan.circle.resolve_parent.v1",
  "shared_plan.circle.memo.splice.v1",
  "shared_plan.need.create.v1",
  "shared_plan.need.delete.v1",
  "shared_plan.need.resolve_parent.v1",
  "shared_plan.need.wanted_quantity.v1",
  "shared_plan.need.buyer_allocation.v1",
  "shared_plan.need.fulfilled_quantity.v1",
  "shared_plan.circle.communication.set.v1",
] as const;

test("the inbox projects all ten operations and conflicts as typed payloads without prose", async () => {
  const database = setup();
  seedPlan(database);
  const eventTypes = [...operationTypes, "shared_plan.conflict.v1"];
  for (const [index, eventType] of eventTypes.entries()) {
    await fanout(database, event(index + 1, eventType, 100 + index), 1);
  }

  const page = await listNotifications(database.binding, identity(1), {
    limit: 100,
    cursor: null,
  });
  assert.deepEqual(
    page.items.map((item) => item.eventType),
    eventTypes.toReversed(),
  );
  assert.equal(page.nextCursor, null);
  for (const item of page.items) {
    assert.deepEqual(Object.keys(item), [
      "id",
      "kind",
      "planID",
      "eventType",
      "i18nKey",
      "payloadVersion",
      "payload",
      "createdAt",
      "readAt",
    ]);
    assert.equal(item.kind, "sharedPlanEvent");
    assert.equal(item.planID, planID);
    assert.equal(item.payloadVersion, 1);
    assert.equal(item.payload.v, 1);
    assert.equal(typeof item.payload, "object");
    assert.equal("title" in item, false);
    assert.equal("message" in item, false);
    assert.equal(item.readAt, null);
  }
});

test("notification pagination is stable for identical timestamps and excludes concurrent newer inserts", async () => {
  const database = setup();
  seedPlan(database);
  for (const index of [10, 11, 12]) {
    await fanout(
      database,
      event(index, "shared_plan.circle.presence.v1", 100),
      1,
    );
  }
  const first = await listNotifications(database.binding, identity(1), {
    limit: 2,
    cursor: null,
  });
  assert.deepEqual(
    first.items.map((item) => item.id),
    [eventID(12), eventID(11)],
  );
  assert.ok(first.nextCursor);

  await fanout(database, event(13, "shared_plan.circle.presence.v1", 101), 1);
  const second = await listNotifications(database.binding, identity(1), {
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    second.items.map((item) => item.id),
    [eventID(10)],
  );
  assert.equal(second.nextCursor, null);

  const refreshed = await listNotifications(database.binding, identity(1), {
    limit: 100,
    cursor: null,
  });
  assert.deepEqual(
    refreshed.items.map((item) => item.id),
    [eventID(13), eventID(12), eventID(11), eventID(10)],
  );
});

test("notification limit and opaque cursor validation fail closed", async () => {
  assert.deepEqual(
    parseNotificationPage(
      new Request("https://cominavi.net/api/v2/me/notifications"),
    ),
    { limit: 50, cursor: null },
  );
  assert.equal(
    parseNotificationPage(
      new Request("https://cominavi.net/api/v2/me/notifications?limit=100"),
    ).limit,
    100,
  );
  for (const limit of ["", "0", "101", "1.5", "NaN"]) {
    assert.throws(
      () =>
        parseNotificationPage(
          new Request(
            `https://cominavi.net/api/v2/me/notifications?limit=${limit}`,
          ),
        ),
      (error: unknown) => hasCode(error, "invalid_pagination", 400),
    );
  }

  const database = setup();
  seedPlan(database);
  for (const cursor of [
    "not.valid",
    Buffer.from(
      JSON.stringify({
        v: 1,
        kind: "plans",
        eventCreatedAt: 100,
        eventID: eventID(1),
      }),
    ).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        v: 1,
        kind: "notifications",
        eventCreatedAt: 100,
        eventID: "A".repeat(64),
      }),
    ).toString("base64url"),
  ]) {
    await assert.rejects(
      () =>
        listNotifications(database.binding, identity(1), {
          limit: 50,
          cursor,
        }),
      (error: unknown) => hasCode(error, "invalid_pagination", 400),
    );
  }
});

test("read receipts are monotonic under retry and concurrent updates", async () => {
  const database = setup();
  seedPlan(database);
  await fanout(
    database,
    event(20, "shared_plan.circle.memo.splice.v1", 100),
    1,
  );
  const first = await markNotificationRead(
    database.binding,
    identity(1),
    eventID(20),
    200_000,
  );
  const replay = await markNotificationRead(
    database.binding,
    identity(1),
    eventID(20),
    300_000,
  );
  assert.deepEqual(first, {
    id: eventID(20),
    readAt: "1970-01-01T00:03:20.000Z",
  });
  assert.deepEqual(replay, first);

  await fanout(database, event(21, "shared_plan.need.create.v1", 101), 1);
  const concurrent = await Promise.all([
    markNotificationRead(database.binding, identity(1), eventID(21), 400_000),
    markNotificationRead(database.binding, identity(1), eventID(21), 401_000),
  ]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  assert.deepEqual(
    database.rows(
      `SELECT read_at FROM shared_plan_event_recipients
       WHERE event_id = '${eventID(21)}' AND user_id = 1`,
    ),
    [{ read_at: 400 }],
  );
});

test("malformed, absent, and nonrecipient notification IDs do not leak authority", async () => {
  const database = setup();
  seedPlan(database);
  await fanout(
    database,
    event(30, "shared_plan.circle.communication.set.v1", 100),
    1,
  );
  for (const invalid of [undefined, "", "A".repeat(64), "a".repeat(63)]) {
    assert.throws(
      () => parseNotificationEventID(invalid),
      (error: unknown) => hasCode(error, "invalid_notification_event", 400),
    );
  }
  const absent = await rejection(() =>
    markNotificationRead(database.binding, identity(1), eventID(31), 200_000),
  );
  const nonrecipient = await rejection(() =>
    markNotificationRead(database.binding, identity(3), eventID(30), 200_000),
  );
  assert.deepEqual(errorShape(absent), {
    code: "notification_not_found",
    status: 404,
    message: "The notification was not found.",
  });
  assert.deepEqual(errorShape(nonrecipient), errorShape(absent));
});

test("logout or deletion between authentication and the read mutation wins", async () => {
  for (const fence of ["logout", "deletion"] as const) {
    const database = setup();
    seedPlan(database);
    await fanout(
      database,
      event(40, "shared_plan.need.wanted_quantity.v1", 100),
      1,
    );
    database.beforeNextFirst = (query) => {
      assert.match(query, /update "?shared_plan_event_recipients"?/i);
      if (fence === "logout") {
        database.native.exec(
          "UPDATE users SET auth_version = auth_version + 1 WHERE id = 1",
        );
      } else {
        database.native.exec(
          "UPDATE users SET deletion_pending_at = 200 WHERE id = 1",
        );
      }
    };
    await assert.rejects(
      () =>
        markNotificationRead(
          database.binding,
          identity(1),
          eventID(40),
          200_000,
        ),
      (error: unknown) => hasCode(error, "invalid_token", 401),
    );
    assert.deepEqual(
      database.rows(
        `SELECT read_at FROM shared_plan_event_recipients
         WHERE event_id = '${eventID(40)}' AND user_id = 1`,
      ),
      [{ read_at: null }],
    );
  }
});

test("revocation and archive retain prior inbox rows while stale generations suppress APNs", async () => {
  for (const lifecycle of ["member", "plan"] as const) {
    const database = setup();
    seedPlan(database);
    await fanout(
      database,
      event(50, "shared_plan.need.buyer_allocation.v1", 100),
      2,
    );
    if (lifecycle === "member") {
      database.native.exec(`
        UPDATE shared_plan_members
        SET revoked_at = 110, notification_epoch = notification_epoch + 1
        WHERE plan_id = '${planID}' AND user_id = 2;
      `);
    } else {
      database.native.exec(`
        UPDATE shared_plans
        SET archived_at = 110, notification_epoch = notification_epoch + 1
        WHERE id = '${planID}';
      `);
    }
    const history = await listNotifications(database.binding, identity(2), {
      limit: 50,
      cursor: null,
    });
    assert.deepEqual(
      history.items.map((item) => item.id),
      [eventID(50)],
      lifecycle,
    );

    await fanout(
      database,
      event(51, "shared_plan.need.fulfilled_quantity.v1", 101),
      2,
    );
    assert.deepEqual(
      database.rows(
        "SELECT id FROM shared_plan_notification_deliveries ORDER BY id",
      ),
      [],
      lifecycle,
    );
    const delayedHistory = await listNotifications(
      database.binding,
      identity(2),
      { limit: 50, cursor: null },
    );
    assert.deepEqual(
      delayedHistory.items.map((item) => item.id),
      [eventID(51), eventID(50)],
      lifecycle,
    );
  }
});

test("account deletion cascades only the deleted recipient authority", async () => {
  const database = setup();
  seedPlan(database);
  const shared = event(60, "shared_plan.circle.presence.v1", 100);
  await fanout(database, shared, 1);
  await fanout(database, shared, 2);
  database.native.exec(
    `UPDATE shared_plans SET owner_user_id = 2 WHERE id = '${planID}'`,
  );
  database.native.exec("DELETE FROM users WHERE id = 1");
  assert.deepEqual(
    database.rows(
      "SELECT event_id, user_id FROM shared_plan_event_recipients ORDER BY user_id",
    ),
    [{ event_id: eventID(60), user_id: 2 }],
  );
  assert.deepEqual(
    database.rows("SELECT id, actor_user_id FROM shared_plan_events"),
    [{ id: eventID(60), actor_user_id: null }],
  );
  const peer = await listNotifications(database.binding, identity(2), {
    limit: 50,
    cursor: null,
  });
  assert.deepEqual(
    peer.items.map((item) => item.id),
    [eventID(60)],
  );
});

test("the literal notification fixture is emitted by the live parsers and serializers", async () => {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/notification-inbox-v1.json", "utf8"),
  ) as {
    list: {
      request: { method: string; path: string };
      response: {
        items: Array<{
          id: string;
          eventType: string;
          i18nKey: string;
          payload: Record<string, unknown>;
        }>;
        nextCursor: string;
      };
    };
    read: {
      request: { method: string; path: string; body: null };
      response: { id: string; readAt: string };
      exactReplayResponse: { id: string; readAt: string };
    };
    errors: {
      malformedEventID: { status: number; body: Record<string, unknown> };
      notFound: { status: number; body: Record<string, unknown> };
    };
  };
  const database = setup();
  seedPlan(database);
  for (const [index, item] of fixture.list.response.items.entries()) {
    await fanout(
      database,
      {
        eventID: item.id,
        planID,
        sourceKind:
          item.eventType === "shared_plan.conflict.v1"
            ? "conflict"
            : "operation",
        sourceID: (200 + index).toString(16).padStart(64, "0"),
        actorUserID: 1,
        eventType: item.eventType,
        i18nKey: item.i18nKey,
        payloadVersion: 1,
        payloadJSON: JSON.stringify(item.payload),
        membershipEpoch: 7,
        planNotificationEpoch: 1,
        createdAt: 1_786_320_000,
      },
      1,
    );
  }
  await fanout(
    database,
    {
      ...event(70, "shared_plan.circle.presence.v1", 1_786_320_000),
      eventID: "d".repeat(64),
    },
    1,
  );
  const request = new Request(
    `https://cominavi.net${fixture.list.request.path}`,
    { method: fixture.list.request.method },
  );
  assert.deepEqual(
    await listNotifications(
      database.binding,
      identity(1),
      parseNotificationPage(request),
    ),
    fixture.list.response,
  );

  const readEventID = parseNotificationEventID(
    fixture.read.request.path.split("/").at(-2),
  );
  const first = await markNotificationRead(
    database.binding,
    identity(1),
    readEventID,
    1_786_320_060_000,
  );
  const replay = await markNotificationRead(
    database.binding,
    identity(1),
    readEventID,
    1_786_320_120_000,
  );
  assert.deepEqual(first, fixture.read.response);
  assert.deepEqual(replay, fixture.read.exactReplayResponse);

  const malformedResponse = apiErrorResponse(
    rejectionSync(() => parseNotificationEventID("invalid")),
  );
  assert.equal(
    malformedResponse.status,
    fixture.errors.malformedEventID.status,
  );
  assert.deepEqual(
    await malformedResponse.json(),
    fixture.errors.malformedEventID.body,
  );
  const missingResponse = apiErrorResponse(
    await rejection(() =>
      markNotificationRead(
        database.binding,
        identity(1),
        "0".repeat(64),
        1_786_320_120_000,
      ),
    ),
  );
  assert.equal(missingResponse.status, fixture.errors.notFound.status);
  assert.deepEqual(await missingResponse.json(), fixture.errors.notFound.body);

  assert.equal(fixture.read.request.body, null);
  const document = await generateOpenAPIDocument();
  const listOperation = document.paths?.["/api/v2/me/notifications"]?.get;
  const readOperation =
    document.paths?.["/api/v2/me/notifications/{eventID}/read"]?.put;
  assert.equal(listOperation?.operationId, "listNotifications");
  assert.deepEqual(listOperation?.security, [{ bearerAuth: [] }]);
  assert.equal(readOperation?.operationId, "markNotificationRead");
  assert.deepEqual(readOperation?.security, [{ bearerAuth: [] }]);
  assert.equal(readOperation?.requestBody, undefined);
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
      (2, '${"2".repeat(32)}', 'Peer', 1, 1, 1, 1, 1),
      (3, '${"3".repeat(32)}', 'Stranger', 1, 1, 1, 1, 1);
    INSERT INTO shared_plans (
      id, comiket_no, name, owner_user_id, revision, created_at, updated_at
    ) VALUES ('${planID}', 108, 'Fixture Plan', 1, 1, 1, 1);
    INSERT INTO shared_plan_members (
      plan_id, user_id, role, joined_at, updated_at
    ) VALUES
      ('${planID}', 1, 'owner', 1, 1),
      ('${planID}', 2, 'editor', 1, 1);
  `);
}

function event(
  index: number,
  eventType: string,
  createdAt: number,
): SharedPlanOutboxEvent {
  const conflict = eventType === "shared_plan.conflict.v1";
  return {
    eventID: eventID(index),
    planID,
    sourceKind: conflict ? "conflict" : "operation",
    sourceID: (index + 100).toString(16).padStart(64, "0"),
    actorUserID: 1,
    eventType,
    i18nKey: eventType.replace(/\.v1$/, ""),
    payloadVersion: 1,
    payloadJSON: JSON.stringify({ v: 1, eventType }),
    membershipEpoch: 1,
    planNotificationEpoch: 1,
    createdAt,
  };
}

async function fanout(
  database: SQLiteD1Database,
  item: SharedPlanOutboxEvent,
  userID: number,
): Promise<void> {
  await fanoutSharedPlanOutboxEvent(
    database.binding,
    { sendBatch: async () => undefined } as unknown as Queue<never>,
    item,
    { userID, membershipNotificationEpoch: 1 },
  );
}

function identity(userID: number): CominaviIdentity {
  return {
    subject: userID.toString(16).padStart(32, "0"),
    userID,
    authVersion: 1,
  };
}

function eventID(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function hasCode(error: unknown, code: string, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code &&
    "status" in error &&
    (error as { status: unknown }).status === status
  );
}

async function rejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  assert.fail("Expected action to reject.");
}

function errorShape(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof Error);
  return {
    code: "code" in error ? error.code : undefined,
    status: "status" in error ? error.status : undefined,
    message: error.message,
  };
}

function rejectionSync(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  assert.fail("Expected action to throw.");
}
