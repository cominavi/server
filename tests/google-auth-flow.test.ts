import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateOpenAPIDocument } from "../src/api/openapi";
import {
  createSession,
  logoutSession,
  rotateSession,
} from "../src/lib/server/auth-sessions";
import {
  authenticateGoogleRequest,
  completeGoogleAuthentication,
} from "../src/lib/server/google-auth-flow";
import { issueGoogleEntryGrant } from "../src/lib/server/google-entry-grants";
import { processProviderAvatarImports } from "../src/lib/server/provider-avatar-import";
import { SQLiteD1Database } from "./sqlite-d1";

const secret = "test-jwt-secret-that-is-at-least-thirty-two-bytes";
const requestID = "22222222-2222-4222-8222-222222222222";
const nonce = "n".repeat(32);
const google = {
  provider: "google" as const,
  environment: "" as const,
  subject: "google-subject-42",
  email: "owner@example.test",
  displayName: "Google Owner",
  avatarURL: "https://lh3.googleusercontent.com/avatar",
};

test("Google grant, identity, one refresh family, and replay receipt commit atomically", async () => {
  const database = setup();
  const grant = await issueGoogleEntryGrant(database.binding, nonce, 100_000);
  const first = await completeGoogleAuthentication(
    database.binding,
    google,
    "verified-google-id-token",
    grant.entryGrant,
    nonce,
    requestID,
    secret,
    credentialKey(),
    101_000,
    () => 101,
  );
  assert.equal(first.response.user.displayName, "Google Owner");
  assert.equal(first.response.user.avatarURL, null);
  assert.equal(
    database.rows("SELECT count(*) AS count FROM users")[0]?.count,
    1,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM user_identities")[0]?.count,
    1,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM auth_refresh_tokens")[0]
      ?.count,
    1,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM google_auth_receipts")[0]
      ?.count,
    1,
  );
  assert.deepEqual(
    database.rows(
      `SELECT provider_avatar_url, job_revision, state, attempt_count
       FROM provider_avatar_import_jobs`,
    ),
    [
      {
        provider_avatar_url: google.avatarURL,
        job_revision: 1,
        state: "queued",
        attempt_count: 0,
      },
    ],
  );

  const replay = await completeGoogleAuthentication(
    database.binding,
    google,
    "verified-google-id-token",
    grant.entryGrant,
    nonce,
    requestID,
    secret,
    credentialKey(),
    102_000,
    () => 102,
  );
  assert.deepEqual(replay.response, first.response);
  assert.equal(
    database.rows("SELECT count(*) AS count FROM auth_refresh_tokens")[0]
      ?.count,
    1,
  );
  let verifiedOnReplay = false;
  const relaunchedReplay = await authenticateGoogleRequest(
    database.binding,
    {
      idToken: "verified-google-id-token",
      entryGrant: grant.entryGrant,
      nonce,
      requestID,
    },
    secret,
    credentialKey(),
    async () => {
      verifiedOnReplay = true;
      throw new Error("expired provider token must not gate exact replay");
    },
    500_000,
    () => 500,
  );
  assert.deepEqual(relaunchedReplay.response, first.response);
  assert.equal(verifiedOnReplay, false);
  assert.equal(
    database.rows("SELECT count(*) AS count FROM auth_refresh_tokens")[0]
      ?.count,
    1,
  );
  await assert.rejects(
    authenticateGoogleRequest(
      database.binding,
      {
        idToken: "changed-or-replayed-token",
        entryGrant: grant.entryGrant,
        nonce,
        requestID,
      },
      secret,
      credentialKey(),
      async () => {
        throw new Error("changed payload must conflict before provider auth");
      },
      501_000,
      () => 501,
    ),
    (error: unknown) => hasCode(error, "idempotency_conflict"),
  );
  await assert.rejects(
    completeGoogleAuthentication(
      database.binding,
      google,
      "different-token",
      grant.entryGrant,
      nonce,
      requestID,
      secret,
      credentialKey(),
      103_000,
      () => 103,
    ),
    (error: unknown) => hasCode(error, "idempotency_conflict"),
  );
  await rotateSession(
    database.binding,
    first.response.refreshToken,
    secret,
    104_000,
  );
  await assert.rejects(
    completeGoogleAuthentication(
      database.binding,
      google,
      "verified-google-id-token",
      grant.entryGrant,
      nonce,
      requestID,
      secret,
      credentialKey(),
      105_000,
      () => 105,
    ),
    (error: unknown) => hasCode(error, "invalid_entry_grant"),
  );
});

test("Google auth final grant and auth epoch fences roll back every authoritative row", async () => {
  const database = setup();
  const grant = await issueGoogleEntryGrant(database.binding, nonce, 100_000);
  // The session is prepared at 101, then the final authority clock advances
  // past the five-minute entry grant while WebCrypto is conceptually suspended.
  const times = [101, 401];
  await assert.rejects(
    completeGoogleAuthentication(
      database.binding,
      google,
      "verified-google-id-token",
      grant.entryGrant,
      nonce,
      requestID,
      secret,
      credentialKey(),
      101_000,
      () => times.shift() ?? 401,
    ),
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM users")[0]?.count,
    0,
  );
  assert.equal(
    database.rows("SELECT consumed_at FROM google_entry_grants")[0]
      ?.consumed_at,
    null,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM auth_refresh_tokens")[0]
      ?.count,
    0,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM google_auth_receipts")[0]
      ?.count,
    0,
  );
  assert.equal(
    database.rows(
      "SELECT count(*) AS count FROM provider_avatar_import_jobs",
    )[0]?.count,
    0,
  );
});

test("Google reauth refreshes only provider-owned profile fields and advances revision", async () => {
  const database = setup();
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, display_name_edited, profile_revision,
      auth_version, created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${"a".repeat(32)}', 'Alice', 0, 1, 1, 1, 1, 1);
    INSERT INTO user_identities (
      id, user_id, provider, provider_environment, provider_subject,
      provider_email, provider_display_name, created_at, updated_at,
      last_authenticated_at
    ) VALUES (7, 1, 'google', '', 'google-subject-42',
      'old@example.test', 'Alice', 1, 1, 1);
  `);
  const grant = await issueGoogleEntryGrant(database.binding, nonce, 100_000);
  const refreshed = await completeGoogleAuthentication(
    database.binding,
    { ...google, displayName: "Alicia" },
    "verified-google-id-token",
    grant.entryGrant,
    nonce,
    "33333333-3333-4333-8333-333333333333",
    secret,
    credentialKey(),
    101_000,
    () => 101,
  );
  assert.equal(refreshed.response.user.displayName, "Alicia");
  assert.equal(refreshed.response.user.revision, 2);
  assert.deepEqual(
    database.rows(
      "SELECT display_name, profile_revision FROM users WHERE id = 1",
    ),
    [{ display_name: "Alicia", profile_revision: 2 }],
  );

  database.native.exec(`
    UPDATE users SET display_name = 'Manual', display_name_edited = 1,
      profile_revision = 3 WHERE id = 1;
  `);
  const secondGrant = await issueGoogleEntryGrant(
    database.binding,
    `${nonce}x`,
    102_000,
  );
  const explicit = await completeGoogleAuthentication(
    database.binding,
    { ...google, displayName: "Provider Again" },
    "second-verified-google-id-token",
    secondGrant.entryGrant,
    `${nonce}x`,
    "44444444-4444-4444-8444-444444444444",
    secret,
    credentialKey(),
    103_000,
    () => 103,
  );
  assert.equal(explicit.response.user.displayName, "Manual");
  assert.equal(explicit.response.user.revision, 3);
  assert.deepEqual(
    database.rows(
      "SELECT display_name, profile_revision FROM users WHERE id = 1",
    ),
    [{ display_name: "Manual", profile_revision: 3 }],
  );
});

test("Google reauth rolls back when an explicit profile edit races its predicted receipt", async () => {
  const database = setup();
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, display_name_edited, profile_revision,
      auth_version, created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${"a".repeat(32)}', 'Alice', 0, 1, 1, 1, 1, 1);
    INSERT INTO user_identities (
      id, user_id, provider, provider_environment, provider_subject,
      provider_email, provider_display_name, created_at, updated_at,
      last_authenticated_at
    ) VALUES (7, 1, 'google', '', 'google-subject-42',
      'old@example.test', 'Alice', 1, 1, 1);
  `);
  const grant = await issueGoogleEntryGrant(database.binding, nonce, 100_000);
  database.beforeNextBatch = () => {
    database.native.exec(`
      UPDATE users SET display_name = 'Manual', display_name_edited = 1,
        profile_revision = 2 WHERE id = 1;
    `);
  };
  await assert.rejects(
    completeGoogleAuthentication(
      database.binding,
      { ...google, displayName: "Alicia" },
      "verified-google-id-token",
      grant.entryGrant,
      nonce,
      "55555555-5555-4555-8555-555555555555",
      secret,
      credentialKey(),
      101_000,
      () => 101,
    ),
  );
  assert.deepEqual(
    database.rows(
      "SELECT display_name, display_name_edited, profile_revision FROM users",
    ),
    [{ display_name: "Manual", display_name_edited: 1, profile_revision: 2 }],
  );
  assert.equal(
    database.rows("SELECT provider_email FROM user_identities")[0]
      ?.provider_email,
    "old@example.test",
  );
  assert.equal(
    database.rows("SELECT consumed_at FROM google_entry_grants")[0]
      ?.consumed_at,
    null,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM google_auth_receipts")[0]
      ?.count,
    0,
  );
});

test("provider-avatar worker cannot lease or delete a newer queued URL", async () => {
  const database = setup();
  const grant = await issueGoogleEntryGrant(database.binding, nonce, 100_000);
  await completeGoogleAuthentication(
    database.binding,
    google,
    "verified-google-id-token",
    grant.entryGrant,
    nonce,
    requestID,
    secret,
    credentialKey(),
    101_000,
    () => 101,
  );
  let fetched = false;
  const result = await processProviderAvatarImports(
    database.binding,
    emptyBucket(),
    async () => {
      fetched = true;
      return new Response(null, { status: 503 });
    },
    102_000,
    () => {
      database.native.exec(`
        UPDATE provider_avatar_import_jobs
        SET provider_avatar_url = 'https://lh3.googleusercontent.com/new',
            job_revision = job_revision + 1, state = 'queued',
            lease_id = NULL, lease_expires_at = NULL
      `);
    },
  );
  assert.equal(result, 0);
  assert.equal(fetched, false);
  assert.deepEqual(
    database.rows(
      `SELECT provider_avatar_url, job_revision, state
       FROM provider_avatar_import_jobs`,
    ),
    [
      {
        provider_avatar_url: "https://lh3.googleusercontent.com/new",
        job_revision: 2,
        state: "queued",
      },
    ],
  );
});

test("Google logout interleaving leaves the entry grant and existing account unchanged", async () => {
  const database = setup();
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${"a".repeat(32)}', 'Existing Google owner', 1, 1, 1, 1, 1);
    INSERT INTO user_identities (
      id, user_id, provider, provider_environment, provider_subject,
      provider_email, created_at, updated_at, last_authenticated_at
    ) VALUES (7, 1, 'google', '', 'google-subject-42',
      'old@example.test', 1, 1, 1);
  `);
  const grant = await issueGoogleEntryGrant(database.binding, nonce, 100_000);
  database.beforeNextBatch = () => {
    database.native.exec("UPDATE users SET auth_version = 2 WHERE id = 1");
  };
  await assert.rejects(
    completeGoogleAuthentication(
      database.binding,
      google,
      "verified-google-id-token",
      grant.entryGrant,
      nonce,
      requestID,
      secret,
      credentialKey(),
      101_000,
      () => 101,
    ),
  );
  assert.equal(
    database.rows("SELECT consumed_at FROM google_entry_grants")[0]
      ?.consumed_at,
    null,
  );
  assert.equal(
    database.rows("SELECT provider_email FROM user_identities")[0]
      ?.provider_email,
    "old@example.test",
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM auth_refresh_tokens")[0]
      ?.count,
    0,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM google_auth_receipts")[0]
      ?.count,
    0,
  );
});

test("Google proof must be issued after the latest logout fence", async () => {
  const database = setup();
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${"a".repeat(32)}', 'Existing Google owner', 1, 1, 1, 1, 1);
    INSERT INTO user_identities (
      id, user_id, provider, provider_environment, provider_subject,
      provider_email, created_at, updated_at, last_authenticated_at
    ) VALUES (7, 1, 'google', '', 'google-subject-42',
      'old@example.test', 1, 1, 1);
  `);
  const session = await createSession(
    database.binding,
    { subject: "a".repeat(32), userID: 1, authVersion: 1 },
    secret,
    100_000,
  );
  await logoutSession(
    database.binding,
    { subject: "a".repeat(32), authVersion: 1 },
    {
      requestID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      refreshToken: session.refreshToken,
    },
    credentialKey(),
    true,
    200_000,
  );

  const oldGrant = await issueGoogleEntryGrant(
    database.binding,
    nonce,
    201_000,
  );
  await assert.rejects(
    completeGoogleAuthentication(
      database.binding,
      { ...google, issuedAt: 199 },
      "pre-logout-google-proof",
      oldGrant.entryGrant,
      nonce,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      secret,
      credentialKey(),
      202_000,
      () => 202,
    ),
    (error: unknown) => hasCode(error, "invalid_entry_grant"),
  );
  assert.equal(
    database.rows(
      `SELECT consumed_at FROM google_entry_grants
       WHERE grant_hash <> '' ORDER BY created_at DESC LIMIT 1`,
    )[0]?.consumed_at,
    null,
  );

  const freshGrant = await issueGoogleEntryGrant(
    database.binding,
    `${nonce}fresh`,
    203_000,
  );
  const fresh = await completeGoogleAuthentication(
    database.binding,
    { ...google, issuedAt: 201 },
    "post-logout-google-proof",
    freshGrant.entryGrant,
    `${nonce}fresh`,
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    secret,
    credentialKey(),
    204_000,
    () => 204,
  );
  assert.equal(fresh.response.authVersion, 2);
});

test("Google operation exposes the durable request contract and uses durable avatar enrichment", async () => {
  const document = await generateOpenAPIDocument();
  const operation = document.paths?.["/api/v2/auth/google"]?.post;
  assert.equal(operation?.operationId, "authenticateWithGoogle");
  assert.deepEqual(operation?.security, []);
  assert.ok(operation?.requestBody);
  assert.ok(operation?.responses?.["200"]);
  const worker = readFileSync("src/worker.ts", "utf8");
  assert.ok(worker.includes("processProviderAvatarImports"));
});

function credentialKey(): string {
  return Buffer.from(
    Uint8Array.from({ length: 32 }, (_, index) => index),
  ).toString("base64url");
}

function emptyBucket(): R2Bucket {
  return {
    put: async () => null,
    delete: async () => undefined,
  } as unknown as R2Bucket;
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
