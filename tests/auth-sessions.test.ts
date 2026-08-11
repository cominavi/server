import assert from "node:assert/strict";
import test from "node:test";

import {
  createSession,
  logoutSession,
  parseLogoutRequest,
  rotateSession,
} from "../src/lib/server/auth-sessions";
import type { CominaviIdentity } from "../src/lib/server/cominavi-auth";
import { SQLiteD1Database } from "./sqlite-d1";

const jwtSecret = "test-jwt-secret-that-is-at-least-thirty-two-bytes";
const receiptKey = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64url",
);
const identity: CominaviIdentity = {
  subject: "00000000000000000000000000000001",
  userID: 1,
  authVersion: 1,
};

test("a concurrent refresh-token replay revokes the winner's entire family", async () => {
  const database = new SQLiteD1Database(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      public_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_provider_url TEXT,
      avatar_object_key TEXT,
      profile_revision INTEGER NOT NULL,
      auth_version INTEGER NOT NULL
      , deletion_pending_at INTEGER
      , last_auth_fenced_at INTEGER
      , last_auth_fence_request_id TEXT
      , last_auth_fence_payload_hash TEXT
      , updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE user_identities (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_environment TEXT NOT NULL,
      provider_user_id INTEGER,
      provider_email TEXT
    );
    CREATE TABLE auth_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      family_id TEXT NOT NULL,
      auth_version INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      replaced_by_hash TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO users
      (id, public_id, display_name, profile_revision, auth_version)
    VALUES (1, '${identity.subject}', 'User', 1, 1);
  `);
  const initial = await createSession(
    database.binding,
    identity,
    jwtSecret,
    1_000_000,
  );

  const rotations = await Promise.allSettled([
    rotateSession(database.binding, initial.refreshToken, jwtSecret, 1_001_000),
    rotateSession(database.binding, initial.refreshToken, jwtSecret, 1_001_000),
  ]);
  const winner = rotations.find(
    (
      result,
    ): result is PromiseFulfilledResult<
      Awaited<ReturnType<typeof rotateSession>>
    > => result.status === "fulfilled",
  );
  assert.ok(winner);
  assert.equal(
    rotations.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.deepEqual(
    database.rows(
      `SELECT count(*) AS family_tokens,
              sum(consumed_at IS NULL) AS usable_tokens
       FROM auth_refresh_tokens`,
    ),
    [{ family_tokens: 2, usable_tokens: 0 }],
  );
  await assert.rejects(
    () =>
      rotateSession(
        database.binding,
        winner.value.refreshToken,
        jwtSecret,
        1_002_000,
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "invalid_refresh_token",
  );
});

test("refresh rejects a token issued before the user's current auth epoch", async () => {
  const database = new SQLiteD1Database(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      public_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_provider_url TEXT,
      avatar_object_key TEXT,
      profile_revision INTEGER NOT NULL,
      auth_version INTEGER NOT NULL,
      deletion_pending_at INTEGER,
      last_auth_fenced_at INTEGER,
      last_auth_fence_request_id TEXT,
      last_auth_fence_payload_hash TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE user_identities (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_environment TEXT NOT NULL,
      provider_user_id INTEGER,
      provider_email TEXT
    );
    CREATE TABLE auth_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      family_id TEXT NOT NULL,
      auth_version INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      replaced_by_hash TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO users
      (id, public_id, display_name, profile_revision, auth_version)
    VALUES (1, '${identity.subject}', 'User', 1, 1);
  `);
  const initial = await createSession(
    database.binding,
    identity,
    jwtSecret,
    1_000_000,
  );
  database.native.exec("UPDATE users SET auth_version = 2 WHERE id = 1");

  await assert.rejects(
    () =>
      rotateSession(
        database.binding,
        initial.refreshToken,
        jwtSecret,
        1_001_000,
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "invalid_refresh_token",
  );
  assert.deepEqual(
    database.rows(
      `SELECT count(*) AS family_tokens,
              sum(consumed_at IS NULL) AS usable_tokens
       FROM auth_refresh_tokens`,
    ),
    [{ family_tokens: 1, usable_tokens: 0 }],
  );
});

test("logout advances the epoch once and exact predecessor replay stays recoverable", async () => {
  const database = logoutDatabase();
  const first = await createSession(
    database.binding,
    identity,
    jwtSecret,
    1_000_000,
  );
  const second = await createSession(
    database.binding,
    identity,
    jwtSecret,
    1_000_000,
  );
  database.native.exec(`
    INSERT INTO push_devices (id, user_id, enabled, invalidated_at, updated_at)
    VALUES (1, 1, 1, NULL, 1000);
    INSERT INTO notification_deliveries (
      id, user_id, status, lease_expires_at, last_error, updated_at
    ) VALUES (1, 1, 'pending', NULL, NULL, 1000);
  `);
  const input = parseLogoutRequest({
    requestId: "11111111-1111-4111-8111-111111111111",
    refreshToken: first.refreshToken,
  });

  const result = await logoutSession(
    database.binding,
    { subject: identity.subject, authVersion: 1 },
    input,
    receiptKey,
    true,
    1_001_000,
  );
  assert.deepEqual(result, {
    receipt: {
      requestId: input.requestID,
      replayed: false,
      authVersion: 2,
    },
  });
  assert.deepEqual(
    database.rows(
      `SELECT auth_version, last_auth_fenced_at,
              last_auth_fence_request_id
       FROM users`,
    ),
    [
      {
        auth_version: 2,
        last_auth_fenced_at: 1001,
        last_auth_fence_request_id: input.requestID,
      },
    ],
  );
  assert.deepEqual(
    database.rows(
      `SELECT count(*) AS tokens, sum(consumed_at IS NOT NULL) AS consumed
       FROM auth_refresh_tokens`,
    ),
    [{ tokens: 2, consumed: 2 }],
  );
  assert.deepEqual(
    database.rows(
      `SELECT enabled, invalidated_at FROM push_devices WHERE id = 1`,
    ),
    [{ enabled: 0, invalidated_at: 1001 }],
  );
  assert.deepEqual(
    database.rows(
      `SELECT status, last_error FROM notification_deliveries WHERE id = 1`,
    ),
    [{ status: "suppressed", last_error: "account_logged_out" }],
  );

  const replay = await logoutSession(
    database.binding,
    { subject: identity.subject, authVersion: 1 },
    input,
    receiptKey,
    false,
    3_000_000,
  );
  assert.deepEqual(replay, {
    receipt: {
      requestId: input.requestID,
      replayed: true,
      authVersion: 2,
    },
  });
  assert.equal(
    database.rows(`SELECT auth_version FROM users`)[0]?.auth_version,
    2,
  );

  database.native.exec("DELETE FROM users WHERE id = 1");
  const afterAccountDeletion = await logoutSession(
    database.binding,
    { subject: identity.subject, authVersion: 1 },
    input,
    receiptKey,
    false,
    4_000_000,
  );
  assert.deepEqual(afterAccountDeletion, replay);

  await assert.rejects(
    () =>
      logoutSession(
        database.binding,
        { subject: identity.subject, authVersion: 1 },
        { ...input, refreshToken: second.refreshToken },
        receiptKey,
        false,
        3_000_000,
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "idempotency_conflict",
  );
});

test("a live refresh authorizes first logout after access expiry, but expiry alone does not", async () => {
  const database = logoutDatabase();
  const session = await createSession(
    database.binding,
    identity,
    jwtSecret,
    1_000_000,
  );
  const result = await logoutSession(
    database.binding,
    { subject: identity.subject, authVersion: 1 },
    {
      requestID: "22222222-2222-4222-8222-222222222222",
      refreshToken: session.refreshToken,
    },
    receiptKey,
    false,
    2_000_000,
  );
  assert.equal(result.receipt.authVersion, 2);

  const unavailable = logoutDatabase();
  await assert.rejects(
    () =>
      logoutSession(
        unavailable.binding,
        { subject: identity.subject, authVersion: 1 },
        {
          requestID: "33333333-3333-4333-8333-333333333333",
          refreshToken: "A".repeat(43),
        },
        receiptKey,
        false,
        2_000_000,
      ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "invalid_logout_credentials",
  );
  assert.equal(
    unavailable.rows(`SELECT auth_version FROM users`)[0]?.auth_version,
    1,
  );
});

function logoutDatabase(): SQLiteD1Database {
  return new SQLiteD1Database(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      public_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_provider_url TEXT,
      avatar_object_key TEXT,
      profile_revision INTEGER NOT NULL,
      auth_version INTEGER NOT NULL,
      deletion_pending_at INTEGER,
      last_auth_fenced_at INTEGER,
      last_auth_fence_request_id TEXT,
      last_auth_fence_payload_hash TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE user_identities (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_environment TEXT NOT NULL,
      provider_user_id INTEGER,
      provider_email TEXT
    );
    CREATE TABLE auth_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      family_id TEXT NOT NULL,
      auth_version INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      replaced_by_hash TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE auth_logout_receipts (
      request_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      subject_digest TEXT NOT NULL,
      original_auth_version INTEGER NOT NULL,
      result_auth_version INTEGER NOT NULL,
      refresh_token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE auth_logout_atomic_assertions (
      request_id TEXT PRIMARY KEY
        REFERENCES auth_logout_receipts(request_id) ON DELETE CASCADE,
      committed INTEGER NOT NULL CHECK (committed = 1),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE push_devices (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      invalidated_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE notification_deliveries (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      lease_expires_at INTEGER,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE shared_plan_notification_deliveries (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      lease_expires_at INTEGER,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version, updated_at
    ) VALUES (1, '${identity.subject}', 'User', 1, 1, 1000);
  `);
}
