import assert from "node:assert/strict";
import test from "node:test";
import { createHomepageApp } from "../src/api/app";
import { generateOpenAPIDocument } from "../src/api/openapi";
import { issueCominaviJWT } from "../src/lib/server/cominavi-auth";
import { SQLiteD1Database } from "./sqlite-d1";

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
  exports: {},
  tracing: {},
} as unknown as ExecutionContext;

const protectedOperations = [
  ["get", "/api/v2/plans", "listSharedPlans"],
  ["post", "/api/v2/plans", "createSharedPlan"],
  ["get", "/api/v2/plans/{planID}", "getSharedPlan"],
  ["patch", "/api/v2/plans/{planID}", "updateSharedPlan"],
  ["delete", "/api/v2/plans/{planID}", "archiveSharedPlan"],
  ["get", "/api/v2/plans/{planID}/sync", "getSharedPlanSyncSnapshot"],
  ["get", "/api/v2/plans/{planID}/members", "listSharedPlanMembers"],
  [
    "delete",
    "/api/v2/plans/{planID}/members/{userID}",
    "revokeSharedPlanMember",
  ],
  [
    "post",
    "/api/v2/plans/{planID}/members/{userID}/reinstate",
    "reinstateSharedPlanMember",
  ],
  [
    "post",
    "/api/v2/plans/{planID}/transfer-ownership",
    "transferSharedPlanOwnership",
  ],
  ["get", "/api/v2/plans/{planID}/invitations", "listSharedPlanInvitations"],
  ["post", "/api/v2/plans/{planID}/invitations", "createSharedPlanInvitation"],
  [
    "delete",
    "/api/v2/plans/{planID}/invitations/{invitationID}",
    "revokeSharedPlanInvitation",
  ],
] as const;

test("OpenAPI exposes the complete Shared Plan HTTP control plane", async () => {
  const document = await generateOpenAPIDocument();
  const operationIDs = new Set<string>();

  for (const [method, path, expectedOperationID] of protectedOperations) {
    const operation = document.paths?.[path]?.[method];
    assert.equal(operation?.operationId, expectedOperationID);
    assert.deepEqual(operation?.security, [{ bearerAuth: [] }]);
    assert.ok(!operationIDs.has(expectedOperationID));
    operationIDs.add(expectedOperationID);
  }

  const preview = document.paths?.["/api/v2/invitations/{token}"]?.get;
  assert.equal(preview?.operationId, "previewSharedPlanInvitation");
  assert.deepEqual(preview?.security, []);

  const accept = document.paths?.["/api/v2/invitations/{token}/accept"]?.post;
  assert.equal(accept?.operationId, "acceptSharedPlanInvitation");
  assert.deepEqual(accept?.security, [{ bearerAuth: [] }]);

  assert.equal(
    document.paths?.["/api/v2/plans"]?.post?.responses?.["201"]?.description,
    "OK",
  );
  assert.equal(
    document.paths?.["/api/v2/plans/{planID}/invitations"]?.post?.responses?.[
      "201"
    ]?.description,
    "OK",
  );
});

test("Shared Plan generated outputs use omitted optionals rather than null", async () => {
  const document = await generateOpenAPIDocument();
  const planPaths = Object.fromEntries(
    Object.entries(document.paths ?? {}).filter(([path]) =>
      /\/api\/v2\/(plans|invitations)/.test(path),
    ),
  );
  const encoded = JSON.stringify(planPaths);
  assert.doesNotMatch(encoded, /"nullable":true/);
  assert.doesNotMatch(encoded, /"type":\[[^\]]*"null"/);
});

test("public invitation preview is rate limited without requiring bearer auth", async () => {
  const app = createHomepageApp(() => new Response("astro"));
  const response = await app.fetch(
    new Request("https://cominavi.net/api/v2/invitations/AQEBAQEBAQEB"),
    {
      COMINAVI_INVITE_RATE_LIMITER: {
        limit: async () => ({ success: false }),
      },
    } as unknown as Cloudflare.Env,
    executionContext,
  );

  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    error: "rate_limited",
    message: "Too many invitation attempts.",
  });
});

test("invitation acceptance requires a ComiNavi bearer session", async () => {
  const app = createHomepageApp(() => new Response("astro"));
  const response = await app.fetch(
    new Request("https://cominavi.net/api/v2/invitations/AQEBAQEBAQEB/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    }),
    {} as Cloudflare.Env,
    executionContext,
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: "missing_bearer_token",
    message: "A bearer token is required.",
  });
});

test("HTTP sync bootstrap checks membership and forwards bound authority", async () => {
  const planID = "00000000-0000-4000-8000-000000000001";
  const publicUserID = "0123456789abcdef0123456789abcdef";
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
      1, '${publicUserID}', 'Owner', 3, NULL,
      1700000000, 1700000000, 1700000000
    );
    INSERT INTO shared_plans VALUES (
      '${planID}', 108, 'Sync Plan', 1,
      NULL, 7, 1, NULL, NULL, NULL, 1700000000, 1700000100
    );
    INSERT INTO shared_plan_members VALUES (
      '${planID}', 1, 'owner', 1700000000, NULL, 1700000100, 1
    );
  `);
  const secret = "api-shared-plan-test-secret-at-least-32-bytes";
  const token = await issueCominaviJWT(
    { subject: publicUserID, userID: 1, authVersion: 3 },
    secret,
  );
  let internalRequest: Request | undefined;
  const planSyncNamespace = {
    idFromName(value: string) {
      assert.equal(value, planID);
      return value;
    },
    get() {
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          internalRequest = new Request(input, init);
          return Response.json({
            v: 1,
            document: "AQID",
            heads: ["a".repeat(64)],
          });
        },
      };
    },
  };
  const app = createHomepageApp(() => new Response("astro"));
  const response = await app.fetch(
    new Request(`https://cominavi.net/api/v2/plans/${planID}/sync`, {
      headers: { Authorization: `Bearer ${token.token}` },
    }),
    {
      COMINAVI_DB: database.binding,
      COMINAVI_JWT_SECRET: secret,
      COMINAVI_PLAN_SYNC: planSyncNamespace,
    } as unknown as Cloudflare.Env,
    executionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    v: 1,
    document: "AQID",
    heads: ["a".repeat(64)],
  });
  assert.equal(internalRequest?.method, "GET");
  assert.equal(internalRequest?.headers.get("X-ComiNavi-User-ID"), "1");
  assert.equal(
    internalRequest?.headers.get("X-ComiNavi-User-Public-ID"),
    publicUserID,
  );
  assert.equal(internalRequest?.headers.get("X-ComiNavi-Auth-Version"), "3");
  assert.equal(internalRequest?.headers.get("X-ComiNavi-Plan-ID"), planID);
  assert.equal(internalRequest?.headers.get("X-ComiNavi-Comiket-No"), "108");
  assert.equal(internalRequest?.headers.get("Upgrade"), null);
});

test("WebSocket sync upgrade checks membership and forwards bound authority", async () => {
  const planID = "00000000-0000-4000-8000-000000000001";
  const publicUserID = "0123456789abcdef0123456789abcdef";
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
      1, '${publicUserID}', 'Owner', 3, NULL,
      1700000000, 1700000000, 1700000000
    );
    INSERT INTO shared_plans VALUES (
      '${planID}', 108, 'Sync Plan', 1,
      NULL, 7, 1, NULL, NULL, NULL, 1700000000, 1700000100
    );
    INSERT INTO shared_plan_members VALUES (
      '${planID}', 1, 'owner', 1700000000, NULL, 1700000100, 1
    );
  `);
  const secret = "api-shared-plan-test-secret-at-least-32-bytes";
  const token = await issueCominaviJWT(
    { subject: publicUserID, userID: 1, authVersion: 3 },
    secret,
  );
  let internalRequest: Request | undefined;
  const planSyncNamespace = {
    idFromName(value: string) {
      assert.equal(value, planID);
      return value;
    },
    get() {
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          internalRequest = new Request(input, init);
          return Response.json({ connected: true });
        },
      };
    },
  };
  const app = createHomepageApp(() => new Response("astro"));
  const response = await app.fetch(
    new Request(`https://cominavi.net/api/v2/plans/${planID}/sync`, {
      headers: {
        Authorization: `Bearer ${token.token}`,
        Upgrade: "websocket",
      },
    }),
    {
      COMINAVI_DB: database.binding,
      COMINAVI_JWT_SECRET: secret,
      COMINAVI_PLAN_SYNC: planSyncNamespace,
    } as unknown as Cloudflare.Env,
    executionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { connected: true });
  assert.equal(internalRequest?.url, "https://plan-sync.internal/connect");
  assert.equal(internalRequest?.method, "GET");
  assert.equal(internalRequest?.headers.get("Upgrade"), "websocket");
  assert.equal(internalRequest?.headers.get("X-ComiNavi-User-ID"), "1");
  assert.equal(
    internalRequest?.headers.get("X-ComiNavi-User-Public-ID"),
    publicUserID,
  );
  assert.equal(internalRequest?.headers.get("X-ComiNavi-Auth-Version"), "3");
  assert.equal(internalRequest?.headers.get("X-ComiNavi-Plan-ID"), planID);
  assert.equal(internalRequest?.headers.get("X-ComiNavi-Comiket-No"), "108");
});
