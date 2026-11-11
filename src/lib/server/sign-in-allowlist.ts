import { sql, type SQL } from "drizzle-orm";
import { createDatabase } from "../db/client";
import { sha256Hex } from "./auth-sessions";
import { ServiceError } from "./service-error";

// Google and Apple sign-in are allowlist-only (cominavi/cominavi AGENTS.md,
// owner decision 2026-11-11). An identity is admitted when it is bound to an
// active allowlist entry, when this sign-in redeems the invite its entry grant
// carries, or when its user already has a production Circle.ms identity.
// Nothing here ever matches an email address.

export type AllowlistProvider = "google" | "apple";

/**
 * Set by the API layer on a verified provider identity whose verified email
 * is a configured App Review address (`isReviewEmail` in access-tier.ts).
 * Such an identity is admitted without an allowlist entry or invite.
 */
export interface SignInAdmission {
  reviewAccount?: boolean;
}

const inviteAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const inviteLength = 20;

/**
 * Canonical form of a typed invite code (Crockford base32: case-insensitive,
 * separators ignored, O→0 and I/L→1), or null when it cannot be one.
 */
export function normalizeInviteCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const canonical = value
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (canonical.length !== inviteLength) return null;
  for (const character of canonical)
    if (!inviteAlphabet.includes(character)) return null;
  return canonical;
}

export async function inviteCodeHash(canonical: string): Promise<string> {
  return sha256Hex(`cominavi-sign-in-invite:v1:${canonical}`);
}

/** Entry ID of an unredeemed, unrevoked, unexpired invite, or null. */
export async function findRedeemableInvite(
  database: D1Database,
  code: unknown,
  now: number,
): Promise<string | null> {
  const canonical = normalizeInviteCode(code);
  if (!canonical) return null;
  const hash = await inviteCodeHash(canonical);
  const row = await createDatabase(database).get<{ entry_id: string }>(
    sql`SELECT entry_id FROM sign_in_allowlist
        WHERE invite_code_hash = ${hash} AND provider IS NULL
          AND revoked_at IS NULL
          AND (invite_expires_at IS NULL OR invite_expires_at > ${now})`,
  );
  return row?.entry_id ?? null;
}

/**
 * SQL text predicate: this identity may sign in without a new invite.
 * `provider` and `subject` are SQL expressions, normally bound parameters.
 */
export function admittedIdentityClause(
  provider: string,
  subject: string,
): string {
  return `(EXISTS (
      SELECT 1 FROM sign_in_allowlist
      WHERE provider = ${provider} AND provider_subject = ${subject}
        AND revoked_at IS NULL
    ) OR EXISTS (
      SELECT 1 FROM user_identities AS admitted_identity
      JOIN user_identities AS circlems_identity
        ON circlems_identity.user_id = admitted_identity.user_id
      WHERE admitted_identity.provider = ${provider}
        AND admitted_identity.provider_environment = ''
        AND admitted_identity.provider_subject = ${subject}
        AND circlems_identity.provider = 'circlems'
        AND circlems_identity.provider_environment = 'production'
    ))`;
}

/** Drizzle form of `admittedIdentityClause` with bound parameters. */
export function admittedIdentitySQL(
  provider: AllowlistProvider,
  subject: string,
): SQL {
  // Placeholders are spliced back in as bound parameters, never as text.
  return sql.join(
    admittedIdentityClause("\u0000P", "\u0000S")
      .split(/(\u0000[PS])/)
      .map((part) =>
        part === "\u0000P"
          ? sql`${provider}`
          : part === "\u0000S"
            ? sql`${subject}`
            : sql.raw(part),
      ),
  );
}

/**
 * Binds the invite carried by a live entry grant to this identity. It is a
 * no-op when the identity is already admitted, so a code is never spent on
 * someone who did not need it. Must run in the same batch as, and before, the
 * statement that consumes the grant under `admittedIdentitySQL`.
 */
export function redeemGrantInviteSQL(
  provider: AllowlistProvider,
  subject: string,
  grantHash: string,
  nonceHash: string,
  audience: string,
  now: number,
  reviewAccount = false,
): SQL {
  return sql`UPDATE sign_in_allowlist
    SET provider = ${provider}, provider_subject = ${subject},
        bound_at = ${now}
    WHERE entry_id = (
        SELECT allowlist_entry_id FROM google_entry_grants
        WHERE grant_hash = ${grantHash} AND nonce_hash = ${nonceHash}
          AND audience = ${audience} AND expires_at > ${now}
          AND consumed_at IS NULL
      )
      AND provider IS NULL AND revoked_at IS NULL
      AND invite_code_hash IS NOT NULL
      AND (invite_expires_at IS NULL OR invite_expires_at > ${now})
      AND ${reviewAccount ? 1 : 0} = 0
      AND NOT ${admittedIdentitySQL(provider, subject)}`;
}

/** Batch guard on the grant-consuming statement. */
export function signInAdmittedSQL(
  provider: AllowlistProvider,
  subject: string,
  reviewAccount = false,
): SQL {
  return sql`(${reviewAccount ? 1 : 0} = 1 OR ${admittedIdentitySQL(provider, subject)})`;
}

/** Whether an identity may sign in without redeeming a new invite. */
export async function isIdentityAdmitted(
  database: D1Database,
  provider: AllowlistProvider,
  subject: string,
  reviewAccount = false,
): Promise<boolean> {
  if (reviewAccount) return true;
  const row = await createDatabase(database).get<{ admitted: number }>(
    sql`SELECT ${admittedIdentitySQL(provider, subject)} AS admitted`,
  );
  return row?.admitted === 1;
}

/**
 * Pre-commit check so a refused identity gets a typed error before any
 * provider exchange. The batch re-checks atomically.
 */
export async function assertSignInAllowed(
  database: D1Database,
  provider: AllowlistProvider,
  subject: string,
  grantHash: string,
  now: number,
  reviewAccount = false,
): Promise<void> {
  if (reviewAccount) return;
  const row = await createDatabase(database).get<{ allowed: number }>(
    sql`SELECT ${admittedIdentitySQL(provider, subject)} OR EXISTS (
          SELECT 1 FROM google_entry_grants AS grant
          JOIN sign_in_allowlist AS entry
            ON entry.entry_id = grant.allowlist_entry_id
          WHERE grant.grant_hash = ${grantHash} AND entry.provider IS NULL
            AND entry.revoked_at IS NULL
            AND entry.invite_code_hash IS NOT NULL
            AND (entry.invite_expires_at IS NULL
              OR entry.invite_expires_at > ${now})
        ) AS allowed`,
  );
  if (row?.allowed !== 1) throw signInNotAllowlisted(provider);
}

export function signInNotAllowlisted(
  provider: AllowlistProvider,
): ServiceError {
  const name = provider === "google" ? "Google" : "Apple";
  return new ServiceError(
    "sign_in_not_allowlisted",
    403,
    `This ${name} account is not on the ComiNavi sign-in allowlist. Sign in with Circle.ms instead.`,
  );
}
