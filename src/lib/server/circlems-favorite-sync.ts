import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import { createDatabase } from "../db/client";
import {
  catalogEvents,
  providerCredentials,
  userIdentities,
  users,
} from "../db/schema";
import type { CominaviIdentity } from "./cominavi-auth";
import { loadFavoriteSnapshot } from "./favorites";
import {
  loadCircleCredential,
  refreshOwnedCircleCredential,
  type CircleCredentialRefreshBindings,
} from "./provider-credentials";
import { ServiceError } from "./service-error";

const providerPageSize = 1_000;
const maximumProviderPages = 100;

export interface CirclemsFavoriteSyncBindings extends CircleCredentialRefreshBindings {
  COMINAVI_DB: D1Database;
  COMINAVI_PROVIDER_CREDENTIAL_KEY_V1: string;
  COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN: string;
  COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN: string;
}

export interface CirclemsFavoriteSyncResult {
  eventNumber: number;
  revision: number;
  favoriteCount: number;
  addedCount: number;
  updatedCount: number;
  unchangedCount: number;
  skippedMemoOnlyCount: number;
}

interface SyncAuthority {
  identityID: number;
  providerEnvironment: "production" | "sandbox";
  providerCirclemsEventID: number;
}

interface ProviderFavorite {
  wcID: number;
  color: number;
  memo: string;
}

export async function syncFavoritesToCirclems(
  bindings: CirclemsFavoriteSyncBindings,
  identity: CominaviIdentity,
  eventNumber: number,
  fetcher: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1_000),
): Promise<CirclemsFavoriteSyncResult> {
  if (!Number.isSafeInteger(eventNumber) || eventNumber < 1) {
    throw invalidSyncRequest();
  }

  const [snapshot, authority] = await Promise.all([
    loadFavoriteSnapshot(bindings.COMINAVI_DB, identity, eventNumber),
    loadSyncAuthority(bindings.COMINAVI_DB, identity, eventNumber),
  ]);
  if (!authority) throw syncUnavailable();

  let credential = await loadCircleCredential(
    bindings.COMINAVI_DB,
    identity.userID,
    authority.identityID,
    bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
  );
  if (
    credential.accessExpiresAt !== null &&
    credential.accessExpiresAt <= now + 60
  ) {
    credential = await refreshOwnedCircleCredential(
      bindings.COMINAVI_DB,
      identity.userID,
      authority.identityID,
      bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
      bindings,
      fetcher,
      now,
    );
  }

  const origin =
    authority.providerEnvironment === "production"
      ? bindings.COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN
      : bindings.COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN;
  if (!origin) throw syncUnavailable();

  // Circle.ms color zero is a memo-only row, not a favorite. Keep it out of
  // the mirror just as the iOS client keeps it out of canonical favorites.
  const favorites = snapshot.favorites.filter((favorite) => favorite.color > 0);
  const skippedMemoOnlyCount = snapshot.favorites.length - favorites.length;
  if (favorites.length === 0) {
    return {
      eventNumber,
      revision: snapshot.revision,
      favoriteCount: 0,
      addedCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      skippedMemoOnlyCount,
    };
  }

  const remoteFavorites = await loadProviderFavorites(
    origin,
    authority.providerCirclemsEventID,
    credential.accessToken,
    fetcher,
  );
  let addedCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const favorite of favorites) {
    const remote = remoteFavorites.get(favorite.wcID);
    if (remote?.color === favorite.color) {
      unchangedCount += 1;
      continue;
    }
    await mutateProviderFavorite(
      origin,
      credential.accessToken,
      remote ? "PUT" : "POST",
      favorite.wcID,
      favorite.color,
      // Canonical ComiNavi favorites do not own Circle.ms memo text. Preserve
      // an existing provider memo and initialize only newly added rows empty.
      remote?.memo ?? "",
      fetcher,
    );
    if (remote) updatedCount += 1;
    else addedCount += 1;
  }

  return {
    eventNumber,
    revision: snapshot.revision,
    favoriteCount: favorites.length,
    addedCount,
    updatedCount,
    unchangedCount,
    skippedMemoOnlyCount,
  };
}

async function loadSyncAuthority(
  database: D1Database,
  identity: CominaviIdentity,
  eventNumber: number,
): Promise<SyncAuthority | null> {
  const row = await createDatabase(database)
    .select({
      identityID: userIdentities.id,
      providerEnvironment: userIdentities.providerEnvironment,
      providerCirclemsEventID: catalogEvents.providerCirclemsEventID,
    })
    .from(users)
    .innerJoin(userIdentities, eq(userIdentities.userID, users.id))
    .innerJoin(
      providerCredentials,
      eq(providerCredentials.userIdentityID, userIdentities.id),
    )
    .innerJoin(catalogEvents, eq(catalogEvents.comiketNo, eventNumber))
    .where(
      and(
        eq(users.id, identity.userID),
        eq(users.authVersion, identity.authVersion),
        isNull(users.deletionPendingAt),
        eq(userIdentities.provider, "circlems"),
        isNotNull(catalogEvents.providerCirclemsEventID),
      ),
    )
    .orderBy(desc(userIdentities.lastAuthenticatedAt), desc(userIdentities.id))
    .limit(1)
    .get();
  if (
    !row ||
    (row.providerEnvironment !== "production" &&
      row.providerEnvironment !== "sandbox")
  ) {
    return null;
  }
  return {
    identityID: row.identityID,
    providerEnvironment: row.providerEnvironment,
    providerCirclemsEventID: row.providerCirclemsEventID!,
  };
}

async function loadProviderFavorites(
  origin: string,
  eventID: number,
  accessToken: string,
  fetcher: typeof fetch,
): Promise<Map<number, ProviderFavorite>> {
  const favorites = new Map<number, ProviderFavorite>();
  for (let page = 1; page <= maximumProviderPages; page += 1) {
    const url = new URL("/Readers/FavoriteCircles", origin);
    url.searchParams.set("event_id", String(eventID));
    url.searchParams.set("page", String(page));
    const response = await providerRequest(fetcher, url, {
      headers: providerHeaders(accessToken),
    });
    const parsed = parseProviderFavorites(response.value);
    if (!response.ok || parsed === null) throw syncFailed();
    for (const favorite of parsed) favorites.set(favorite.wcID, favorite);
    if (parsed.length < providerPageSize) return favorites;
  }
  throw syncFailed();
}

async function mutateProviderFavorite(
  origin: string,
  accessToken: string,
  method: "POST" | "PUT",
  wcID: number,
  color: number,
  memo: string,
  fetcher: typeof fetch,
): Promise<void> {
  const body = new URLSearchParams({
    wcid: String(wcID),
    color: String(color),
    memo,
  });
  const response = await providerRequest(
    fetcher,
    new URL("/Readers/Favorite", origin),
    {
      method,
      headers: {
        ...providerHeaders(accessToken),
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body,
    },
  );
  if (
    !response.ok ||
    !isRecord(response.value) ||
    response.value.status !== "success"
  ) {
    throw syncFailed();
  }
}

async function providerRequest(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
): Promise<{ ok: boolean; value: unknown }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw syncFailed();
  }
  try {
    return { ok: response.ok, value: await response.json() };
  } catch {
    throw syncFailed();
  }
}

function providerHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
}

function parseProviderFavorites(value: unknown): ProviderFavorite[] | null {
  if (
    !isRecord(value) ||
    value.status !== "success" ||
    !isRecord(value.response) ||
    !Array.isArray(value.response.list) ||
    value.response.list.length > providerPageSize
  ) {
    return null;
  }
  const favorites: ProviderFavorite[] = [];
  for (const entry of value.response.list) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.circle) ||
      !isRecord(entry.favorite)
    ) {
      return null;
    }
    const wcID = integer(entry.circle.wcid);
    const favoriteWCID = integer(entry.favorite.wcid);
    const color = integer(entry.favorite.color);
    const memo = entry.favorite.memo;
    if (
      wcID === null ||
      wcID < 1 ||
      favoriteWCID !== wcID ||
      color === null ||
      color < 0 ||
      color > 9 ||
      typeof memo !== "string" ||
      memo.length > 65_536
    ) {
      return null;
    }
    favorites.push({ wcID, color, memo });
  }
  return favorites;
}

function integer(value: unknown): number | null {
  const parsed =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(parsed) ? Number(parsed) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSyncRequest(): ServiceError {
  return new ServiceError(
    "invalid_circlems_favorite_sync",
    400,
    "The Circle.ms favorite sync request is invalid.",
  );
}

function syncUnavailable(): ServiceError {
  return new ServiceError(
    "circlems_favorite_sync_unavailable",
    404,
    "A linked Circle.ms account and catalog event are required.",
  );
}

function syncFailed(): ServiceError {
  return new ServiceError(
    "circlems_favorite_sync_failed",
    502,
    "Circle.ms favorites could not be synced.",
  );
}
