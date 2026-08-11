import { and, asc, eq, exists, isNull, lte, or, sql } from "drizzle-orm";
import { createDatabase } from "../db/client";
import { providerAvatarImportJobs, userIdentities, users } from "../db/schema";
import { importProviderAvatar } from "./avatars";

export async function processProviderAvatarImports(
  database: D1Database,
  bucket: R2Bucket,
  fetcher: typeof fetch = fetch,
  nowMilliseconds = Date.now(),
  afterLoad: (() => void | Promise<void>) | undefined = undefined,
): Promise<number> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const db = createDatabase(database);
  const jobs = await db
    .select({
      userIdentityID: providerAvatarImportJobs.userIdentityID,
      providerAvatarURL: providerAvatarImportJobs.providerAvatarURL,
      jobRevision: providerAvatarImportJobs.jobRevision,
      userID: userIdentities.userID,
      publicID: users.publicID,
      authVersion: users.authVersion,
      attemptCount: providerAvatarImportJobs.attemptCount,
    })
    .from(providerAvatarImportJobs)
    .innerJoin(
      userIdentities,
      eq(userIdentities.id, providerAvatarImportJobs.userIdentityID),
    )
    .innerJoin(users, eq(users.id, userIdentities.userID))
    .where(
      and(
        or(
          and(
            eq(providerAvatarImportJobs.state, "queued"),
            lte(providerAvatarImportJobs.availableAt, now),
          ),
          and(
            eq(providerAvatarImportJobs.state, "leased"),
            lte(providerAvatarImportJobs.leaseExpiresAt, now),
          ),
        ),
        isNull(users.deletionPendingAt),
      ),
    )
    .orderBy(
      asc(providerAvatarImportJobs.availableAt),
      asc(providerAvatarImportJobs.createdAt),
    )
    .limit(20);
  await afterLoad?.();
  let completed = 0;
  for (const job of jobs) {
    const leaseID = crypto.randomUUID();
    const authority = db
      .select({ value: sql`1` })
      .from(userIdentities)
      .innerJoin(users, eq(users.id, userIdentities.userID))
      .where(
        and(
          eq(userIdentities.id, job.userIdentityID),
          isNull(users.deletionPendingAt),
          eq(users.authVersion, job.authVersion),
        ),
      );
    const leased = await db
      .update(providerAvatarImportJobs)
      .set({
        state: "leased",
        leaseID,
        leaseExpiresAt: now + 60,
        updatedAt: now,
      })
      .where(
        and(
          eq(providerAvatarImportJobs.userIdentityID, job.userIdentityID),
          eq(providerAvatarImportJobs.jobRevision, job.jobRevision),
          eq(providerAvatarImportJobs.providerAvatarURL, job.providerAvatarURL),
          or(
            and(
              eq(providerAvatarImportJobs.state, "queued"),
              lte(providerAvatarImportJobs.availableAt, now),
            ),
            and(
              eq(providerAvatarImportJobs.state, "leased"),
              lte(providerAvatarImportJobs.leaseExpiresAt, now),
            ),
          ),
          exists(authority),
        ),
      )
      .run();
    if ((leased.meta.changes ?? 0) !== 1) continue;
    try {
      const imported = await importProviderAvatar(
        database,
        bucket,
        {
          subject: job.publicID,
          userID: job.userID,
          authVersion: job.authVersion,
        },
        job.providerAvatarURL,
        fetcher,
        {
          userIdentityID: job.userIdentityID,
          providerAvatarURL: job.providerAvatarURL,
          jobRevision: job.jobRevision,
          leaseID,
        },
      );
      if (imported || job.attemptCount >= 4) {
        await db
          .delete(providerAvatarImportJobs)
          .where(
            and(
              eq(providerAvatarImportJobs.userIdentityID, job.userIdentityID),
              eq(providerAvatarImportJobs.leaseID, leaseID),
              eq(providerAvatarImportJobs.jobRevision, job.jobRevision),
              eq(
                providerAvatarImportJobs.providerAvatarURL,
                job.providerAvatarURL,
              ),
            ),
          )
          .run();
        completed += 1;
      } else {
        await retry(
          database,
          job.userIdentityID,
          leaseID,
          job.jobRevision,
          job.providerAvatarURL,
          now,
          "not_imported",
        );
      }
    } catch (error) {
      await retry(
        database,
        job.userIdentityID,
        leaseID,
        job.jobRevision,
        job.providerAvatarURL,
        now,
        error instanceof Error
          ? error.message
          : "provider_avatar_import_failed",
      );
    }
  }
  return completed;
}

async function retry(
  database: D1Database,
  identityID: number,
  leaseID: string,
  jobRevision: number,
  providerAvatarURL: string,
  now: number,
  error: string,
): Promise<void> {
  await createDatabase(database)
    .update(providerAvatarImportJobs)
    .set({
      state: "queued",
      attemptCount: sql`${providerAvatarImportJobs.attemptCount} + 1`,
      leaseID: null,
      leaseExpiresAt: null,
      availableAt: now + 300,
      lastError: error.slice(0, 500),
      updatedAt: now,
    })
    .where(
      and(
        eq(providerAvatarImportJobs.userIdentityID, identityID),
        eq(providerAvatarImportJobs.leaseID, leaseID),
        eq(providerAvatarImportJobs.jobRevision, jobRevision),
        eq(providerAvatarImportJobs.providerAvatarURL, providerAvatarURL),
      ),
    )
    .run();
}
