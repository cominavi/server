import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateOpenAPIDocument } from "../src/api/openapi";
import { logoutSession, rotateSession } from "../src/lib/server/auth-sessions";
import {
  authenticateAppleRequest,
  loadAppleRefreshCredential,
  processAppleRevocations,
} from "../src/lib/server/apple-auth-flow";
import { issueAppleEntryGrant } from "../src/lib/server/apple-entry-grants";
import { SQLiteD1Database } from "./sqlite-d1";

const secret = "test-jwt-secret-that-is-at-least-thirty-two-bytes";
const requestID = "77777777-7777-4777-8777-777777777777";
const nonce = "n".repeat(43);
const apple = {
  provider: "apple" as const,
  environment: "" as const,
  subject: "apple.subject.42",
  clientID: "llc.mikunet.cominavi",
  email: "private@privaterelay.appleid.com",
};

test("Apple grant, code exchange, identity, credential, and one session commit atomically", async () => {
  const database = setup();
  const grant = await issueAppleEntryGrant(database.binding, nonce, 100_000);
  let verifications = 0;
  let exchanges = 0;
  const first = await authenticateAppleRequest(
    database.binding,
    {
      requestID,
      identityToken: "verified-apple-identity-token",
      authorizationCode: "single-use-authorization-code",
      entryGrant: grant.entryGrant,
      nonce,
      displayName: "Private Apple User",
    },
    secret,
    credentialKey(),
    async () => {
      verifications += 1;
      return apple;
    },
    async () => {
      exchanges += 1;
      return { refreshToken: "apple-refresh-secret", clientID: apple.clientID };
    },
    101_000,
    () => 101,
  );
  assert.equal(first.response.user.displayName, "Private Apple User");
  assert.deepEqual(first.response.user.identities, [
    { provider: "apple", email: apple.email },
  ]);
  assert.equal(verifications, 1);
  assert.equal(exchanges, 1);
  for (const table of [
    "users",
    "user_identities",
    "apple_provider_credentials",
    "auth_refresh_tokens",
    "apple_auth_receipts",
    "apple_auth_atomic_assertions",
  ]) {
    assert.equal(
      database.rows(`SELECT count(*) AS count FROM ${table}`)[0]?.count,
      1,
      table,
    );
  }
  const identity = database.rows(
    `SELECT identity.id, user.public_id
     FROM user_identities AS identity
     JOIN users AS user ON user.id = identity.user_id`,
  )[0]!;
  assert.deepEqual(
    await loadAppleRefreshCredential(
      database.binding,
      Number(identity.id),
      String(identity.public_id),
      apple.subject,
      credentialKey(),
    ),
    { refreshToken: "apple-refresh-secret", clientID: apple.clientID },
  );

  const replay = await authenticateAppleRequest(
    database.binding,
    {
      requestID,
      identityToken: "verified-apple-identity-token",
      authorizationCode: "single-use-authorization-code",
      entryGrant: grant.entryGrant,
      nonce,
      displayName: "Private Apple User",
    },
    secret,
    credentialKey(),
    async () => {
      throw new Error("expired Apple token must not gate exact receipt replay");
    },
    async () => {
      throw new Error("single-use code must not be exchanged twice");
    },
    500_000,
    () => 500,
  );
  assert.deepEqual(replay.response, first.response);
  assert.equal(verifications, 1);
  assert.equal(exchanges, 1);
  await assert.rejects(
    authenticateAppleRequest(
      database.binding,
      {
        requestID,
        identityToken: "changed-token",
        authorizationCode: "single-use-authorization-code",
        entryGrant: grant.entryGrant,
        nonce,
      },
      secret,
      credentialKey(),
      async () => apple,
      async () => ({
        refreshToken: "must-not-replace",
        clientID: apple.clientID,
      }),
      501_000,
      () => 501,
    ),
    (error: unknown) => hasCode(error, "idempotency_conflict"),
  );
  await rotateSession(
    database.binding,
    first.response.refreshToken,
    secret,
    502_000,
  );
  await assert.rejects(
    authenticateAppleRequest(
      database.binding,
      {
        requestID,
        identityToken: "verified-apple-identity-token",
        authorizationCode: "single-use-authorization-code",
        entryGrant: grant.entryGrant,
        nonce,
        displayName: "Private Apple User",
      },
      secret,
      credentialKey(),
      async () => apple,
      async () => ({
        refreshToken: "must-not-replace",
        clientID: apple.clientID,
      }),
      503_000,
      () => 503,
    ),
    (error: unknown) => hasCode(error, "invalid_entry_grant"),
  );
});

test("a durably claimed Apple code can finish after the entry-grant TTL", async () => {
  const expired = setup();
  const grant = await issueAppleEntryGrant(expired.binding, nonce, 100_000);
  const times = [101, 401];
  const completed = await authenticateAppleRequest(
    expired.binding,
    {
      requestID,
      identityToken: "verified-apple-identity-token",
      authorizationCode: "single-use-authorization-code",
      entryGrant: grant.entryGrant,
      nonce,
    },
    secret,
    credentialKey(),
    async () => apple,
    async () => ({ refreshToken: "refresh", clientID: apple.clientID }),
    101_000,
    () => times.shift() ?? 401,
  );
  assert.equal(completed.response.user.displayName, "Apple User");
  assert.equal(
    expired.rows("SELECT state FROM apple_auth_requests")[0]?.state,
    "completed",
  );
  for (const table of [
    "users",
    "user_identities",
    "apple_provider_credentials",
    "auth_refresh_tokens",
    "apple_auth_receipts",
  ]) {
    assert.equal(
      expired.rows(`SELECT count(*) AS count FROM ${table}`)[0]?.count,
      1,
      table,
    );
  }
  assert.equal(
    expired.rows("SELECT consumed_at FROM google_entry_grants")[0]?.consumed_at,
    101,
  );
  assert.equal(
    expired.rows("SELECT stage_ciphertext FROM apple_auth_requests")[0]
      ?.stage_ciphertext,
    null,
  );
});

test("Apple proof must be issued after the latest logout fence", async () => {
  const database = setup();
  const initialGrant = await issueAppleEntryGrant(
    database.binding,
    nonce,
    100_000,
  );
  const initial = await authenticateAppleRequest(
    database.binding,
    {
      requestID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      identityToken: "initial-apple-proof",
      authorizationCode: "initial-apple-code",
      entryGrant: initialGrant.entryGrant,
      nonce,
    },
    secret,
    credentialKey(),
    async () => ({ ...apple, issuedAt: 100 }),
    async () => ({ refreshToken: "initial-refresh", clientID: apple.clientID }),
    101_000,
    () => 101,
  );
  await logoutSession(
    database.binding,
    { subject: initial.identity.subject, authVersion: 1 },
    {
      requestID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      refreshToken: initial.response.refreshToken,
    },
    credentialKey(),
    true,
    200_000,
  );

  const oldGrant = await issueAppleEntryGrant(
    database.binding,
    "o".repeat(43),
    201_000,
  );
  let oldExchanges = 0;
  await assert.rejects(
    authenticateAppleRequest(
      database.binding,
      {
        requestID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        identityToken: "pre-logout-apple-proof",
        authorizationCode: "pre-logout-apple-code",
        entryGrant: oldGrant.entryGrant,
        nonce: "o".repeat(43),
      },
      secret,
      credentialKey(),
      async () => ({ ...apple, issuedAt: 199 }),
      async () => {
        oldExchanges += 1;
        return { refreshToken: "must-not-stage", clientID: apple.clientID };
      },
      202_000,
      () => 202,
    ),
    (error: unknown) => hasCode(error, "invalid_entry_grant"),
  );
  assert.equal(oldExchanges, 0);

  const freshGrant = await issueAppleEntryGrant(
    database.binding,
    "f".repeat(43),
    203_000,
  );
  const fresh = await authenticateAppleRequest(
    database.binding,
    {
      requestID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      identityToken: "post-logout-apple-proof",
      authorizationCode: "post-logout-apple-code",
      entryGrant: freshGrant.entryGrant,
      nonce: "f".repeat(43),
    },
    secret,
    credentialKey(),
    async () => ({ ...apple, issuedAt: 201 }),
    async () => ({ refreshToken: "fresh-refresh", clientID: apple.clientID }),
    204_000,
    () => 204,
  );
  assert.equal(fresh.response.authVersion, 2);
});

test("concurrent Apple credential creation is CAS-safe and exact staged retry revokes the displaced token", async () => {
  const database = setup();
  const initialGrant = await issueAppleEntryGrant(
    database.binding,
    nonce,
    100_000,
  );
  await authenticateAppleRequest(
    database.binding,
    {
      requestID: "10000000-0000-4000-8000-000000000001",
      identityToken: "initial-token",
      authorizationCode: "initial-code",
      entryGrant: initialGrant.entryGrant,
      nonce,
    },
    secret,
    credentialKey(),
    async () => apple,
    async () => ({ refreshToken: "initial-refresh", clientID: apple.clientID }),
    101_000,
    () => 101,
  );
  database.native.exec("DELETE FROM apple_provider_credentials");

  const nonceA = "a".repeat(43);
  const nonceB = "b".repeat(43);
  const [grantA, grantB] = await Promise.all([
    issueAppleEntryGrant(database.binding, nonceA, 110_000),
    issueAppleEntryGrant(database.binding, nonceB, 110_000),
  ]);
  let releaseB!: () => void;
  let reachedB!: () => void;
  const bReached = new Promise<void>((resolve) => {
    reachedB = resolve;
  });
  const bRelease = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  const requestB = {
    requestID: "20000000-0000-4000-8000-000000000002",
    identityToken: "token-b",
    authorizationCode: "code-b",
    entryGrant: grantB.entryGrant,
    nonce: nonceB,
  };
  const pendingB = authenticateAppleRequest(
    database.binding,
    requestB,
    secret,
    credentialKey(),
    async () => apple,
    async () => ({ refreshToken: "refresh-b", clientID: apple.clientID }),
    111_000,
    () => 111,
    {
      beforeFinalBatch: async () => {
        reachedB();
        await bRelease;
      },
    },
  );
  await bReached;
  await authenticateAppleRequest(
    database.binding,
    {
      requestID: "30000000-0000-4000-8000-000000000003",
      identityToken: "token-a",
      authorizationCode: "code-a",
      entryGrant: grantA.entryGrant,
      nonce: nonceA,
    },
    secret,
    credentialKey(),
    async () => apple,
    async () => ({ refreshToken: "refresh-a", clientID: apple.clientID }),
    112_000,
    () => 112,
  );
  releaseB();
  await assert.rejects(pendingB);
  assert.equal(
    database.rows(
      "SELECT state FROM apple_auth_requests WHERE request_id = '20000000-0000-4000-8000-000000000002'",
    )[0]?.state,
    "staged",
  );

  await authenticateAppleRequest(
    database.binding,
    requestB,
    secret,
    credentialKey(),
    async () => {
      throw new Error("staged retry must not reverify");
    },
    async () => {
      throw new Error("staged retry must not re-exchange");
    },
    113_000,
    () => 113,
  );
  const identity = database.rows(
    `SELECT identity.id, user.public_id
     FROM user_identities AS identity
     JOIN users AS user ON user.id = identity.user_id
     WHERE identity.provider = 'apple'`,
  )[0]!;
  assert.deepEqual(
    await loadAppleRefreshCredential(
      database.binding,
      Number(identity.id),
      String(identity.public_id),
      apple.subject,
      credentialKey(),
    ),
    { refreshToken: "refresh-b", clientID: apple.clientID },
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM apple_provider_revocations")[0]
      ?.count,
    1,
  );
  const revoked: string[] = [];
  await processAppleRevocations(
    database.binding,
    appleBindings(),
    credentialKey(),
    fetch,
    114_000,
    async (token) => {
      revoked.push(token);
    },
  );
  assert.deepEqual(revoked, ["refresh-a"]);
});

test("Apple reauth never revokes an identical retained refresh token", async () => {
  const database = setup();
  const firstNonce = "c".repeat(43);
  const firstGrant = await issueAppleEntryGrant(
    database.binding,
    firstNonce,
    100_000,
  );
  await authenticateAppleRequest(
    database.binding,
    {
      requestID: "40000000-0000-4000-8000-000000000004",
      identityToken: "first-token",
      authorizationCode: "first-code",
      entryGrant: firstGrant.entryGrant,
      nonce: firstNonce,
    },
    secret,
    credentialKey(),
    async () => apple,
    async () => ({ refreshToken: "same-refresh", clientID: apple.clientID }),
    101_000,
    () => 101,
  );
  const secondNonce = "d".repeat(43);
  const secondGrant = await issueAppleEntryGrant(
    database.binding,
    secondNonce,
    102_000,
  );
  await authenticateAppleRequest(
    database.binding,
    {
      requestID: "50000000-0000-4000-8000-000000000005",
      identityToken: "second-token",
      authorizationCode: "second-code",
      entryGrant: secondGrant.entryGrant,
      nonce: secondNonce,
    },
    secret,
    credentialKey(),
    async () => apple,
    async () => ({ refreshToken: "same-refresh", clientID: apple.clientID }),
    103_000,
    () => 103,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM apple_provider_revocations")[0]
      ?.count,
    0,
  );
  assert.equal(
    database.rows(
      "SELECT credential_revision FROM apple_provider_credentials",
    )[0]?.credential_revision,
    2,
  );
});

test("abandoned staged Apple authority is retried and erased only after revocation", async () => {
  const database = setup();
  const initialGrant = await issueAppleEntryGrant(
    database.binding,
    nonce,
    100_000,
  );
  const initial = await authenticateAppleRequest(
    database.binding,
    {
      requestID: "60000000-0000-4000-8000-000000000006",
      identityToken: "initial-token",
      authorizationCode: "initial-code",
      entryGrant: initialGrant.entryGrant,
      nonce,
    },
    secret,
    credentialKey(),
    async () => apple,
    async () => ({ refreshToken: "current-refresh", clientID: apple.clientID }),
    101_000,
    () => 101,
  );
  const stagedNonce = "e".repeat(43);
  const stagedGrant = await issueAppleEntryGrant(
    database.binding,
    stagedNonce,
    110_000,
  );
  await assert.rejects(
    authenticateAppleRequest(
      database.binding,
      {
        requestID: "70000000-0000-4000-8000-000000000007",
        identityToken: "staged-token",
        authorizationCode: "staged-code",
        entryGrant: stagedGrant.entryGrant,
        nonce: stagedNonce,
      },
      secret,
      credentialKey(),
      async () => ({ ...apple, issuedAt: 110 }),
      async () => ({
        refreshToken: "abandoned-refresh",
        clientID: apple.clientID,
      }),
      111_000,
      () => 111,
      {
        beforeFinalBatch: async () => {
          await logoutSession(
            database.binding,
            { subject: initial.identity.subject, authVersion: 1 },
            {
              requestID: "80000000-0000-4000-8000-000000000008",
              refreshToken: initial.response.refreshToken,
            },
            credentialKey(),
            true,
            112_000,
          );
        },
      },
    ),
  );
  const staged = database.rows(
    `SELECT state, stage_ciphertext, cleanup_available_at
     FROM apple_auth_requests
     WHERE request_id = '70000000-0000-4000-8000-000000000007'`,
  )[0]!;
  assert.equal(staged.state, "staged");
  assert.ok(staged.stage_ciphertext);

  let attempts = 0;
  await processAppleRevocations(
    database.binding,
    appleBindings(),
    credentialKey(),
    fetch,
    Number(staged.cleanup_available_at) * 1_000,
    async () => {
      attempts += 1;
      throw new Error("temporary Apple outage");
    },
  );
  const retry = database.rows(
    `SELECT stage_ciphertext, cleanup_attempt_count, cleanup_available_at
     FROM apple_auth_requests
     WHERE request_id = '70000000-0000-4000-8000-000000000007'`,
  )[0]!;
  assert.ok(retry.stage_ciphertext);
  assert.equal(retry.cleanup_attempt_count, 1);

  const revoked: string[] = [];
  await processAppleRevocations(
    database.binding,
    appleBindings(),
    credentialKey(),
    fetch,
    (Number(retry.cleanup_available_at) + 1) * 1_000,
    async (token) => {
      attempts += 1;
      revoked.push(token);
    },
  );
  assert.equal(attempts, 2);
  assert.deepEqual(revoked, ["abandoned-refresh"]);
  assert.equal(
    database.rows(
      "SELECT count(*) AS count FROM apple_auth_requests WHERE request_id = '70000000-0000-4000-8000-000000000007'",
    )[0]?.count,
    0,
  );
});

test("Apple operations remain special-entry only and AASA includes the deliberate path", async () => {
  const document = await generateOpenAPIDocument();
  const entryGrant = document.paths?.["/api/v2/auth/apple/entry-grant"]?.post;
  const authentication = document.paths?.["/api/v2/auth/apple"]?.post;
  assert.equal(entryGrant?.operationId, "issueAppleAuthenticationEntryGrant");
  assert.deepEqual(entryGrant?.security, []);
  assert.equal(authentication?.operationId, "authenticateWithApple");
  assert.deepEqual(authentication?.security, []);
  assert.ok(authentication?.requestBody);
  const association = readFileSync(
    "src/pages/.well-known/apple-app-site-association.ts",
    "utf8",
  );
  assert.ok(association.includes('"/auth/apple"'));
  assert.ok(
    readFileSync("src/pages/auth/apple.ts", "utf8").includes("no-store"),
  );
});

function credentialKey(): string {
  return Buffer.from(
    Uint8Array.from({ length: 32 }, (_, index) => index),
  ).toString("base64url");
}

function appleBindings() {
  return {
    COMINAVI_APPLE_CLIENT_IDS: apple.clientID,
    COMINAVI_APPLE_TEAM_ID: "TEAM",
    COMINAVI_APPLE_KEY_ID: "KEY",
    COMINAVI_APPLE_PRIVATE_KEY_P8_BASE64URL: "unused-by-injected-revoker",
  };
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
