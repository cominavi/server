import { z } from "zod";
import {
  authenticateCrawlerRequest,
  ingestCrawlerBatch,
  parseCrawlerBatch,
} from "../../lib/server/crawler-ingest";
import { enqueuePushDeliveries } from "../../lib/server/push-queue";
import {
  crawlerProcedure,
  type APIContext,
  type AuthenticatedCrawlerRequest,
} from "../core";

const crawlerMediaSchema = z.object({
  key: z.string().min(1).max(500),
  type: z.string(),
  role: z.enum(["shinagaki", "cover", "post_image"]),
  url: z.string(),
  previewURL: z.unknown().optional(),
  width: z.unknown().optional(),
  height: z.unknown().optional(),
  palette: z.unknown().optional(),
  payloadSHA256: z.unknown().optional(),
});

const crawlerCircleSchema = z.object({
  comiketNo: z.number().int().positive(),
  wcID: z.number().int().positive(),
  circleID: z.number().int().positive().optional(),
  circleName: z.unknown().optional(),
  penName: z.unknown().optional(),
  day: z.unknown().optional(),
  areaName: z.unknown().optional(),
  blockName: z.unknown().optional(),
  spaceNo: z.unknown().optional(),
  spaceNoSub: z.unknown().optional(),
  location: z.unknown().optional(),
  catalogPayloadSHA256: z.unknown().optional(),
  catalogRecord: z.unknown().optional(),
});

const crawlerPostSchema = z.object({
  id: z.string().regex(/^[0-9]{1,24}$/),
  url: z.unknown().optional(),
  text: z.string().max(100_000),
  occurredAt: z.string().min(1),
  author: z.object({
    xUserID: z.unknown().optional(),
    handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
    name: z.unknown().optional(),
    profileImageURL: z.unknown().optional(),
  }),
  media: z.array(crawlerMediaSchema).max(20),
  raw: z.unknown().optional(),
});

const crawlerEventSchema = z.object({
  eventKey: z.string().regex(/^[A-Za-z0-9._:-]{8,240}$/),
  sourceRevision: z.number().int().positive(),
  updateKind: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  stateKind: z.enum([
    "attendance",
    "inventory",
    "presence",
    "shinagaki",
    "cover",
  ]),
  stateValue: z.string().min(1).max(500),
  confidence: z.enum(["high", "medium", "low", "unmatched"]),
  notifiable: z.boolean(),
  post: crawlerPostSchema,
  circles: z.array(crawlerCircleSchema).min(1).max(20),
  evidence: z.unknown().optional(),
});

const crawlerBatchSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("cominavi-collector"),
  observedAt: z.string().min(1),
  events: z.array(crawlerEventSchema).max(50),
});

const crawlerIngestResponseSchema = z.object({
  acceptedEvents: z.number().int().nonnegative(),
  duplicate: z.boolean(),
  cursor: z.number().int().nonnegative(),
  queuedDeliveries: z.number().int().nonnegative(),
});

export const ingestCrawlerEvents = crawlerProcedure
  .route({
    method: "POST",
    path: "/api/v2/internal/crawler/events",
    operationId: "ingestCrawlerEvents",
    summary: "Ingest classified crawler events",
    description:
      "Internal collector ingress. The signature is HMAC-SHA256 over `<timestamp>.<idempotency-key>.<exact-request-body>` and must be supplied with the timestamp and idempotency headers described by the operation security requirement.",
    tags: ["Internal Crawler"],
    inputStructure: "detailed",
    outputStructure: "detailed",
    successStatus: 200,
    successDescription: "The exact crawler batch was already accepted.",
    spec: (operation) => ({
      ...operation,
      responses: {
        ...operation.responses,
        "200": {
          ...(operation.responses?.["202"] ?? {
            description: "The exact crawler batch was already accepted.",
          }),
          description: "The exact crawler batch was already accepted.",
        },
        "202": {
          ...operation.responses?.["202"],
          description: "The crawler batch was accepted for the first time.",
        },
      },
    }),
  })
  .input(z.object({ body: crawlerBatchSchema }))
  .output(
    z.object({
      status: z.literal(202).optional().describe("First acceptance"),
      body: crawlerIngestResponseSchema,
    }),
  )
  .handler(async ({ context }) => {
    const authenticated = await authenticatedCrawlerRequest(context);
    const result = await ingestCrawlerBatch(context.env.COMINAVI_DB, {
      ...authenticated,
      batch: authenticated.batch,
    });
    await enqueuePushDeliveries(
      context.env.COMINAVI_PUSH_QUEUE,
      result.deliveryIDs,
    );
    const body = {
      acceptedEvents: result.acceptedEvents,
      duplicate: result.duplicate,
      cursor: result.cursor,
      queuedDeliveries: result.deliveryIDs.length,
    };
    return result.duplicate ? { body } : { status: 202 as const, body };
  });

export const crawlerIngressRouter = {
  ingest: ingestCrawlerEvents,
};

async function authenticatedCrawlerRequest(
  context: APIContext,
): Promise<AuthenticatedCrawlerRequest> {
  if (context.authenticatedCrawlerRequest) {
    return context.authenticatedCrawlerRequest;
  }
  const authenticated = await authenticateCrawlerRequest(
    context.request.clone() as unknown as Request,
    context.env.COMINAVI_CRAWLER_WEBHOOK_SECRET,
  );
  return {
    ...authenticated,
    batch: parseCrawlerBatch(authenticated.rawBody),
  };
}
