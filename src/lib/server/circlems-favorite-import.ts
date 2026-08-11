import type { CominaviIdentity } from "./cominavi-auth";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { createDatabase } from "../db/client";
import {
  catalogEvents,
  providerCredentials,
  userIdentities,
  users,
} from "../db/schema";
import { base64URL, decodeBase64URL } from "./auth-sessions";
import {
  loadCircleCredential,
  refreshOwnedCircleCredential,
  type CircleCredentialRefreshBindings,
} from "./provider-credentials";
import { ServiceError } from "./service-error";

const providerPageSize = 1_000;
const maximumCursorLength = 256;

export interface CirclemsFavoriteImportBindings extends CircleCredentialRefreshBindings {
  COMINAVI_DB: D1Database;
  COMINAVI_PROVIDER_CREDENTIAL_KEY_V1: string;
  COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN: string;
  COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN: string;
}

export interface CirclemsFavoriteImportItem {
  wcID: number;
  updateID: number;
  circleName: string;
  color: number;
  memo: string;
}

export interface CirclemsFavoriteImportPage {
  eventNumber: number;
  items: CirclemsFavoriteImportItem[];
  nextCursor: string | null;
}

interface ImportAuthority {
  identity_id: number;
  provider_environment: "production" | "sandbox";
  provider_circlems_event_id: number;
}

export async function loadCirclemsFavoriteImportPage(
  bindings: CirclemsFavoriteImportBindings,
  identity: CominaviIdentity,
  eventNumber: number,
  cursor: string | null,
  fetcher: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1_000),
): Promise<CirclemsFavoriteImportPage> {
  if (!Number.isSafeInteger(eventNumber) || eventNumber < 1) {
    throw invalidImportRequest();
  }
  const page = decodeCursor(cursor, eventNumber);
  const row = await createDatabase(bindings.COMINAVI_DB)
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
  const authority: ImportAuthority | null =
    row &&
    (row.providerEnvironment === "production" ||
      row.providerEnvironment === "sandbox")
      ? {
          identity_id: row.identityID,
          provider_environment: row.providerEnvironment,
          provider_circlems_event_id: row.providerCirclemsEventID!,
        }
      : null;
  if (!authority) throw importUnavailable();

  let credential = await loadCircleCredential(
    bindings.COMINAVI_DB,
    identity.userID,
    authority.identity_id,
    bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
  );
  if (
    credential.accessExpiresAt !== null &&
    credential.accessExpiresAt <= now + 60
  ) {
    credential = await refreshOwnedCircleCredential(
      bindings.COMINAVI_DB,
      identity.userID,
      authority.identity_id,
      bindings.COMINAVI_PROVIDER_CREDENTIAL_KEY_V1,
      bindings,
      fetcher,
      now,
    );
  }

  const origin =
    authority.provider_environment === "production"
      ? bindings.COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN
      : bindings.COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN;
  if (!origin) throw importUnavailable();
  const url = new URL("/Readers/FavoriteCircles", origin);
  url.searchParams.set(
    "event_id",
    String(authority.provider_circlems_event_id),
  );
  url.searchParams.set("page", String(page));

  let response: Response;
  try {
    response = await fetcher(url, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw providerFailure();
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw providerFailure();
  }
  const parsed = parseProviderFavorites(value);
  if (!response.ok || parsed === null) throw providerFailure();
  return {
    eventNumber,
    items: parsed.items,
    nextCursor:
      parsed.providerCount === providerPageSize && page < 100
        ? encodeCursor(eventNumber, page + 1)
        : null,
  };
}

function parseProviderFavorites(
  value: unknown,
): { items: CirclemsFavoriteImportItem[]; providerCount: number } | null {
  if (
    !isRecord(value) ||
    value.status !== "success" ||
    !isRecord(value.response) ||
    !Array.isArray(value.response.list) ||
    value.response.list.length > providerPageSize
  ) {
    return null;
  }
  const byCircle = new Map<number, CirclemsFavoriteImportItem>();
  for (const entry of value.response.list) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.circle) ||
      !isRecord(entry.favorite)
    ) {
      return null;
    }
    const wcID = integer(entry.circle.wcid);
    const updateID = integer(entry.circle.updateId);
    const favoriteWCID = integer(entry.favorite.wcid);
    const color = integer(entry.favorite.color);
    const circleName = entry.favorite.circle_name;
    const memo = entry.favorite.memo;
    if (
      wcID === null ||
      wcID < 1 ||
      updateID === null ||
      updateID < 1 ||
      favoriteWCID !== wcID ||
      color === null ||
      color < 0 ||
      color > 9 ||
      typeof circleName !== "string" ||
      circleName.length > 200 ||
      typeof memo !== "string" ||
      memo.length > 65_536
    ) {
      return null;
    }
    byCircle.set(wcID, { wcID, updateID, circleName, color, memo });
  }
  return {
    items: [...byCircle.values()].sort((left, right) => left.wcID - right.wcID),
    providerCount: value.response.list.length,
  };
}

function integer(value: unknown): number | null {
  const parsed =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(parsed) ? Number(parsed) : null;
}

function encodeCursor(eventNumber: number, page: number): string {
  return base64URL(
    new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        kind: "circlemsFavoriteImport",
        eventNumber,
        page,
      }),
    ),
  );
}

function decodeCursor(value: string | null, eventNumber: number): number {
  if (value === null) return 1;
  if (value.length < 1 || value.length > maximumCursorLength) {
    throw invalidImportRequest();
  }
  try {
    const decoded: unknown = JSON.parse(
      new TextDecoder().decode(decodeBase64URL(value)),
    );
    if (
      !isRecord(decoded) ||
      decoded.v !== 1 ||
      decoded.kind !== "circlemsFavoriteImport" ||
      decoded.eventNumber !== eventNumber ||
      !Number.isSafeInteger(decoded.page) ||
      Number(decoded.page) < 2 ||
      Number(decoded.page) > 100
    ) {
      throw invalidImportRequest();
    }
    return Number(decoded.page);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw invalidImportRequest();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidImportRequest(): ServiceError {
  return new ServiceError(
    "invalid_circlems_favorite_import",
    400,
    "The Circle.ms favorite import request is invalid.",
  );
}

function importUnavailable(): ServiceError {
  return new ServiceError(
    "circlems_favorite_import_unavailable",
    404,
    "A linked Circle.ms account and catalog event are required.",
  );
}

function providerFailure(): ServiceError {
  return new ServiceError(
    "circlems_favorite_import_failed",
    502,
    "Circle.ms favorites could not be loaded.",
  );
}
