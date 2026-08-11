import type { CominaviIdentity } from "./cominavi-auth";
import { and, desc, eq, exists, isNull, lt, or, sql } from "drizzle-orm";
import { createDatabase } from "../db/client";
import {
  sharedPlanEventRecipients,
  sharedPlanEvents,
  users,
} from "../db/schema";
import { AuthenticationError } from "./cominavi-auth";
import { base64URL, decodeBase64URL } from "./auth-sessions";
import { ServiceError } from "./service-error";

const defaultNotificationPageSize = 50;
const maximumNotificationPageSize = 100;
const maximumNotificationCursorLength = 512;
const notificationEventIDPattern = /^[0-9a-f]{64}$/;

export interface NotificationPage {
  limit: number;
  cursor: string | null;
}

export interface SharedPlanNotificationItem {
  id: string;
  kind: "sharedPlanEvent";
  planID: string;
  eventType: string;
  i18nKey: string;
  payloadVersion: number;
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPageResult {
  items: SharedPlanNotificationItem[];
  nextCursor: string | null;
}

export interface NotificationReadReceipt {
  id: string;
  readAt: string;
}

interface NotificationCursor {
  eventCreatedAt: number;
  eventID: string;
}

interface NotificationRow {
  eventID: string | null;
  eventCreatedAt: number | null;
  readAt: number | null;
  planID: string | null;
  eventType: string | null;
  i18nKey: string | null;
  payloadVersion: number | null;
  payloadJSON: string | null;
}

export function parseNotificationPage(request: Request): NotificationPage {
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const limit =
    rawLimit === null ? defaultNotificationPageSize : Number(rawLimit);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > maximumNotificationPageSize
  ) {
    throw invalidNotificationPagination();
  }
  return { limit, cursor: url.searchParams.get("cursor") };
}

export function parseNotificationEventID(value: unknown): string {
  if (typeof value !== "string" || !notificationEventIDPattern.test(value)) {
    throw invalidNotificationEvent();
  }
  return value;
}

export async function listNotifications(
  database: D1Database,
  identity: CominaviIdentity,
  page: NotificationPage,
): Promise<NotificationPageResult> {
  const cursor = decodeNotificationCursor(page.cursor);
  const cursorCondition = cursor
    ? or(
        lt(sharedPlanEventRecipients.eventCreatedAt, cursor.eventCreatedAt),
        and(
          eq(sharedPlanEventRecipients.eventCreatedAt, cursor.eventCreatedAt),
          lt(sharedPlanEventRecipients.eventID, cursor.eventID),
        ),
      )
    : undefined;
  const rows = await createDatabase(database)
    .select({
      eventID: sharedPlanEventRecipients.eventID,
      eventCreatedAt: sharedPlanEventRecipients.eventCreatedAt,
      readAt: sharedPlanEventRecipients.readAt,
      planID: sharedPlanEvents.planID,
      eventType: sharedPlanEvents.eventType,
      i18nKey: sharedPlanEvents.i18nKey,
      payloadVersion: sharedPlanEvents.payloadVersion,
      payloadJSON: sharedPlanEvents.payloadJSON,
    })
    .from(users)
    .leftJoin(
      sharedPlanEventRecipients,
      and(eq(sharedPlanEventRecipients.userID, users.id), cursorCondition),
    )
    .leftJoin(
      sharedPlanEvents,
      eq(sharedPlanEvents.id, sharedPlanEventRecipients.eventID),
    )
    .where(
      and(
        eq(users.id, identity.userID),
        eq(users.authVersion, identity.authVersion),
        isNull(users.deletionPendingAt),
      ),
    )
    .orderBy(
      desc(sharedPlanEventRecipients.eventCreatedAt),
      desc(sharedPlanEventRecipients.eventID),
    )
    .limit(page.limit + 1);
  if (rows.length === 0) throw invalidSession();
  const data = rows.filter(
    (
      row,
    ): row is NotificationRow & {
      eventID: string;
      eventCreatedAt: number;
      planID: string;
      eventType: string;
      i18nKey: string;
      payloadVersion: number;
      payloadJSON: string;
    } => row.eventID !== null,
  );
  const pageRows = data.slice(0, page.limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(serializeNotification),
    nextCursor:
      data.length > page.limit && last
        ? encodeNotificationCursor({
            eventCreatedAt: last.eventCreatedAt,
            eventID: last.eventID,
          })
        : null,
  };
}

export async function markNotificationRead(
  database: D1Database,
  identity: CominaviIdentity,
  eventID: string,
  nowMilliseconds = Date.now(),
): Promise<NotificationReadReceipt> {
  const readAt = Math.floor(nowMilliseconds / 1_000);
  const db = createDatabase(database);
  const authorized = db
    .select({ allowed: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, identity.userID),
        eq(users.authVersion, identity.authVersion),
        isNull(users.deletionPendingAt),
      ),
    );
  const updated = await db
    .update(sharedPlanEventRecipients)
    .set({
      readAt: sql`coalesce(${sharedPlanEventRecipients.readAt}, ${readAt})`,
    })
    .where(
      and(
        eq(sharedPlanEventRecipients.eventID, eventID),
        eq(sharedPlanEventRecipients.userID, identity.userID),
        exists(authorized),
      ),
    )
    .returning({
      eventID: sharedPlanEventRecipients.eventID,
      readAt: sharedPlanEventRecipients.readAt,
    })
    .get();
  if (!updated) {
    if (!(await authorized.get())) throw invalidSession();
    throw notificationNotFound();
  }
  return { id: updated.eventID, readAt: timestamp(updated.readAt!) };
}

function serializeNotification(
  row: NotificationRow & {
    eventID: string;
    eventCreatedAt: number;
    planID: string;
    eventType: string;
    i18nKey: string;
    payloadVersion: number;
    payloadJSON: string;
  },
): SharedPlanNotificationItem {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payloadJSON);
  } catch {
    throw new Error("Shared Plan notification payload is not valid JSON.");
  }
  if (
    !isRecord(payload) ||
    payload.v !== row.payloadVersion ||
    !Number.isSafeInteger(row.payloadVersion) ||
    row.payloadVersion < 1
  ) {
    throw new Error("Shared Plan notification payload is not typed.");
  }
  return {
    id: row.eventID,
    kind: "sharedPlanEvent",
    planID: row.planID,
    eventType: row.eventType,
    i18nKey: row.i18nKey,
    payloadVersion: row.payloadVersion,
    payload,
    createdAt: timestamp(row.eventCreatedAt),
    readAt: row.readAt === null ? null : timestamp(row.readAt),
  };
}

function encodeNotificationCursor(cursor: NotificationCursor): string {
  return base64URL(
    new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        kind: "notifications",
        eventCreatedAt: cursor.eventCreatedAt,
        eventID: cursor.eventID,
      }),
    ),
  );
}

function decodeNotificationCursor(
  value: string | null,
): NotificationCursor | null {
  if (value === null) return null;
  if (value.length < 1 || value.length > maximumNotificationCursorLength) {
    throw invalidNotificationPagination();
  }
  try {
    const decoded: unknown = JSON.parse(
      new TextDecoder().decode(decodeBase64URL(value)),
    );
    if (
      !isRecord(decoded) ||
      decoded.v !== 1 ||
      decoded.kind !== "notifications" ||
      !Number.isSafeInteger(decoded.eventCreatedAt) ||
      Number(decoded.eventCreatedAt) < 0 ||
      typeof decoded.eventID !== "string" ||
      !notificationEventIDPattern.test(decoded.eventID)
    ) {
      throw invalidNotificationPagination();
    }
    return {
      eventCreatedAt: Number(decoded.eventCreatedAt),
      eventID: decoded.eventID,
    };
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw invalidNotificationPagination();
  }
}

function timestamp(seconds: number): string {
  const date = new Date(seconds * 1_000);
  if (!Number.isSafeInteger(seconds) || Number.isNaN(date.valueOf())) {
    throw new Error("Shared Plan notification timestamp is invalid.");
  }
  return date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidNotificationPagination(): ServiceError {
  return new ServiceError(
    "invalid_pagination",
    400,
    "Notification limit must be between 1 and 100 and cursor must be valid.",
  );
}

function invalidNotificationEvent(): ServiceError {
  return new ServiceError(
    "invalid_notification_event",
    400,
    "The notification event ID is invalid.",
  );
}

function notificationNotFound(): ServiceError {
  return new ServiceError(
    "notification_not_found",
    404,
    "The notification was not found.",
  );
}

function invalidSession(): AuthenticationError {
  return new AuthenticationError(
    "invalid_token",
    401,
    "The ComiNavi session is no longer valid.",
  );
}
