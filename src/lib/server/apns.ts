import type { PushQueueMessage } from "./push-queue";

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

let cachedProviderToken:
  { key: string; token: string; issuedAt: number } | undefined;

export async function processPushQueueMessage(
  message: Message<PushQueueMessage>,
  bindings: APNsBindings,
  fetcher: typeof fetch = fetch,
  nowMilliseconds = Date.now(),
): Promise<void> {
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
  const claimed = await bindings.COMINAVI_DB.prepare(
    `UPDATE notification_deliveries
     SET status = 'processing', attempt_count = attempt_count + 1,
         lease_expires_at = ?1, updated_at = ?2
     WHERE id = ?3 AND status IN ('pending', 'retry') AND available_at <= ?2
     RETURNING id`,
  )
    .bind(now + 120, now, deliveryID)
    .first<{ id: number }>();
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
    const response = await fetcher(request);
    const apnsID = response.headers.get("apns-id");
    if (response.ok) {
      await bindings.COMINAVI_DB.prepare(
        `UPDATE notification_deliveries
         SET status = 'delivered', delivered_at = ?1, apns_id = ?2,
             lease_expires_at = NULL, last_error = NULL, updated_at = ?1
         WHERE id = ?3 AND status = 'processing'`,
      )
        .bind(now, apnsID, deliveryID)
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
      await bindings.COMINAVI_DB.batch([
        bindings.COMINAVI_DB.prepare(
          `UPDATE push_devices
           SET enabled = 0, invalidated_at = ?1, updated_at = ?1
           WHERE id = (SELECT device_id FROM notification_deliveries WHERE id = ?2)`,
        ).bind(now, deliveryID),
        bindings.COMINAVI_DB.prepare(
          `UPDATE notification_deliveries
           SET status = 'dead', apns_id = ?1, last_error = ?2,
               lease_expires_at = NULL, updated_at = ?3
           WHERE id = ?4`,
        ).bind(apnsID, reason, now, deliveryID),
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

async function loadDelivery(
  database: D1Database,
  deliveryID: number,
): Promise<DeliveryRow | null> {
  return database
    .prepare(
      `SELECT delivery.id, delivery.attempt_count, device.token,
              device.apns_environment, device.bundle_id, event.state_kind,
              event.state_value, event.update_kind, target.comiket_no,
              target.wc_id,
              COALESCE(circle.circle_name, '') AS circle_name,
              post.author_handle, post.text,
              CASE WHEN EXISTS (
                SELECT 1
                FROM circle_update_targets AS subscribed_target
                JOIN user_favorites AS favorite
                  ON favorite.comiket_no = subscribed_target.comiket_no
                 AND favorite.wc_id = subscribed_target.wc_id
                 AND favorite.user_id = delivery.user_id
                 AND favorite.active = 1
                 AND favorite.notifications_enabled = 1
                WHERE subscribed_target.update_event_id = event.id
              ) THEN 1 ELSE 0 END AS subscribed
       FROM notification_deliveries AS delivery
       JOIN push_devices AS device ON device.id = delivery.device_id
       JOIN circle_update_events AS event ON event.id = delivery.update_event_id
       JOIN social_posts AS post ON post.post_id = event.post_id
       JOIN circle_update_targets AS target ON target.update_event_id = event.id
       JOIN circles AS circle
         ON circle.comiket_no = target.comiket_no AND circle.wc_id = target.wc_id
       WHERE delivery.id = ?1
       ORDER BY target.wc_id
       LIMIT 1`,
    )
    .bind(deliveryID)
    .first<DeliveryRow>();
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
  await database
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'retry', available_at = ?1, lease_expires_at = NULL,
           last_error = ?2, updated_at = ?3
       WHERE id = ?4`,
    )
    .bind(now + delay, reason.slice(0, 1_000), now, delivery.id)
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
  await database
    .prepare(
      `UPDATE notification_deliveries
       SET status = ?1, last_error = ?2, lease_expires_at = NULL, updated_at = ?3
       WHERE id = ?4`,
    )
    .bind(status, reason.slice(0, 1_000), now, deliveryID)
    .run();
}
