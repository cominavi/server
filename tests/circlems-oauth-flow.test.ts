import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { logoutSession, rotateSession } from "../src/lib/server/auth-sessions";
import {
  completeCirclemsAuthentication,
  completeCirclemsLink,
  finishCirclemsOAuthCallback,
  processExpiredCirclemsOAuth,
  startCirclemsOAuth,
  type CirclemsOAuthFlowBindings,
} from "../src/lib/server/circlems-oauth-flow";
import { storeCircleCredential } from "../src/lib/server/provider-credentials";
import { SQLiteD1Database } from "./sqlite-d1";

const secret = "test-jwt-secret-that-is-at-least-thirty-two-bytes";
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const requestId = "22222222-2222-4222-8222-222222222222";
const clientInstanceID = "44444444-4444-4444-8444-444444444444";

test("Circle.ms PKCE start, callback, and completion never expose provider credentials", async () => {
  const database = setup();
  const configured = bindings(database);
  const start = await startCirclemsOAuth(
    configured,
    "authenticate",
    {
      requestId,
      clientInstanceID,
      environment: "production",
      codeChallenge: challenge,
    },
    undefined,
    100,
  );
  const replayedStart = await startCirclemsOAuth(
    configured,
    "authenticate",
    {
      requestId,
      clientInstanceID,
      environment: "production",
      codeChallenge: challenge,
    },
    undefined,
    101,
  );
  assert.deepEqual(replayedStart, start);
  const authorization = new URL(start.authorizationURL);
  assert.equal(authorization.origin, "https://auth1.circle.test");
  assert.equal(authorization.pathname, "/OAuth2/");
  assert.equal(
    authorization.searchParams.get("redirect_uri"),
    "https://cominavi.net/oauth/circlems/landing",
  );
  assert.equal(
    authorization.searchParams.get("scope"),
    "circle_read favorite_read favorite_write user_info",
  );
  const state = authorization.searchParams.get("state")!;
  const stored = database.rows(
    `SELECT state_hash, state_nonce, state_ciphertext
     FROM circlems_oauth_starts`,
  )[0]!;
  assert.equal("state_token" in stored, false);
  assert.notEqual(stored.state_ciphertext, state);
  assert.equal(
    stored.state_hash,
    createHash("sha256").update(state).digest("hex"),
  );

  const completionCode = await finishCirclemsOAuthCallback(
    configured,
    state,
    "provider-code",
    circleFetcher(42, "Circle Alice"),
    102,
  );
  assert.match(completionCode, /^[A-Za-z0-9_-]{43}$/);
  const completion = await completeCirclemsAuthentication(
    configured,
    { requestId, clientInstanceID, completionCode, codeVerifier: verifier },
    103_000,
    () => 103,
  );
  assert.equal(completion.user.displayName, "Circle Alice");
  assert.equal(completion.credentialReceipt.clientInstanceID, clientInstanceID);
  assert.equal(completion.credentialReceipt.subject, "42");
  assert.equal(
    database.rows("SELECT count(*) AS count FROM auth_refresh_tokens")[0]
      ?.count,
    1,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM provider_credentials")[0]
      ?.count,
    1,
  );
  assert.deepEqual(
    database.rows(
      `SELECT provider_subject, provider_user_id, provider_display_name,
              credential_nonce, credential_ciphertext
       FROM circlems_oauth_completions`,
    ),
    [
      {
        provider_subject: null,
        provider_user_id: null,
        provider_display_name: null,
        credential_nonce: null,
        credential_ciphertext: null,
      },
    ],
  );
  assert.deepEqual(
    database.rows(
      `SELECT state_nonce, state_ciphertext, completion_code_nonce,
              completion_code_ciphertext FROM circlems_oauth_starts`,
    ),
    [
      {
        state_nonce: null,
        state_ciphertext: null,
        completion_code_nonce: null,
        completion_code_ciphertext: null,
      },
    ],
  );

  const lostResponseReplay = await completeCirclemsAuthentication(
    configured,
    { requestId, clientInstanceID, completionCode, codeVerifier: verifier },
    104_000,
    () => 104,
  );
  assert.deepEqual(lostResponseReplay, completion);
  assert.equal(
    database.rows("SELECT count(*) AS count FROM auth_refresh_tokens")[0]
      ?.count,
    1,
  );
  await rotateSession(
    database.binding,
    completion.refreshToken,
    secret,
    105_000,
  );
  await assert.rejects(
    completeCirclemsAuthentication(
      configured,
      { requestId, clientInstanceID, completionCode, codeVerifier: verifier },
      106_000,
      () => 106,
    ),
    (error: unknown) => hasCode(error, "circlems_oauth_unavailable"),
  );
});

test("link completion rolls back identity and credential when logout wins the final D1 fence", async () => {
  const database = setup();
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${"a".repeat(32)}', 'Google owner', 1, 1, 1, 1, 1);
    INSERT INTO user_identities (
      id, user_id, provider, provider_environment, provider_subject,
      provider_email, created_at, updated_at, last_authenticated_at
    ) VALUES (1, 1, 'google', '', 'google-subject', 'owner@example.test', 1, 1, 1);
  `);
  const configured = bindings(database);
  const linkIdentity = {
    subject: "a".repeat(32),
    userID: 1,
    authVersion: 1,
  };
  const start = await startCirclemsOAuth(
    configured,
    "link",
    {
      requestId,
      clientInstanceID,
      environment: "sandbox",
      codeChallenge: challenge,
    },
    linkIdentity,
    100,
  );
  const state = new URL(start.authorizationURL).searchParams.get("state")!;
  const completionCode = await finishCirclemsOAuthCallback(
    configured,
    state,
    "provider-code",
    circleFetcher(88, "Linked Circle"),
    101,
  );
  database.beforeNextBatch = () => {
    database.native.exec("UPDATE users SET auth_version = 2 WHERE id = 1");
  };
  await assert.rejects(
    completeCirclemsLink(
      configured,
      { requestId, clientInstanceID, completionCode, codeVerifier: verifier },
      linkIdentity,
      102_000,
      () => 102,
    ),
  );
  assert.deepEqual(
    database.rows("SELECT provider FROM user_identities ORDER BY id"),
    [{ provider: "google" }],
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM provider_credentials")[0]
      ?.count,
    0,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM auth_refresh_tokens")[0]
      ?.count,
    0,
  );
  assert.equal(
    database.rows(
      "SELECT count(*) AS count FROM circlems_oauth_atomic_assertions",
    )[0]?.count,
    0,
  );
  assert.equal(
    database.rows("SELECT result_ciphertext FROM circlems_oauth_completions")[0]
      ?.result_ciphertext,
    null,
  );
});

test("completion expiry after claim rolls back every authoritative auth row", async () => {
  const database = setup();
  const configured = bindings(database);
  const start = await startCirclemsOAuth(
    configured,
    "authenticate",
    {
      requestId,
      clientInstanceID,
      environment: "production",
      codeChallenge: challenge,
    },
    undefined,
    100,
  );
  const completionCode = await finishCirclemsOAuthCallback(
    configured,
    new URL(start.authorizationURL).searchParams.get("state")!,
    "provider-code",
    circleFetcher(42, "Circle Alice"),
    101,
  );
  // Request entry and claim occur at 102, but the injected final clock crosses
  // the 221-second completion expiry after credential/session preparation.
  await assert.rejects(
    completeCirclemsAuthentication(
      configured,
      { requestId, clientInstanceID, completionCode, codeVerifier: verifier },
      102_000,
      () => 222,
    ),
    (error: unknown) => hasCode(error, "circlems_oauth_unavailable"),
  );
  for (const table of [
    "users",
    "user_identities",
    "provider_credentials",
    "auth_refresh_tokens",
    "circlems_oauth_atomic_assertions",
  ]) {
    assert.equal(
      database.rows(`SELECT count(*) AS count FROM ${table}`)[0]?.count,
      0,
      table,
    );
  }
  assert.deepEqual(
    database.rows(
      `SELECT user_id, user_identity_id, result_token_hash, result_ciphertext,
              completed_at, processing_lease_id
       FROM circlems_oauth_completions`,
    ),
    [
      {
        user_id: null,
        user_identity_id: null,
        result_token_hash: null,
        result_ciphertext: null,
        completed_at: null,
        processing_lease_id: null,
      },
    ],
  );
});

test("Circle OAuth start must be created after the latest logout fence", async () => {
  const database = setup();
  const configured = bindings(database);
  const initialStart = await startCirclemsOAuth(
    configured,
    "authenticate",
    {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      clientInstanceID,
      environment: "production",
      codeChallenge: challenge,
    },
    undefined,
    100,
  );
  const initialCode = await finishCirclemsOAuthCallback(
    configured,
    new URL(initialStart.authorizationURL).searchParams.get("state")!,
    "initial-code",
    circleFetcher(42, "Circle Alice"),
    101,
  );
  const initial = await completeCirclemsAuthentication(
    configured,
    {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      clientInstanceID,
      completionCode: initialCode,
      codeVerifier: verifier,
    },
    102_000,
    () => 102,
  );
  const staleStart = await startCirclemsOAuth(
    configured,
    "authenticate",
    {
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      clientInstanceID,
      environment: "production",
      codeChallenge: challenge,
    },
    undefined,
    103,
  );
  await logoutSession(
    database.binding,
    { subject: initial.user.id, authVersion: 1 },
    {
      requestID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      refreshToken: initial.refreshToken,
    },
    configured.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
    true,
    104_000,
  );
  await assert.rejects(
    finishCirclemsOAuthCallback(
      configured,
      new URL(staleStart.authorizationURL).searchParams.get("state")!,
      "stale-after-logout-code",
      circleFetcher(42, "Circle Alice"),
      105,
    ),
    (error: unknown) => hasCode(error, "circlems_oauth_unavailable"),
  );

  const freshStart = await startCirclemsOAuth(
    configured,
    "authenticate",
    {
      requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      clientInstanceID,
      environment: "production",
      codeChallenge: challenge,
    },
    undefined,
    105,
  );
  const freshCode = await finishCirclemsOAuthCallback(
    configured,
    new URL(freshStart.authorizationURL).searchParams.get("state")!,
    "fresh-after-logout-code",
    circleFetcher(42, "Circle Alice"),
    106,
  );
  const fresh = await completeCirclemsAuthentication(
    configured,
    {
      requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      clientInstanceID,
      completionCode: freshCode,
      codeVerifier: verifier,
    },
    107_000,
    () => 107,
  );
  assert.equal(fresh.authVersion, 2);
});

test("explicit OAuth replaces a legacy credential and result replay follows refresh-family lifecycle", async () => {
  const database = setup();
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${"a".repeat(32)}', 'Existing owner', 1, 1, 1, 1, 1);
    INSERT INTO user_identities (
      id, user_id, provider, provider_environment, provider_subject,
      provider_user_id, created_at, updated_at, last_authenticated_at
    ) VALUES (7, 1, 'circlems', 'production', '42', 42, 1, 1, 1);
  `);
  await storeCircleCredential(
    database.binding,
    1,
    7,
    {
      accessToken: "legacy",
      refreshToken: "legacy-refresh",
      accessExpiresAt: 50,
    },
    credentialKey(),
    1,
  );
  const configured = bindings(database);
  const start = await startCirclemsOAuth(
    configured,
    "authenticate",
    {
      requestId,
      clientInstanceID,
      environment: "production",
      codeChallenge: challenge,
    },
    undefined,
    100,
  );
  const completionCode = await finishCirclemsOAuthCallback(
    configured,
    new URL(start.authorizationURL).searchParams.get("state")!,
    "new-code",
    circleFetcher(42, "Existing owner"),
    101,
  );
  const completed = await completeCirclemsAuthentication(
    configured,
    { requestId, clientInstanceID, completionCode, codeVerifier: verifier },
    102_000,
    () => 102,
  );
  assert.equal(completed.credentialReceipt.credentialRevision, 2);
  assert.equal(
    database.rows("SELECT last_oauth_flow_id FROM provider_credentials")[0]
      ?.last_oauth_flow_id,
    database.rows("SELECT id FROM circlems_oauth_starts")[0]?.id,
  );
  const delayedReplay = await completeCirclemsAuthentication(
    configured,
    { requestId, clientInstanceID, completionCode, codeVerifier: verifier },
    222_000,
    () => 222,
  );
  assert.deepEqual(delayedReplay, completed);
  assert.equal(
    database.rows("SELECT count(*) AS count FROM auth_refresh_tokens")[0]
      ?.count,
    1,
  );
  assert.equal(
    database.rows("SELECT credential_revision FROM provider_credentials")[0]
      ?.credential_revision,
    2,
  );
});

test("production callback exposes no provider tokens", () => {
  const landing = readFileSync("src/pages/oauth/circlems/landing.ts", "utf8");
  for (const forbidden of ["access_token", "refresh_token", "token_type"]) {
    assert.equal(landing.includes(forbidden), false);
  }
});

test("expired unclaimed Circle starts and staged credentials are scrubbed", async () => {
  const database = setup();
  const configured = bindings(database);
  const stagedStart = await startCirclemsOAuth(
    configured,
    "authenticate",
    {
      requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      clientInstanceID,
      environment: "production",
      codeChallenge: challenge,
    },
    undefined,
    100,
  );
  await finishCirclemsOAuthCallback(
    configured,
    new URL(stagedStart.authorizationURL).searchParams.get("state")!,
    "abandoned-provider-code",
    circleFetcher(99, "Abandoned Circle"),
    101,
  );
  await startCirclemsOAuth(
    configured,
    "authenticate",
    {
      requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      clientInstanceID,
      environment: "production",
      codeChallenge: challenge,
    },
    undefined,
    100,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM circlems_oauth_starts")[0]
      ?.count,
    2,
  );
  assert.ok(
    database.rows(
      "SELECT credential_ciphertext FROM circlems_oauth_completions",
    )[0]?.credential_ciphertext,
  );
  assert.equal(await processExpiredCirclemsOAuth(database.binding, 701_000), 2);
  assert.equal(
    database.rows("SELECT count(*) AS count FROM circlems_oauth_starts")[0]
      ?.count,
    0,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM circlems_oauth_completions")[0]
      ?.count,
    0,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM provider_credentials")[0]
      ?.count,
    0,
  );
});

function circleFetcher(userID: number, nickname: string): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/OAuth2/Token") {
      return Response.json({
        access_token: "provider-access-secret",
        refresh_token: "provider-refresh-secret",
        token_type: "Bearer",
        expires_in: 3_600,
      });
    }
    assert.equal(url.pathname, "/User/Info");
    return Response.json({
      status: "success",
      response: { pid: userID, nickname },
    });
  };
}

function bindings(database: SQLiteD1Database): CirclemsOAuthFlowBindings {
  return {
    COMINAVI_DB: database.binding,
    COMINAVI_JWT_SECRET: secret,
    COMINAVI_PROVIDER_CREDENTIAL_KEY_V1: credentialKey(),
    COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_ORIGIN: "https://auth1.circle.test",
    COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_ID: "production-client",
    COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_SECRET: "production-secret",
    COMINAVI_OAUTH_CIRCLEMS_SANDBOX_ORIGIN: "https://auth1-sandbox.circle.test",
    COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID: "sandbox-client",
    COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET: "sandbox-secret",
    COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN: "https://api1.circle.test",
    COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN: "https://api1-sandbox.circle.test",
  };
}

function credentialKey(): string {
  return Buffer.from(
    Uint8Array.from({ length: 32 }, (_, index) => index),
  ).toString("base64url");
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
