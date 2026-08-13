import { z } from "zod";

import { authenticateCrawlerRequest } from "../../lib/server/crawler-ingest";
import {
  loadCrawlerSnapshotAuthority,
  maximumCrawlerSnapshotAuthorityBytes,
  maximumCrawlerSnapshotPublicationBytes,
  publishCrawlerSnapshot,
  serveActiveCrawlerCatalogSource,
} from "../../lib/server/crawler-snapshots";
import { ServiceError } from "../../lib/server/service-error";
import { crawlerSnapshotProcedure, type APIContext } from "../core";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const revisionSchema = z.union([z.literal("none"), digestSchema]);
const versionIDSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._-]+$/);
const eventNumberSchema = z.number().int().positive().max(10_000);

const mediaSchema = z.object({
  key: z.string().min(1).max(500),
  type: z.string().max(64),
  role: z.enum(["shinagaki", "cover", "post_image"]),
  url: z.url(),
  previewURL: z.url().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  palette: z.unknown().optional(),
  payloadSHA256: digestSchema.optional(),
});

const circleSchema = z.object({
  comiketNo: z.number().int().positive().max(10_000),
  wcID: z.number().int().positive(),
  circleID: z.number().int().positive().optional(),
  circleName: z.string().max(1_000).optional(),
  penName: z.string().max(1_000).optional(),
  day: z.number().int().positive().optional(),
  areaName: z.string().optional(),
  blockName: z.string().optional(),
  spaceNo: z.number().int().positive().optional(),
  spaceNoSub: z.number().int().optional(),
  location: z.string().optional(),
  catalogPayloadSHA256: digestSchema.optional(),
  catalogRecord: z.unknown().optional(),
});

const postSchema = z.object({
  id: z.string().regex(/^[0-9]{1,24}$/),
  url: z.url().optional(),
  text: z.string().max(100_000),
  occurredAt: z.iso.datetime(),
  author: z.object({
    xUserID: z.string().optional(),
    handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
    name: z.string().max(500).optional(),
    profileImageURL: z.url().optional(),
  }),
  media: z.array(mediaSchema).max(20),
  raw: z.unknown().optional(),
});

const eventSchema = z.object({
  eventKey: z.string().regex(/^[A-Za-z0-9._:-]{8,240}$/),
  sourceRevision: z.number().int().positive(),
  updateKind: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  stateKind: z.enum(["shinagaki", "cover"]),
  stateValue: z.string().min(1).max(500),
  confidence: z.enum(["high", "medium", "low", "unmatched"]),
  notifiable: z.literal(false),
  post: postSchema,
  circles: z.array(circleSchema).min(1).max(20),
  evidence: z.unknown().optional(),
});

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("cominavi-collector"),
  eventNumber: z.number().int().positive().max(10_000),
  revision: digestSchema,
  generation: z.number().int().positive(),
  catalogPayloadSHA256: digestSchema,
  matchingPolicyRevision: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  observedAt: z.iso.datetime(),
  events: z.array(eventSchema).max(20_000),
});

const publicationResultSchema = z.object({
  eventNumber: eventNumberSchema,
  revision: digestSchema,
  generation: z.number().int().positive(),
  publicationCursor: z.number().int().nonnegative(),
  active: z.literal(true),
  publishedAt: z.iso.datetime(),
  duplicate: z.boolean(),
});

const noStoreHeadersSchema = z.object({
  "Cache-Control": z.literal("private, no-store"),
  "CDN-Cache-Control": z.literal("no-store"),
  "Cloudflare-CDN-Cache-Control": z.literal("no-store"),
});

const authorityRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("readSnapshotAuthority"),
    eventNumber: eventNumberSchema,
    proposedPublication: z
      .object({
        revision: digestSchema,
        generation: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

const authorityResponseSchema = z.object({
  schemaVersion: z.literal(1),
  eventNumber: eventNumberSchema,
  publicationRevision: z.string().regex(/^(?:none|[0-9a-f]{64})$/),
  publicationGeneration: z.number().int().nonnegative(),
  publicationCursor: z.number().int().nonnegative(),
  snapshotCatalogSourceMainSHA256: z.string().regex(/^(?:none|[0-9a-f]{64})$/),
  activeCatalog: z.object({
    versionID: versionIDSchema,
    sourceMainSHA256: digestSchema,
    sourceMainBytes: z.number().int().positive(),
    contentType: z.literal("application/vnd.sqlite3"),
    downloadPath: z.literal("/api/v2/internal/crawler/catalog-source-main"),
  }),
  proposedPublication: z
    .discriminatedUnion("status", [
      z.object({
        revision: digestSchema,
        generation: z.number().int().positive(),
        status: z.literal("notActivated"),
      }),
      z.object({
        revision: digestSchema,
        generation: z.number().int().positive(),
        status: z.literal("activated"),
        publicationCursor: z.number().int().nonnegative(),
        publishedAt: z.iso.datetime(),
        active: z.boolean(),
      }),
    ])
    .optional(),
});

const catalogSourceRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("downloadActiveCatalogSourceMain"),
    eventNumber: eventNumberSchema,
    versionID: versionIDSchema,
    sourceMainSHA256: digestSchema,
  })
  .strict();

const catalogSourceHeadersSchema = noStoreHeadersSchema.extend({
  "Content-Disposition": z.string().min(1),
  "Content-Length": z.string().regex(/^[0-9]+$/),
  "Content-Type": z.literal("application/vnd.sqlite3"),
  Digest: z.string().min(1),
  ETag: z.string().min(1),
  "X-ComiNavi-Catalog-Version": versionIDSchema,
  "X-ComiNavi-Source-Main-SHA256": digestSchema,
  "X-Content-Type-Options": z.literal("nosniff"),
});

const catalogSourceBodySchema = z.custom<ReadableStream<Uint8Array>>(
  (value) => value instanceof ReadableStream,
);

const catalogSourceBinaryContent = {
  "application/vnd.sqlite3": {
    schema: { type: "string", format: "binary" },
  },
} as const;

export const publishCrawlerRealtimeSnapshot = crawlerSnapshotProcedure
  .route({
    method: "POST",
    path: "/api/v2/internal/crawler/realtime-snapshots",
    operationId: "publishCrawlerRealtimeSnapshot",
    summary: "Publish a complete crawler realtime snapshot",
    description:
      "Atomically activates a complete, content-addressed artwork snapshot under a monotonic generation and compare-and-swap base revision. Uses a dedicated crawler snapshot HMAC secret and is bounded to 16 MiB.",
    tags: ["Internal Crawler"],
    inputStructure: "detailed",
    outputStructure: "detailed",
    successStatus: 200,
    successDescription: "The exact snapshot publication was replayed.",
    spec: (operation) => ({
      ...operation,
      responses: {
        ...operation.responses,
        "200": {
          ...(operation.responses?.["202"] ?? {
            description: "The exact snapshot publication was replayed.",
          }),
          description: "The exact snapshot publication was replayed.",
        },
        "202": {
          ...operation.responses?.["202"],
          description:
            "The complete snapshot was activated for the first time.",
        },
      },
    }),
  })
  .input(
    z.object({
      body: z
        .object({ baseRevision: revisionSchema, snapshot: snapshotSchema })
        .strict(),
    }),
  )
  .output(
    z.object({
      status: z.literal(202).optional(),
      body: publicationResultSchema,
    }),
  )
  .handler(async ({ context }) => {
    const authenticated = await authenticatedSnapshotRequest(context);
    const result = await publishCrawlerSnapshot(
      context.env.COMINAVI_DB,
      context.env.COMINAVI_CATALOGS,
      authenticated,
    );
    return result.duplicate
      ? { body: result }
      : { status: 202 as const, body: result };
  });

export const getCrawlerRealtimeSnapshotAuthority = crawlerSnapshotProcedure
  .route({
    method: "POST",
    path: "/api/v2/internal/crawler/realtime-snapshot-authority",
    operationId: "getCrawlerRealtimeSnapshotAuthority",
    summary: "Read crawler snapshot and catalog authority",
    description:
      "Returns a no-store snapshot head, current private source-main identity, and an optional durable historical activation result. The exact operation-tagged body is authenticated with the dedicated snapshot HMAC secret.",
    tags: ["Internal Crawler"],
    inputStructure: "detailed",
    outputStructure: "detailed",
  })
  .input(z.object({ body: authorityRequestSchema }))
  .output(
    z.object({
      headers: noStoreHeadersSchema,
      body: authorityResponseSchema,
    }),
  )
  .handler(async ({ context, input }) => {
    const authenticated = await authenticatedSnapshotRequest(
      context,
      maximumCrawlerSnapshotAuthorityBytes,
    );
    requireExactReadKey(
      authenticated.idempotencyKey,
      `crawler-snapshot-authority:${input.body.eventNumber}`,
    );
    return {
      headers: noStoreHeaders(),
      body: await loadCrawlerSnapshotAuthority(
        context.env.COMINAVI_DB,
        input.body.eventNumber,
        input.body.proposedPublication,
      ),
    };
  });

export const downloadCrawlerCatalogSourceMain = crawlerSnapshotProcedure
  .route({
    method: "POST",
    path: "/api/v2/internal/crawler/catalog-source-main",
    operationId: "downloadCrawlerCatalogSourceMain",
    summary: "Download the active raw source-main catalog",
    description:
      "Streams the exact private R2 source-main SQLite object selected by an operation-bound snapshot HMAC request. The requested version and SHA must still be active.",
    tags: ["Internal Crawler"],
    inputStructure: "detailed",
    outputStructure: "detailed",
    spec: (operation) => ({
      ...operation,
      responses: {
        ...operation.responses,
        "200": {
          ...operation.responses?.["200"],
          description: "Exact active private source-main SQLite artifact",
          content: catalogSourceBinaryContent,
        },
      },
    }),
  })
  .input(z.object({ body: catalogSourceRequestSchema }))
  .output(
    z.object({
      status: z.literal(200),
      headers: catalogSourceHeadersSchema,
      body: catalogSourceBodySchema,
    }),
  )
  .handler(async ({ context, input }) => {
    const authenticated = await authenticatedSnapshotRequest(
      context,
      maximumCrawlerSnapshotAuthorityBytes,
    );
    requireExactReadKey(
      authenticated.idempotencyKey,
      `crawler-catalog-source-main:${input.body.eventNumber}:${input.body.sourceMainSHA256}`,
    );
    const response = await serveActiveCrawlerCatalogSource(
      context.env.COMINAVI_DB,
      context.env.COMINAVI_CATALOGS,
      input.body,
    );
    if (response.status !== 200 || !response.body) {
      throw new Error(
        "The crawler catalog source returned an invalid response.",
      );
    }
    return {
      status: 200 as const,
      headers: catalogSourceHeaders(response),
      body: response.body,
    };
  });

async function authenticatedSnapshotRequest(
  context: APIContext,
  maximumBodyBytes = maximumCrawlerSnapshotPublicationBytes,
) {
  if (context.authenticatedCrawlerRequest) {
    return context.authenticatedCrawlerRequest;
  }
  return authenticateCrawlerRequest(
    context.request.clone() as unknown as Request,
    context.env.COMINAVI_CRAWLER_SNAPSHOT_SECRET,
    Date.now(),
    maximumBodyBytes,
  );
}

function noStoreHeaders() {
  return {
    "Cache-Control": "private, no-store" as const,
    "CDN-Cache-Control": "no-store" as const,
    "Cloudflare-CDN-Cache-Control": "no-store" as const,
  };
}

function catalogSourceHeaders(
  response: Response,
): z.infer<typeof catalogSourceHeadersSchema> {
  return {
    ...noStoreHeaders(),
    "Content-Disposition": requiredHeader(response, "Content-Disposition"),
    "Content-Length": requiredHeader(response, "Content-Length"),
    "Content-Type": "application/vnd.sqlite3",
    Digest: requiredHeader(response, "Digest"),
    ETag: requiredHeader(response, "ETag"),
    "X-ComiNavi-Catalog-Version": requiredHeader(
      response,
      "X-ComiNavi-Catalog-Version",
    ),
    "X-ComiNavi-Source-Main-SHA256": requiredHeader(
      response,
      "X-ComiNavi-Source-Main-SHA256",
    ),
    "X-Content-Type-Options": "nosniff",
  };
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value)
    throw new Error(`Missing crawler catalog response header ${name}.`);
  return value;
}

function requireExactReadKey(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new ServiceError(
      "invalid_crawler_signature",
      401,
      "Crawler request authentication failed.",
    );
  }
}

export const crawlerSnapshotRouter = {
  authority: getCrawlerRealtimeSnapshotAuthority,
  catalogSourceMain: downloadCrawlerCatalogSourceMain,
  publish: publishCrawlerRealtimeSnapshot,
};
