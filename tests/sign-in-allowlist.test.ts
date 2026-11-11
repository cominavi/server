import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { authenticateAppleRequest } from "../src/lib/server/apple-auth-flow";
import { issueAppleEntryGrant } from "../src/lib/server/apple-entry-grants";
import { rotateSession } from "../src/lib/server/auth-sessions";
import { completeGoogleAuthentication } from "../src/lib/server/google-auth-flow";
import { issueGoogleEntryGrant } from "../src/lib/server/google-entry-grants";
import {
  handleEntryPageGET,
  handleEntryPagePOST,
} from "../src/lib/server/sign-in-entry-page";
import {
  findRedeemableInvite,
  inviteCodeHash as workerInviteCodeHash,
  normalizeInviteCode,
} from "../src/lib/server/sign-in-allowlist";
import {
  generateInviteCode,
  inviteCodeHash,
  inviteSQL,
  listSQL,
  revokeSQL,
} from "../tools/sign-in-allowlist";
import { SQLiteD1Database } from "./sqlite-d1";

const secret = "test-jwt-secret-that-is-at-least-thirty-two-bytes";
const googleNonce = "n".repeat(32);
const appleNonce = "a".repeat(43);
const google = (subject: string) => ({
  provider: "google" as const,
  environment: "" as const,
  subject,
  email: "same-address@example.test",
  displayName: "Friend",
});
const apple = (subject: string) => ({
  provider: "apple" as const,
  environment: "" as const,
  subject,
  clientID: "llc.mikunet.cominavi",
});

test("an identity that is not allowlisted is refused before any account exists", async () => {
  const database = setup();
  const grant = await issueGoogleEntryGrant(
    database.binding,
    googleNonce,
    100_000,
  );
  await assert.rejects(
    signInGoogle(database, google("stranger"), grant.entryGrant, 1),
    (error: unknown) => hasCode(error, "sign_in_not_allowlisted"),
  );
  assert.equal(count(database, "users"), 0);
  assert.equal(count(database, "user_identities"), 0);
  assert.equal(
    database.rows("SELECT consumed_at FROM google_entry_grants")[0]
      ?.consumed_at,
    null,
  );
});

test("an invite binds to the first identity that redeems it, and only once", async () => {
  const database = setup();
  const code = generateInviteCode();
  const entryID = "1".repeat(32);
  database.native.exec(
    inviteSQL({
      entryID,
      label: "Friend's test phone",
      codeHash: inviteCodeHash(code),
      now: 50,
      expiresAt: null,
    }),
  );
  // Typed loosely: lowercase, without dashes.
  const typed = code.toLowerCase().replaceAll("-", " ");
  assert.equal(
    await findRedeemableInvite(database.binding, typed, 100),
    entryID,
  );

  const grant = await issueGoogleEntryGrant(
    database.binding,
    googleNonce,
    100_000,
    entryID,
  );
  const signedIn = await signInGoogle(
    database,
    google("friend"),
    grant.entryGrant,
    1,
  );
  assert.ok(signedIn.response.user.id);
  assert.deepEqual(
    database.rows(
      "SELECT provider, provider_subject, bound_at FROM sign_in_allowlist",
    ),
    [{ provider: "google", provider_subject: "friend", bound_at: 101 }],
  );
  assert.equal(await findRedeemableInvite(database.binding, code, 102), null);

  // The same email on a different Google subject is not admitted.
  const second = await issueGoogleEntryGrant(
    database.binding,
    googleNonce,
    102_000,
    entryID,
  );
  await assert.rejects(
    signInGoogle(database, google("someone-else"), second.entryGrant, 2),
    (error: unknown) => hasCode(error, "sign_in_not_allowlisted"),
  );

  // The bound identity signs in again without any code.
  const again = await issueGoogleEntryGrant(
    database.binding,
    googleNonce,
    103_000,
  );
  const reauth = await signInGoogle(
    database,
    google("friend"),
    again.entryGrant,
    3,
  );
  assert.equal(reauth.response.user.id, signedIn.response.user.id);
});

test("an already admitted identity does not spend a code it carries", async () => {
  const database = setup();
  bind(database, "2".repeat(32), "google", "friend");
  const code = generateInviteCode();
  const spare = "3".repeat(32);
  database.native.exec(
    inviteSQL({
      entryID: spare,
      label: "spare",
      codeHash: inviteCodeHash(code),
      now: 50,
      expiresAt: null,
    }),
  );
  const grant = await issueGoogleEntryGrant(
    database.binding,
    googleNonce,
    100_000,
    spare,
  );
  await signInGoogle(database, google("friend"), grant.entryGrant, 1);
  assert.equal(await findRedeemableInvite(database.binding, code, 102), spare);
});

test("expired and revoked invites are not redeemable", async () => {
  const database = setup();
  const expired = generateInviteCode();
  const revoked = generateInviteCode();
  database.native.exec(
    inviteSQL({
      entryID: "4".repeat(32),
      label: "expired",
      codeHash: inviteCodeHash(expired),
      now: 50,
      expiresAt: 90,
    }) +
      inviteSQL({
        entryID: "5".repeat(32),
        label: "revoked",
        codeHash: inviteCodeHash(revoked),
        now: 50,
        expiresAt: null,
      }) +
      revokeSQL("5".repeat(32), 60),
  );
  assert.equal(
    await findRedeemableInvite(database.binding, expired, 100),
    null,
  );
  assert.equal(
    await findRedeemableInvite(database.binding, revoked, 100),
    null,
  );
  assert.equal(await findRedeemableInvite(database.binding, "nope", 100), null);
});

test("revoking an entry ends the user's sessions and refuses the next sign-in", async () => {
  const database = setup();
  const entryID = "6".repeat(32);
  bind(database, entryID, "google", "friend");
  const grant = await issueGoogleEntryGrant(
    database.binding,
    googleNonce,
    100_000,
  );
  const signedIn = await signInGoogle(
    database,
    google("friend"),
    grant.entryGrant,
    1,
  );
  database.native.exec(revokeSQL(entryID, 200));
  assert.deepEqual(
    database.rows("SELECT auth_version, last_auth_fenced_at FROM users"),
    [{ auth_version: 2, last_auth_fenced_at: 200 }],
  );
  await assert.rejects(
    rotateSession(
      database.binding,
      signedIn.response.refreshToken,
      secret,
      201_000,
    ),
  );
  const next = await issueGoogleEntryGrant(
    database.binding,
    googleNonce,
    300_000,
  );
  await assert.rejects(
    completeGoogleAuthentication(
      database.binding,
      { ...google("friend"), issuedAt: 299 },
      "verified-google-id-token",
      next.entryGrant,
      googleNonce,
      "33333333-3333-4333-8333-333333333333",
      secret,
      credentialKey(),
      301_000,
      () => 301,
    ),
    (error: unknown) => hasCode(error, "sign_in_not_allowlisted"),
  );
  assert.match(listSQL, /FROM sign_in_allowlist/);
  assert.equal(database.native.prepare(listSQL).all()[0]?.revoked_at, 200);
});

test("a user with a production Circle.ms identity is admitted without an entry", async () => {
  const database = setup();
  const entryID = "7".repeat(32);
  bind(database, entryID, "google", "friend");
  const grant = await issueGoogleEntryGrant(
    database.binding,
    googleNonce,
    100_000,
  );
  const signedIn = await signInGoogle(
    database,
    google("friend"),
    grant.entryGrant,
    1,
  );
  database.native.exec(`
    INSERT INTO user_identities (
      user_id, provider, provider_environment, provider_subject,
      created_at, updated_at, last_authenticated_at
    )
    SELECT user_id, 'circlems', 'production', '424242', 150, 150, 150
    FROM user_identities WHERE provider = 'google';
  `);
  // Revoking leaves a Circle.ms user's sessions alone.
  database.native.exec(revokeSQL(entryID, 200));
  assert.equal(
    database.rows("SELECT auth_version FROM users")[0]?.auth_version,
    1,
  );
  const next = await issueGoogleEntryGrant(
    database.binding,
    googleNonce,
    300_000,
  );
  const reauth = await completeGoogleAuthentication(
    database.binding,
    google("friend"),
    "verified-google-id-token",
    next.entryGrant,
    googleNonce,
    "44444444-4444-4444-8444-444444444444",
    secret,
    credentialKey(),
    301_000,
    () => 301,
  );
  assert.equal(reauth.response.user.id, signedIn.response.user.id);
});

test("Apple refuses an unlisted identity before exchanging its code, and redeems an invite", async () => {
  const database = setup();
  const refused = await issueAppleEntryGrant(
    database.binding,
    appleNonce,
    100_000,
  );
  let exchanges = 0;
  const exchange = async () => {
    exchanges += 1;
    return { refreshToken: "apple-refresh", clientID: apple("x").clientID };
  };
  await assert.rejects(
    signInApple(
      database,
      apple("hidden-email-user"),
      refused.entryGrant,
      1,
      exchange,
    ),
    (error: unknown) => hasCode(error, "sign_in_not_allowlisted"),
  );
  assert.equal(exchanges, 0);
  assert.equal(count(database, "apple_auth_requests"), 0);

  const code = generateInviteCode();
  const entryID = "8".repeat(32);
  database.native.exec(
    inviteSQL({
      entryID,
      label: "Apple friend",
      codeHash: inviteCodeHash(code),
      now: 50,
      expiresAt: null,
    }),
  );
  const invited = await issueAppleEntryGrant(
    database.binding,
    appleNonce,
    110_000,
    entryID,
  );
  await signInApple(
    database,
    apple("hidden-email-user"),
    invited.entryGrant,
    2,
    exchange,
  );
  assert.equal(exchanges, 1);
  assert.deepEqual(
    database.rows("SELECT provider, provider_subject FROM sign_in_allowlist"),
    [{ provider: "apple", provider_subject: "hidden-email-user" }],
  );
  assert.equal(count(database, "users"), 1);
});

test("the migration grandfathers every existing Google and Apple identity", () => {
  const database = new SQLiteD1Database(
    migrationsThrough0005() +
      `
      INSERT INTO users (
        id, public_id, display_name, display_name_edited, avatar_edited,
        avatar_removed, profile_revision, auth_version, created_at,
        updated_at, last_authenticated_at
      ) VALUES
        (1, '${"a".repeat(32)}', 'G', 0, 0, 0, 1, 1, 1, 1, 1),
        (2, '${"b".repeat(32)}', 'A', 0, 0, 0, 1, 1, 1, 1, 1),
        (3, '${"c".repeat(32)}', 'C', 0, 0, 0, 1, 1, 1, 1, 1);
      INSERT INTO user_identities (
        user_id, provider, provider_environment, provider_subject,
        created_at, updated_at, last_authenticated_at
      ) VALUES
        (1, 'google', '', 'g-1', 1, 1, 1),
        (2, 'apple', '', 'a-2', 1, 1, 1),
        (3, 'circlems', 'production', '3', 1, 1, 1);
      ` +
      readFileSync("migrations/0014_sign_in_allowlist.sql", "utf8"),
  );
  const rows = database.rows(
    `SELECT provider, provider_subject, label, invite_code_hash, revoked_at
     FROM sign_in_allowlist ORDER BY provider`,
  );
  assert.deepEqual(rows, [
    {
      provider: "apple",
      provider_subject: "a-2",
      label: `grandfathered apple user ${"b".repeat(32)}`,
      invite_code_hash: null,
      revoked_at: null,
    },
    {
      provider: "google",
      provider_subject: "g-1",
      label: `grandfathered google user ${"a".repeat(32)}`,
      invite_code_hash: null,
      revoked_at: null,
    },
  ]);
});

test("tool and Worker hash the same canonical invite code", async () => {
  for (let index = 0; index < 20; index += 1) {
    const code = generateInviteCode();
    assert.match(code, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    assert.doesNotMatch(code, /[ILOU]/);
    const canonical = normalizeInviteCode(code)!;
    assert.equal(await workerInviteCodeHash(canonical), inviteCodeHash(code));
  }
  assert.equal(
    normalizeInviteCode("oooo0-iiiil-11111-00000"),
    "0".repeat(5) + "1".repeat(10) + "0".repeat(5),
  );
  assert.equal(normalizeInviteCode("too-short"), null);
  assert.equal(normalizeInviteCode("UUUUU-UUUUU-UUUUU-UUUUU"), null);
  assert.throws(() => revokeSQL("'; DROP TABLE users; --", 1));
  assert.match(
    inviteSQL({
      entryID: "9".repeat(32),
      label: "O'Brien",
      codeHash: "f".repeat(64),
      now: 1,
      expiresAt: null,
    }),
    /'O''Brien'/,
  );
});

test("a revocation that lands between the check and the commit rolls the sign-in back", async () => {
  const database = setup();
  const entryID = "a".repeat(32);
  bind(database, entryID, "google", "friend");
  const grant = await issueGoogleEntryGrant(
    database.binding,
    googleNonce,
    100_000,
  );
  database.beforeNextBatch = () =>
    database.native.exec(revokeSQL(entryID, 100));
  await assert.rejects(
    signInGoogle(database, google("friend"), grant.entryGrant, 1),
  );
  assert.equal(count(database, "users"), 0);
  assert.equal(count(database, "auth_refresh_tokens"), 0);
});

test("the entry page asks for an optional code and returns a grant that carries it", async () => {
  const database = setup();
  const env = {
    COMINAVI_DB: database.binding,
    COMINAVI_INVITE_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const page = await handleEntryPageGET(
    "apple",
    new Request(`https://cominavi.net/auth/apple?nonce=${appleNonce}`),
    env,
  );
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("Cache-Control"), "no-store");
  const html = await page.text();
  assert.match(html, /name="inviteCode"/);
  assert.match(html, new RegExp(`value="${appleNonce}"`));

  const badNonce = await handleEntryPageGET(
    "apple",
    new Request("https://cominavi.net/auth/apple?nonce=%22%3E%3Cscript%3E"),
    env,
  );
  assert.equal(badNonce.status, 302);
  assert.equal(badNonce.headers.get("Location"), "/");

  const post = (fields: Record<string, string>) =>
    handleEntryPagePOST(
      "apple",
      new Request("https://cominavi.net/auth/apple", {
        method: "POST",
        body: new URLSearchParams(fields),
      }),
      env,
    );
  const wrong = await post({
    nonce: appleNonce,
    inviteCode: "AAAAA-AAAAA-AAAAA-AAAAA",
  });
  assert.equal(wrong.status, 400);
  assert.match(await wrong.text(), /role="alert"/);
  assert.equal(count(database, "google_entry_grants"), 0);

  const empty = await post({ nonce: appleNonce, inviteCode: "" });
  assert.equal(empty.status, 302);
  assert.match(
    empty.headers.get("Location")!,
    /^cominavi:\/\/auth\/apple\/grant\?/,
  );
  assert.deepEqual(
    database.rows("SELECT allowlist_entry_id FROM google_entry_grants"),
    [{ allowlist_entry_id: null }],
  );

  const code = generateInviteCode();
  database.native.exec(
    inviteSQL({
      entryID: "b".repeat(32),
      label: "page",
      codeHash: inviteCodeHash(code),
      now: Math.floor(Date.now() / 1_000) - 1,
      expiresAt: null,
    }),
  );
  const invited = await post({ nonce: appleNonce, inviteCode: code });
  assert.equal(invited.status, 302);
  const callback = new URL(invited.headers.get("Location")!);
  assert.deepEqual([...callback.searchParams.keys()].sort(), [
    "entryGrant",
    "expiresAt",
    "nonce",
  ]);
  assert.equal(
    database.rows(
      "SELECT count(*) AS count FROM google_entry_grants WHERE allowlist_entry_id = '" +
        "b".repeat(32) +
        "'",
    )[0]?.count,
    1,
  );

  const limited = await handleEntryPagePOST(
    "apple",
    new Request("https://cominavi.net/auth/apple", {
      method: "POST",
      body: new URLSearchParams({ nonce: appleNonce }),
    }),
    {
      ...env,
      COMINAVI_INVITE_RATE_LIMITER: { limit: async () => ({ success: false }) },
    },
  );
  assert.equal(limited.headers.get("Location"), "/");
});

function setup(): SQLiteD1Database {
  return new SQLiteD1Database(
    migrationsThrough0005() +
      readFileSync("migrations/0014_sign_in_allowlist.sql", "utf8"),
  );
}

function migrationsThrough0005(): string {
  return [
    "migrations/0001_following_imports.sql",
    "migrations/0002_realtime_service.sql",
    "migrations/0003_accounts_shared_plans.sql",
    "migrations/0004_sanitized_catalog.sql",
    "migrations/0005_shared_plan_crdt_notifications.sql",
  ]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

function bind(
  database: SQLiteD1Database,
  entryID: string,
  provider: "google" | "apple",
  subject: string,
): void {
  database.native.exec(`
    INSERT INTO sign_in_allowlist (
      entry_id, label, provider, provider_subject, bound_at, created_at
    ) VALUES ('${entryID}', 'test', '${provider}', '${subject}', 10, 10);
  `);
}

function signInGoogle(
  database: SQLiteD1Database,
  identity: ReturnType<typeof google>,
  entryGrant: string,
  attempt: number,
) {
  const at = 100 + attempt;
  return completeGoogleAuthentication(
    database.binding,
    identity,
    "verified-google-id-token",
    entryGrant,
    googleNonce,
    `2222222${attempt}-2222-4222-8222-222222222222`,
    secret,
    credentialKey(),
    at * 1_000,
    () => at,
  );
}

function signInApple(
  database: SQLiteD1Database,
  identity: ReturnType<typeof apple>,
  entryGrant: string,
  attempt: number,
  exchange: () => Promise<{ refreshToken: string; clientID: string }>,
) {
  const at = 100 + attempt * 10 + 1;
  return authenticateAppleRequest(
    database.binding,
    {
      requestID: `7777777${attempt}-7777-4777-8777-777777777777`,
      identityToken: "verified-apple-identity-token",
      authorizationCode: `single-use-authorization-code-${attempt}`,
      entryGrant,
      nonce: appleNonce,
    },
    secret,
    credentialKey(),
    async () => identity,
    exchange,
    at * 1_000,
    () => at,
  );
}

function count(database: SQLiteD1Database, table: string): number {
  return database.rows(`SELECT count(*) AS count FROM ${table}`)[0]
    ?.count as number;
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
