import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accessTierFor, isReviewEmail } from "../src/lib/server/access-tier";
import { authenticateAppleRequest } from "../src/lib/server/apple-auth-flow";
import { issueAppleEntryGrant } from "../src/lib/server/apple-entry-grants";
import { completeGoogleAuthentication } from "../src/lib/server/google-auth-flow";
import { issueGoogleEntryGrant } from "../src/lib/server/google-entry-grants";
import { SQLiteD1Database } from "./sqlite-d1";

const secret = "test-jwt-secret-that-is-at-least-thirty-two-bytes";
const reviewEmails =
  " Review@Example.test , ,apple-review@privaterelay.appleid.com";

test("isReviewEmail is false whenever the secret is unset or empty", () => {
  for (const configured of [undefined, "", " ", ",", " , ,"]) {
    const env = { COMINAVI_REVIEW_ACCOUNT_EMAILS: configured };
    assert.equal(isReviewEmail(env, "review@example.test"), false);
    assert.equal(isReviewEmail(env, ""), false);
    assert.equal(isReviewEmail(env, undefined), false);
    assert.equal(isReviewEmail(env, null), false);
  }
  assert.equal(isReviewEmail({}, "review@example.test"), false);
});

test("isReviewEmail matches trimmed, case-insensitive entries only", () => {
  const env = { COMINAVI_REVIEW_ACCOUNT_EMAILS: reviewEmails };
  assert.equal(isReviewEmail(env, "review@example.test"), true);
  assert.equal(isReviewEmail(env, "  REVIEW@EXAMPLE.TEST "), true);
  assert.equal(
    isReviewEmail(env, "apple-review@privaterelay.appleid.com"),
    true,
  );
  assert.equal(isReviewEmail(env, "review@example.test.evil"), false);
  assert.equal(isReviewEmail(env, "xreview@example.test"), false);
  assert.equal(isReviewEmail(env, ""), false);
});

test("accessTierFor ranks review over circlems over allowlisted over none", async () => {
  const database = setup();
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, display_name_edited, avatar_edited,
      avatar_removed, profile_revision, auth_version, created_at,
      updated_at, last_authenticated_at
    ) VALUES
      (1, '${"1".repeat(32)}', 'circlems', 0, 0, 0, 1, 1, 1, 1, 1),
      (2, '${"2".repeat(32)}', 'allowlisted', 0, 0, 0, 1, 1, 1, 1, 1),
      (3, '${"3".repeat(32)}', 'revoked', 0, 0, 0, 1, 1, 1, 1, 1),
      (4, '${"4".repeat(32)}', 'review', 0, 0, 0, 1, 1, 1, 1, 1),
      (5, '${"5".repeat(32)}', 'sandbox', 0, 0, 0, 1, 1, 1, 1, 1);
    INSERT INTO user_identities (
      user_id, provider, provider_environment, provider_subject,
      provider_email, created_at, updated_at, last_authenticated_at
    ) VALUES
      (1, 'circlems', 'production', '11', NULL, 1, 1, 1),
      (1, 'google', '', 'g-1', NULL, 1, 1, 1),
      (2, 'google', '', 'g-2', 'friend@example.test', 1, 1, 1),
      (3, 'apple', '', 'a-3', NULL, 1, 1, 1),
      (4, 'google', '', 'g-4', 'REVIEW@example.test', 1, 1, 1),
      (5, 'circlems', 'sandbox', '55', NULL, 1, 1, 1);
    INSERT INTO sign_in_allowlist (
      entry_id, label, provider, provider_subject, bound_at, created_at,
      revoked_at
    ) VALUES
      ('${"a".repeat(32)}', 't', 'google', 'g-2', 1, 1, NULL),
      ('${"b".repeat(32)}', 't', 'apple', 'a-3', 1, 1, 9),
      ('${"c".repeat(32)}', 't', 'google', 'g-4', 1, 1, NULL);
  `);
  const env = {
    COMINAVI_DB: database.binding,
    COMINAVI_REVIEW_ACCOUNT_EMAILS: reviewEmails,
  };
  assert.equal(await accessTierFor(env, 1), "circlems");
  assert.equal(await accessTierFor(env, 2), "allowlisted");
  assert.equal(await accessTierFor(env, 3), "none");
  assert.equal(await accessTierFor(env, 4), "review");
  assert.equal(await accessTierFor(env, 5), "none");
  assert.equal(await accessTierFor(env, 99), "none");
  // Without the secret the review account is just an allowlisted user.
  assert.equal(
    await accessTierFor({ COMINAVI_DB: database.binding }, 4),
    "allowlisted",
  );
});

test("a review identity signs in without an entry and spends no invite", async () => {
  const database = setup();
  database.native.exec(`
    INSERT INTO sign_in_allowlist (
      entry_id, label, invite_code_hash, created_at
    ) VALUES ('${"d".repeat(32)}', 'spare', '${"e".repeat(64)}', 1);
  `);
  const nonce = "n".repeat(32);
  const grant = await issueGoogleEntryGrant(
    database.binding,
    nonce,
    100_000,
    "d".repeat(32),
  );
  const signedIn = await completeGoogleAuthentication(
    database.binding,
    {
      provider: "google",
      environment: "",
      subject: "review-google",
      email: "review@example.test",
      reviewAccount: true,
    },
    "verified-google-id-token",
    grant.entryGrant,
    nonce,
    "22222222-2222-4222-8222-222222222222",
    secret,
    credentialKey(),
    101_000,
    () => 101,
  );
  assert.ok(signedIn.response.user.id);
  assert.deepEqual(database.rows("SELECT provider FROM sign_in_allowlist"), [
    { provider: null },
  ]);
  assert.equal(
    await accessTierFor(
      {
        COMINAVI_DB: database.binding,
        COMINAVI_REVIEW_ACCOUNT_EMAILS: reviewEmails,
      },
      signedIn.identity.userID,
    ),
    "review",
  );

  const appleNonce = "a".repeat(43);
  const appleGrant = await issueAppleEntryGrant(
    database.binding,
    appleNonce,
    200_000,
  );
  await authenticateAppleRequest(
    database.binding,
    {
      requestID: "77777777-7777-4777-8777-777777777777",
      identityToken: "verified-apple-identity-token",
      authorizationCode: "single-use-authorization-code",
      entryGrant: appleGrant.entryGrant,
      nonce: appleNonce,
    },
    secret,
    credentialKey(),
    async () => ({
      provider: "apple" as const,
      environment: "" as const,
      subject: "review-apple",
      clientID: "llc.mikunet.cominavi",
      email: "apple-review@privaterelay.appleid.com",
      reviewAccount: true,
    }),
    async () => ({
      refreshToken: "apple-refresh",
      clientID: "llc.mikunet.cominavi",
    }),
    201_000,
    () => 201,
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM users")[0]?.count,
    2,
  );
});

function setup(): SQLiteD1Database {
  return new SQLiteD1Database(
    [
      "migrations/0001_following_imports.sql",
      "migrations/0002_realtime_service.sql",
      "migrations/0003_accounts_shared_plans.sql",
      "migrations/0004_sanitized_catalog.sql",
      "migrations/0005_shared_plan_crdt_notifications.sql",
      "migrations/0014_sign_in_allowlist.sql",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  );
}

function credentialKey(): string {
  return Buffer.from(
    Uint8Array.from({ length: 32 }, (_, index) => index),
  ).toString("base64url");
}
