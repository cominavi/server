import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadCirclemsFavoriteImportPage } from "../src/lib/server/circlems-favorite-import";
import { storeCircleCredential } from "../src/lib/server/provider-credentials";
import { SQLiteD1Database } from "./sqlite-d1";

const identity = { subject: "a".repeat(32), userID: 1, authVersion: 1 };

test("projects linked Circle.ms favorites without exposing provider authority", async () => {
  const database = setup();
  await seed(database, 10_000);
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  const page = await loadCirclemsFavoriteImportPage(
    bindings(database),
    identity,
    108,
    null,
    async (input, init) => {
      requests.push({
        url: new URL(String(input)),
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return providerResponse([
        favorite(20, 200, 2, "Circle B", "memo B"),
        favorite(10, 100, 1, "Circle A", "memo A"),
        favorite(10, 100, 1, "Circle A", "memo A"),
      ]);
    },
    100,
  );

  assert.deepEqual(page, {
    eventNumber: 108,
    items: [
      {
        wcID: 10,
        updateID: 100,
        circleName: "Circle A",
        color: 1,
        memo: "memo A",
      },
      {
        wcID: 20,
        updateID: 200,
        circleName: "Circle B",
        color: 2,
        memo: "memo B",
      },
    ],
    nextCursor: null,
  });
  assert.equal(requests[0]?.url.pathname, "/Readers/FavoriteCircles");
  assert.equal(requests[0]?.url.searchParams.get("event_id"), "190");
  assert.equal(requests[0]?.url.searchParams.get("page"), "1");
  assert.equal(requests[0]?.authorization, "Bearer private-access");
  assert.equal(JSON.stringify(page).includes("private-access"), false);
});

test("cursor binds pagination to the event and refreshes an expiring credential", async () => {
  const database = setup();
  await seed(database, 120);
  const favoriteRequests: URL[] = [];
  const first = await loadCirclemsFavoriteImportPage(
    bindings(database),
    identity,
    108,
    null,
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/OAuth2/Token") {
        return Response.json({
          access_token: "fresh-access",
          expires_in: 3_600,
        });
      }
      favoriteRequests.push(url);
      return providerResponse(
        Array.from({ length: 1_000 }, (_, index) =>
          favorite(index + 1, index + 1_000, index % 10, `Circle ${index}`, ""),
        ),
      );
    },
    100,
  );
  assert.ok(first.nextCursor);

  await loadCirclemsFavoriteImportPage(
    bindings(database),
    identity,
    108,
    first.nextCursor,
    async (input) => {
      favoriteRequests.push(new URL(String(input)));
      return providerResponse([]);
    },
    101,
  );
  assert.equal(favoriteRequests.at(-1)?.searchParams.get("page"), "2");

  await assert.rejects(
    loadCirclemsFavoriteImportPage(
      bindings(database),
      identity,
      109,
      first.nextCursor,
      async () => providerResponse([]),
      101,
    ),
    (error: unknown) => hasCode(error, "invalid_circlems_favorite_import"),
  );
});

test("fails closed for unlinked users and malformed provider favorites", async () => {
  const database = setup();
  await assert.rejects(
    loadCirclemsFavoriteImportPage(
      bindings(database),
      identity,
      108,
      null,
      async () => providerResponse([]),
    ),
    (error: unknown) => hasCode(error, "circlems_favorite_import_unavailable"),
  );

  await seed(database, 10_000);
  await assert.rejects(
    loadCirclemsFavoriteImportPage(
      bindings(database),
      identity,
      108,
      null,
      async () => providerResponse([favorite(10, 100, 99, "Circle", "")]),
      100,
    ),
    (error: unknown) => hasCode(error, "circlems_favorite_import_failed"),
  );
});

function favorite(
  wcID: number,
  updateID: number,
  color: number,
  circleName: string,
  memo: string,
) {
  return {
    circle: { wcid: String(wcID), updateId: String(updateID) },
    favorite: { wcid: wcID, circle_name: circleName, color, memo },
  };
}

function providerResponse(list: unknown[]): Response {
  return Response.json({ status: "success", response: { list } });
}

async function seed(
  database: SQLiteD1Database,
  expiresAt: number,
): Promise<void> {
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
  `);
  await storeCircleCredential(
    database.binding,
    1,
    7,
    {
      accessToken: "private-access",
      refreshToken: "private-refresh",
      accessExpiresAt: expiresAt,
      scopes: ["favorite_read"],
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
