import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { syncFavoritesToCirclems } from "../src/lib/server/circlems-favorite-sync";
import { storeCircleCredential } from "../src/lib/server/provider-credentials";
import { SQLiteD1Database } from "./sqlite-d1";

const identity = { subject: "a".repeat(32), userID: 1, authVersion: 1 };

test("manual Circle.ms sync adds and updates canonical favorites without deleting provider data", async () => {
  const database = setup();
  await seed(database);
  const requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
    body: URLSearchParams;
  }> = [];

  const result = await syncFavoritesToCirclems(
    bindings(database),
    identity,
    108,
    async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return providerResponse([
          favorite(10, 1, "keep provider memo"),
          favorite(30, 3, "already current"),
          favorite(99, 9, "provider owned"),
        ]);
      }
      requests.push({
        method,
        path: url.pathname,
        authorization: new Headers(init?.headers).get("Authorization"),
        body: new URLSearchParams(String(init?.body ?? "")),
      });
      return Response.json({ status: "success", response: {} });
    },
    100,
  );

  assert.deepEqual(result, {
    eventNumber: 108,
    revision: 4,
    favoriteCount: 3,
    addedCount: 1,
    updatedCount: 1,
    unchangedCount: 1,
    skippedMemoOnlyCount: 1,
  });
  assert.deepEqual(
    requests.map((request) => ({
      method: request.method,
      path: request.path,
      wcid: request.body.get("wcid"),
      color: request.body.get("color"),
      memo: request.body.get("memo"),
    })),
    [
      {
        method: "PUT",
        path: "/Readers/Favorite",
        wcid: "10",
        color: "2",
        memo: "keep provider memo",
      },
      {
        method: "POST",
        path: "/Readers/Favorite",
        wcid: "20",
        color: "4",
        memo: "",
      },
    ],
  );
  assert.ok(
    requests.every(
      (request) => request.authorization === "Bearer private-access",
    ),
  );
  assert.equal(
    requests.some((request) => request.method === "DELETE"),
    false,
  );
  assert.equal(
    requests.some((request) => request.body.get("wcid") === "99"),
    false,
  );
});

test("manual Circle.ms sync fails closed without a linked provider authority", async () => {
  const database = setup();
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${"a".repeat(32)}', 'Owner', 1, 1, 1, 1, 1);
  `);

  await assert.rejects(
    syncFavoritesToCirclems(bindings(database), identity, 108, async () =>
      providerResponse([]),
    ),
    (error: unknown) => hasCode(error, "circlems_favorite_sync_unavailable"),
  );
});

test("manual Circle.ms sync rejects malformed provider responses before writing", async () => {
  const database = setup();
  await seed(database);
  let writes = 0;

  await assert.rejects(
    syncFavoritesToCirclems(
      bindings(database),
      identity,
      108,
      async (_input, init) => {
        if ((init?.method ?? "GET") !== "GET") writes += 1;
        return Response.json({ status: "success", response: { list: [{}] } });
      },
      100,
    ),
    (error: unknown) => hasCode(error, "circlems_favorite_sync_failed"),
  );
  assert.equal(writes, 0);
});

function favorite(wcID: number, color: number, memo: string) {
  return {
    circle: { wcid: String(wcID) },
    favorite: { wcid: wcID, color, memo },
  };
}

function providerResponse(list: unknown[]): Response {
  return Response.json({ status: "success", response: { list } });
}

async function seed(database: SQLiteD1Database): Promise<void> {
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${"a".repeat(32)}', 'Owner', 1, 1, 1, 1, 1);
    INSERT INTO user_identities (
      id, user_id, provider, provider_environment, provider_subject,
      provider_user_id, created_at, updated_at, last_authenticated_at
    ) VALUES (7, 1, 'circlems', 'production', '77', 77, 1, 1, 10);
    INSERT INTO catalog_events (
      comiket_no, name, provider_circlems_event_id, created_at, updated_at
    ) VALUES (108, 'Comic Market 108', 190, 1, 1);
    INSERT INTO favorite_sets (
      user_id, comiket_no, revision, last_mutation_id,
      last_mutation_payload_hash, updated_at
    ) VALUES (
      1, 108, 4, '11111111-1111-4111-8111-111111111111',
      '${"b".repeat(64)}', 1
    );
    INSERT INTO user_favorites (
      user_id, comiket_no, wc_id, color, notifications_enabled,
      active, snapshot_revision, created_at, updated_at
    ) VALUES
      (1, 108, 10, 2, 1, 1, 4, 1, 1),
      (1, 108, 20, 4, 1, 1, 4, 1, 1),
      (1, 108, 30, 3, 1, 1, 4, 1, 1),
      (1, 108, 40, 0, 1, 1, 4, 1, 1);
  `);
  await storeCircleCredential(
    database.binding,
    1,
    7,
    {
      accessToken: "private-access",
      refreshToken: "private-refresh",
      accessExpiresAt: 10_000,
      scopes: ["favorite_read", "favorite_write"],
    },
    key(),
    1,
  );
}

function bindings(database: SQLiteD1Database) {
  return {
    COMINAVI_DB: database.binding,
    COMINAVI_PROVIDER_CREDENTIAL_KEY_V1: key(),
    COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN: "https://api.example",
    COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN: "https://sandbox-api.example",
    COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_ORIGIN: "https://auth.example",
    COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_ID: "client",
    COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_SECRET: "secret",
    COMINAVI_OAUTH_CIRCLEMS_SANDBOX_ORIGIN: "https://sandbox-auth.example",
    COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID: "sandbox-client",
    COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET: "sandbox-secret",
  };
}

function key(): string {
  let binary = "";
  for (let index = 0; index < 32; index += 1) {
    binary += String.fromCharCode(index);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function setup(): SQLiteD1Database {
  return new SQLiteD1Database(
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
}
