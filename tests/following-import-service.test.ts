import assert from "node:assert/strict";
import test from "node:test";
import type { CominaviIdentity } from "../src/lib/server/cominavi-auth";
import {
  FollowingImportError,
  importFollowingSnapshot,
  type FollowingImportBindings,
} from "../src/lib/server/following-import";

interface StoredRow {
  subject: string;
  twitter_username: string;
  status: "fetching" | "ready" | "failed";
  lease_id: string | null;
  attempted_at: number;
  next_allowed_at: number;
  successful_at: number | null;
  snapshot_key: string | null;
  following_count: number;
  last_error: string | null;
}

const identity: CominaviIdentity = {
  subject: "circlems:production:42",
  circlemsEnvironment: "production",
  circlemsUserID: 42,
  userID: 7,
  authVersion: 1,
};

test("six-hour lease serves same-user cache and rejects account switching", async () => {
  const database = new FakeD1();
  const snapshots = new FakeKV();
  const bindings: FollowingImportBindings = {
    COMINAVI_DB: database as unknown as D1Database,
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
  const database = new FakeD1();
  const snapshots = new FakeKV();
  const bindings: FollowingImportBindings = {
    COMINAVI_DB: database as unknown as D1Database,
    COMINAVI_FOLLOWING_SNAPSHOTS: snapshots as unknown as KVNamespace,
    TWITTERAPI_IO_API_KEY: "key",
  };
  const success: typeof fetch = async () =>
    Response.json({
      status: "success",
      followings: [{ id: "x-1", userName: "circle_a" }],
      has_next_page: false,
    });
  const failure: typeof fetch = async () =>
    Response.json({
      status: "error",
      message: "private account",
      followings: [],
      has_next_page: false,
    });

  await importFollowingSnapshot(
    identity,
    "owner",
    bindings,
    1_000_000,
    success,
  );
  const priorSnapshotKey = database.row?.snapshot_key;
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
      error.code === "twitter_api_error",
  );

  assert.equal(database.row?.snapshot_key, priorSnapshotKey);
  assert.equal(snapshots.has(priorSnapshotKey), true);
  await assert.rejects(
    importFollowingSnapshot(
      identity,
      "new_owner",
      bindings,
      1_000_000 + 21_601_000,
      failure,
    ),
    (error: unknown) =>
      error instanceof FollowingImportError && error.code === "import_cooldown",
  );
});

class FakeD1 {
  row: StoredRow | null = null;

  prepare(query: string): FakeStatement {
    return new FakeStatement(this, query);
  }
}

class FakeStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.row ? { ...this.database.row } : null) as T | null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.query.includes("INSERT OR IGNORE")) {
      if (this.database.row) return { meta: { changes: 0 } };
      this.database.row = {
        subject: this.values[0] as string,
        twitter_username: this.values[1] as string,
        status: "fetching",
        lease_id: this.values[2] as string,
        attempted_at: this.values[3] as number,
        next_allowed_at: this.values[4] as number,
        successful_at: null,
        snapshot_key: null,
        following_count: 0,
        last_error: null,
      };
      return { meta: { changes: 1 } };
    }

    const row = this.database.row;
    if (!row) return { meta: { changes: 0 } };
    if (this.query.includes("SET twitter_username")) {
      const now = this.values[2] as number;
      const subject = this.values[4] as string;
      if (row.subject !== subject || row.next_allowed_at > now) {
        return { meta: { changes: 0 } };
      }
      Object.assign(row, {
        twitter_username: this.values[0] as string,
        status: "fetching" as const,
        lease_id: this.values[1] as string,
        attempted_at: now,
        next_allowed_at: this.values[3] as number,
        last_error: null,
      });
      return { meta: { changes: 1 } };
    }
    if (this.query.includes("SET status = 'ready'")) {
      if (row.subject !== this.values[3] || row.lease_id !== this.values[4]) {
        return { meta: { changes: 0 } };
      }
      Object.assign(row, {
        status: "ready" as const,
        successful_at: this.values[0] as number,
        snapshot_key: this.values[1] as string,
        following_count: this.values[2] as number,
        last_error: null,
      });
      return { meta: { changes: 1 } };
    }
    if (this.query.includes("SET status = 'failed'")) {
      if (row.subject !== this.values[1] || row.lease_id !== this.values[2]) {
        return { meta: { changes: 0 } };
      }
      row.status = "failed";
      row.last_error = this.values[0] as string;
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled fake D1 query: ${this.query}`);
  }
}

class FakeKV {
  private readonly values = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async get<T>(key: string): Promise<T | null> {
    const value = this.values.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  has(key: string | null | undefined): boolean {
    return key ? this.values.has(key) : false;
  }
}
