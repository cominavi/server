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
  if (result.matched) return withCanonicalJSONHeaders(result.response);
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

function withCanonicalJSONHeaders(response: Response): Response {
  if (!response.headers.get("Content-Type")?.toLowerCase().includes("json")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
