export interface PushDeliveryQueueMessage {
  kind?: "push";
  deliveryID: number;
}

export interface SharedPlanPushQueueMessage {
  kind: "shared-plan";
  sharedPlanDeliveryID: number;
}

export type PushQueueMessage =
  PushDeliveryQueueMessage | SharedPlanPushQueueMessage;

export async function enqueuePushDeliveries(
  queue: Queue<PushQueueMessage>,
  deliveryIDs: number[],
): Promise<void> {
  const unique = Array.from(new Set(deliveryIDs)).filter(
    (value) => Number.isSafeInteger(value) && value > 0,
  );
  for (let offset = 0; offset < unique.length; offset += 100) {
    await queue.sendBatch(
      unique.slice(offset, offset + 100).map((deliveryID) => ({
        body: { kind: "push" as const, deliveryID },
      })),
    );
  }
}

export async function enqueueSharedPlanPushDeliveries(
  queue: Queue<PushQueueMessage>,
  deliveryIDs: number[],
): Promise<void> {
  const unique = Array.from(new Set(deliveryIDs)).filter(
    (value) => Number.isSafeInteger(value) && value > 0,
  );
  for (let offset = 0; offset < unique.length; offset += 100) {
    await queue.sendBatch(
      unique.slice(offset, offset + 100).map((sharedPlanDeliveryID) => ({
        body: { kind: "shared-plan" as const, sharedPlanDeliveryID },
      })),
    );
  }
}

export async function enqueuePendingPushDeliveries(
  database: D1Database,
  queue: Queue<PushQueueMessage>,
  nowMilliseconds = Date.now(),
): Promise<number> {
  const now = Math.floor(nowMilliseconds / 1_000);
  // A Worker can be terminated after claiming a delivery but before it can
  // put that delivery back into retry. Reclaim expired leases before scanning
  // so a crash cannot strand a notification in `processing` forever.
  const db = createDatabase(database);
  await db
    .update(notificationDeliveries)
    .set({
      status: "retry",
      availableAt: now,
      leaseExpiresAt: null,
      lastError: sql`coalesce(${notificationDeliveries.lastError}, 'processing_lease_expired')`,
      updatedAt: now,
    })
    .where(
      and(
        eq(notificationDeliveries.status, "processing"),
        isNotNull(notificationDeliveries.leaseExpiresAt),
        lte(notificationDeliveries.leaseExpiresAt, now),
      ),
    )
    .run();
  await db
    .update(sharedPlanNotificationDeliveries)
    .set({
      status: "retry",
      availableAt: now,
      leaseExpiresAt: null,
      lastError: sql`coalesce(${sharedPlanNotificationDeliveries.lastError}, 'processing_lease_expired')`,
      updatedAt: now,
    })
    .where(
      and(
        eq(sharedPlanNotificationDeliveries.status, "processing"),
        isNotNull(sharedPlanNotificationDeliveries.leaseExpiresAt),
        lte(sharedPlanNotificationDeliveries.leaseExpiresAt, now),
      ),
    )
    .run();
  const rows = await db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .innerJoin(users, eq(users.id, notificationDeliveries.userID))
    .innerJoin(pushDevices, eq(pushDevices.id, notificationDeliveries.deviceID))
    .where(
      and(
        inArray(notificationDeliveries.status, ["pending", "retry"]),
        lte(notificationDeliveries.availableAt, now),
        isNull(users.deletionPendingAt),
        eq(pushDevices.enabled, 1),
      ),
    )
    .orderBy(
      asc(notificationDeliveries.availableAt),
      asc(notificationDeliveries.id),
    )
    .limit(500);
  await enqueuePushDeliveries(
    queue,
    rows.map((row) => row.id),
  );
  const sharedPlanRows = await db
    .select({ id: sharedPlanNotificationDeliveries.id })
    .from(sharedPlanNotificationDeliveries)
    .innerJoin(users, eq(users.id, sharedPlanNotificationDeliveries.userID))
    .innerJoin(
      pushDevices,
      eq(pushDevices.id, sharedPlanNotificationDeliveries.deviceID),
    )
    .where(
      and(
        inArray(sharedPlanNotificationDeliveries.status, ["pending", "retry"]),
        lte(sharedPlanNotificationDeliveries.availableAt, now),
        isNull(users.deletionPendingAt),
        eq(pushDevices.enabled, 1),
      ),
    )
    .orderBy(
      asc(sharedPlanNotificationDeliveries.availableAt),
      asc(sharedPlanNotificationDeliveries.id),
    )
    .limit(500);
  await enqueueSharedPlanPushDeliveries(
    queue,
    sharedPlanRows.map((row) => row.id),
  );
  return rows.length + sharedPlanRows.length;
}
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import { createDatabase } from "../db/client";
import {
  notificationDeliveries,
  pushDevices,
  sharedPlanNotificationDeliveries,
  users,
} from "../db/schema";
