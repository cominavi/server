import assert from "node:assert/strict";
import test from "node:test";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { createHomepageApp } from "../src/api/app";
import { canonicalErrorResponseBody } from "../src/api/core";
import { pushDeviceRouter } from "../src/api/routers/push-devices";
import { realtimeUpdatesRouter } from "../src/api/routers/realtime-updates";
import { issueCominaviJWT } from "../src/lib/server/cominavi-auth";
import { SQLiteD1Database } from "./sqlite-d1";

const apiRouter = {
  me: { devices: pushDeviceRouter },
  events: { updates: realtimeUpdatesRouter },
};

const handler = new OpenAPIHandler(apiRouter, {
  customErrorResponseBodyEncoder: canonicalErrorResponseBody,
});

const jwtSecret = "push-realtime-router-test-secret-at-least-32-bytes";
const publicUserID = "0123456789abcdef0123456789abcdef";
const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
  exports: {},
  tracing: {},
} as unknown as ExecutionContext;

test("push and realtime routers publish non-nullable OpenAPI contracts", async () => {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });
  const document = await generator.generate(apiRouter, {
    info: { title: "Router Test", version: "2.0.0" },
  });

  const register = document.paths?.["/api/v2/me/devices/{installationID}"]?.put;
  const disable =
    document.paths?.["/api/v2/me/devices/{installationID}"]?.delete;
  const updates = document.paths?.["/api/v2/events/{eventNumber}/updates"]?.get;
  assert.equal(register?.operationId, "registerPushDevice");
  assert.equal(disable?.operationId, "disablePushDevice");
  assert.equal(updates?.operationId, "listRealtimeUpdates");
  assert.deepEqual(updates?.security, []);
  assert.ok(disable?.responses?.["200"]);

  const updateParameters = (updates?.parameters ?? []) as Array<{
    name?: string;
  }>;
  assert.deepEqual(
    updateParameters.map((parameter) => parameter.name),
    ["eventNumber", "afterCursor"],
  );
  assert.doesNotMatch(JSON.stringify(document), /"nullable"/);
  assert.doesNotMatch(JSON.stringify(document), /"null"/);
});

test("push-device transport registers and idempotently disables an installation", async () => {
  const database = serviceDatabase();
  seedUser(database);
  const authorization = await bearerAuthorization();
  const installationID = "ABCDEF12-3456-7890";
  const env = serviceEnvironment(database);

  const put = await dispatch(
    new Request(`https://cominavi.net/api/v2/me/devices/${installationID}`, {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token: "AB".repeat(32),
        apnsEnvironment: "sandbox",
        bundleID: "llc.mikunet.cominavi.debug",
        locale: "ja-JP",
        timeZone: "Asia/Tokyo",
      }),
    }),
    env,
  );
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), {
    installationID: installationID.toLowerCase(),
    enabled: true,
  });
  assert.deepEqual(
    database.rows("SELECT installation_id, token, enabled FROM push_devices"),
    [
      {
        installation_id: installationID.toLowerCase(),
        token: "ab".repeat(32),
        enabled: 1,
      },
    ],
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const disabled = await dispatch(
      new Request(`https://cominavi.net/api/v2/me/devices/${installationID}`, {
        method: "DELETE",
        headers: { Authorization: authorization },
      }),
      env,
    );
    assert.equal(disabled.status, 200);
    assert.deepEqual(await disabled.json(), {
      installationID: installationID.toLowerCase(),
      enabled: false,
    });
  }
  assert.equal(
    database.rows("SELECT enabled FROM push_devices")[0]?.enabled,
    0,
  );
});

test("realtime transport preserves the complete snapshot and pages after a cursor", async () => {
  const database = serviceDatabase();
  seedRealtimeUpdates(database);
  const env = serviceEnvironment(database);

  const response = await dispatch(
    new Request("https://cominavi.net/api/v2/events/108/updates"),
    env,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json<{
    eventNumber: number;
    hasMore: boolean;
    updates: Array<{
      cursor: number;
      post: { media: unknown[] };
      circles: Array<{ wcID: number }>;
    }>;
  }>();
  assert.equal(body.eventNumber, 108);
  assert.equal(body.hasMore, false);
  assert.deepEqual(
    body.updates.map((update) => update.cursor),
    [1, 2, 3],
  );
  assert.deepEqual(
    body.updates.map((update) => update.circles.map((circle) => circle.wcID)),
    [[101], [102], [101]],
  );
  assert.deepEqual(body.updates[2]?.post.media, [
    {
      key: "media-3",
      type: "image/jpeg",
      role: "shinagaki",
      url: "https://images.example/media-3.jpg",
      width: 1200,
      height: 800,
      palette: ["#112233", "#445566"],
      payloadSHA256: "d".repeat(64),
    },
  ]);
  assert.deepEqual(Object.keys(body).sort(), [
    "eventNumber",
    "hasMore",
    "updates",
  ]);

  const incremental = await dispatch(
    new Request("https://cominavi.net/api/v2/events/108/updates?afterCursor=1"),
    env,
  );
  assert.equal(incremental.status, 200, await incremental.clone().text());
  const page = await incremental.json<{
    hasMore: boolean;
    updates: Array<{ cursor: number }>;
  }>();
  assert.equal(page.hasMore, false);
  assert.deepEqual(
    page.updates.map((update) => update.cursor),
    [2, 3],
  );
});

test("realtime transport bounds incremental pages and exposes continuation", async () => {
  const database = serviceDatabase();
  seedRealtimeUpdates(database);
  seedAdditionalRealtimeUpdates(database, 501);
  const env = serviceEnvironment(database);

  const first = await dispatch(
    new Request("https://cominavi.net/api/v2/events/108/updates?afterCursor=0"),
    env,
  );
  const firstPage = await first.json<{
    hasMore: boolean;
    updates: Array<{ cursor: number }>;
  }>();
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.updates.length, 500);
  assert.equal(firstPage.updates[0]?.cursor, 1);
  assert.equal(firstPage.updates.at(-1)?.cursor, 500);

  const next = await dispatch(
    new Request(
      "https://cominavi.net/api/v2/events/108/updates?afterCursor=500",
    ),
    env,
  );
  const nextPage = await next.json<{
    hasMore: boolean;
    updates: Array<{ cursor: number }>;
  }>();
  assert.equal(nextPage.hasMore, false);
  assert.deepEqual(
    nextPage.updates.map((update) => update.cursor),
    [501, 502, 503, 504],
  );
});

test("homepage serves the canonical snapshot with SWR headers and ETag revalidation", async () => {
  const database = serviceDatabase();
  seedRealtimeUpdates(database);
  const env = serviceEnvironment(database);
  const app = createHomepageApp(() => new Response("astro"));
  const url = "https://cominavi.net/api/v2/events/108/updates";

  const response = await app.fetch(new Request(url), env, executionContext);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(
    response.headers.get("Cache-Control"),
    "public, max-age=60, stale-while-revalidate=60, stale-if-error=86400",
  );
  assert.equal(
    response.headers.get("Cloudflare-CDN-Cache-Control"),
    "public, max-age=60, stale-while-revalidate=300, stale-if-error=86400",
  );
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  const etag = response.headers.get("ETag");
  assert.match(etag ?? "", /^"sha256-[0-9a-f]{64}"$/);
  assert.deepEqual(
    (await response.json<{ updates: Array<{ cursor: number }> }>()).updates.map(
      (update) => update.cursor,
    ),
    [1, 2, 3],
  );

  const unchanged = await app.fetch(
    new Request(url, { headers: { "If-None-Match": `W/${etag}` } }),
    env,
    executionContext,
  );
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get("ETag"), etag);
  assert.equal(await unchanged.text(), "");

  const incremental = await app.fetch(
    new Request(`${url}?afterCursor=1`),
    env,
    executionContext,
  );
  assert.equal(incremental.status, 200, await incremental.clone().text());
  assert.equal(
    incremental.headers.get("Cache-Control"),
    "public, max-age=60, stale-while-revalidate=60, stale-if-error=86400",
  );
  assert.match(
    incremental.headers.get("ETag") ?? "",
    /^"sha256-[0-9a-f]{64}"$/,
  );
  assert.deepEqual(
    (
      await incremental.json<{ updates: Array<{ cursor: number }> }>()
    ).updates.map((update) => update.cursor),
    [2, 3],
  );

  const rejected = await app.fetch(
    new Request(`${url}?after=1`),
    env,
    executionContext,
  );
  assert.equal(rejected.status, 400);
  assert.equal(rejected.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await rejected.json(), {
    error: "invalid_realtime_query",
    message: "Realtime updates accept only one canonical afterCursor value.",
  });

  const noncanonical = await app.fetch(
    new Request(`${url}?afterCursor=01`),
    env,
    executionContext,
  );
  assert.equal(noncanonical.status, 400);
  assert.equal(noncanonical.headers.get("Cache-Control"), "private, no-store");
});

async function dispatch(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const result = await handler.handle(request, {
    context: { request, env },
  });
  assert.equal(result.matched, true);
  if (!result.matched) throw new Error("Expected the OpenAPI route to match.");
  return result.response;
}

async function bearerAuthorization(): Promise<string> {
  const issued = await issueCominaviJWT(
    { subject: publicUserID, userID: 1, authVersion: 1 },
    jwtSecret,
  );
  return `Bearer ${issued.token}`;
}

function serviceEnvironment(database: SQLiteD1Database): Cloudflare.Env {
  return {
    COMINAVI_DB: database.binding,
    COMINAVI_JWT_SECRET: jwtSecret,
    COMINAVI_APNS_BUNDLE_IDS: "llc.mikunet.cominavi.debug,llc.mikunet.cominavi",
  } as unknown as Cloudflare.Env;
}

function serviceDatabase(): SQLiteD1Database {
  return new SQLiteD1Database(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      public_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      auth_version INTEGER NOT NULL,
      deletion_pending_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_authenticated_at INTEGER NOT NULL
    );
    CREATE TABLE push_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      installation_id TEXT NOT NULL,
      token TEXT NOT NULL,
      token_sha256 TEXT NOT NULL,
      apns_environment TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      locale TEXT,
      time_zone TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_registered_at INTEGER NOT NULL,
      invalidated_at INTEGER,
      UNIQUE (user_id, installation_id),
      UNIQUE (apns_environment, bundle_id, token_sha256)
    );
    CREATE TABLE circles (
      comiket_no INTEGER NOT NULL,
      wc_id INTEGER NOT NULL,
      circle_id INTEGER,
      circle_name TEXT NOT NULL,
      day INTEGER,
      area_name TEXT,
      block_name TEXT,
      space_no INTEGER,
      space_no_sub INTEGER,
      location TEXT,
      PRIMARY KEY (comiket_no, wc_id)
    );
    CREATE TABLE ingest_batches (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      raw_payload_json TEXT NOT NULL
    );
    CREATE TABLE social_posts (
      post_id TEXT PRIMARY KEY,
      author_x_user_id TEXT,
      author_handle TEXT NOT NULL,
      author_name TEXT,
      author_profile_image_url TEXT,
      post_url TEXT,
      text TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      latest_observed_at INTEGER NOT NULL,
      raw_post_json TEXT NOT NULL
    );
    CREATE TABLE post_media (
      post_id TEXT NOT NULL REFERENCES social_posts(post_id),
      media_index INTEGER NOT NULL,
      media_key TEXT NOT NULL,
      media_type TEXT NOT NULL,
      role TEXT NOT NULL,
      url TEXT NOT NULL,
      preview_url TEXT,
      width INTEGER,
      height INTEGER,
      palette_json TEXT,
      payload_sha256 TEXT,
      PRIMARY KEY (post_id, media_key)
    );
    CREATE TABLE circle_update_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      ingest_batch_id INTEGER NOT NULL REFERENCES ingest_batches(id),
      source TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      post_id TEXT NOT NULL REFERENCES social_posts(post_id),
      update_kind TEXT NOT NULL,
      state_kind TEXT NOT NULL,
      state_value TEXT NOT NULL,
      confidence TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      notifiable INTEGER NOT NULL DEFAULT 1,
      evidence_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE circle_update_targets (
      update_event_id INTEGER NOT NULL REFERENCES circle_update_events(id),
      comiket_no INTEGER NOT NULL,
      wc_id INTEGER NOT NULL,
      PRIMARY KEY (update_event_id, comiket_no, wc_id),
      FOREIGN KEY (comiket_no, wc_id) REFERENCES circles(comiket_no, wc_id)
    );
  `);
}

function seedUser(database: SQLiteD1Database): void {
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, auth_version, deletion_pending_at,
      created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${publicUserID}', 'Router User', 1, NULL, 1, 1, 1);
  `);
}

function seedRealtimeUpdates(database: SQLiteD1Database): void {
  database.native.exec(`
    INSERT INTO circles (
      comiket_no, wc_id, circle_name, day, area_name, block_name,
      space_no, space_no_sub, location
    ) VALUES
      (108, 101, 'Circle One', NULL, NULL, NULL, NULL, NULL, NULL),
      (108, 102, 'Circle Two', 1, 'East', 'A', 10, 2, '東A-10b');
    INSERT INTO ingest_batches (
      id, source, idempotency_key, payload_sha256, schema_version,
      observed_at, received_at, raw_payload_json
    ) VALUES (1, 'fixture', 'router-fixture', '${"a".repeat(64)}', 1,
              1700000000, 1700000000, '{}');
    INSERT INTO social_posts (
      post_id, author_handle, text, occurred_at, latest_observed_at, raw_post_json
    ) VALUES
      ('post-1', 'circle_one', 'First update', 1700000000, 1700000000, '{}'),
      ('post-2', 'circle_two', 'Filtered update', 1700000100, 1700000100, '{}'),
      ('post-3', 'circle_one', 'Next update', 1700000200, 1700000200, '{}');
    INSERT INTO post_media (
      post_id, media_index, media_key, media_type, role, url,
      width, height, palette_json, payload_sha256
    ) VALUES (
      'post-3', 0, 'media-3', 'image/jpeg', 'shinagaki',
      'https://images.example/media-3.jpg', 1200, 800,
      '["#112233","#445566"]', '${"d".repeat(64)}'
    );
    INSERT INTO circle_update_events (
      id, event_key, ingest_batch_id, source, source_revision, post_id,
      update_kind, state_kind, state_value, confidence, occurred_at,
      evidence_json, created_at
    ) VALUES
      (1, 'event-1', 1, 'fixture', 1, 'post-1', 'presence_present',
       'presence', 'present', 'high', 1700000000, '{}', 1700000000),
      (2, 'event-2', 1, 'fixture', 1, 'post-2', 'inventory_low',
       'inventory', 'low_stock', 'medium', 1700000100, '{}', 1700000100),
      (3, 'event-3', 1, 'fixture', 1, 'post-3', 'shinagaki_changed',
       'shinagaki', 'published', 'high', 1700000200, '{}', 1700000200);
    INSERT INTO circle_update_targets (update_event_id, comiket_no, wc_id)
    VALUES (1, 108, 101), (2, 108, 102), (3, 108, 101);
  `);
}

function seedAdditionalRealtimeUpdates(
  database: SQLiteD1Database,
  count: number,
): void {
  const insertPost = database.native.prepare(`
    INSERT INTO social_posts (
      post_id, author_handle, text, occurred_at, latest_observed_at, raw_post_json
    ) VALUES (?, 'circle_one', ?, ?, ?, '{}')
  `);
  const insertEvent = database.native.prepare(`
    INSERT INTO circle_update_events (
      event_key, ingest_batch_id, source, source_revision, post_id,
      update_kind, state_kind, state_value, confidence, occurred_at,
      evidence_json, created_at
    ) VALUES (?, 1, 'fixture', 1, ?, 'presence_present', 'presence',
              'present', 'high', ?, '{}', ?)
  `);
  const insertTarget = database.native.prepare(`
    INSERT INTO circle_update_targets (update_event_id, comiket_no, wc_id)
    VALUES (?, 108, 101)
  `);
  for (let offset = 0; offset < count; offset += 1) {
    const sequence = offset + 4;
    const postID = `post-${sequence}`;
    const occurredAt = 1_700_001_000 + offset;
    insertPost.run(postID, `Update ${sequence}`, occurredAt, occurredAt);
    const result = insertEvent.run(
      `event-${sequence}`,
      postID,
      occurredAt,
      occurredAt,
    );
    insertTarget.run(Number(result.lastInsertRowid));
  }
}
