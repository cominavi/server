import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { createDatabase } from "../db/client";
import { runDrizzleBatch } from "../db/batch";
import { testIdentities, users } from "../db/schema";
import { apiErrorResponse } from "./api-response";
import { prepareSessionForUser, sha256Hex } from "./auth-sessions";
import type { SessionResponse } from "./auth-sessions";
import type { CominaviIdentity } from "./cominavi-auth";
import { ServiceError } from "./service-error";
import { loadUserProfile } from "./users";

/**
 * Test identity provider (data-layering proposal §7, phase N1).
 *
 * `POST /api/v2/auth/test/session {label}` signs an agent, simulator, or CI
 * run into a stable ComiNavi user named by `label`, with no third-party OAuth.
 * It is for staging and local development only:
 *
 * - Build time: `createHomepageApp` registers the route only when the bundle
 *   was compiled with `__COMINAVI_TEST_IDENTITY_PROVIDER__ = true` (staging
 *   builds and `astro dev`). Production builds fold the call away.
 * - Runtime: every request is refused unless `ENVIRONMENT` is exactly
 *   `staging` or `development` and `COMINAVI_TEST_IDENTITY_SECRET` (at least
 *   32 characters) matches the `X-ComiNavi-Test-Identity-Secret` header.
 *
 * Sessions are minted with the same refresh-family and JWT code path as every
 * other provider. The provider proof is the shared secret presented in this
 * request, so its issuance time is "now": a login is refused while the user is
 * deletion-fenced, and until the clock is strictly after the user's
 * `last_auth_fenced_at` logout fence. Refresh, logout, and account deletion
 * then behave exactly as for real providers. Because the proof is reusable, a
 * lost response is recovered by asking again (a new family), not by replaying
 * a stored result.
 */

export const testIdentitySessionPath = "/api/v2/auth/test/session";
export const testIdentitySecretHeader = "X-ComiNavi-Test-Identity-Secret";

const allowedEnvironments = new Set(["staging", "development"]);
const labelPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const maximumDisplayNameScalars = 80;

export interface TestIdentityBindings {
  ENVIRONMENT?: string;
  COMINAVI_TEST_IDENTITY_SECRET?: string;
  COMINAVI_DB: D1Database;
  COMINAVI_JWT_SECRET: string;
}

export interface TestIdentityRequest {
  label: string;
  displayName?: string;
}

export function registerTestIdentityProvider(
  app: Hono<{ Bindings: Cloudflare.Env }>,
): void {
  app.post(testIdentitySessionPath, async (context) => {
    try {
      await assertTestIdentityAllowed(
        context.env,
        context.req.header(testIdentitySecretHeader),
      );
      const input = parseTestIdentityRequest(
        await context.req.json().catch(() => undefined),
      );
      const session = await authenticateTestIdentity(
        context.env.COMINAVI_DB,
        input,
        context.env.COMINAVI_JWT_SECRET,
      );
      const { avatarURL, ...user } = session.user;
      return context.json(
        { ...session, user: { ...user, ...(avatarURL ? { avatarURL } : {}) } },
        200,
        { "Cache-Control": "private, no-store" },
      );
    } catch (error) {
      const response = apiErrorResponse(error);
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }
  });
}

/**
 * Fails closed: anything other than an explicit non-production environment,
 * a configured secret, and a matching header looks like a missing route.
 */
export async function assertTestIdentityAllowed(
  bindings: Pick<
    TestIdentityBindings,
    "ENVIRONMENT" | "COMINAVI_TEST_IDENTITY_SECRET"
  >,
  presentedSecret: string | undefined,
): Promise<void> {
  const environment = bindings.ENVIRONMENT;
  const secret = bindings.COMINAVI_TEST_IDENTITY_SECRET;
  if (
    typeof environment !== "string" ||
    !allowedEnvironments.has(environment) ||
    typeof secret !== "string" ||
    secret.length < 32
  ) {
    throw notFound();
  }
  if (
    typeof presentedSecret !== "string" ||
    !(await constantTimeEqual(presentedSecret, secret))
  ) {
    throw new ServiceError(
      "invalid_test_identity_secret",
      401,
      "The test identity secret is missing or wrong.",
    );
  }
}

export function parseTestIdentityRequest(value: unknown): TestIdentityRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest();
  }
  const { label, displayName, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw invalidRequest();
  if (typeof label !== "string" || !labelPattern.test(label)) {
    throw invalidRequest();
  }
  if (displayName === undefined) return { label };
  if (typeof displayName !== "string") throw invalidRequest();
  const normalized = displayName.trim();
  const scalars = Array.from(normalized).length;
  if (scalars < 1 || scalars > maximumDisplayNameScalars) {
    throw invalidRequest();
  }
  return { label, displayName: normalized };
}

export async function authenticateTestIdentity(
  database: D1Database,
  input: TestIdentityRequest,
  jwtSecret: string,
  nowMilliseconds = Date.now(),
): Promise<SessionResponse> {
  if (!labelPattern.test(input.label)) throw invalidRequest();
  const now = Math.floor(nowMilliseconds / 1_000);
  let account = await findTestAccount(database, input.label);
  if (!account) {
    const creationError = await createTestAccount(database, input, now);
    account = await findTestAccount(database, input.label);
    // A failed creation is only benign when a concurrent request created the
    // same label; otherwise surface the real error.
    if (!account) throw creationError ?? accountUnavailable();
  }
  if (account.deletionPendingAt !== null) throw accountUnavailable();
  if (account.lastAuthFencedAt !== null && now <= account.lastAuthFencedAt) {
    throw new ServiceError(
      "test_identity_fenced",
      409,
      "This account logged out in the current second. Retry shortly.",
    );
  }

  const identity: CominaviIdentity = {
    subject: account.publicID,
    userID: account.userID,
    authVersion: account.authVersion,
  };
  const prepared = await prepareSessionForUser(
    identity,
    await loadUserProfile(database, account.userID),
    jwtSecret,
    nowMilliseconds,
  );

  // The refresh family is installed only if the user is still on the observed
  // auth epoch, not deletion-fenced, and strictly after any logout fence. A
  // concurrent logout or deletion therefore wins.
  const results = await runDrizzleBatch(database, [
    sql`INSERT INTO auth_refresh_tokens (
          token_hash, user_id, family_id, auth_version, expires_at,
          consumed_at, replaced_by_hash, created_at
        )
        SELECT ${prepared.tokenHash}, id, ${prepared.familyID},
               ${prepared.authVersion}, ${prepared.refreshExpiresAt},
               NULL, NULL, ${prepared.createdAt}
        FROM users
        WHERE id = ${account.userID}
          AND public_id = ${account.publicID}
          AND auth_version = ${account.authVersion}
          AND deletion_pending_at IS NULL
          AND (last_auth_fenced_at IS NULL OR last_auth_fenced_at < ${now})`,
    sql`UPDATE users SET last_authenticated_at = ${now}
        WHERE id = ${account.userID} AND EXISTS (
          SELECT 1 FROM auth_refresh_tokens
          WHERE token_hash = ${prepared.tokenHash}
        )`,
    sql`UPDATE test_identities SET last_authenticated_at = ${now}
        WHERE label = ${input.label} AND user_id = ${account.userID}
          AND EXISTS (
            SELECT 1 FROM auth_refresh_tokens
            WHERE token_hash = ${prepared.tokenHash}
          )`,
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new ServiceError(
      "test_identity_conflict",
      409,
      "The account changed while signing in. Retry.",
    );
  }
  return prepared.response;
}

interface TestAccount {
  userID: number;
  publicID: string;
  authVersion: number;
  deletionPendingAt: number | null;
  lastAuthFencedAt: number | null;
}

async function findTestAccount(
  database: D1Database,
  label: string,
): Promise<TestAccount | null> {
  const row = await createDatabase(database)
    .select({
      userID: users.id,
      publicID: users.publicID,
      authVersion: users.authVersion,
      deletionPendingAt: users.deletionPendingAt,
      lastAuthFencedAt: users.lastAuthFencedAt,
    })
    .from(testIdentities)
    .innerJoin(users, eq(users.id, testIdentities.userID))
    .where(eq(testIdentities.label, label))
    .get();
  return row ?? null;
}

async function createTestAccount(
  database: D1Database,
  input: TestIdentityRequest,
  now: number,
): Promise<unknown> {
  const publicID = randomPublicID();
  const displayName = input.displayName ?? `Test ${input.label}`;
  try {
    // One atomic batch: a label race fails the second insert and rolls the
    // new user back, so no orphan account is left behind.
    await runDrizzleBatch(database, [
      sql`INSERT INTO users (
            public_id, display_name, avatar_provider_url, avatar_object_key,
            avatar_content_type, display_name_edited, avatar_edited,
            avatar_removed, profile_revision, auth_version, created_at,
            updated_at, last_authenticated_at
          ) VALUES (
            ${publicID}, ${displayName}, NULL, NULL, NULL,
            0, 0, 0, 1, 1, ${now}, ${now}, ${now}
          )`,
      sql`INSERT INTO test_identities (
            label, user_id, created_at, last_authenticated_at
          )
          SELECT ${input.label}, id, ${now}, ${now}
          FROM users WHERE public_id = ${publicID}`,
    ]);
  } catch (error) {
    // Usually a lost creation race for the same label; the caller re-reads
    // and rethrows this error if the label still does not exist.
    return error;
  }
  return undefined;
}

async function constantTimeEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(left), sha256Hex(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function randomPublicID(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// Same body as an unknown /api/v2 route, so a refused request does not reveal
// that the provider was compiled in.
function notFound(): ServiceError {
  return new ServiceError("not_found", 404, "The API route was not found.");
}

function invalidRequest(): ServiceError {
  return new ServiceError(
    "invalid_test_identity_request",
    400,
    "label must match ^[a-z0-9][a-z0-9-]{0,63}$; displayName, if present, must have 1-80 characters.",
  );
}

function accountUnavailable(): ServiceError {
  return new ServiceError(
    "account_unavailable",
    409,
    "This test account is being deleted.",
  );
}
