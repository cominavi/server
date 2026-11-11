import { sql } from "drizzle-orm";
import { createDatabase } from "../db/client";

// Who may read which catalog data (cominavi/cominavi AGENTS.md, owner
// decisions 2026-11-11). Computed from D1 on every call; it is not a JWT
// claim or a response field.
//
// - review: the App Review account, recognized by a verified provider email
//   listed in the COMINAVI_REVIEW_ACCOUNT_EMAILS Worker secret (comma
//   separated; never in source, the repository is public). Wins over every
//   other tier so the reviewer always gets the content-stripped demo data.
// - circlems: the user has a production Circle.ms identity.
// - allowlisted: a Google/Apple identity bound to an active allowlist entry.
// - none: anything else.

export type AccessTier = "review" | "circlems" | "allowlisted" | "none";

export interface AccessTierBindings {
  COMINAVI_DB: D1Database;
  COMINAVI_REVIEW_ACCOUNT_EMAILS?: string;
}

/**
 * Whether a verified provider email is a configured review address. Matching
 * is case-insensitive and whitespace-trimmed; an unset or empty secret
 * matches nothing. This is the only place an email grants anything.
 */
export function isReviewEmail(
  env: object,
  email: string | null | undefined,
): boolean {
  const candidate = email?.trim().toLowerCase();
  if (!candidate) return false;
  // The secret is set with `wrangler secret put`, so the generated Env type
  // does not declare it.
  const configured = (env as { COMINAVI_REVIEW_ACCOUNT_EMAILS?: unknown })
    .COMINAVI_REVIEW_ACCOUNT_EMAILS;
  if (typeof configured !== "string") return false;
  return configured
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => entry !== "" && entry === candidate);
}

export async function accessTierFor(
  env: AccessTierBindings,
  userID: number,
): Promise<AccessTier> {
  const identities = await createDatabase(env.COMINAVI_DB).all<{
    provider: string;
    provider_environment: string;
    provider_email: string | null;
    allowlisted: number;
  }>(
    sql`SELECT identity.provider, identity.provider_environment,
               identity.provider_email,
               EXISTS (
                 SELECT 1 FROM sign_in_allowlist AS entry
                 WHERE entry.provider = identity.provider
                   AND entry.provider_subject = identity.provider_subject
                   AND entry.revoked_at IS NULL
               ) AS allowlisted
        FROM user_identities AS identity
        JOIN users AS user ON user.id = identity.user_id
        WHERE identity.user_id = ${userID}
          AND user.deletion_pending_at IS NULL`,
  );
  const providerIdentities = identities.filter(
    (identity) =>
      (identity.provider === "google" || identity.provider === "apple") &&
      identity.provider_environment === "",
  );
  if (
    providerIdentities.some((identity) =>
      isReviewEmail(env, identity.provider_email),
    )
  )
    return "review";
  if (
    identities.some(
      (identity) =>
        identity.provider === "circlems" &&
        identity.provider_environment === "production",
    )
  )
    return "circlems";
  if (providerIdentities.some((identity) => identity.allowlisted === 1))
    return "allowlisted";
  return "none";
}
