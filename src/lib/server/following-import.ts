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
  const existing = await loadRow(bindings.COMINAVI_DB, identity.subject);
  if (existing && existing.next_allowed_at > now) {
    if (existing.twitter_username !== userName) {
      throw cooldownError(existing.next_allowed_at);
    }
    const cached = await loadSnapshot(
      bindings.COMINAVI_FOLLOWING_SNAPSHOTS,
      existing.snapshot_key,
    );
    if (snapshotMatchesUserName(cached, userName)) {
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
    identity.subject,
    userName,
    leaseID,
    now,
    nextAllowedAt,
  );
  if (!acquired) {
    const current = await loadRow(bindings.COMINAVI_DB, identity.subject);
    if (current?.twitter_username === userName) {
      const cached = await loadSnapshot(
        bindings.COMINAVI_FOLLOWING_SNAPSHOTS,
        current.snapshot_key,
      );
      if (snapshotMatchesUserName(cached, userName)) {
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
    const snapshotKey = `following-import/${encodeURIComponent(identity.subject)}/${leaseID}`;
    await bindings.COMINAVI_FOLLOWING_SNAPSHOTS.put(
      snapshotKey,
      JSON.stringify(snapshot),
    );

    const published = await bindings.COMINAVI_DB.prepare(
      `UPDATE following_imports
       SET status = 'ready', successful_at = ?1, snapshot_key = ?2,
           following_count = ?3, last_error = NULL
       WHERE subject = ?4 AND lease_id = ?5`,
    )
      .bind(now, snapshotKey, followings.length, identity.subject, leaseID)
      .run();
    if ((published.meta.changes ?? 0) !== 1) {
      throw new FollowingImportError(
        "import_publication_failed",
        503,
        "The imported snapshot could not be published.",
      );
    }

    if (existing?.snapshot_key && existing.snapshot_key !== snapshotKey) {
      await bindings.COMINAVI_FOLLOWING_SNAPSHOTS.delete(existing.snapshot_key);
    }
    return { ...snapshot, source: "twitterapi.io" };
  } catch (error) {
    const code =
      error instanceof TwitterFollowingError ||
      error instanceof FollowingImportError
        ? error.code
        : "import_failed";
    await bindings.COMINAVI_DB.prepare(
      `UPDATE following_imports
       SET status = 'failed', last_error = ?1
       WHERE subject = ?2 AND lease_id = ?3`,
    )
      .bind(code, identity.subject, leaseID)
      .run();

    if (error instanceof FollowingImportError) throw error;
    if (error instanceof TwitterFollowingError) {
      throw new FollowingImportError(
        error.code,
        502,
        error.message,
        new Date(nextAllowedAt * 1_000).toISOString(),
      );
    }
    throw new FollowingImportError(
      "import_failed",
      502,
      "The followings import failed.",
      new Date(nextAllowedAt * 1_000).toISOString(),
    );
  }
}

async function acquireLease(
  database: D1Database,
  subject: string,
  userName: string,
  leaseID: string,
  now: number,
  nextAllowedAt: number,
): Promise<boolean> {
  const inserted = await database
    .prepare(
      `INSERT OR IGNORE INTO following_imports (
         subject, twitter_username, status, lease_id, attempted_at, next_allowed_at,
         successful_at, snapshot_key, following_count, last_error
       ) VALUES (?1, ?2, 'fetching', ?3, ?4, ?5, NULL, NULL, 0, NULL)`,
    )
    .bind(subject, userName, leaseID, now, nextAllowedAt)
    .run();
  if ((inserted.meta.changes ?? 0) === 1) return true;

  const updated = await database
    .prepare(
      `UPDATE following_imports
       SET twitter_username = ?1, status = 'fetching', lease_id = ?2,
           attempted_at = ?3, next_allowed_at = ?4, last_error = NULL
       WHERE subject = ?5 AND next_allowed_at <= ?3`,
    )
    .bind(userName, leaseID, now, nextAllowedAt, subject)
    .run();
  return (updated.meta.changes ?? 0) === 1;
}

async function loadRow(
  database: D1Database,
  subject: string,
): Promise<FollowingImportRow | null> {
  return database
    .prepare(
      `SELECT subject, twitter_username, status, lease_id, attempted_at, next_allowed_at,
              successful_at, snapshot_key, following_count, last_error
       FROM following_imports WHERE subject = ?1`,
    )
    .bind(subject)
    .first<FollowingImportRow>();
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
