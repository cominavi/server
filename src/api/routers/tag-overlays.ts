import { z } from "zod";

import { authenticateCrawlerRequest } from "../../lib/server/crawler-ingest";
import {
  maximumTagOverlayPublicationBytes,
  publishTagOverlay,
} from "../../lib/server/tag-overlays";
import { crawlerProcedure, type APIContext } from "../core";
import {
  circleTagOverlaySchema,
  tagOverlayRevisionSchema,
} from "../tag-overlay-schema";

const publicationResponseSchema = z.object({
  eventNumber: z.number().int().positive().max(10_000),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  activeRevision: z.string().regex(/^[0-9a-f]{64}$/),
  active: z.literal(true),
  publishedAt: z.iso.datetime(),
  duplicate: z.boolean(),
});

export const publishCrawlerTagOverlay = crawlerProcedure
  .route({
    method: "POST",
    path: "/api/v2/internal/crawler/tag-overlays",
    operationId: "publishCrawlerTagOverlay",
    summary: "Publish a complete circle tag overlay",
    description:
      "Publishes an immutable, content-addressed tag overlay under a compare-and-swap base revision. The request uses the same exact-byte HMAC convention as crawler event ingress and is bounded to 16 MiB.",
    tags: ["Internal Crawler"],
    inputStructure: "detailed",
    outputStructure: "detailed",
    successStatus: 200,
    successDescription: "The exact tag overlay publication was replayed.",
    spec: (operation) => ({
      ...operation,
      responses: {
        ...operation.responses,
        "200": {
          ...(operation.responses?.["202"] ?? {
            description: "The exact tag overlay publication was replayed.",
          }),
          description: "The exact tag overlay publication was replayed.",
        },
        "202": {
          ...operation.responses?.["202"],
          description: "The tag overlay was activated for the first time.",
        },
      },
    }),
  })
  .input(
    z.object({
      body: z
        .object({
          eventNumber: z.number().int().positive().max(10_000),
          baseRevision: tagOverlayRevisionSchema,
          overlay: circleTagOverlaySchema,
        })
        .strict(),
    }),
  )
  .output(
    z.object({
      status: z.literal(202).optional().describe("First activation"),
      body: publicationResponseSchema,
    }),
  )
  .handler(async ({ context }) => {
    const authenticated = await authenticatedCrawlerRequest(context);
    const result = await publishTagOverlay(
      context.env.COMINAVI_DB,
      context.env.COMINAVI_CATALOGS,
      authenticated,
    );
    return result.duplicate
      ? { body: result }
      : { status: 202 as const, body: result };
  });

export const tagOverlayRouter = {
  publish: publishCrawlerTagOverlay,
};

async function authenticatedCrawlerRequest(context: APIContext) {
  if (context.authenticatedCrawlerRequest) {
    return context.authenticatedCrawlerRequest;
  }
  return authenticateCrawlerRequest(
    context.request.clone() as unknown as Request,
    context.env.COMINAVI_CRAWLER_WEBHOOK_SECRET,
    Date.now(),
    maximumTagOverlayPublicationBytes,
  );
}
