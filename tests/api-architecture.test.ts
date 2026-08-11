import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createHomepageApp } from "../src/api/app";
import { generateOpenAPIDocument } from "../src/api/openapi";
import { issueCominaviJWT } from "../src/lib/server/cominavi-auth";
import { SQLiteD1Database } from "./sqlite-d1";

const environment = {} as Cloudflare.Env;
const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
  exports: {},
  tracing: {},
} as unknown as ExecutionContext;

test("oRPC generates the type-safe Shared Plans OpenAPI operation", async () => {
  const document = await generateOpenAPIDocument();
  assert.equal(document.openapi, "3.1.1");
  const operation = document.paths?.["/api/v2/plans"]?.get;
  assert.equal(operation?.operationId, "listSharedPlans");
  assert.deepEqual(operation?.tags, ["Shared Plans"]);
  assert.equal(document.security, undefined);
  assert.deepEqual(operation?.security, [{ bearerAuth: [] }]);
  assert.equal(
    document.components?.securitySchemes?.bearerAuth &&
      "scheme" in document.components.securitySchemes.bearerAuth
      ? document.components.securitySchemes.bearerAuth.scheme
      : undefined,
    "bearer",
  );
});

test("Hono serves OpenAPI, delegates pages, and leaves retired v1 routes as Astro 404s", async () => {
  const fallbackRequests: string[] = [];
  const app = createHomepageApp((request) => {
    const pathname = new URL(request.url).pathname;
    fallbackRequests.push(pathname);
    return new Response(pathname.startsWith("/api/v1/") ? "missing" : "astro", {
      status: pathname.startsWith("/api/v1/") ? 404 : 200,
      headers: { "X-Handler": "astro" },
    });
  });

  const specification = await app.fetch(
    new Request("https://cominavi.net/api/openapi.json"),
    environment,
    executionContext,
  );
  assert.equal(specification.status, 200);
  assert.match(specification.headers.get("Content-Type") ?? "", /json/);
  assert.ok(
    Object.hasOwn(
      (await specification.json<{ paths: Record<string, unknown> }>()).paths,
      "/api/v2/plans",
    ),
  );

  for (const pathname of ["/", "/privacy"]) {
    const response = await app.fetch(
      new Request(`https://cominavi.net${pathname}`),
      environment,
      executionContext,
    );
    assert.equal(response.headers.get("X-Handler"), "astro");
  }
  const retired = await app.fetch(
    new Request("https://cominavi.net/api/v1/plans"),
    environment,
    executionContext,
  );
  assert.equal(retired.status, 404);
  assert.equal(retired.headers.get("X-Handler"), "astro");
  assert.deepEqual(fallbackRequests, ["/", "/privacy", "/api/v1/plans"]);
});

test("the OpenAPI handler owns v2 misses and authentication failures", async () => {
  let fallbackCount = 0;
  const app = createHomepageApp(() => {
    fallbackCount += 1;
    return new Response("astro");
  });

  const missing = await app.fetch(
    new Request("https://cominavi.net/api/v2/missing"),
    environment,
    executionContext,
  );
  assert.equal(missing.status, 404);

  const unauthorized = await app.fetch(
    new Request("https://cominavi.net/api/v2/plans"),
    environment,
    executionContext,
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(fallbackCount, 0);
});

test("the authenticated OpenAPI route reads Shared Plans through Drizzle", async () => {
  const database = new SQLiteD1Database(`
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
    CREATE TABLE shared_plans (
      id TEXT PRIMARY KEY,
      comiket_no INTEGER NOT NULL,
      name TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL REFERENCES users(id),
      archived_at INTEGER,
      revision INTEGER NOT NULL,
      notification_epoch INTEGER NOT NULL,
      last_mutation_scope TEXT,
      last_mutation_request_id TEXT,
      last_mutation_payload_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE shared_plan_members (
      plan_id TEXT NOT NULL REFERENCES shared_plans(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      role TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      revoked_at INTEGER,
      updated_at INTEGER NOT NULL,
      notification_epoch INTEGER NOT NULL,
      PRIMARY KEY (plan_id, user_id)
    );
    INSERT INTO users VALUES (
      1, '0123456789abcdef0123456789abcdef', 'Owner', 1, NULL,
      1700000000, 1700000000, 1700000000
    );
    INSERT INTO shared_plans VALUES (
      '00000000-0000-4000-8000-000000000001', 108, 'OpenAPI Plan', 1,
      NULL, 3, 1, NULL, NULL, NULL, 1700000000, 1700000100
    );
    INSERT INTO shared_plan_members VALUES (
      '00000000-0000-4000-8000-000000000001', 1, 'owner',
      1700000000, NULL, 1700000100, 1
    );
  `);
  const secret = "api-architecture-test-secret-at-least-32-bytes";
  const token = await issueCominaviJWT(
    {
      subject: "0123456789abcdef0123456789abcdef",
      userID: 1,
      authVersion: 1,
    },
    secret,
  );
  const app = createHomepageApp(() => new Response("astro"));
  const response = await app.fetch(
    new Request("https://cominavi.net/api/v2/plans?limit=10", {
      headers: { Authorization: `Bearer ${token.token}` },
    }),
    {
      COMINAVI_DB: database.binding,
      COMINAVI_JWT_SECRET: secret,
    } as Cloudflare.Env,
    executionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    items: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "OpenAPI Plan",
        comiketNo: 108,
        role: "owner",
        status: "active",
        revision: 3,
        createdAt: "2023-11-14T22:13:20.000Z",
        updatedAt: "2023-11-14T22:15:00.000Z",
      },
    ],
  });
});

test("the homepage API uses OpenAPI transport and never RPC transport", async () => {
  const sources = await Promise.all(
    ["src/api/app.ts", "src/api/openapi.ts", "src/api/shared-plans.ts"].map(
      (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8"),
    ),
  );
  const source = sources.join("\n");
  assert.match(source, /OpenAPIHandler/);
  assert.match(source, /OpenAPIGenerator/);
  assert.doesNotMatch(source, /RPCLink|RPCHandler/);
});
