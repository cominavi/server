import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { createHomepageApp } from "../src/api/app";
import { rotateSession } from "../src/lib/server/auth-sessions";
import { verifyCominaviJWT } from "../src/lib/server/cominavi-auth";
import { ServiceError } from "../src/lib/server/service-error";
import {
  assertTestIdentityAllowed,
  authenticateTestIdentity,
  parseTestIdentityRequest,
  testIdentitySecretHeader,
  testIdentitySessionPath,
} from "../src/lib/server/test-identity-provider";
import { SQLiteD1Database } from "./sqlite-d1";

const jwtSecret = "test-jwt-secret-that-is-at-least-thirty-two-bytes";
const testSecret = "staging-test-identity-secret-at-least-32-chars";
const now = Date.UTC(2026, 10, 9, 3, 0, 0);

function migratedDatabase(): SQLiteD1Database {
  const schema = readdirSync("migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(`migrations/${name}`, "utf8"))
    .join("\n");
  return new SQLiteD1Database(schema);
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ServiceError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test("the runtime gate fails closed outside explicit non-production environments", async () => {
  for (const ENVIRONMENT of [
    undefined,
    "",
    "production",
    "Staging",
    "prod",
    "preview",
  ]) {
    await rejectsWith(
      assertTestIdentityAllowed(
        { ENVIRONMENT, COMINAVI_TEST_IDENTITY_SECRET: testSecret },
        testSecret,
      ),
      "not_found",
      404,
    );
  }
  for (const secret of [undefined, "", "short-secret"]) {
    await rejectsWith(
      assertTestIdentityAllowed(
        { ENVIRONMENT: "staging", COMINAVI_TEST_IDENTITY_SECRET: secret },
        secret,
      ),
      "not_found",
      404,
    );
  }
  for (const presented of [undefined, "", `${testSecret}x`, "wrong"]) {
    await rejectsWith(
      assertTestIdentityAllowed(
        { ENVIRONMENT: "staging", COMINAVI_TEST_IDENTITY_SECRET: testSecret },
        presented,
      ),
      "invalid_test_identity_secret",
      401,
    );
  }
  for (const ENVIRONMENT of ["staging", "development"]) {
    await assertTestIdentityAllowed(
      { ENVIRONMENT, COMINAVI_TEST_IDENTITY_SECRET: testSecret },
      testSecret,
    );
  }
});

test("labels and display names are validated strictly", () => {
  assert.deepEqual(parseTestIdentityRequest({ label: "agent-1" }), {
    label: "agent-1",
  });
  assert.deepEqual(
    parseTestIdentityRequest({ label: "a", displayName: "  Ann  " }),
    { label: "a", displayName: "Ann" },
  );
  for (const value of [
    null,
    [],
    {},
    { label: "" },
    { label: "-agent" },
    { label: "Agent" },
    { label: "agent_1" },
    { label: "a".repeat(65) },
    { label: "agent", displayName: "" },
    { label: "agent", displayName: "x".repeat(81) },
    { label: "agent", extra: true },
  ]) {
    assert.throws(
      () => parseTestIdentityRequest(value),
      (error: unknown) =>
        error instanceof ServiceError &&
        error.code === "invalid_test_identity_request",
    );
  }
});

test("a label maps to one stable user and mints a normal refresh family", async () => {
  const database = migratedDatabase();
  const first = await authenticateTestIdentity(
    database.binding,
    { label: "agent-1" },
    jwtSecret,
    now,
  );
  const again = await authenticateTestIdentity(
    database.binding,
    { label: "agent-1", displayName: "Ignored on existing accounts" },
    jwtSecret,
    now + 1_000,
  );
  const other = await authenticateTestIdentity(
    database.binding,
    { label: "agent-2", displayName: "Second agent" },
    jwtSecret,
    now,
  );

  assert.equal(first.user.id, again.user.id);
  assert.notEqual(first.user.id, other.user.id);
  assert.equal(first.user.displayName, "Test agent-1");
  assert.equal(other.user.displayName, "Second agent");
  assert.deepEqual(first.user.identities, []);
  assert.equal(first.tokenType, "Bearer");
  assert.equal(first.authVersion, 1);
  assert.notEqual(first.refreshToken, again.refreshToken);

  const families = database.native
    .prepare(
      "SELECT COUNT(DISTINCT family_id) AS families FROM auth_refresh_tokens",
    )
    .get() as { families: number };
  assert.equal(families.families, 3);
  const userIdentityRows = database.native
    .prepare("SELECT COUNT(*) AS count FROM user_identities")
    .get() as { count: number };
  assert.equal(userIdentityRows.count, 0, "no production provider row");

  const token = await verifyCominaviJWT(first.accessToken, jwtSecret, now);
  assert.equal(token.subject, first.user.id);
  const rotated = await rotateSession(
    database.binding,
    first.refreshToken,
    jwtSecret,
    now + 2_000,
  );
  assert.equal(rotated.user.id, first.user.id);
});

test("the logout fence and deletion fence win over a test login", async () => {
  const database = migratedDatabase();
  const session = await authenticateTestIdentity(
    database.binding,
    { label: "fenced" },
    jwtSecret,
    now,
  );
  const fencedAt = Math.floor(now / 1_000) + 10;
  database.native
    .prepare(
      `UPDATE users SET auth_version = auth_version + 1,
         last_auth_fenced_at = ? WHERE public_id = ?`,
    )
    .run(fencedAt, session.user.id);

  await rejectsWith(
    authenticateTestIdentity(
      database.binding,
      { label: "fenced" },
      jwtSecret,
      fencedAt * 1_000,
    ),
    "test_identity_fenced",
    409,
  );
  const after = await authenticateTestIdentity(
    database.binding,
    { label: "fenced" },
    jwtSecret,
    (fencedAt + 1) * 1_000,
  );
  assert.equal(after.user.id, session.user.id);
  assert.equal(after.authVersion, 2);

  database.native
    .prepare("UPDATE users SET deletion_pending_at = ? WHERE public_id = ?")
    .run(fencedAt + 2, session.user.id);
  await rejectsWith(
    authenticateTestIdentity(
      database.binding,
      { label: "fenced" },
      jwtSecret,
      (fencedAt + 3) * 1_000,
    ),
    "account_unavailable",
    409,
  );
});

test("deleting the user removes the label, so it later names a new account", async () => {
  const database = migratedDatabase();
  const first = await authenticateTestIdentity(
    database.binding,
    { label: "reused" },
    jwtSecret,
    now,
  );
  database.native
    .prepare("DELETE FROM users WHERE public_id = ?")
    .run(first.user.id);
  const second = await authenticateTestIdentity(
    database.binding,
    { label: "reused" },
    jwtSecret,
    now + 1_000,
  );
  assert.notEqual(second.user.id, first.user.id);
});

test("the HTTP route exists only in builds compiled with the flag", async () => {
  const database = migratedDatabase();
  const env = (ENVIRONMENT: string) =>
    ({
      ENVIRONMENT,
      COMINAVI_TEST_IDENTITY_SECRET: testSecret,
      COMINAVI_DB: database.binding,
      COMINAVI_JWT_SECRET: jwtSecret,
    }) as unknown as Cloudflare.Env;
  const request = () =>
    new Request(`https://staging.cominavi.net${testIdentitySessionPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [testIdentitySecretHeader]: testSecret,
      },
      body: JSON.stringify({ label: "http-agent" }),
    });
  const context = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const globals = globalThis as {
    __COMINAVI_TEST_IDENTITY_PROVIDER__?: boolean;
  };

  // Production-shaped build: the route is not registered at all.
  delete globals.__COMINAVI_TEST_IDENTITY_PROVIDER__;
  const production = createHomepageApp(
    () => new Response("astro", { status: 404 }),
  );
  const absent = await production.fetch(request(), env("staging"), context);
  assert.equal(absent.status, 404);
  const absentBody = await absent.text();

  globals.__COMINAVI_TEST_IDENTITY_PROVIDER__ = true;
  try {
    const staging = createHomepageApp(
      () => new Response("astro", { status: 404 }),
    );
    const refused = await staging.fetch(request(), env("production"), context);
    assert.equal(refused.status, 404);
    assert.equal(await refused.text(), absentBody, "indistinguishable");
    assert.equal(refused.headers.get("Cache-Control"), "private, no-store");

    const response = await staging.fetch(request(), env("staging"), context);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    const body = (await response.json()) as {
      tokenType: string;
      refreshToken: string;
      user: { displayName: string; avatarURL?: string };
    };
    assert.equal(body.tokenType, "Bearer");
    assert.equal(body.user.displayName, "Test http-agent");
    assert.equal("avatarURL" in body.user, false);
  } finally {
    delete globals.__COMINAVI_TEST_IDENTITY_PROVIDER__;
  }
});
