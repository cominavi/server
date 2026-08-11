import { z } from "zod";
import {
  listNotifications,
  markNotificationRead,
  parseNotificationEventID,
} from "../../lib/server/notifications";
import { authenticatedProcedure } from "../core";

const notificationEventIDSchema = z.string().regex(/^[0-9a-f]{64}$/);

const notificationPayloadSchema = z.record(z.string(), z.unknown());

const notificationItemSchema = z.object({
  id: notificationEventIDSchema,
  kind: z.literal("sharedPlanEvent"),
  planID: z.string().min(1),
  eventType: z.string().min(1),
  i18nKey: z.string().min(1),
  payloadVersion: z.number().int().positive(),
  payload: notificationPayloadSchema,
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().optional(),
});

const notificationPageSchema = z.object({
  items: z.array(notificationItemSchema),
  nextCursor: z.string().min(1).optional(),
});

const notificationReadReceiptSchema = z.object({
  id: notificationEventIDSchema,
  readAt: z.iso.datetime(),
});

export const listNotificationInbox = authenticatedProcedure
  .route({
    method: "GET",
    path: "/api/v2/me/notifications",
    operationId: "listNotifications",
    summary: "List notification inbox",
    description:
      "Lists the authenticated user's durable notification events in stable newest-first order.",
    tags: ["Notifications"],
    inputStructure: "detailed",
  })
  .input(
    z.object({
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().min(1).max(512).optional(),
      }),
    }),
  )
  .output(notificationPageSchema)
  .handler(async ({ context, input }) => {
    const result = await listNotifications(
      context.env.COMINAVI_DB,
      context.identity,
      {
        limit: input.query.limit,
        cursor: input.query.cursor ?? null,
      },
    );
    return {
      items: result.items.map((item) => ({
        ...item,
        readAt: item.readAt ?? undefined,
      })),
      nextCursor: result.nextCursor ?? undefined,
    };
  });

export const markNotificationInboxItemRead = authenticatedProcedure
  .route({
    method: "PUT",
    path: "/api/v2/me/notifications/{eventID}/read",
    operationId: "markNotificationRead",
    summary: "Mark notification read",
    description:
      "Monotonically marks one notification as read. Exact retries return the original read timestamp.",
    tags: ["Notifications"],
    inputStructure: "detailed",
  })
  .input(
    z.object({
      params: z.object({ eventID: notificationEventIDSchema }),
    }),
  )
  .output(notificationReadReceiptSchema)
  .handler(async ({ context, input }) =>
    markNotificationRead(
      context.env.COMINAVI_DB,
      context.identity,
      parseNotificationEventID(input.params.eventID),
    ),
  );

export const notificationRouter = {
  list: listNotificationInbox,
  markRead: markNotificationInboxItemRead,
};
