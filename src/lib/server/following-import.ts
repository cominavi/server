import * as Sentry from "@sentry/cloudflare";
import {
  and,
  asc,
  eq,
  exists,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { createDatabase } from "../db/client";
import { runDrizzleBatch } from "../db/batch";
import {
  followingImports,
  followingSnapshotCleanup,
  users,
} from "../db/schema";
import type { CominaviIdentity } from "./cominavi-auth";
import {
  fetchTwitterFollowings,
  normalizeTwitterUserName,
  TwitterFollowingError,
  type TwitterFollowingUser,
} from "./twitter-followings";

export interface FollowingImportBindings {
  COMINAVI_DB: D1Database;
  COMINAVI_FOLLOWING_SNAPSHOTS: KVNamespace;
  TWITTERAPI_IO_API_KEY: string;
}

interface FollowingImportRow {
  subject: string;
  twitter_username: string;
  status: "fetching" | "ready" | "failed";
  lease_id: string | null;
  attempted_at: number;
  next_allowed_at: number;
  successful_at: number | null;
  snapshot_key: string | null;
  following_count: number;
  last_error: string | null;
}

export interface FollowingSnapshot {
  twitterUserName: string;
  importedAt: string;
  nextAllowedAt: string;
  followings: TwitterFollowingUser[];
}

export interface FollowingImportResponse extends FollowingSnapshot {
  source: "twitterapi.io" | "cache";
}

export interface FollowingImportHooks {
  afterSnapshotStored?: () => Promise<void>;
  onServerError?: (error: FollowingImportError) => void;
}

export class FollowingImportError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly nextAllowedAt?: string,
  ) {
    super(message);
  }
}

export const followingImportIntervalSeconds = 6 * 60 * 60;

export async function importFollowingSnapshot(
  identity: CominaviIdentity,
  requestedUserName: string,
  bindings: FollowingImportBindings,
  nowMilliseconds = Date.now(),
  fetcher: typeof fetch = fetch,
  hooks: FollowingImportHooks = {},
): Promise<FollowingImportResponse> {
  const userName = normalizeTwitterUserName(requestedUserName);
  if (!userName) {
    throw new FollowingImportError(
      "invalid_twitter_username",
      400,
      "Enter a valid X username.",
    );
  }

  const now = Math.floor(nowMilliseconds / 1_000);
  const existing = await loadRow(bindings.COMINAVI_DB, identity);
  if (existing && existing.next_allowed_at > now) {
    if (existing.twitter_username !== userName) {
      throw cooldownError(existing.next_allowed_at);
    }
    const cached = await loadSnapshot(
      bindings.COMINAVI_FOLLOWING_SNAPSHOTS,
      existing.snapshot_key,
    );
    if (snapshotMatchesUserName(cached, userName)) {
      await assertImportAuthority(bindings.COMINAVI_DB, identity);
      return { ...cached, source: "cache" };
    }
    throw new FollowingImportError(
      existing.status === "fetching" ? "import_in_progress" : "import_cooldown",
      existing.status === "fetching" ? 409 : 429,
      existing.status === "fetching"
        ? "The followings import is already running."
        : "The next followings import is not available yet.",
      new Date(existing.next_allowed_at * 1_000).toISOString(),
    );
  }

  const leaseID = crypto.randomUUID();
  const nextAllowedAt = now + followingImportIntervalSeconds;
  const acquired = await acquireLease(
    bindings.COMINAVI_DB,
    identity,
    userName,
    leaseID,
    now,
    nextAllowedAt,
  );
  if (!acquired) {
    const current = await loadRow(bindings.COMINAVI_DB, identity);
    if (current?.twitter_username === userName) {
      const cached = await loadSnapshot(
        bindings.COMINAVI_FOLLOWING_SNAPSHOTS,
        current.snapshot_key,
      );
      if (snapshotMatchesUserName(cached, userName)) {
        await assertImportAuthority(bindings.COMINAVI_DB, identity);
        return { ...cached, source: "cache" };
      }
    }
    throw new FollowingImportError(
      "import_in_progress",
      409,
      "The followings import is already running.",
      current
        ? new Date(current.next_allowed_at * 1_000).toISOString()
        : undefined,
    );
  }

  let snapshotKey: string | null = null;
  let publishedSnapshot = false;
  try {
    const followings = await fetchTwitterFollowings(
      userName,
      bindings.TWITTERAPI_IO_API_KEY,
      fetcher,
    );
    const snapshot: FollowingSnapshot = {
      twitterUserName: userName,
      importedAt: new Date(now * 1_000).toISOString(),
      nextAllowedAt: new Date(nextAllowedAt * 1_000).toISOString(),
      followings,
    };
    snapshotKey = `following-import/${encodeURIComponent(identity.subject)}/${leaseID}`;
    const db = createDatabase(bindings.COMINAVI_DB);
    const cleanupQueued = await db.run(sql`
      INSERT INTO ${followingSnapshotCleanup} (
         object_key, state, attempt_count, lease_id, lease_expires_at,
         available_at, last_error, created_at, updated_at
       )
       SELECT ${snapshotKey}, 'queued', 0, NULL, NULL, ${now} + 600,
              NULL, ${now}, ${now}
       FROM ${users}
       WHERE ${users.id} = ${identity.userID}
         AND ${users.publicID} = ${identity.subject}
         AND ${users.authVersion} = ${identity.authVersion}
         AND deletion_pending_at IS NULL
       ON CONFLICT(object_key) DO NOTHING`);
    if ((cleanupQueued.meta.changes ?? 0) !== 1) throw unavailableImport();
    await bindings.COMINAVI_FOLLOWING_SNAPSHOTS.put(
      snapshotKey,
      JSON.stringify(snapshot),
    );
    await hooks.afterSnapshotStored?.();

    const published = await runDrizzleBatch(bindings.COMINAVI_DB, [
      sql`
        UPDATE ${followingImports}
         SET status = 'ready', successful_at = ${now},
             snapshot_key = ${snapshotKey}, following_count = ${followings.length},
             last_error = NULL
         WHERE subject = ${identity.subject} AND lease_id = ${leaseID}
           AND EXISTS (
             SELECT 1 FROM ${users}
             WHERE ${users.id} = ${identity.userID}
               AND ${users.publicID} = ${identity.subject}
               AND ${users.authVersion} = ${identity.authVersion}
               AND ${users.deletionPendingAt} IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM ${followingSnapshotCleanup}
             WHERE object_key = ${snapshotKey} AND state = 'queued'
           )`,
      sql`
        DELETE FROM ${followingSnapshotCleanup}
         WHERE object_key = ${snapshotKey} AND state = 'queued' AND EXISTS (
           SELECT 1 FROM ${followingImports} AS import
           JOIN ${users} AS user ON user.public_id = import.subject
           WHERE import.subject = ${identity.subject}
             AND import.lease_id = ${leaseID}
             AND import.snapshot_key = ${snapshotKey}
             AND import.status = 'ready'
             AND user.id = ${identity.userID}
             AND user.auth_version = ${identity.authVersion}
             AND user.deletion_pending_at IS NULL
         )`,
      sql`
        INSERT INTO ${followingSnapshotCleanup} (
           object_key, state, attempt_count, lease_id, lease_expires_at,
           available_at, last_error, created_at, updated_at
         )
         SELECT ${existing?.snapshot_key ?? null}, 'queued', 0, NULL, NULL,
                ${now}, NULL, ${now}, ${now}
         FROM ${followingImports} AS import
         JOIN ${users} AS user ON user.public_id = import.subject
         WHERE ${existing?.snapshot_key ?? null} IS NOT NULL
           AND ${existing?.snapshot_key ?? null} <> ${snapshotKey}
           AND import.subject = ${identity.subject}
           AND import.lease_id = ${leaseID}
           AND import.snapshot_key = ${snapshotKey}
           AND import.status = 'ready'
           AND user.id = ${identity.userID}
           AND user.auth_version = ${identity.authVersion}
           AND user.deletion_pending_at IS NULL
         ON CONFLICT(object_key) DO NOTHING`,
    ]);
    if (
      (published[0]?.meta.changes ?? 0) !== 1 ||
      (published[1]?.meta.changes ?? 0) !== 1
    ) {
      throw new FollowingImportError(
        "import_publication_failed",
        503,
        "The imported snapshot could not be published.",
      );
    }
    publishedSnapshot = true;

    if (existing?.snapshot_key && existing.snapshot_key !== snapshotKey) {
      await deleteQueuedSnapshot(
        bindings.COMINAVI_DB,
        bindings.COMINAVI_FOLLOWING_SNAPSHOTS,
        existing.snapshot_key,
      ).catch(() => undefined);
    }
    return { ...snapshot, source: "twitterapi.io" };
  } catch (error) {
    if (!publishedSnapshot && snapshotKey) {
      await deleteQueuedSnapshot(
        bindings.COMINAVI_DB,
        bindings.COMINAVI_FOLLOWING_SNAPSHOTS,
        snapshotKey,
      ).catch(() => undefined);
    }
    const code =
      error instanceof TwitterFollowingError ||
      error instanceof FollowingImportError
        ? error.code
        : "import_failed";
    await createDatabase(bindings.COMINAVI_DB).run(sql`
      UPDATE ${followingImports}
       SET status = 'failed', lease_id = NULL, next_allowed_at = ${now},
           last_error = ${code}
       WHERE subject = ${identity.subject} AND lease_id = ${leaseID}
         AND EXISTS (
           SELECT 1 FROM ${users}
           WHERE ${users.id} = ${identity.userID}
             AND ${users.publicID} = ${identity.subject}
             AND ${users.authVersion} = ${identity.authVersion}
             AND ${users.deletionPendingAt} IS NULL
         )`);

    if (error instanceof FollowingImportError) {
      reportServerError(error, hooks);
      throw error;
    }
    if (error instanceof TwitterFollowingError) {
      const importError = new FollowingImportError(
        error.code,
        error.code === "twitter_following_limit_exceeded" ? 422 : 502,
        error.message,
        new Date(nextAllowedAt * 1_000).toISOString(),
      );
      reportServerError(importError, hooks);
      throw importError;
    }
    const importError = new FollowingImportError(
      "import_failed",
      502,
      "The followings import failed.",
      new Date(nextAllowedAt * 1_000).toISOString(),
    );
    reportServerError(importError, hooks);
    throw importError;
  }
}

async function acquireLease(
  database: D1Database,
  identity: CominaviIdentity,
  userName: string,
  leaseID: string,
  now: number,
  nextAllowedAt: number,
): Promise<boolean> {
  const db = createDatabase(database);
  const inserted = await db.run(sql`
      INSERT OR IGNORE INTO ${followingImports} (
         subject, twitter_username, status, lease_id, attempted_at, next_allowed_at,
         successful_at, snapshot_key, following_count, last_error
       )
       SELECT ${identity.subject}, ${userName}, 'fetching', ${leaseID}, ${now},
              ${nextAllowedAt}, NULL, NULL, 0, NULL
       FROM ${users}
       WHERE ${users.id} = ${identity.userID}
         AND ${users.publicID} = ${identity.subject}
         AND ${users.authVersion} = ${identity.authVersion}
         AND ${users.deletionPendingAt} IS NULL`);
  if ((inserted.meta.changes ?? 0) === 1) return true;

  const updated = await db.run(sql`
      UPDATE ${followingImports}
       SET twitter_username = ${userName}, status = 'fetching',
           lease_id = ${leaseID}, attempted_at = ${now},
           next_allowed_at = ${nextAllowedAt}, last_error = NULL
       WHERE subject = ${identity.subject} AND next_allowed_at <= ${now}
         AND EXISTS (
           SELECT 1 FROM ${users}
           WHERE ${users.id} = ${identity.userID}
             AND ${users.publicID} = ${identity.subject}
             AND ${users.authVersion} = ${identity.authVersion}
             AND ${users.deletionPendingAt} IS NULL
         )`);
  return (updated.meta.changes ?? 0) === 1;
}

async function loadRow(
  database: D1Database,
  identity: CominaviIdentity,
): Promise<FollowingImportRow | null> {
  const row = await createDatabase(database)
    .select({
      subject: followingImports.subject,
      twitterUserName: followingImports.twitterUsername,
      status: followingImports.status,
      leaseID: followingImports.leaseID,
      attemptedAt: followingImports.attemptedAt,
      nextAllowedAt: followingImports.nextAllowedAt,
      successfulAt: followingImports.successfulAt,
      snapshotKey: followingImports.snapshotKey,
      followingCount: followingImports.followingCount,
      lastError: followingImports.lastError,
    })
    .from(followingImports)
    .innerJoin(users, eq(users.publicID, followingImports.subject))
    .where(
      and(
        eq(followingImports.subject, identity.subject),
        eq(users.id, identity.userID),
        eq(users.authVersion, identity.authVersion),
        isNull(users.deletionPendingAt),
      ),
    )
    .get();
  return row
    ? {
        subject: row.subject,
        twitter_username: row.twitterUserName,
        status: row.status,
        lease_id: row.leaseID,
        attempted_at: row.attemptedAt,
        next_allowed_at: row.nextAllowedAt,
        successful_at: row.successfulAt,
        snapshot_key: row.snapshotKey,
        following_count: row.followingCount,
        last_error: row.lastError,
      }
    : null;
}

async function assertImportAuthority(
  database: D1Database,
  identity: CominaviIdentity,
): Promise<void> {
  const active = await createDatabase(database)
    .select({ active: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, identity.userID),
        eq(users.publicID, identity.subject),
        eq(users.authVersion, identity.authVersion),
        isNull(users.deletionPendingAt),
      ),
    )
    .get();
  if (!active) throw unavailableImport();
}

async function deleteQueuedSnapshot(
  database: D1Database,
  snapshots: KVNamespace,
  objectKey: string,
): Promise<void> {
  await snapshots.delete(objectKey);
  await createDatabase(database)
    .delete(followingSnapshotCleanup)
    .where(eq(followingSnapshotCleanup.objectKey, objectKey))
    .run();
}

export async function processFollowingSnapshotCleanup(
  database: D1Database,
  snapshots: KVNamespace,
  nowMilliseconds = Date.now(),
): Promise<number> {
  const now = Math.floor(nowMilliseconds / 1_000);
  const db = createDatabase(database);
  const queued = await db
    .select({
      objectKey: followingSnapshotCleanup.objectKey,
      attemptCount: followingSnapshotCleanup.attemptCount,
    })
    .from(followingSnapshotCleanup)
    .where(
      or(
        and(
          eq(followingSnapshotCleanup.state, "queued"),
          lte(followingSnapshotCleanup.availableAt, now),
        ),
        and(
          eq(followingSnapshotCleanup.state, "leased"),
          lte(followingSnapshotCleanup.leaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(
      asc(followingSnapshotCleanup.availableAt),
      asc(followingSnapshotCleanup.createdAt),
    )
    .limit(20);
  let completed = 0;
  for (const item of queued) {
    const leaseID = crypto.randomUUID();
    const leased = await db
      .update(followingSnapshotCleanup)
      .set({
        state: "leased",
        leaseID,
        leaseExpiresAt: now + 60,
        updatedAt: now,
      })
      .where(
        and(
          eq(followingSnapshotCleanup.objectKey, item.objectKey),
          or(
            and(
              eq(followingSnapshotCleanup.state, "queued"),
              lte(followingSnapshotCleanup.availableAt, now),
            ),
            and(
              eq(followingSnapshotCleanup.state, "leased"),
              lte(followingSnapshotCleanup.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .run();
    if ((leased.meta.changes ?? 0) !== 1) continue;
    try {
      const readyImport = db
        .select({ ready: followingImports.subject })
        .from(followingImports)
        .where(
          and(
            eq(followingImports.snapshotKey, item.objectKey),
            eq(followingImports.status, "ready"),
          ),
        );
      const authorized = await db
        .select({ authorized: followingSnapshotCleanup.objectKey })
        .from(followingSnapshotCleanup)
        .where(
          and(
            eq(followingSnapshotCleanup.objectKey, item.objectKey),
            eq(followingSnapshotCleanup.state, "leased"),
            eq(followingSnapshotCleanup.leaseID, leaseID),
            notExists(readyImport),
          ),
        )
        .get();
      if (!authorized) {
        await db
          .delete(followingSnapshotCleanup)
          .where(
            and(
              eq(followingSnapshotCleanup.objectKey, item.objectKey),
              eq(followingSnapshotCleanup.leaseID, leaseID),
              exists(readyImport),
            ),
          )
          .run();
        continue;
      }
      await snapshots.delete(item.objectKey);
      await db
        .delete(followingSnapshotCleanup)
        .where(
          and(
            eq(followingSnapshotCleanup.objectKey, item.objectKey),
            eq(followingSnapshotCleanup.leaseID, leaseID),
          ),
        )
        .run();
      completed += 1;
    } catch (error) {
      await db
        .update(followingSnapshotCleanup)
        .set({
          state: "queued",
          attemptCount: sql`${followingSnapshotCleanup.attemptCount} + 1`,
          leaseID: null,
          leaseExpiresAt: null,
          availableAt:
            now + Math.min(3_600, 60 * 2 ** Math.min(item.attemptCount, 5)),
          lastError: (error instanceof Error
            ? error.message
            : "snapshot_delete_failed"
          ).slice(0, 500),
          updatedAt: now,
        })
        .where(
          and(
            eq(followingSnapshotCleanup.objectKey, item.objectKey),
            eq(followingSnapshotCleanup.leaseID, leaseID),
          ),
        )
        .run();
    }
  }
  return completed;
}

async function loadSnapshot(
  snapshots: KVNamespace,
  snapshotKey: string | null,
): Promise<FollowingSnapshot | null> {
  if (!snapshotKey) return null;
  const value = await snapshots.get<unknown>(snapshotKey, "json");
  return isFollowingSnapshot(value) ? value : null;
}

function cooldownError(nextAllowedAt: number): FollowingImportError {
  return new FollowingImportError(
    "import_cooldown",
    429,
    "Followings can only be imported once every six hours.",
    new Date(nextAllowedAt * 1_000).toISOString(),
  );
}

function unavailableImport(): FollowingImportError {
  return new FollowingImportError(
    "import_unavailable",
    401,
    "The followings import is no longer authorized.",
  );
}

function reportServerError(
  error: FollowingImportError,
  hooks: FollowingImportHooks,
): void {
  if (error.status < 500) return;

  hooks.onServerError?.(error);
  Sentry.withScope((scope) => {
    scope.setTag("cominavi.feature", "x-following-import");
    scope.setTag("cominavi.error_code", error.code);
    scope.setContext("x_following_import", {
      provider: "twitterapi.io",
      status: error.status,
    });
    Sentry.captureException(error, {
      mechanism: {
        handled: true,
        type: "cominavi.x_following_import",
      },
    });
  });
}

export function snapshotMatchesUserName(
  snapshot: FollowingSnapshot | null,
  normalizedUserName: string,
): snapshot is FollowingSnapshot {
  return (
    snapshot !== null &&
    snapshot.twitterUserName.toLowerCase() === normalizedUserName
  );
}

function isFollowingSnapshot(value: unknown): value is FollowingSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "twitterUserName" in value &&
    typeof value.twitterUserName === "string" &&
    "importedAt" in value &&
    typeof value.importedAt === "string" &&
    "nextAllowedAt" in value &&
    typeof value.nextAllowedAt === "string" &&
    "followings" in value &&
    Array.isArray(value.followings)
  );
}
