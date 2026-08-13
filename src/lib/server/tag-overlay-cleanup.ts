import { and, asc, eq, exists, lte, notExists, or, sql } from "drizzle-orm";

import { createDatabase } from "../db/client";
import {
  circleTagOverlayObjectCleanup,
  circleTagOverlayVersions,
} from "../db/schema";

export interface CircleTagOverlayCleanupIdentity {
  objectKey: string;
  eventNumber: number;
  revision: string;
  objectSHA256: string;
}

/** Records deletion authority before an immutable tag-overlay object is written. */
export async function enqueueCircleTagOverlayPrewriteCleanup(
  database: D1Database,
  identity: CircleTagOverlayCleanupIdentity,
  nowMilliseconds = Date.now(),
): Promise<void> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const db = createDatabase(database);
  const inserted = await db
    .insert(circleTagOverlayObjectCleanup)
    .values({
      ...identity,
      state: "queued",
      attemptCount: 0,
      leaseID: null,
      leaseExpiresAt: null,
      availableAt: now + 600,
      lastError: "prewrite_cleanup",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: circleTagOverlayObjectCleanup.objectKey })
    .run();
  if ((inserted.meta.changes ?? 0) === 1) return;

  const existing = await db
    .select({
      eventNumber: circleTagOverlayObjectCleanup.eventNumber,
      revision: circleTagOverlayObjectCleanup.revision,
      objectSHA256: circleTagOverlayObjectCleanup.objectSHA256,
      state: circleTagOverlayObjectCleanup.state,
    })
    .from(circleTagOverlayObjectCleanup)
    .where(eq(circleTagOverlayObjectCleanup.objectKey, identity.objectKey))
    .get();
  if (
    existing?.eventNumber !== identity.eventNumber ||
    existing.revision !== identity.revision ||
    existing.objectSHA256 !== identity.objectSHA256
  ) {
    throw new Error("tag_overlay_cleanup_intent_conflict");
  }
  if (existing.state !== "queued") {
    throw new Error("tag_overlay_cleanup_intent_leased");
  }
  const renewed = await db
    .update(circleTagOverlayObjectCleanup)
    .set({
      availableAt: now + 600,
      lastError: "prewrite_cleanup",
      updatedAt: now,
    })
    .where(
      and(
        eq(circleTagOverlayObjectCleanup.objectKey, identity.objectKey),
        eq(circleTagOverlayObjectCleanup.eventNumber, identity.eventNumber),
        eq(circleTagOverlayObjectCleanup.revision, identity.revision),
        eq(circleTagOverlayObjectCleanup.objectSHA256, identity.objectSHA256),
        eq(circleTagOverlayObjectCleanup.state, "queued"),
      ),
    )
    .run();
  if ((renewed.meta.changes ?? 0) !== 1) {
    throw new Error("tag_overlay_cleanup_intent_conflict");
  }
}

export async function processPendingCircleTagOverlayCleanup(
  database: D1Database,
  bucket: R2Bucket,
  nowMilliseconds = Date.now(),
): Promise<number> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const db = createDatabase(database);
  const rows = await db
    .select({
      objectKey: circleTagOverlayObjectCleanup.objectKey,
      attemptCount: circleTagOverlayObjectCleanup.attemptCount,
    })
    .from(circleTagOverlayObjectCleanup)
    .where(
      or(
        and(
          eq(circleTagOverlayObjectCleanup.state, "queued"),
          lte(circleTagOverlayObjectCleanup.availableAt, now),
        ),
        and(
          eq(circleTagOverlayObjectCleanup.state, "leased"),
          lte(circleTagOverlayObjectCleanup.leaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(
      asc(circleTagOverlayObjectCleanup.availableAt),
      asc(circleTagOverlayObjectCleanup.createdAt),
    )
    .limit(100);

  let removed = 0;
  for (const row of rows) {
    const leaseID = crypto.randomUUID();
    const leased = await db
      .update(circleTagOverlayObjectCleanup)
      .set({
        state: "leased",
        leaseID,
        leaseExpiresAt: now + 60,
        updatedAt: now,
      })
      .where(
        and(
          eq(circleTagOverlayObjectCleanup.objectKey, row.objectKey),
          or(
            and(
              eq(circleTagOverlayObjectCleanup.state, "queued"),
              lte(circleTagOverlayObjectCleanup.availableAt, now),
            ),
            and(
              eq(circleTagOverlayObjectCleanup.state, "leased"),
              lte(circleTagOverlayObjectCleanup.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .run();
    if ((leased.meta.changes ?? 0) !== 1) continue;

    try {
      const referencedVersion = db
        .select({ value: sql`1` })
        .from(circleTagOverlayVersions)
        .where(
          eq(
            circleTagOverlayVersions.objectKey,
            circleTagOverlayObjectCleanup.objectKey,
          ),
        );
      const authorized = await db
        .select({ authorized: sql<number>`1` })
        .from(circleTagOverlayObjectCleanup)
        .where(
          and(
            eq(circleTagOverlayObjectCleanup.objectKey, row.objectKey),
            eq(circleTagOverlayObjectCleanup.leaseID, leaseID),
            eq(circleTagOverlayObjectCleanup.state, "leased"),
            notExists(referencedVersion),
          ),
        )
        .get();
      if (!authorized) {
        const nowReferencedVersion = db
          .select({ value: sql`1` })
          .from(circleTagOverlayVersions)
          .where(
            eq(
              circleTagOverlayVersions.objectKey,
              circleTagOverlayObjectCleanup.objectKey,
            ),
          );
        await db
          .delete(circleTagOverlayObjectCleanup)
          .where(
            and(
              eq(circleTagOverlayObjectCleanup.objectKey, row.objectKey),
              eq(circleTagOverlayObjectCleanup.leaseID, leaseID),
              exists(nowReferencedVersion),
            ),
          )
          .run();
        continue;
      }

      await bucket.delete(row.objectKey);
      await db
        .delete(circleTagOverlayObjectCleanup)
        .where(
          and(
            eq(circleTagOverlayObjectCleanup.objectKey, row.objectKey),
            eq(circleTagOverlayObjectCleanup.leaseID, leaseID),
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
        .update(circleTagOverlayObjectCleanup)
        .set({
          state: "queued",
          attemptCount: sql`${circleTagOverlayObjectCleanup.attemptCount} + 1`,
          leaseID: null,
          leaseExpiresAt: null,
          availableAt: now + 300,
          lastError: message,
          updatedAt: now,
        })
        .where(
          and(
            eq(circleTagOverlayObjectCleanup.objectKey, row.objectKey),
            eq(circleTagOverlayObjectCleanup.leaseID, leaseID),
          ),
        )
        .run();
    }
  }
  return removed;
}
