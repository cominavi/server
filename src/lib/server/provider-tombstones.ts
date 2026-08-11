import { and, eq } from "drizzle-orm";
import { createDatabase } from "../db/client";
import { deletedProviderIdentityTombstones } from "../db/schema";
import { decodeBase64URL } from "./auth-sessions";
import { ServiceError } from "./service-error";

export async function providerSubjectDigest(
  provider: "circlems" | "google" | "apple",
  environment: string,
  subject: string,
  encodedKey: string,
): Promise<string> {
  const keyBytes = Uint8Array.from(decodeBase64URL(encodedKey));
  if (keyBytes.byteLength !== 32) throw unavailable();
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        `provider-subject-tombstone:v1:${provider}:${environment}:${subject}`,
      ),
    ),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function assertProviderProofAfterDeletion(
  database: D1Database,
  provider: "circlems" | "google" | "apple",
  environment: string,
  subjectDigest: string,
  proofIssuedAt: number | undefined,
): Promise<void> {
  const row = await createDatabase(database)
    .select({ deletedAt: deletedProviderIdentityTombstones.deletedAt })
    .from(deletedProviderIdentityTombstones)
    .where(
      and(
        eq(deletedProviderIdentityTombstones.provider, provider),
        eq(deletedProviderIdentityTombstones.providerEnvironment, environment),
        eq(
          deletedProviderIdentityTombstones.providerSubjectDigest,
          subjectDigest,
        ),
      ),
    )
    .get();
  if (row && (!proofIssuedAt || proofIssuedAt <= row.deletedAt)) {
    throw new ServiceError(
      "provider_identity_deleted",
      401,
      "This provider proof predates account deletion. Start a fresh authorization.",
    );
  }
}

function unavailable(): ServiceError {
  return new ServiceError(
    "authentication_unavailable",
    503,
    "Provider identity deletion fencing is unavailable.",
  );
}
