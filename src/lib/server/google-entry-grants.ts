import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { createDatabase } from "../db/client";
import { googleEntryGrants } from "../db/schema";
import { base64URL, sha256Hex } from "./auth-sessions";
import { AuthenticationError } from "./cominavi-auth";

const grantLifetimeSeconds = 5 * 60;
const audience = "cominavi-ios-google-sign-in";

export function validateGoogleNonce(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22,128}$/.test(value)) {
    throw new AuthenticationError(
      "invalid_entry_grant",
      400,
      "A valid Google sign-in nonce is required.",
    );
  }
  return value;
}

export async function issueGoogleEntryGrant(
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
      audience,
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

export async function consumeGoogleEntryGrant(
  database: D1Database,
  entryGrant: string,
  nonce: string,
  nowMilliseconds = Date.now(),
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(entryGrant)) throw invalidGrant();
  const now = Math.floor(nowMilliseconds / 1_000);
  const [grantHash, nonceHash] = await Promise.all([
    sha256Hex(entryGrant),
    sha256Hex(nonce),
  ]);
  const result = await createDatabase(database)
    .update(googleEntryGrants)
    .set({ consumedAt: now })
    .where(
      and(
        eq(googleEntryGrants.grantHash, grantHash),
        eq(googleEntryGrants.nonceHash, nonceHash),
        eq(googleEntryGrants.audience, audience),
        gt(googleEntryGrants.expiresAt, now),
        isNull(googleEntryGrants.consumedAt),
      ),
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) throw invalidGrant();
}

function invalidGrant(): AuthenticationError {
  return new AuthenticationError(
    "invalid_entry_grant",
    401,
    "The Google sign-in entry grant is invalid or has already been used.",
  );
}
