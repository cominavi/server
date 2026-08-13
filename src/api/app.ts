import { OpenAPIHandler } from "@orpc/openapi/fetch";
import * as Sentry from "@sentry/hono/cloudflare";
import { Hono } from "hono";
import type { Context } from "hono";
import { generateOpenAPIDocument } from "./openapi";
import { apiRouter } from "./router";
import { canonicalErrorResponseBody } from "./core";
import { apiErrorResponse } from "../lib/server/api-response";
import { authenticateRequestWithBindings } from "../lib/server/authenticated-request-core";
import { assertPlanMember } from "../lib/server/shared-plans";
import {
  authenticateCrawlerRequest,
  parseCrawlerBatch,
} from "../lib/server/crawler-ingest";
import { maximumTagOverlayPublicationBytes } from "../lib/server/tag-overlays";
import {
  maximumCrawlerSnapshotAuthorityBytes,
  maximumCrawlerSnapshotPublicationBytes,
} from "../lib/server/crawler-snapshots";
import { authenticateCatalogPublisherRequest } from "../lib/server/catalog-publisher-auth";
import type {
  AuthenticatedCatalogPublisherRequest,
  AuthenticatedCrawlerRawRequest,
  AuthenticatedCrawlerRequest,
} from "./core";

export type AstroFetch = (
  request: Request,
  env: Cloudflare.Env,
  context: ExecutionContext,
) => Response | Promise<Response>;

const openAPIHandler = new OpenAPIHandler(apiRouter, {
  customErrorResponseBodyEncoder: canonicalErrorResponseBody,
});

const realtimeUpdatesPathPattern =
  /^\/api\/v2\/events\/(?:[1-9]\d{0,3}|10000)\/updates$/;
const realtimeUpdatesBrowserCacheControl =
  "public, max-age=60, stale-while-revalidate=60, stale-if-error=86400";
const realtimeUpdatesCDNCacheControl =
  "public, max-age=60, stale-while-revalidate=300, stale-if-error=86400";

export const sentrySensitiveCrawlerRequestHeaders = [
  "x-cominavi-signature",
  "x-cominavi-timestamp",
  "idempotency-key",
] as const;

const sentrySensitiveCrawlerRequestHeaderSet = new Set<string>(
  sentrySensitiveCrawlerRequestHeaders,
);
const sentrySensitiveCrawlerSpanAttributeSet = new Set(
  sentrySensitiveCrawlerRequestHeaders.map(
    (header) => `http.request.header.${header.replaceAll("-", "_")}`,
  ),
);

export function scrubSensitiveCrawlerHeadersFromSentryEvent<
  T extends {
    request?: { headers?: Record<string, string> };
    spans?: Array<{ data?: Record<string, unknown> }>;
  },
>(event: T): T {
  const headers = event.request?.headers;
  if (headers) {
    for (const header of Object.keys(headers)) {
      if (sentrySensitiveCrawlerRequestHeaderSet.has(header.toLowerCase())) {
        delete headers[header];
      }
    }
  }
  for (const span of event.spans ?? []) {
    scrubSensitiveCrawlerHeadersFromSentrySpan(span);
  }
  return event;
}

export function scrubSensitiveCrawlerHeadersFromSentrySpan<
  T extends { data?: Record<string, unknown> },
>(span: T): T {
  if (span.data) {
    for (const attribute of Object.keys(span.data)) {
      if (sentrySensitiveCrawlerSpanAttributeSet.has(attribute.toLowerCase())) {
        delete span.data[attribute];
      }
    }
  }
  return span;
}

export function createHomepageSentryOptions(): Sentry.CloudflareOptions {
  return {
    dsn: "https://5366d55254bddce30ce78749ace96c70@o4508052459225088.ingest.us.sentry.io/4511898103709696",
    tracesSampleRate: 1.0,
    enableLogs: true,
    dataCollection: {
      userInfo: true,
      httpHeaders: {
        request: { deny: [...sentrySensitiveCrawlerRequestHeaders] },
      },
      httpBodies: [
        "incomingRequest",
        "outgoingRequest",
        "incomingResponse",
        "outgoingResponse",
      ],
    },
    beforeSend: scrubSensitiveCrawlerHeadersFromSentryEvent,
    beforeSendTransaction: scrubSensitiveCrawlerHeadersFromSentryEvent,
    beforeSendSpan: scrubSensitiveCrawlerHeadersFromSentrySpan,
    integrations: (defaults) => [
      ...defaults.filter((integration) => integration.name !== "HttpServer"),
      Sentry.httpServerIntegration({
        // Sentry v10 captures request bodies independently of the
        // dataCollection list. Never tee or await the exact-byte signed
        // internal streams before their bounded authenticators run.
        ignoreRequestBody: (url) =>
          new URL(url).pathname.startsWith("/api/v2/internal/"),
      }),
    ],
  };
}

export function createHomepageApp(astroFetch: AstroFetch) {
  const app = new Hono<{ Bindings: Cloudflare.Env }>();

  app.use(Sentry.sentry(app, createHomepageSentryOptions()));

  app.get("/api/openapi.json", async (context) => {
    return context.json(await generateOpenAPIDocument(), 200, {
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    });
  });

  app.post("/api/v2/internal/crawler/events", async (context) => {
    try {
      const authenticated = await authenticateCrawlerRequest(
        context.req.raw,
        context.env.COMINAVI_CRAWLER_WEBHOOK_SECRET,
      );
      return handleOpenAPIRequest(
        context,
        {
          authenticatedCrawlerRequest: {
            ...authenticated,
            batch: parseCrawlerBatch(authenticated.rawBody),
          },
        },
        crawlerJSONTransportRequest(context.req.raw, authenticated.rawBody),
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  });

  app.post("/api/v2/internal/crawler/tag-overlays", async (context) => {
    try {
      const authenticatedCrawlerRequest = await authenticateCrawlerRequest(
        context.req.raw,
        context.env.COMINAVI_CRAWLER_WEBHOOK_SECRET,
        Date.now(),
        maximumTagOverlayPublicationBytes,
      );
      return handleOpenAPIRequest(
        context,
        { authenticatedCrawlerRequest },
        crawlerJSONTransportRequest(
          context.req.raw,
          authenticatedCrawlerRequest.rawBody,
        ),
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  });

  app.post("/api/v2/internal/crawler/realtime-snapshots", async (context) => {
    try {
      const authenticatedCrawlerRequest = await authenticateCrawlerRequest(
        context.req.raw,
        context.env.COMINAVI_CRAWLER_SNAPSHOT_SECRET,
        Date.now(),
        maximumCrawlerSnapshotPublicationBytes,
      );
      return handleOpenAPIRequest(
        context,
        { authenticatedCrawlerRequest },
        crawlerJSONTransportRequest(
          context.req.raw,
          authenticatedCrawlerRequest.rawBody,
        ),
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  });

  for (const path of [
    "/api/v2/internal/crawler/realtime-snapshot-authority",
    "/api/v2/internal/crawler/catalog-source-main",
  ]) {
    app.post(path, async (context) => {
      try {
        const authenticatedCrawlerRequest = await authenticateCrawlerRequest(
          context.req.raw,
          context.env.COMINAVI_CRAWLER_SNAPSHOT_SECRET,
          Date.now(),
          maximumCrawlerSnapshotAuthorityBytes,
        );
        return handleOpenAPIRequest(
          context,
          { authenticatedCrawlerRequest },
          crawlerJSONTransportRequest(
            context.req.raw,
            authenticatedCrawlerRequest.rawBody,
          ),
        );
      } catch (error) {
        return apiErrorResponse(error);
      }
    });
  }

  for (const path of [
    "/api/v2/internal/catalog-publications",
    "/api/v2/internal/catalog-refresh-jobs",
    "/api/v2/internal/catalog-artifacts/multipart",
  ]) {
    app.post(path, (context) => handleCatalogControlRequest(context));
  }

  app.put(
    "/api/v2/internal/catalog-artifacts/multipart/:uploadID/:partNumber",
    (context) => handleCatalogControlRequest(context, 10 * 1024 * 1024),
  );

  app.get("/api/v2/plans/:planID/sync", async (context) => {
    if (context.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return handleOpenAPIRequest(context);
    }

    try {
      const identity = await authenticateRequestWithBindings(
        context.req.raw,
        context.env,
      );
      const planID = context.req.param("planID");
      const membership = await assertPlanMember(
        context.env.COMINAVI_DB,
        identity.userID,
        planID,
      );
      const stub = context.env.COMINAVI_PLAN_SYNC.get(
        context.env.COMINAVI_PLAN_SYNC.idFromName(planID),
      );
      return await stub.fetch("https://plan-sync.internal/connect", {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          "X-ComiNavi-User-ID": String(identity.userID),
          "X-ComiNavi-User-Public-ID": identity.subject,
          "X-ComiNavi-Auth-Version": String(identity.authVersion),
          "X-ComiNavi-Plan-ID": planID,
          "X-ComiNavi-Comiket-No": String(membership.comiketNo),
        },
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  });

  app.get("/api/v2/events/:eventNumber/updates", (context) => {
    if (!isCacheableRealtimeUpdatesURL(new URL(context.req.url))) {
      const mentionsTagRevision = /(?:^\?|&)tagRevision(?:=|&|$)/.test(
        new URL(context.req.url).search,
      );
      return context.json(
        {
          error: "invalid_realtime_query",
          message: mentionsTagRevision
            ? "Realtime updates accept only canonical afterCursor and tagRevision values."
            : "Realtime updates accept only one canonical afterCursor value.",
        },
        400,
        {
          "Cache-Control": "private, no-store",
          "CDN-Cache-Control": "no-store",
          "Cloudflare-CDN-Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      );
    }
    return handleOpenAPIRequest(context);
  });

  app.all("/api/v2", (context) => handleOpenAPIRequest(context));
  app.all("/api/v2/*", (context) => handleOpenAPIRequest(context));

  app.notFound((context) =>
    astroFetch(
      context.req.raw,
      context.env,
      context.executionCtx as ExecutionContext,
    ),
  );

  return app;
}

async function handleOpenAPIRequest(
  context: Context<{ Bindings: Cloudflare.Env }>,
  authenticated?: {
    authenticatedCrawlerRequest?:
      AuthenticatedCrawlerRawRequest | AuthenticatedCrawlerRequest;
    authenticatedCatalogPublisherRequest?: AuthenticatedCatalogPublisherRequest;
  },
  transportRequest: Request = context.req.raw,
): Promise<Response> {
  const result = await openAPIHandler.handle(transportRequest, {
    context: {
      request: context.req.raw,
      env: context.env,
      ...authenticated,
    },
  });
  if (result.matched) {
    return withCanonicalJSONHeaders(result.response, context.req.raw);
  }
  return context.json(
    { error: "not_found", message: "The API route was not found." },
    404,
    { "Cache-Control": "private, no-store" },
  );
}

async function handleCatalogControlRequest(
  context: Context<{ Bindings: Cloudflare.Env }>,
  maximumBodyBytes?: number,
): Promise<Response> {
  try {
    const authenticatedCatalogPublisherRequest =
      await authenticateCatalogPublisherRequest(
        context.req.raw.clone() as unknown as Request,
        {
          manual: context.env.COMINAVI_CATALOG_PUBLISH_SECRET,
          scheduled: context.env.COMINAVI_CATALOG_SCHEDULED_PUBLISH_SECRET,
        },
        maximumBodyBytes,
      );
    return handleOpenAPIRequest(
      context,
      {
        authenticatedCatalogPublisherRequest,
      },
      maximumBodyBytes === undefined
        ? catalogJSONTransportRequest(context.req.raw)
        : context.req.raw,
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

function catalogJSONTransportRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: "{}",
  });
}

function crawlerJSONTransportRequest(
  request: Request,
  rawBody: Uint8Array,
): Request {
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: Uint8Array.from(rawBody).buffer,
  });
}

async function withCanonicalJSONHeaders(
  response: Response,
  request: Request,
): Promise<Response> {
  if (!response.headers.get("Content-Type")?.toLowerCase().includes("json")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");

  const url = new URL(request.url);
  if (
    request.method === "GET" &&
    response.status === 200 &&
    realtimeUpdatesPathPattern.test(url.pathname) &&
    isCacheableRealtimeUpdatesURL(url)
  ) {
    const body = await response.arrayBuffer();
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set(
      "Access-Control-Expose-Headers",
      "Cache-Control, CDN-Cache-Control, ETag",
    );
    const tagOverlayIsTransientOrUncacheable =
      url.searchParams.has("tagRevision") &&
      new TextDecoder()
        .decode(body)
        .match(/"tagOverlayStatus":"(?:invalidated|unavailable)"/) !== null;
    if (tagOverlayIsTransientOrUncacheable) {
      headers.set("Cache-Control", "private, no-store");
      headers.set("CDN-Cache-Control", "no-store");
      headers.set("Cloudflare-CDN-Cache-Control", "no-store");
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    const etag = await responseETag(body);
    headers.set("Cache-Control", realtimeUpdatesBrowserCacheControl);
    headers.set("CDN-Cache-Control", realtimeUpdatesCDNCacheControl);
    headers.set("Cloudflare-CDN-Cache-Control", realtimeUpdatesCDNCacheControl);
    headers.set("ETag", etag);

    if (ifNoneMatchMatches(request.headers.get("If-None-Match"), etag)) {
      headers.delete("Content-Length");
      return new Response(null, {
        status: 304,
        statusText: "Not Modified",
        headers,
      });
    }

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isCacheableRealtimeUpdatesURL(url: URL): boolean {
  if (url.search.length === 0) return true;
  const expectedOrder = ["afterCursor", "publicationRevision", "tagRevision"];
  const entries = Array.from(url.searchParams.entries());
  if (
    entries.length === 0 ||
    entries.length > expectedOrder.length ||
    new Set(entries.map(([key]) => key)).size !== entries.length
  ) {
    return false;
  }
  let lastIndex = -1;
  for (const [key, value] of entries) {
    const index = expectedOrder.indexOf(key);
    if (index <= lastIndex) return false;
    lastIndex = index;
    if (key === "afterCursor") {
      if (!/^(?:0|[1-9]\d*)$/.test(value)) return false;
      const cursor = Number(value);
      if (!Number.isSafeInteger(cursor) || cursor < 0) return false;
    } else if (!/^(?:none|[0-9a-f]{64})$/.test(value)) {
      return false;
    }
  }
  return true;
}

async function responseETag(body: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `"sha256-${hex}"`;
}

function ifNoneMatchMatches(value: string | null, etag: string): boolean {
  const expected = etag.startsWith("W/") ? etag.slice(2) : etag;
  return (
    value?.split(",").some((candidate) => {
      const trimmed = candidate.trim();
      return (
        trimmed === "*" ||
        (trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed) === expected
      );
    }) ?? false
  );
}
