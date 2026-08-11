import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { runDrizzleBatch } from "../db/batch";
import { createDatabase } from "../db/client";
import {
  pushDevices,
  sharedPlanEventRecipients,
  sharedPlanEvents,
  sharedPlanMembers,
  sharedPlanNotificationDeliveries,
  sharedPlans,
  users,
} from "../db/schema";
import { enqueueSharedPlanPushDeliveries } from "./push-queue";

export const maximumNotificationAudienceMembers = 50;
export const maximumNotificationFanoutPairsPerDrain = 100;

export interface SharedPlanOutboxEvent {
  eventID: string;
  planID: string;
  sourceKind: "operation" | "conflict";
  sourceID: string;
  actorUserID: number | null;
  eventType: string;
  i18nKey: string;
  payloadVersion: 1;
  payloadJSON: string;
  membershipEpoch: number;
  planNotificationEpoch: number;
  createdAt: number;
}

export interface SharedPlanOutboxRecipient {
  userID: number;
  membershipNotificationEpoch: number;
}

export function notificationOutboxFitsBounds(
  events: readonly SharedPlanOutboxEvent[],
  recipientCount: number,
): boolean {
  if (
    !Number.isSafeInteger(recipientCount) ||
    recipientCount < 1 ||
    recipientCount > maximumNotificationAudienceMembers ||
    events.length < 1
  ) {
    return false;
  }
  return true;
}

export async function fanoutSharedPlanOutboxEvent(
  database: D1Database,
  queue: Queue<import("./push-queue").PushQueueMessage>,
  event: SharedPlanOutboxEvent,
  recipient: SharedPlanOutboxRecipient,
): Promise<void> {
  const results = await runDrizzleBatch(database, [
    sql`INSERT INTO ${sharedPlanEvents} (
      id, plan_id, actor_user_id, event_type, i18n_key,
      payload_version, payload_json, created_at, source_kind,
      source_id, membership_epoch, plan_notification_epoch
    )
    SELECT ${event.eventID}, plan.id,
      (SELECT id FROM ${users} WHERE id = ${event.actorUserID}),
      ${event.eventType}, ${event.i18nKey}, ${event.payloadVersion},
      ${event.payloadJSON}, ${event.createdAt}, ${event.sourceKind},
      ${event.sourceID}, ${event.membershipEpoch},
      ${event.planNotificationEpoch}
    FROM ${sharedPlans} AS plan WHERE plan.id = ${event.planID}
    ON CONFLICT(id) DO NOTHING`,
    sql`INSERT INTO ${sharedPlanEventRecipients} (
      event_id, user_id, read_at, membership_notification_epoch,
      event_created_at
    )
    SELECT event.id, user.id, NULL,
      ${recipient.membershipNotificationEpoch}, event.created_at
    FROM ${sharedPlanEvents} AS event
    JOIN ${users} AS user ON user.id = ${recipient.userID}
    WHERE event.id = ${event.eventID}
    ON CONFLICT(event_id, user_id) DO NOTHING`,
    sql`INSERT INTO ${sharedPlanNotificationDeliveries} (
      event_id, user_id, device_id, urgency, collapse_key, status,
      plan_notification_epoch, membership_notification_epoch,
      attempt_count, available_at, lease_expires_at, apns_id,
      delivered_at, last_error, created_at, updated_at
    )
    SELECT event.id, user.id, device.id,
      ${event.sourceKind === "conflict" ? "conflict" : "routine"},
      ${event.sourceKind === "conflict" ? null : `shared-plan:${event.planID}`.slice(0, 64)},
      'pending', ${event.planNotificationEpoch},
      ${recipient.membershipNotificationEpoch}, 0, ${event.createdAt},
      NULL, NULL, NULL, NULL, ${event.createdAt}, ${event.createdAt}
    FROM ${sharedPlanEvents} AS event
    JOIN ${sharedPlans} AS plan ON plan.id = event.plan_id
    JOIN ${users} AS user ON user.id = ${recipient.userID}
    JOIN ${sharedPlanMembers} AS member
      ON member.plan_id = plan.id AND member.user_id = user.id
    JOIN ${pushDevices} AS device
      ON device.user_id = user.id AND device.enabled = 1
    WHERE event.id = ${event.eventID} AND user.deletion_pending_at IS NULL
      AND member.revoked_at IS NULL AND plan.archived_at IS NULL
      AND (${event.actorUserID} IS NULL OR user.id <> ${event.actorUserID})
      AND plan.notification_epoch = ${event.planNotificationEpoch}
      AND member.notification_epoch = ${recipient.membershipNotificationEpoch}
    ON CONFLICT(event_id, device_id) DO NOTHING`,
  ]);
  const authoritative = await createDatabase(database)
    .select({
      plan_id: sharedPlanEvents.planID,
      source_kind: sharedPlanEvents.sourceKind,
      source_id: sharedPlanEvents.sourceID,
      event_type: sharedPlanEvents.eventType,
      i18n_key: sharedPlanEvents.i18nKey,
      payload_version: sharedPlanEvents.payloadVersion,
      payload_json: sharedPlanEvents.payloadJSON,
      membership_epoch: sharedPlanEvents.membershipEpoch,
      plan_notification_epoch: sharedPlanEvents.planNotificationEpoch,
      created_at: sharedPlanEvents.createdAt,
    })
    .from(sharedPlanEvents)
    .where(eq(sharedPlanEvents.id, event.eventID))
    .get();
  if (
    !authoritative ||
    authoritative.plan_id !== event.planID ||
    authoritative.source_kind !== event.sourceKind ||
    authoritative.source_id !== event.sourceID ||
    authoritative.event_type !== event.eventType ||
    authoritative.i18n_key !== event.i18nKey ||
    authoritative.payload_version !== event.payloadVersion ||
    authoritative.payload_json !== event.payloadJSON ||
    authoritative.membership_epoch !== event.membershipEpoch ||
    authoritative.plan_notification_epoch !== event.planNotificationEpoch ||
    authoritative.created_at !== event.createdAt
  ) {
    throw new Error("shared_plan_event_idempotency_conflict");
  }
  if ((results[2]?.meta.changes ?? 0) > 0) {
    const deliveries = await createDatabase(database)
      .select({ id: sharedPlanNotificationDeliveries.id })
      .from(sharedPlanNotificationDeliveries)
      .where(
        and(
          eq(sharedPlanNotificationDeliveries.eventID, event.eventID),
          eq(sharedPlanNotificationDeliveries.userID, recipient.userID),
          inArray(sharedPlanNotificationDeliveries.status, [
            "pending",
            "retry",
          ]),
        ),
      )
      .orderBy(asc(sharedPlanNotificationDeliveries.id));
    await enqueueSharedPlanPushDeliveries(
      queue,
      deliveries.map((row) => row.id),
    );
  }
}
