import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseAccountDeletion,
  requestAccountDeletion,
} from "../src/lib/server/account-deletion";
import type { CominaviIdentity } from "../src/lib/server/cominavi-auth";
import {
  FollowingImportError,
  importFollowingSnapshot,
  processFollowingSnapshotCleanup,
  streamFollowingSnapshot,
  type FollowingImportBindings,
} from "../src/lib/server/following-import";
import { SQLiteD1Database } from "./sqlite-d1";

const identity: CominaviIdentity = {
  subject: "0123456789abcdef0123456789abcdef",
  userID: 7,
  authVersion: 1,
};

test("streaming import emits page progress and releases a cancelled lease", async () => {
  const database = setup();
  const snapshots = new FakeKV();
  const bindings: FollowingImportBindings = {
    COMINAVI_DB: database.binding,
    COMINAVI_FOLLOWING_SNAPSHOTS: snapshots as unknown as KVNamespace,
    TWITTERAPI_IO_API_KEY: "key",
  };
  const stream = streamFollowingSnapshot(
    identity,
    "owner",
    bindings,
    1_000_000,
    async () =>
      Response.json({
        status: "success",
        followings: [{ id: "x-1", userName: "circle_a" }],
        has_next_page: true,
        next_cursor: "next",
      }),
  );

  const first = await stream.next();
  assert.equal(first.done, false);
  if (!first.done) {
    assert.equal(first.value.page, 1);
    assert.equal(first.value.fetchedCount, 1);
  }
  await stream.return(undefined as never);

  assert.deepEqual(
    database.rows(
      "SELECT status, lease_id, next_allowed_at, last_error FROM following_imports",
    ),
    [
      {
        status: "failed",
        lease_id: null,
        next_allowed_at: 1_000,
        last_error: "import_cancelled",
      },
    ],
  );
});

test("six-hour lease serves same-user cache and rejects account switching", async () => {
  const database = setup();
  const snapshots = new FakeKV();
  const bindings: FollowingImportBindings = {
    COMINAVI_DB: database.binding,
    COMINAVI_FOLLOWING_SNAPSHOTS: snapshots as unknown as KVNamespace,
    TWITTERAPI_IO_API_KEY: "key",
  };
  let providerRequests = 0;
  const fetcher: typeof fetch = async () => {
    providerRequests += 1;
    return Response.json({
      status: "success",
      followings: [{ id: "x-1", userName: "circle_a", name: "Circle A" }],
      has_next_page: false,
    });
  };

  const first = await importFollowingSnapshot(
    identity,
    "owner",
    bindings,
    1_000_000,
    fetcher,
  );
  const cached = await importFollowingSnapshot(
    identity,
    "OWNER",
    bindings,
    2_000_000,
    fetcher,
  );

  assert.equal(first.source, "twitterapi.io");
  assert.equal(cached.source, "cache");
  assert.deepEqual(cached.followings, first.followings);
  assert.equal(providerRequests, 1);
  await assert.rejects(
    importFollowingSnapshot(
      identity,
      "different_owner",
      bindings,
      2_000_000,
      fetcher,
    ),
    (error: unknown) =>
      error instanceof FollowingImportError && error.code === "import_cooldown",
  );
  assert.equal(providerRequests, 1);
});

test("a failed account switch retains but never mislabels the prior snapshot", async () => {
  const database = setup();
  const snapshots = new FakeKV();
  const bindings: FollowingImportBindings = {
    COMINAVI_DB: database.binding,
    COMINAVI_FOLLOWING_SNAPSHOTS: snapshots as unknown as KVNamespace,
    TWITTERAPI_IO_API_KEY: "key",
  };
  const success: typeof fetch = async () =>
    Response.json({
      status: "success",
      followings: [{ id: "x-1", userName: "circle_a" }],
      has_next_page: false,
    });
  let failureRequests = 0;
  const failure: typeof fetch = async () => {
    failureRequests += 1;
    return Response.json({
      status: "error",
      message: "private account",
      followings: [],
      has_next_page: false,
    });
  };

  await importFollowingSnapshot(
    identity,
    "owner",
    bindings,
    1_000_000,
    success,
  );
  const priorSnapshotKey = database.rows(
    "SELECT snapshot_key FROM following_imports",
  )[0]?.snapshot_key as string;
  await assert.rejects(
    importFollowingSnapshot(
      identity,
      "new_owner",
      bindings,
      1_000_000 + 21_600_000,
      failure,
    ),
    (error: unknown) =>
      error instanceof FollowingImportError &&
      error.code === "twitter_api_error" &&
      error.nextAllowedAt === undefined,
  );

  assert.equal(
    database.rows("SELECT snapshot_key FROM following_imports")[0]
      ?.snapshot_key,
    priorSnapshotKey,
  );
  assert.equal(snapshots.has(priorSnapshotKey), true);
  assert.equal(failureRequests, 1);
  await assert.rejects(
    importFollowingSnapshot(
      identity,
      "new_owner",
      bindings,
      1_000_000 + 21_601_000,
      failure,
    ),
    (error: unknown) =>
      error instanceof FollowingImportError &&
      error.code === "twitter_api_error" &&
      error.nextAllowedAt === undefined,
  );
  assert.equal(failureRequests, 2);
});

test("reports upstream X import failures without reporting client errors", async () => {
  const database = setup();
  const snapshots = new FakeKV();
  const bindings: FollowingImportBindings = {
    COMINAVI_DB: database.binding,
    COMINAVI_FOLLOWING_SNAPSHOTS: snapshots as unknown as KVNamespace,
    TWITTERAPI_IO_API_KEY: "key",
  };
  const reported: FollowingImportError[] = [];

  await assert.rejects(
    importFollowingSnapshot(
      identity,
      "owner",
      bindings,
      1_000_000,
      async () =>
        Response.json({
          status: "error",
          message: "upstream failure",
          followings: [],
          has_next_page: false,
        }),
      {
        onServerError: (error) => reported.push(error),
      },
    ),
    (error: unknown) =>
      error instanceof FollowingImportError &&
      error.code === "twitter_api_error" &&
      error.status === 502,
  );
  assert.deepEqual(
    reported.map(({ code, status }) => ({ code, status })),
    [{ code: "twitter_api_error", status: 502 }],
  );

  const limitDatabase = setup();
  const limitSnapshots = new FakeKV();
  const limitReported: FollowingImportError[] = [];
  await assert.rejects(
    importFollowingSnapshot(
      identity,
      "owner",
      {
        ...bindings,
        COMINAVI_DB: limitDatabase.binding,
        COMINAVI_FOLLOWING_SNAPSHOTS: limitSnapshots as unknown as KVNamespace,
      },
      1_000_000,
      async () =>
        Response.json({
          status: "success",
          followings: Array.from({ length: 5_001 }, (_, index) => ({
            id: String(index),
            userName: `circle_${index}`,
          })),
          has_next_page: false,
        }),
      {
        onServerError: (error) => limitReported.push(error),
      },
    ),
    (error: unknown) =>
      error instanceof FollowingImportError &&
      error.code === "twitter_following_limit_exceeded" &&
      error.status === 422,
  );
  assert.deepEqual(limitReported, []);
});

test("returns a typed 422 error when the X following limit is exceeded", async () => {
  const database = setup();
  const snapshots = new FakeKV();
  const bindings: FollowingImportBindings = {
    COMINAVI_DB: database.binding,
    COMINAVI_FOLLOWING_SNAPSHOTS: snapshots as unknown as KVNamespace,
    TWITTERAPI_IO_API_KEY: "key",
  };

  await assert.rejects(
    importFollowingSnapshot(identity, "owner", bindings, 1_000_000, async () =>
      Response.json({
        status: "success",
        followings: Array.from({ length: 5_001 }, (_, index) => ({
          id: String(index),
          userName: `circle_${index}`,
        })),
        has_next_page: false,
      }),
    ),
    (error: unknown) =>
      error instanceof FollowingImportError &&
      error.status === 422 &&
      error.code === "twitter_following_limit_exceeded" &&
      error.message ===
        "This X account follows more than 5,000 people. ComiNavi can import up to 5,000 accounts.",
  );
  assert.deepEqual(
    database.rows("SELECT status, last_error FROM following_imports"),
    [{ status: "failed", last_error: "twitter_following_limit_exceeded" }],
  );
  assert.equal(snapshots.size, 0);
});

test("postpublication failure deleting the prior KV snapshot preserves the new ready cache", async () => {
  const database = setup();
  const snapshots = new FakeKV();
  const bindings: FollowingImportBindings = {
    COMINAVI_DB: database.binding,
    COMINAVI_FOLLOWING_SNAPSHOTS: snapshots as unknown as KVNamespace,
    TWITTERAPI_IO_API_KEY: "key",
  };
  let generation = 0;
  const fetcher: typeof fetch = async () => {
    generation += 1;
    return Response.json({
      status: "success",
      followings: [{ id: `x-${generation}`, userName: `circle_${generation}` }],
      has_next_page: false,
    });
  };
  const first = await importFollowingSnapshot(
    identity,
    "owner",
    bindings,
    1_000_000,
    fetcher,
  );
  const oldKey = database.rows("SELECT snapshot_key FROM following_imports")[0]
    ?.snapshot_key as string;
  snapshots.failNextDelete = true;
  const second = await importFollowingSnapshot(
    identity,
    "owner",
    bindings,
    1_000_000 + 21_600_000,
    fetcher,
  );
  const current = database.rows(
    "SELECT status, snapshot_key, following_count FROM following_imports",
  )[0]!;
  const newKey = current.snapshot_key as string;
  assert.equal(second.source, "twitterapi.io");
  assert.notDeepEqual(second.followings, first.followings);
  assert.deepEqual(current, {
    status: "ready",
    snapshot_key: newKey,
    following_count: 1,
  });
  assert.notEqual(newKey, oldKey);
  assert.equal(snapshots.has(newKey), true);
  assert.equal(snapshots.has(oldKey), true);
  assert.deepEqual(
    database.rows("SELECT object_key FROM following_snapshot_cleanup"),
    [{ object_key: oldKey }],
  );

  const cached = await importFollowingSnapshot(
    identity,
    "owner",
    bindings,
    1_000_000 + 21_601_000,
    fetcher,
  );
  assert.equal(cached.source, "cache");
  assert.deepEqual(cached.followings, second.followings);
  assert.equal(
    await processFollowingSnapshotCleanup(
      database.binding,
      snapshots as unknown as KVNamespace,
      1_000_000 + 21_602_000,
    ),
    1,
  );
  assert.equal(snapshots.has(oldKey), false);
  assert.equal(snapshots.has(newKey), true);
});

test("deletion between KV storage and D1 publication fences the import and durably cleans the orphan", async () => {
  const database = setup();
  const snapshots = new FakeKV();
  snapshots.failNextDelete = true;
  const bindings: FollowingImportBindings = {
    COMINAVI_DB: database.binding,
    COMINAVI_FOLLOWING_SNAPSHOTS: snapshots as unknown as KVNamespace,
    TWITTERAPI_IO_API_KEY: "key",
  };
  await assert.rejects(
    importFollowingSnapshot(
      identity,
      "owner",
      bindings,
      1_000_000,
      async () =>
        Response.json({
          status: "success",
          followings: [{ id: "x-1", userName: "circle_a" }],
          has_next_page: false,
        }),
      {
        afterSnapshotStored: async () => {
          await requestAccountDeletion(
            database.binding,
            identity,
            parseAccountDeletion({
              requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              confirmation: "DELETE",
            }),
            credentialKey(),
            1_001_000,
          );
        },
      },
    ),
    (error: unknown) =>
      error instanceof FollowingImportError &&
      error.code === "import_publication_failed",
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM users")[0]?.count,
    0,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM following_imports")[0]?.count,
    0,
  );
  const cleanupKey = database.rows(
    "SELECT object_key FROM following_snapshot_cleanup",
  )[0]?.object_key as string;
  assert.ok(cleanupKey);
  assert.equal(snapshots.has(cleanupKey), true);
  assert.equal(
    await processFollowingSnapshotCleanup(
      database.binding,
      snapshots as unknown as KVNamespace,
      1_601_000,
    ),
    1,
  );
  assert.equal(snapshots.has(cleanupKey), false);
  assert.equal(
    database.rows("SELECT count(*) AS count FROM following_snapshot_cleanup")[0]
      ?.count,
    0,
  );
});

test("cleanup leased before publication cannot delete an authoritative ready snapshot", async () => {
  const database = setup();
  const snapshots = new FakeKV();
  const bindings: FollowingImportBindings = {
    COMINAVI_DB: database.binding,
    COMINAVI_FOLLOWING_SNAPSHOTS: snapshots as unknown as KVNamespace,
    TWITTERAPI_IO_API_KEY: "key",
  };
  let cleanupCount = -1;
  await assert.rejects(
    importFollowingSnapshot(
      identity,
      "owner",
      bindings,
      1_000_000,
      async () =>
        Response.json({
          status: "success",
          followings: [{ id: "x-1", userName: "circle_a" }],
          has_next_page: false,
        }),
      {
        afterSnapshotStored: async () => {
          cleanupCount = await processFollowingSnapshotCleanup(
            database.binding,
            snapshots as unknown as KVNamespace,
            1_601_000,
          );
        },
      },
    ),
    (error: unknown) =>
      error instanceof FollowingImportError &&
      error.code === "import_publication_failed",
  );
  assert.equal(cleanupCount, 1);
  assert.deepEqual(
    database.rows("SELECT status, snapshot_key FROM following_imports"),
    [{ status: "failed", snapshot_key: null }],
  );
  assert.equal(snapshots.size, 0);
  assert.equal(
    database.rows("SELECT count(*) AS count FROM following_snapshot_cleanup")[0]
      ?.count,
    0,
  );
});

class FakeKV {
  private readonly values = new Map<string, string>();
  failNextDelete = false;

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async get<T>(key: string): Promise<T | null> {
    const value = this.values.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  async delete(key: string): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("simulated KV outage");
    }
    this.values.delete(key);
  }

  has(key: string | null | undefined): boolean {
    return key ? this.values.has(key) : false;
  }

  get size(): number {
    return this.values.size;
  }
}

function credentialKey(): string {
  return Buffer.from(
    Uint8Array.from({ length: 32 }, (_, index) => index),
  ).toString("base64url");
}

function setup(): SQLiteD1Database {
  const database = new SQLiteD1Database(
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
  database.native
    .prepare(
      `INSERT INTO users (
         id, public_id, display_name, profile_revision, auth_version,
         created_at, updated_at, last_authenticated_at
       ) VALUES (?1, ?2, 'Following User', 1, ?3, 1, 1, 1)`,
    )
    .run(identity.userID, identity.subject, identity.authVersion);
  return database;
}
