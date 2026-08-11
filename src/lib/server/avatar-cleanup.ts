import { and, asc, eq, exists, lte, notExists, or, sql } from "drizzle-orm";
import { createDatabase } from "../db/client";
import { avatarObjectCleanup, users } from "../db/schema";

export async function enqueueAvatarPrewriteCleanup(
  database: D1Database,
  objectKey: string,
  nowMilliseconds = Date.now(),
): Promise<void> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const queued = await createDatabase(database)
    .insert(avatarObjectCleanup)
    .values({
      id: crypto.randomUUID(),
      objectKey,
      state: "queued",
      attemptCount: 0,
      leaseID: null,
      leaseExpiresAt: null,
      availableAt: now + 600,
      lastError: "prewrite_cleanup",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: avatarObjectCleanup.objectKey })
    .run();
  if ((queued.meta.changes ?? 0) !== 1) {
    throw new Error("avatar_cleanup_intent_conflict");
  }
}

export async function enqueueAvatarCleanup(
  database: D1Database,
  objectKey: string,
  nowMilliseconds = Date.now(),
): Promise<void> {
  const now = Math.floor(nowMilliseconds / 1_000);
  await createDatabase(database)
    .insert(avatarObjectCleanup)
    .values({
      id: crypto.randomUUID(),
      objectKey,
      state: "queued",
      attemptCount: 0,
      leaseID: null,
      leaseExpiresAt: null,
      availableAt: now,
      lastError: "immediate_delete_failed",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: avatarObjectCleanup.objectKey,
      set: {
        availableAt: sql`min(${avatarObjectCleanup.availableAt}, ${now})`,
        lastError: "immediate_delete_failed",
        updatedAt: now,
      },
      where: eq(avatarObjectCleanup.state, "queued"),
    })
    .run();
}

export async function cancelQueuedAvatarCleanup(
  database: D1Database,
  objectKey: string,
): Promise<void> {
  await createDatabase(database)
    .delete(avatarObjectCleanup)
    .where(
      and(
        eq(avatarObjectCleanup.objectKey, objectKey),
        eq(avatarObjectCleanup.state, "queued"),
      ),
    )
    .run();
}

export async function processPendingAvatarCleanup(
  database: D1Database,
  bucket: R2Bucket,
  nowMilliseconds = Date.now(),
): Promise<number> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const db = createDatabase(database);
  const rows = await db
    .select({
      id: avatarObjectCleanup.id,
      objectKey: avatarObjectCleanup.objectKey,
      attemptCount: avatarObjectCleanup.attemptCount,
    })
    .from(avatarObjectCleanup)
    .where(
      or(
        and(
          eq(avatarObjectCleanup.state, "queued"),
          lte(avatarObjectCleanup.availableAt, now),
        ),
        and(
          eq(avatarObjectCleanup.state, "leased"),
          lte(avatarObjectCleanup.leaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(
      asc(avatarObjectCleanup.availableAt),
      asc(avatarObjectCleanup.createdAt),
    )
    .limit(100);
  let removed = 0;
  for (const row of rows) {
    const leaseID = crypto.randomUUID();
    const leased = await db
      .update(avatarObjectCleanup)
      .set({
        state: "leased",
        leaseID,
        leaseExpiresAt: now + 60,
        updatedAt: now,
      })
      .where(
        and(
          eq(avatarObjectCleanup.id, row.id),
          or(
            and(
              eq(avatarObjectCleanup.state, "queued"),
              lte(avatarObjectCleanup.availableAt, now),
            ),
            and(
              eq(avatarObjectCleanup.state, "leased"),
              lte(avatarObjectCleanup.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .run();
    if ((leased.meta.changes ?? 0) !== 1) continue;
    try {
      const referencedAvatar = db
        .select({ value: sql`1` })
        .from(users)
        .where(eq(users.avatarObjectKey, avatarObjectCleanup.objectKey));
      const authorized = await db
        .select({ authorized: sql<number>`1` })
        .from(avatarObjectCleanup)
        .where(
          and(
            eq(avatarObjectCleanup.id, row.id),
            eq(avatarObjectCleanup.leaseID, leaseID),
            eq(avatarObjectCleanup.state, "leased"),
            notExists(referencedAvatar),
          ),
        )
        .get();
      if (!authorized) {
        const nowReferencedAvatar = db
          .select({ value: sql`1` })
          .from(users)
          .where(eq(users.avatarObjectKey, avatarObjectCleanup.objectKey));
        await db
          .delete(avatarObjectCleanup)
          .where(
            and(
              eq(avatarObjectCleanup.id, row.id),
              eq(avatarObjectCleanup.leaseID, leaseID),
              exists(nowReferencedAvatar),
            ),
          )
          .run();
        continue;
      }
      await bucket.delete(row.objectKey);
      await db
        .delete(avatarObjectCleanup)
        .where(
          and(
            eq(avatarObjectCleanup.id, row.id),
            eq(avatarObjectCleanup.leaseID, leaseID),
          ),
        )
        .run();
      removed += 1;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "r2_delete_failed";
      await db
        .update(avatarObjectCleanup)
        .set({
          state: "queued",
          attemptCount: sql`${avatarObjectCleanup.attemptCount} + 1`,
          leaseID: null,
          leaseExpiresAt: null,
          availableAt: now + 300,
          lastError: message,
          updatedAt: now,
        })
        .where(
          and(
            eq(avatarObjectCleanup.id, row.id),
            eq(avatarObjectCleanup.leaseID, leaseID),
          ),
        )
        .run();
    }
  }
  return removed;
}
