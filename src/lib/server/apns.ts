import type { PushQueueMessage } from "./push-queue";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { createDatabase } from "../db/client";
import { runDrizzleBatch } from "../db/batch";
import {
  circleUpdateEvents,
  circleUpdateTargets,
  circles,
  notificationDeliveries,
  pushDevices,
  sharedPlanEvents,
  sharedPlanMembers,
  sharedPlanNotificationDeliveries,
  sharedPlans,
  socialPosts,
  userFavorites,
  users,
} from "../db/schema";

interface APNsBindings {
  COMINAVI_DB: D1Database;
  COMINAVI_APNS_KEY_ID: string;
  COMINAVI_APNS_TEAM_ID: string;
  COMINAVI_APNS_PRIVATE_KEY: string;
}

interface DeliveryRow {
  id: number;
  attempt_count: number;
  token: string;
  apns_environment: "sandbox" | "production";
  bundle_id: string;
  state_kind: string;
  state_value: string;
  update_kind: string;
  comiket_no: number;
  wc_id: number;
  circle_name: string;
  author_handle: string;
  text: string;
  subscribed: number;
}

interface SharedPlanDeliveryRow {
  id: number;
  attempt_count: number;
  token: string;
  apns_environment: "sandbox" | "production";
  bundle_id: string;
  event_id: string;
  plan_id: string;
  plan_name: string;
  event_type: string;
  i18n_key: string;
  payload_version: number;
  urgency: "routine" | "conflict";
  collapse_key: string | null;
}

let cachedProviderToken:
  { key: string; token: string; issuedAt: number } | undefined;

export async function processPushQueueMessage(
  message: Message<PushQueueMessage>,
  bindings: APNsBindings,
  fetcher: typeof fetch = fetch,
  nowMilliseconds = Date.now(),
  beforeFinalAuthorityCheck?: () => void | Promise<void>,
): Promise<void> {
  if (message.body?.kind === "shared-plan") {
    await processSharedPlanPush(
      message,
      bindings,
      fetcher,
      nowMilliseconds,
      beforeFinalAuthorityCheck,
    );
    return;
  }
  const candidateDeliveryID =
    message.body && "deliveryID" in message.body
      ? message.body.deliveryID
      : undefined;
  if (
    typeof candidateDeliveryID !== "number" ||
    !Number.isSafeInteger(candidateDeliveryID) ||
    candidateDeliveryID <= 0
  ) {
    message.ack();
    return;
  }
  const deliveryID = candidateDeliveryID;
  const now = Math.floor(nowMilliseconds / 1_000);
  const db = createDatabase(bindings.COMINAVI_DB);
  const claimed = await db
    .update(notificationDeliveries)
    .set({
      status: "processing",
      attemptCount: sql`${notificationDeliveries.attemptCount} + 1`,
      leaseExpiresAt: now + 120,
      updatedAt: now,
    })
    .where(
      and(
        eq(notificationDeliveries.id, deliveryID),
        inArray(notificationDeliveries.status, ["pending", "retry"]),
        lte(notificationDeliveries.availableAt, now),
      ),
    )
    .returning({ id: notificationDeliveries.id })
    .get();
  if (!claimed) {
    message.ack();
    return;
  }

  const delivery = await loadDelivery(bindings.COMINAVI_DB, deliveryID);
  if (!delivery || delivery.subscribed !== 1) {
    await finishDelivery(
      bindings.COMINAVI_DB,
      deliveryID,
      "suppressed",
      now,
      "favorite_disabled",
    );
    message.ack();
    return;
  }

  try {
    const token = await providerToken(bindings, now);
    const request = makeAPNsRequest(delivery, token);
    await beforeFinalAuthorityCheck?.();
    const stillAuthorized = await db
      .select({ authorized: notificationDeliveries.id })
      .from(notificationDeliveries)
      .innerJoin(
        pushDevices,
        eq(pushDevices.id, notificationDeliveries.deviceID),
      )
      .innerJoin(users, eq(users.id, notificationDeliveries.userID))
      .where(
        and(
          eq(notificationDeliveries.id, deliveryID),
          eq(notificationDeliveries.status, "processing"),
          eq(pushDevices.enabled, 1),
          isNull(users.deletionPendingAt),
        ),
      )
      .get();
    if (!stillAuthorized) {
      await finishDelivery(
        bindings.COMINAVI_DB,
        deliveryID,
        "suppressed",
        now,
        "account_disabled",
      );
      message.ack();
      return;
    }
    const response = await fetcher(request);
    const apnsID = response.headers.get("apns-id");
    if (response.ok) {
      await db
        .update(notificationDeliveries)
        .set({
          status: "delivered",
          deliveredAt: now,
          apnsID,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(notificationDeliveries.id, deliveryID),
            eq(notificationDeliveries.status, "processing"),
          ),
        )
        .run();
      message.ack();
      return;
    }

    const reason = await apnsReason(response);
    if (
      response.status === 410 ||
      reason === "BadDeviceToken" ||
      reason === "DeviceTokenNotForTopic" ||
      reason === "Unregistered"
    ) {
      await runDrizzleBatch(bindings.COMINAVI_DB, [
        sql`
          UPDATE ${pushDevices}
           SET enabled = 0, invalidated_at = ${now}, updated_at = ${now}
           WHERE id = (
             SELECT device_id FROM ${notificationDeliveries}
             WHERE id = ${deliveryID}
           )`,
        sql`
          UPDATE ${notificationDeliveries}
          SET status = 'dead', apns_id = ${apnsID}, last_error = ${reason},
              lease_expires_at = NULL, updated_at = ${now}
          WHERE id = ${deliveryID}`,
      ]);
      message.ack();
      return;
    }

    if (response.status >= 500 || response.status === 429) {
      await retryDelivery(message, bindings.COMINAVI_DB, delivery, reason, now);
      return;
    }
    await finishDelivery(bindings.COMINAVI_DB, deliveryID, "dead", now, reason);
    message.ack();
  } catch (error) {
    await retryDelivery(
      message,
      bindings.COMINAVI_DB,
      delivery,
      error instanceof Error ? error.message : "push_transport_error",
      now,
    );
  }
}

async function processSharedPlanPush(
  message: Message<PushQueueMessage>,
  bindings: APNsBindings,
  fetcher: typeof fetch,
  nowMilliseconds: number,
  beforeFinalAuthorityCheck?: () => void | Promise<void>,
): Promise<void> {
  if (message.body?.kind !== "shared-plan") return;
  const deliveryID = message.body.sharedPlanDeliveryID;
  if (!Number.isSafeInteger(deliveryID) || deliveryID < 1) {
    message.ack();
    return;
  }
  const now = Math.floor(nowMilliseconds / 1_000);
  const db = createDatabase(bindings.COMINAVI_DB);
  const claimed = await db
    .update(sharedPlanNotificationDeliveries)
    .set({
      status: "processing",
      attemptCount: sql`${sharedPlanNotificationDeliveries.attemptCount} + 1`,
      leaseExpiresAt: now + 120,
      updatedAt: now,
    })
    .where(
      and(
        eq(sharedPlanNotificationDeliveries.id, deliveryID),
        inArray(sharedPlanNotificationDeliveries.status, ["pending", "retry"]),
        lte(sharedPlanNotificationDeliveries.availableAt, now),
      ),
    )
    .returning({ id: sharedPlanNotificationDeliveries.id })
    .get();
  if (!claimed) {
    message.ack();
    return;
  }
  const delivery = await loadSharedPlanDelivery(
    bindings.COMINAVI_DB,
    deliveryID,
  );
  if (!delivery) {
    await finishSharedPlanDelivery(
      bindings.COMINAVI_DB,
      deliveryID,
      "suppressed",
      now,
      "plan_authority_changed",
    );
    message.ack();
    return;
  }
  try {
    const token = await providerToken(bindings, now);
    const request = makeSharedPlanAPNsRequest(delivery, token);
    await beforeFinalAuthorityCheck?.();
    const authorized = await db
      .select({ authorized: sharedPlanNotificationDeliveries.id })
      .from(sharedPlanNotificationDeliveries)
      .innerJoin(
        sharedPlanEvents,
        eq(sharedPlanEvents.id, sharedPlanNotificationDeliveries.eventID),
      )
      .innerJoin(sharedPlans, eq(sharedPlans.id, sharedPlanEvents.planID))
      .innerJoin(
        sharedPlanMembers,
        and(
          eq(sharedPlanMembers.planID, sharedPlans.id),
          eq(sharedPlanMembers.userID, sharedPlanNotificationDeliveries.userID),
        ),
      )
      .innerJoin(
        pushDevices,
        eq(pushDevices.id, sharedPlanNotificationDeliveries.deviceID),
      )
      .innerJoin(users, eq(users.id, sharedPlanNotificationDeliveries.userID))
      .where(
        and(
          eq(sharedPlanNotificationDeliveries.id, deliveryID),
          eq(sharedPlanNotificationDeliveries.status, "processing"),
          isNull(sharedPlanMembers.revokedAt),
          isNull(sharedPlans.archivedAt),
          eq(
            sharedPlanNotificationDeliveries.planNotificationEpoch,
            sharedPlans.notificationEpoch,
          ),
          eq(
            sharedPlanNotificationDeliveries.planNotificationEpoch,
            sharedPlanEvents.planNotificationEpoch,
          ),
          eq(
            sharedPlanNotificationDeliveries.membershipNotificationEpoch,
            sharedPlanMembers.notificationEpoch,
          ),
          eq(pushDevices.enabled, 1),
          isNull(users.deletionPendingAt),
        ),
      )
      .get();
    if (!authorized) {
      await finishSharedPlanDelivery(
        bindings.COMINAVI_DB,
        deliveryID,
        "suppressed",
        now,
        "plan_authority_changed",
      );
      message.ack();
      return;
    }
    const response = await fetcher(request);
    const apnsID = response.headers.get("apns-id");
    if (response.ok) {
      await db
        .update(sharedPlanNotificationDeliveries)
        .set({
          status: "delivered",
          deliveredAt: now,
          apnsID,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(sharedPlanNotificationDeliveries.id, deliveryID),
            eq(sharedPlanNotificationDeliveries.status, "processing"),
          ),
        )
        .run();
      message.ack();
      return;
    }
    const reason = await apnsReason(response);
    if (
      response.status === 410 ||
      reason === "BadDeviceToken" ||
      reason === "DeviceTokenNotForTopic" ||
      reason === "Unregistered"
    ) {
      await runDrizzleBatch(bindings.COMINAVI_DB, [
        sql`
          UPDATE ${pushDevices}
           SET enabled = 0, invalidated_at = ${now}, updated_at = ${now}
           WHERE id = (
             SELECT device_id FROM ${sharedPlanNotificationDeliveries}
             WHERE id = ${deliveryID}
           )`,
        sql`
          UPDATE ${sharedPlanNotificationDeliveries}
          SET status = 'dead', apns_id = ${apnsID}, last_error = ${reason},
              lease_expires_at = NULL, updated_at = ${now}
          WHERE id = ${deliveryID}`,
      ]);
      message.ack();
      return;
    }
    if (response.status >= 500 || response.status === 429) {
      await retrySharedPlanDelivery(
        message,
        bindings.COMINAVI_DB,
        delivery,
        reason,
        now,
      );
      return;
    }
    await finishSharedPlanDelivery(
      bindings.COMINAVI_DB,
      deliveryID,
      "dead",
      now,
      reason,
    );
    message.ack();
  } catch (error) {
    await retrySharedPlanDelivery(
      message,
      bindings.COMINAVI_DB,
      delivery,
      error instanceof Error ? error.message : "push_transport_error",
      now,
    );
  }
}

async function loadSharedPlanDelivery(
  database: D1Database,
  deliveryID: number,
): Promise<SharedPlanDeliveryRow | null> {
  const row = await createDatabase(database)
    .select({
      id: sql<number>`${sharedPlanNotificationDeliveries.id}`.as("delivery_id"),
      attemptCount: sharedPlanNotificationDeliveries.attemptCount,
      token: pushDevices.token,
      apnsEnvironment: pushDevices.apnsEnvironment,
      bundleID: pushDevices.bundleID,
      eventID: sql<string>`${sharedPlanEvents.id}`.as("event_id"),
      planID: sharedPlanEvents.planID,
      planName: sharedPlans.name,
      eventType: sharedPlanEvents.eventType,
      i18nKey: sharedPlanEvents.i18nKey,
      payloadVersion: sharedPlanEvents.payloadVersion,
      urgency: sharedPlanNotificationDeliveries.urgency,
      collapseKey: sharedPlanNotificationDeliveries.collapseKey,
    })
    .from(sharedPlanNotificationDeliveries)
    .innerJoin(
      sharedPlanEvents,
      eq(sharedPlanEvents.id, sharedPlanNotificationDeliveries.eventID),
    )
    .innerJoin(sharedPlans, eq(sharedPlans.id, sharedPlanEvents.planID))
    .innerJoin(
      sharedPlanMembers,
      and(
        eq(sharedPlanMembers.planID, sharedPlans.id),
        eq(sharedPlanMembers.userID, sharedPlanNotificationDeliveries.userID),
      ),
    )
    .innerJoin(
      pushDevices,
      eq(pushDevices.id, sharedPlanNotificationDeliveries.deviceID),
    )
    .innerJoin(users, eq(users.id, sharedPlanNotificationDeliveries.userID))
    .where(
      and(
        eq(sharedPlanNotificationDeliveries.id, deliveryID),
        eq(sharedPlanNotificationDeliveries.status, "processing"),
        isNull(sharedPlanMembers.revokedAt),
        isNull(sharedPlans.archivedAt),
        eq(
          sharedPlanNotificationDeliveries.planNotificationEpoch,
          sharedPlans.notificationEpoch,
        ),
        eq(
          sharedPlanNotificationDeliveries.planNotificationEpoch,
          sharedPlanEvents.planNotificationEpoch,
        ),
        eq(
          sharedPlanNotificationDeliveries.membershipNotificationEpoch,
          sharedPlanMembers.notificationEpoch,
        ),
        eq(pushDevices.enabled, 1),
        isNull(users.deletionPendingAt),
      ),
    )
    .get();
  return row
    ? {
        id: row.id,
        attempt_count: row.attemptCount,
        token: row.token,
        apns_environment: row.apnsEnvironment,
        bundle_id: row.bundleID,
        event_id: row.eventID,
        plan_id: row.planID,
        plan_name: row.planName,
        event_type: row.eventType,
        i18n_key: row.i18nKey,
        payload_version: row.payloadVersion,
        urgency: row.urgency,
        collapse_key: row.collapseKey,
      }
    : null;
}

function makeSharedPlanAPNsRequest(
  delivery: SharedPlanDeliveryRow,
  providerJWT: string,
): Request {
  const host =
    delivery.apns_environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";
  const headers: Record<string, string> = {
    Authorization: `bearer ${providerJWT}`,
    "Content-Type": "application/json",
    "apns-topic": delivery.bundle_id,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(Date.now() / 1_000) + 21_600),
  };
  if (delivery.collapse_key)
    headers["apns-collapse-id"] = delivery.collapse_key;
  return new Request(`${host}/3/device/${delivery.token}`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers,
    body: JSON.stringify({
      aps: {
        alert: {
          "loc-key": delivery.i18n_key,
          "loc-args": [delivery.plan_name],
        },
        sound: "default",
        "thread-id": `shared-plan-${delivery.plan_id}`,
        "interruption-level":
          delivery.urgency === "conflict" ? "time-sensitive" : "active",
      },
      cominavi: {
        version: 1,
        kind: "sharedPlanEvent",
        eventID: delivery.event_id,
        planID: delivery.plan_id,
        eventType: delivery.event_type,
        payloadVersion: delivery.payload_version,
      },
    }),
  });
}

async function loadDelivery(
  database: D1Database,
  deliveryID: number,
): Promise<DeliveryRow | null> {
  const subscribed = sql<number>`CASE WHEN EXISTS (
    SELECT 1 FROM ${circleUpdateTargets} AS subscribed_target
    JOIN ${userFavorites} AS favorite
      ON favorite.comiket_no = subscribed_target.comiket_no
     AND favorite.wc_id = subscribed_target.wc_id
     AND favorite.user_id = ${notificationDeliveries.userID}
     AND favorite.active = 1 AND favorite.notifications_enabled = 1
    WHERE subscribed_target.update_event_id = ${circleUpdateEvents.id}
  ) THEN 1 ELSE 0 END`;
  const row = await createDatabase(database)
    .select({
      id: notificationDeliveries.id,
      attemptCount: notificationDeliveries.attemptCount,
      token: pushDevices.token,
      apnsEnvironment: pushDevices.apnsEnvironment,
      bundleID: pushDevices.bundleID,
      stateKind: circleUpdateEvents.stateKind,
      stateValue: circleUpdateEvents.stateValue,
      updateKind: circleUpdateEvents.updateKind,
      comiketNo: circleUpdateTargets.comiketNo,
      wcID: circleUpdateTargets.wcID,
      circleName: sql<string>`coalesce(${circles.circleName}, '')`,
      authorHandle: socialPosts.authorHandle,
      text: socialPosts.text,
      subscribed,
    })
    .from(notificationDeliveries)
    .innerJoin(pushDevices, eq(pushDevices.id, notificationDeliveries.deviceID))
    .innerJoin(users, eq(users.id, notificationDeliveries.userID))
    .innerJoin(
      circleUpdateEvents,
      eq(circleUpdateEvents.id, notificationDeliveries.updateEventID),
    )
    .innerJoin(socialPosts, eq(socialPosts.postID, circleUpdateEvents.postID))
    .innerJoin(
      circleUpdateTargets,
      eq(circleUpdateTargets.updateEventID, circleUpdateEvents.id),
    )
    .innerJoin(
      circles,
      and(
        eq(circles.comiketNo, circleUpdateTargets.comiketNo),
        eq(circles.wcID, circleUpdateTargets.wcID),
      ),
    )
    .where(
      and(
        eq(notificationDeliveries.id, deliveryID),
        eq(pushDevices.enabled, 1),
        isNull(users.deletionPendingAt),
      ),
    )
    .orderBy(circleUpdateTargets.wcID)
    .limit(1)
    .get();
  return row
    ? {
        id: row.id,
        attempt_count: row.attemptCount,
        token: row.token,
        apns_environment: row.apnsEnvironment,
        bundle_id: row.bundleID,
        state_kind: row.stateKind,
        state_value: row.stateValue,
        update_kind: row.updateKind,
        comiket_no: row.comiketNo,
        wc_id: row.wcID,
        circle_name: row.circleName,
        author_handle: row.authorHandle,
        text: row.text,
        subscribed: row.subscribed,
      }
    : null;
}

function makeAPNsRequest(delivery: DeliveryRow, providerJWT: string): Request {
  const host =
    delivery.apns_environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";
  const content = notificationContent(delivery);
  return new Request(`${host}/3/device/${delivery.token}`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `bearer ${providerJWT}`,
      "Content-Type": "application/json",
      "apns-topic": delivery.bundle_id,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1_000) + 21_600),
      "apns-collapse-id":
        `c${delivery.comiket_no}-${delivery.wc_id}-${delivery.state_kind}`.slice(
          0,
          64,
        ),
    },
    body: JSON.stringify({
      aps: {
        alert: { title: content.title, body: content.body },
        sound: "default",
        "thread-id": `c${delivery.comiket_no}-circle-${delivery.wc_id}`,
        "interruption-level": content.timeSensitive
          ? "time-sensitive"
          : "active",
      },
      cominavi: {
        version: 1,
        eventNumber: delivery.comiket_no,
        updateKind: delivery.update_kind,
        stateKind: delivery.state_kind,
        stateValue: delivery.state_value,
        wcID: delivery.wc_id,
      },
    }),
  });
}

function notificationContent(delivery: DeliveryRow): {
  title: string;
  body: string;
  timeSensitive: boolean;
} {
  const circle = delivery.circle_name || `@${delivery.author_handle}`;
  const titles: Record<string, string> = {
    attendance_absent: `${circle} は欠席です`,
    inventory_sold_out: `${circle} は完売しました`,
    inventory_low_stock: `${circle} は残りわずかです`,
    presence_temporarily_away: `${circle} は一時離席中です`,
    presence_present: `${circle} がスペースに戻りました`,
    presence_closed: `${circle} は撤収しました`,
    shinagaki_published: `${circle} のお品書きが更新されました`,
    cover_published: `${circle} の表紙が公開されました`,
  };
  const timeSensitive = ["attendance", "inventory", "presence"].includes(
    delivery.state_kind,
  );
  const body = delivery.text.replace(/\s+/g, " ").trim().slice(0, 140);
  return {
    title: titles[delivery.update_kind] ?? `${circle} から新しいお知らせ`,
    body: body || `@${delivery.author_handle} の投稿を確認してください。`,
    timeSensitive,
  };
}

async function providerToken(
  bindings: APNsBindings,
  nowSeconds: number,
): Promise<string> {
  const cacheKey = `${bindings.COMINAVI_APNS_TEAM_ID}:${bindings.COMINAVI_APNS_KEY_ID}`;
  if (
    cachedProviderToken?.key === cacheKey &&
    nowSeconds - cachedProviderToken.issuedAt < 50 * 60
  ) {
    return cachedProviderToken.token;
  }
  const header = base64URL(
    new TextEncoder().encode(
      JSON.stringify({ alg: "ES256", kid: bindings.COMINAVI_APNS_KEY_ID }),
    ),
  );
  const payload = base64URL(
    new TextEncoder().encode(
      JSON.stringify({ iss: bindings.COMINAVI_APNS_TEAM_ID, iat: nowSeconds }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(bindings.COMINAVI_APNS_PRIVATE_KEY),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  const token = `${signingInput}.${base64URL(signature)}`;
  cachedProviderToken = { key: cacheKey, token, issuedAt: nowSeconds };
  return token;
}

function pemBytes(pem: string): ArrayBuffer {
  const value = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function base64URL(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function apnsReason(response: Response): Promise<string> {
  try {
    const value = (await response.json()) as { reason?: unknown };
    return typeof value.reason === "string"
      ? value.reason.slice(0, 500)
      : `apns_http_${response.status}`;
  } catch {
    return `apns_http_${response.status}`;
  }
}

async function retryDelivery(
  message: Message<PushQueueMessage>,
  database: D1Database,
  delivery: DeliveryRow,
  reason: string,
  now: number,
): Promise<void> {
  if (delivery.attempt_count >= 8) {
    await finishDelivery(database, delivery.id, "dead", now, reason);
    message.ack();
    return;
  }
  const delay = Math.min(3_600, 15 * 2 ** Math.min(delivery.attempt_count, 8));
  await createDatabase(database)
    .update(notificationDeliveries)
    .set({
      status: "retry",
      availableAt: now + delay,
      leaseExpiresAt: null,
      lastError: reason.slice(0, 1_000),
      updatedAt: now,
    })
    .where(eq(notificationDeliveries.id, delivery.id))
    .run();
  message.retry({ delaySeconds: delay });
}

async function finishDelivery(
  database: D1Database,
  deliveryID: number,
  status: "dead" | "suppressed",
  now: number,
  reason: string,
): Promise<void> {
  await createDatabase(database)
    .update(notificationDeliveries)
    .set({
      status,
      lastError: reason.slice(0, 1_000),
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(eq(notificationDeliveries.id, deliveryID))
    .run();
}

async function retrySharedPlanDelivery(
  message: Message<PushQueueMessage>,
  database: D1Database,
  delivery: SharedPlanDeliveryRow,
  reason: string,
  now: number,
): Promise<void> {
  if (delivery.attempt_count >= 8) {
    await finishSharedPlanDelivery(database, delivery.id, "dead", now, reason);
    message.ack();
    return;
  }
  const delay = Math.min(3_600, 15 * 2 ** Math.min(delivery.attempt_count, 8));
  await createDatabase(database)
    .update(sharedPlanNotificationDeliveries)
    .set({
      status: "retry",
      availableAt: now + delay,
      leaseExpiresAt: null,
      lastError: reason.slice(0, 1_000),
      updatedAt: now,
    })
    .where(eq(sharedPlanNotificationDeliveries.id, delivery.id))
    .run();
  message.retry({ delaySeconds: delay });
}

async function finishSharedPlanDelivery(
  database: D1Database,
  deliveryID: number,
  status: "dead" | "suppressed",
  now: number,
  reason: string,
): Promise<void> {
  await createDatabase(database)
    .update(sharedPlanNotificationDeliveries)
    .set({
      status,
      lastError: reason.slice(0, 1_000),
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(eq(sharedPlanNotificationDeliveries.id, deliveryID))
    .run();
}
