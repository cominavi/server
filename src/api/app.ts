import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { Hono } from "hono";
import type { Context } from "hono";
import { generateOpenAPIDocument } from "./openapi";
import { apiRouter } from "./router";
import { canonicalErrorResponseBody } from "./core";
import { apiErrorResponse } from "../lib/server/api-response";
import { authenticateRequestWithBindings } from "../lib/server/authenticated-request-core";
import { assertPlanMember } from "../lib/server/shared-plans";
import {
  catalogDownloadCapabilityConfiguration,
  catalogDownloadCapabilityRedirect,
} from "../lib/server/catalog-download-capability";
import {
  authenticateCrawlerRequest,
  parseCrawlerBatch,
} from "../lib/server/crawler-ingest";
import { authenticateCatalogPublisherRequest } from "../lib/server/catalog-publisher-auth";
import type {
  AuthenticatedCatalogPublisherRequest,
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

export function createHomepageApp(astroFetch: AstroFetch) {
  const app = new Hono<{ Bindings: Cloudflare.Env }>();

  app.get("/api/openapi.json", async (context) => {
    return context.json(await generateOpenAPIDocument(), 200, {
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    });
  });

  app.post("/api/v2/internal/crawler/events", async (context) => {
    try {
      const authenticated = await authenticateCrawlerRequest(
        context.req.raw.clone() as unknown as Request,
        context.env.COMINAVI_CRAWLER_WEBHOOK_SECRET,
      );
      return handleOpenAPIRequest(context, {
        authenticatedCrawlerRequest: {
          ...authenticated,
          batch: parseCrawlerBatch(authenticated.rawBody),
        },
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  });

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
    if (new URL(context.req.url).search.length > 0) {
      return context.json(
        {
          error: "invalid_realtime_query",
          message: "Realtime updates use one query-free event URL.",
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

  app.on(
    ["GET", "HEAD"],
    "/api/v2/catalogs/:comiketNo/versions/:versionID/artifact",
    async (context) => {
      try {
        const configuration = catalogDownloadCapabilityConfiguration(
          context.env,
        );
        if (!configuration) return handleOpenAPIRequest(context);
        await authenticateRequestWithBindings(context.req.raw, context.env);
        const comiketNo = Number(context.req.param("comiketNo"));
        const versionID = context.req.param("versionID");
        if (
          !Number.isSafeInteger(comiketNo) ||
          comiketNo < 1 ||
          comiketNo > 10_000 ||
          !/^[A-Za-z0-9._-]{1,160}$/.test(versionID)
        ) {
          return context.json(
            { error: "bad_request", message: "The request is invalid." },
            400,
            { "Cache-Control": "private, no-store" },
          );
        }
        return catalogDownloadCapabilityRedirect(
          context.env.COMINAVI_DB,
          context.env.COMINAVI_CATALOG_DOWNLOADS!,
          comiketNo,
          versionID,
          context.req.method as "GET" | "HEAD",
          configuration,
        );
      } catch (error) {
        return apiErrorResponse(error);
      }
    },
  );

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
    authenticatedCrawlerRequest?: AuthenticatedCrawlerRequest;
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
    url.search.length === 0 &&
    realtimeUpdatesPathPattern.test(url.pathname)
  ) {
    const body = await response.arrayBuffer();
    const etag = await responseETag(body);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set(
      "Access-Control-Expose-Headers",
      "Cache-Control, CDN-Cache-Control, ETag",
    );
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
