import { lte, or } from "drizzle-orm";
import { createDatabase } from "../db/client";
import { googleEntryGrants } from "../db/schema";
import { base64URL, sha256Hex } from "./auth-sessions";
import { AuthenticationError } from "./cominavi-auth";

const grantLifetimeSeconds = 5 * 60;
export const appleEntryAudience = "cominavi-ios-apple-sign-in";

export function validateAppleNonce(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw invalidGrant();
  }
  return value;
}

export async function issueAppleEntryGrant(
  database: D1Database,
  nonce: string,
  nowMilliseconds = Date.now(),
): Promise<{ entryGrant: string; expiresAt: string }> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const expiresAt = now + grantLifetimeSeconds;
  const entryGrant = base64URL(crypto.getRandomValues(new Uint8Array(32)));
  const [grantHash, nonceHash] = await Promise.all([
    sha256Hex(entryGrant),
    sha256Hex(nonce),
  ]);
  const db = createDatabase(database);
  const results = await db.batch([
    db
      .delete(googleEntryGrants)
      .where(
        or(
          lte(googleEntryGrants.expiresAt, now),
          lte(googleEntryGrants.consumedAt, now - 24 * 60 * 60),
        ),
      ),
    db.insert(googleEntryGrants).values({
      grantHash,
      nonceHash,
      audience: appleEntryAudience,
      expiresAt,
      consumedAt: null,
      createdAt: now,
    }),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1) throw invalidGrant();
  return {
    entryGrant,
    expiresAt: new Date(expiresAt * 1_000).toISOString(),
  };
}

function invalidGrant(): AuthenticationError {
  return new AuthenticationError(
    "invalid_entry_grant",
    401,
    "The Apple sign-in entry grant is invalid or has already been used.",
  );
}
