import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import { createDatabase } from "../db/client";
import {
  avatarObjectCleanup,
  providerAvatarImportJobs,
  sharedPlanMembers,
  sharedPlanRequests,
  users,
} from "../db/schema";
import type { CominaviIdentity } from "./cominavi-auth";
import { ServiceError } from "./service-error";
import { loadUserProfile, setUserAvatar } from "./users";
import { sha256Hex } from "./auth-sessions";
import { parseCanonicalRequestID } from "./request-id";
import {
  cancelQueuedAvatarCleanup,
  enqueueAvatarCleanup,
  enqueueAvatarPrewriteCleanup,
} from "./avatar-cleanup";

const maximumAvatarBytes = 2 * 1024 * 1024;

export function parseProfileRevisionPrecondition(request: Request): number {
  const value = request.headers.get("If-Match")?.trim();
  const match = value ? /^"profile:(\d+)"$/.exec(value) : null;
  const revision = Number(match?.[1]);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ServiceError(
      "profile_precondition_required",
      428,
      'If-Match must contain the current profile revision, for example "profile:3".',
    );
  }
  return revision;
}

export async function replaceAvatar(
  database: D1Database,
  bucket: R2Bucket,
  identity: CominaviIdentity,
  request: Request,
  hooks: { afterObjectStored?: () => Promise<void> } = {},
): Promise<Awaited<ReturnType<typeof setUserAvatar>>["profile"]> {
  const baseRevision = parseProfileRevisionPrecondition(request);
  const requestID = parseIdempotencyKey(request);
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumAvatarBytes) {
    throw invalidAvatar();
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length < 12 || bytes.length > maximumAvatarBytes)
    throw invalidAvatar();
  const detected = detectImage(bytes);
  const declared = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim();
  if (!detected || declared !== detected.contentType) throw invalidAvatar();

  const contentHash = await sha256Bytes(bytes);
  const objectKey = `users/${identity.subject}/${crypto.randomUUID()}-${contentHash}.${detected.extension}`;
  const receipt = {
    scope: `users:${identity.subject}:avatar`,
    requestID,
    payloadHash: await sha256Hex(`put:${baseRevision}:${contentHash}`),
    prewriteObjectKey: objectKey,
  };
  await enqueueAvatarPrewriteCleanup(database, objectKey);
  try {
    await bucket.put(objectKey, bytes, {
      httpMetadata: { contentType: detected.contentType },
      customMetadata: { owner: identity.subject },
    });
  } catch (error) {
    await discardUnpublishedAvatar(database, bucket, objectKey);
    throw error;
  }
  await hooks.afterObjectStored?.();
  let updated: Awaited<ReturnType<typeof setUserAvatar>>;
  try {
    updated = await setUserAvatar(
      database,
      identity,
      baseRevision,
      objectKey,
      detected.contentType,
      receipt,
    );
  } catch (error) {
    const committed = await avatarMutationCommitted(
      database,
      identity,
      objectKey,
      receipt,
    );
    if (committed === true) {
      return loadUserProfile(database, identity.userID);
    }
    if (committed === false) {
      await discardUnpublishedAvatar(database, bucket, objectKey);
    }
    throw error;
  }
  if (updated.replayed) {
    await discardUnpublishedAvatar(database, bucket, objectKey);
    return updated.profile;
  }
  return updated.profile;
}

async function avatarMutationCommitted(
  database: D1Database,
  identity: CominaviIdentity,
  objectKey: string,
  receipt: { scope: string; requestID: string; payloadHash: string },
): Promise<boolean | null> {
  try {
    const row = await createDatabase(database)
      .select({ committed: sql<number>`1` })
      .from(users)
      .innerJoin(sharedPlanRequests, eq(sharedPlanRequests.userID, users.id))
      .where(
        and(
          eq(users.id, identity.userID),
          eq(users.publicID, identity.subject),
          eq(users.avatarObjectKey, objectKey),
          eq(users.lastMutationScope, receipt.scope),
          eq(users.lastMutationRequestID, receipt.requestID),
          eq(users.lastMutationPayloadHash, receipt.payloadHash),
          eq(sharedPlanRequests.scope, receipt.scope),
          eq(sharedPlanRequests.requestID, receipt.requestID),
          eq(sharedPlanRequests.payloadHash, receipt.payloadHash),
          eq(sharedPlanRequests.operation, "avatar"),
        ),
      )
      .get();
    return row !== undefined;
  } catch {
    return null;
  }
}

export async function removeAvatar(
  database: D1Database,
  identity: CominaviIdentity,
  request: Request,
): Promise<Awaited<ReturnType<typeof setUserAvatar>>["profile"]> {
  const baseRevision = parseProfileRevisionPrecondition(request);
  const requestID = parseIdempotencyKey(request);
  const updated = await setUserAvatar(
    database,
    identity,
    baseRevision,
    null,
    null,
    {
      scope: `users:${identity.subject}:avatar`,
      requestID,
      payloadHash: await sha256Hex(`delete:${baseRevision}`),
    },
  );
  return updated.profile;
}

function parseIdempotencyKey(request: Request): string {
  return parseCanonicalRequestID(request.headers.get("Idempotency-Key"));
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function loadAvatar(
  database: D1Database,
  bucket: R2Bucket,
  requester: CominaviIdentity,
  targetUserID: number,
): Promise<Response> {
  const db = createDatabase(database);
  const mine = alias(sharedPlanMembers, "mine");
  const theirs = alias(sharedPlanMembers, "theirs");
  const sharedMembership = db
    .select({ value: sql<number>`1` })
    .from(mine)
    .innerJoin(theirs, eq(theirs.planID, mine.planID))
    .where(
      and(
        eq(mine.userID, requester.userID),
        isNull(mine.revokedAt),
        eq(theirs.userID, users.id),
        isNull(theirs.revokedAt),
      ),
    );
  const row = await db
    .select({
      avatar_object_key: users.avatarObjectKey,
      avatar_content_type: users.avatarContentType,
    })
    .from(users)
    .where(
      and(
        eq(users.id, targetUserID),
        sql`${users.avatarObjectKey} IS NOT NULL`,
        sql`(${users.id} = ${requester.userID} OR ${exists(sharedMembership)})`,
      ),
    )
    .get();
  if (!row)
    throw new ServiceError("avatar_not_found", 404, "Avatar not found.");
  if (row.avatar_object_key && row.avatar_content_type) {
    const object = await bucket.get(row.avatar_object_key);
    if (!object)
      throw new ServiceError("avatar_not_found", 404, "Avatar not found.");
    return new Response(object.body, {
      headers: {
        "Content-Type": row.avatar_content_type,
        "Content-Length": String(object.size),
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        ETag: object.httpEtag,
      },
    });
  }
  throw new ServiceError("avatar_not_found", 404, "Avatar not found.");
}

export async function importProviderAvatar(
  database: D1Database,
  bucket: R2Bucket,
  identity: CominaviIdentity,
  providerAvatarURL: string | null | undefined,
  fetcher: typeof fetch = fetch,
  authority:
    | {
        userIdentityID: number;
        providerAvatarURL: string;
        jobRevision: number;
        leaseID: string;
      }
    | undefined = undefined,
  hooks: { afterObjectStored?: () => Promise<void> } = {},
): Promise<boolean> {
  const providerURL = safeProviderAvatarURL(providerAvatarURL ?? null);
  if (!providerURL) return false;
  const db = createDatabase(database);
  const current = await db
    .select({
      avatar_edited: users.avatarEdited,
      avatar_object_key: users.avatarObjectKey,
    })
    .from(users)
    .where(
      and(
        eq(users.id, identity.userID),
        eq(users.publicID, identity.subject),
        isNull(users.deletionPendingAt),
      ),
    )
    .get();
  if (!current || current.avatar_edited === 1) return false;
  let objectKey: string | null = null;
  let preserveCleanupIntent = false;
  try {
    const response = await fetcher(providerURL, {
      headers: { Accept: "image/webp,image/png,image/jpeg" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const declaredLength = Number(
      response.headers.get("Content-Length") ?? "0",
    );
    if (!response.ok || declaredLength > maximumAvatarBytes) return false;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const detected = detectImage(bytes);
    if (
      !detected ||
      bytes.byteLength < 12 ||
      bytes.byteLength > maximumAvatarBytes
    ) {
      return false;
    }
    const contentHash = await sha256Bytes(bytes);
    objectKey = `users/${identity.subject}/${crypto.randomUUID()}-${contentHash}.${detected.extension}`;
    await enqueueAvatarPrewriteCleanup(database, objectKey);
    await bucket.put(objectKey, bytes, {
      httpMetadata: { contentType: detected.contentType },
      customMetadata: { owner: identity.subject, source: "provider-import" },
    });
    if (hooks.afterObjectStored) {
      preserveCleanupIntent = true;
      await hooks.afterObjectStored();
      preserveCleanupIntent = false;
    }
    if (current.avatar_object_key?.includes(`-${contentHash}.`)) {
      await discardUnpublishedAvatar(database, bucket, objectKey);
      return false;
    }
    const now = Math.floor(Date.now() / 1_000);
    const cleanupIntentExists = db
      .select({ value: sql<number>`1` })
      .from(avatarObjectCleanup)
      .where(
        and(
          eq(avatarObjectCleanup.objectKey, objectKey),
          eq(avatarObjectCleanup.state, "queued"),
        ),
      );
    const importAuthorityExists = authority
      ? db
          .select({ value: sql<number>`1` })
          .from(providerAvatarImportJobs)
          .where(
            and(
              eq(
                providerAvatarImportJobs.userIdentityID,
                authority.userIdentityID,
              ),
              eq(
                providerAvatarImportJobs.providerAvatarURL,
                authority.providerAvatarURL,
              ),
              eq(providerAvatarImportJobs.jobRevision, authority.jobRevision),
              eq(providerAvatarImportJobs.leaseID, authority.leaseID),
              eq(providerAvatarImportJobs.state, "leased"),
            ),
          )
      : undefined;
    const publishAvatar = db
      .update(users)
      .set({
        avatarObjectKey: objectKey,
        avatarContentType: detected.contentType,
        profileRevision: sql`${users.profileRevision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(users.id, identity.userID),
          eq(users.publicID, identity.subject),
          eq(users.avatarEdited, 0),
          isNull(users.deletionPendingAt),
          current.avatar_object_key === null
            ? isNull(users.avatarObjectKey)
            : eq(users.avatarObjectKey, current.avatar_object_key),
          exists(cleanupIntentExists),
          importAuthorityExists ? exists(importAuthorityExists) : undefined,
        ),
      );
    const publishedAvatarExists = db
      .select({ value: sql<number>`1` })
      .from(users)
      .where(
        and(
          eq(users.id, identity.userID),
          eq(users.publicID, identity.subject),
          eq(users.avatarObjectKey, objectKey),
          eq(users.avatarEdited, 0),
          isNull(users.deletionPendingAt),
        ),
      );
    const consumeCleanupIntent = db
      .delete(avatarObjectCleanup)
      .where(
        and(
          eq(avatarObjectCleanup.objectKey, objectKey),
          eq(avatarObjectCleanup.state, "queued"),
          exists(publishedAvatarExists),
        ),
      );
    const results = current.avatar_object_key
      ? await db.batch([
          publishAvatar,
          consumeCleanupIntent,
          db.insert(avatarObjectCleanup).select(
            db
              .select({
                id: sql<string>`${crypto.randomUUID()}`.as("id"),
                objectKey: sql<string>`${current.avatar_object_key}`.as(
                  "object_key",
                ),
                state: sql<"queued">`'queued'`.as("state"),
                attemptCount: sql<number>`0`.as("attempt_count"),
                leaseID: sql<string | null>`NULL`.as("lease_id"),
                leaseExpiresAt: sql<number | null>`NULL`.as("lease_expires_at"),
                availableAt: sql<number>`${now}`.as("available_at"),
                lastError: sql<string | null>`NULL`.as("last_error"),
                createdAt: sql<number>`${now}`.as("created_at"),
                updatedAt: sql<number>`${now}`.as("updated_at"),
              })
              .from(users)
              .where(
                and(
                  eq(users.id, identity.userID),
                  eq(users.publicID, identity.subject),
                  eq(users.avatarEdited, 0),
                  isNull(users.deletionPendingAt),
                  eq(users.avatarObjectKey, objectKey),
                ),
              ),
          ),
        ])
      : await db.batch([publishAvatar, consumeCleanupIntent]);
    if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
      await discardUnpublishedAvatar(database, bucket, objectKey);
      return false;
    }
    return true;
  } catch (error) {
    if (preserveCleanupIntent) throw error;
    if (objectKey) {
      const committed = await providerAvatarMutationCommitted(
        database,
        identity,
        objectKey,
      );
      if (committed === true) return true;
      if (committed === false) {
        await discardUnpublishedAvatar(database, bucket, objectKey);
      }
    }
    return false;
  }
}

async function providerAvatarMutationCommitted(
  database: D1Database,
  identity: CominaviIdentity,
  objectKey: string,
): Promise<boolean | null> {
  try {
    const row = await createDatabase(database)
      .select({ committed: sql<number>`1` })
      .from(users)
      .where(
        and(
          eq(users.id, identity.userID),
          eq(users.publicID, identity.subject),
          eq(users.avatarObjectKey, objectKey),
        ),
      )
      .get();
    return row !== undefined;
  } catch {
    return null;
  }
}

async function discardUnpublishedAvatar(
  database: D1Database,
  bucket: R2Bucket,
  objectKey: string,
): Promise<void> {
  try {
    await bucket.delete(objectKey);
    await cancelQueuedAvatarCleanup(database, objectKey);
  } catch {
    try {
      await enqueueAvatarCleanup(database, objectKey);
    } catch {
      // Cleanup failure must not replace the original typed CAS/replay result.
      // The unique key remains non-authoritative and safe from accidental reuse.
    }
  }
}

function safeProviderAvatarURL(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" &&
      (hostname === "googleusercontent.com" ||
        hostname.endsWith(".googleusercontent.com"))
      ? url
      : null;
  } catch {
    return null;
  }
}

function detectImage(bytes: Uint8Array): {
  contentType: "image/jpeg" | "image/png" | "image/webp";
  extension: string;
} | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((value, index) => bytes[index] === value)) {
    return { contentType: "image/png", extension: "png" };
  }
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

function invalidAvatar(): ServiceError {
  return new ServiceError(
    "invalid_avatar",
    415,
    "Avatar bytes must be a JPEG, PNG, or WebP image no larger than 2 MiB and match Content-Type.",
  );
}
