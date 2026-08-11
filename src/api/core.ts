import { oo } from "@orpc/openapi";
import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import {
  AuthenticationError,
  type CominaviIdentity,
} from "../lib/server/cominavi-auth";
import { authenticateRequestWithBindings } from "../lib/server/authenticated-request-core";
import { FollowingImportError } from "../lib/server/following-import";
import { ServiceError } from "../lib/server/service-error";
import type { CrawlerBatch } from "../lib/server/crawler-ingest";

export interface AuthenticatedCrawlerRequest {
  idempotencyKey: string;
  rawBody: Uint8Array;
  payloadSHA256: string;
  batch: CrawlerBatch;
}

export interface AuthenticatedCatalogPublisherRequest {
  idempotencyKey: string;
  rawBody: Uint8Array;
  payloadSHA256: string;
  signerScope: "manual" | "scheduled";
}

export interface APIContext {
  request: Request;
  env: Cloudflare.Env;
  authenticatedCrawlerRequest?: AuthenticatedCrawlerRequest;
  authenticatedCatalogPublisherRequest?: AuthenticatedCatalogPublisherRequest;
}

export interface AuthenticatedAPIContext extends APIContext {
  identity: CominaviIdentity;
}

export const serviceErrorDataSchema = z.object({
  error: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
  nextAllowedAt: z.iso.datetime().optional(),
});

export const apiErrorMap = {
  BAD_REQUEST: {
    status: 400,
    message: "The request is invalid.",
    data: serviceErrorDataSchema,
  },
  UNAUTHORIZED: {
    status: 401,
    message: "The request is not authorized.",
    data: serviceErrorDataSchema,
  },
  FORBIDDEN: {
    status: 403,
    message: "The request is forbidden.",
    data: serviceErrorDataSchema,
  },
  NOT_FOUND: {
    status: 404,
    message: "The requested resource was not found.",
    data: serviceErrorDataSchema,
  },
  CONFLICT: {
    status: 409,
    message: "The request conflicts with the current resource state.",
    data: serviceErrorDataSchema,
  },
  GONE: {
    status: 410,
    message: "The requested resource is no longer available.",
    data: serviceErrorDataSchema,
  },
  PRECONDITION_FAILED: {
    status: 412,
    message: "A request precondition failed.",
    data: serviceErrorDataSchema,
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    message: "The request payload is too large.",
    data: serviceErrorDataSchema,
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    message: "The request media type is unsupported.",
    data: serviceErrorDataSchema,
  },
  UNPROCESSABLE_CONTENT: {
    status: 422,
    message: "The request content cannot be processed.",
    data: serviceErrorDataSchema,
  },
  PRECONDITION_REQUIRED: {
    status: 428,
    message: "A request precondition is required.",
    data: serviceErrorDataSchema,
  },
  TOO_MANY_REQUESTS: {
    status: 429,
    message: "Too many requests were made.",
    data: serviceErrorDataSchema,
  },
  BAD_GATEWAY: {
    status: 502,
    message: "An upstream service returned an invalid response.",
    data: serviceErrorDataSchema,
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: "The service is temporarily unavailable.",
    data: serviceErrorDataSchema,
  },
  INTERNAL_SERVER_ERROR: {
    status: 500,
    message: "The request could not be completed.",
    data: serviceErrorDataSchema,
  },
} as const;

const api = os.$context<APIContext>().errors(apiErrorMap);

const translateExpectedErrors = api.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (
      error instanceof AuthenticationError ||
      error instanceof FollowingImportError ||
      error instanceof ServiceError
    ) {
      throw expectedAPIError(error);
    }
    throw error;
  }
});

const requireAuthentication = api.middleware(async ({ context, next }) => {
  const identity = await authenticateRequestWithBindings(
    context.request,
    context.env,
  );
  return next({ context: { identity } });
});

const publicSecurity = oo.spec(
  api.middleware(async ({ next }) => next()),
  (operation) => ({ ...operation, security: [] }),
);

const bearerSecurity = oo.spec(
  api.middleware(async ({ next }) => next()),
  (operation) => ({
    ...operation,
    security: [{ bearerAuth: [] }],
  }),
);

const crawlerHMACSecurity = oo.spec(
  api.middleware(async ({ next }) => next()),
  (operation) => ({
    ...operation,
    security: [
      {
        crawlerSignature: [],
        crawlerTimestamp: [],
        crawlerIdempotencyKey: [],
      },
    ],
  }),
);

const catalogPublisherHMACSecurity = oo.spec(
  api.middleware(async ({ next }) => next()),
  (operation) => ({
    ...operation,
    security: [
      {
        catalogPublisherSignature: [],
        catalogPublisherTimestamp: [],
        catalogPublisherIdempotencyKey: [],
      },
    ],
  }),
);

const baseProcedure = api.use(translateExpectedErrors);

/** A procedure whose request carries no ComiNavi bearer-session authority. */
export const publicProcedure = baseProcedure.use(publicSecurity);

/** A procedure authenticated by the current ComiNavi bearer-session JWT. */
export const authenticatedProcedure = baseProcedure
  .use(bearerSecurity)
  .use(requireAuthentication);

/**
 * A bearer-authenticated operation that validates its own authority semantics.
 * Logout and deletion use this because an exact durable receipt may be
 * recovered with a signed predecessor JWT after ordinary session expiry.
 */
export const predecessorTokenProcedure = baseProcedure.use(bearerSecurity);

/** An internal collector operation authenticated by its exact-body HMAC. */
export const crawlerProcedure = baseProcedure.use(crawlerHMACSecurity);

/** An internal catalog control-plane operation authenticated by exact-body HMAC. */
export const catalogPublisherProcedure = baseProcedure.use(
  catalogPublisherHMACSecurity,
);

/** Marks a completed public procedure as overriding the document's bearer default. */
export function documentPublicOperation<T extends object>(procedure: T): T {
  return oo.spec(procedure, (operation) => ({
    ...operation,
    security: [],
  }));
}

/** Explicitly documents bearer proof on a completed special-authority procedure. */
export function documentBearerOperation<T extends object>(procedure: T): T {
  return oo.spec(procedure, (operation) => ({
    ...operation,
    security: [{ bearerAuth: [] }],
  }));
}

function expectedAPIError(
  error: AuthenticationError | FollowingImportError | ServiceError,
): ORPCError<string, z.infer<typeof serviceErrorDataSchema>> {
  const code = errorCodeForStatus(error.status);
  return new ORPCError(code, {
    message: error.message,
    data: {
      error: error.code,
      ...(error instanceof ServiceError && error.details
        ? { details: error.details }
        : {}),
      ...(error instanceof FollowingImportError && error.nextAllowedAt
        ? { nextAllowedAt: error.nextAllowedAt }
        : {}),
    },
    cause: error,
  });
}

function errorCodeForStatus(status: number): keyof typeof apiErrorMap {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 410:
      return "GONE";
    case 412:
      return "PRECONDITION_FAILED";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 415:
      return "UNSUPPORTED_MEDIA_TYPE";
    case 422:
      return "UNPROCESSABLE_CONTENT";
    case 428:
      return "PRECONDITION_REQUIRED";
    case 429:
      return "TOO_MANY_REQUESTS";
    case 502:
      return "BAD_GATEWAY";
    case 503:
      return "SERVICE_UNAVAILABLE";
    default:
      return "INTERNAL_SERVER_ERROR";
  }
}

export function canonicalErrorResponseBody(error: ORPCError<any, any>) {
  const data = isRecord(error.data) ? error.data : undefined;
  return {
    error:
      typeof data?.error === "string" ? data.error : error.code.toLowerCase(),
    message: error.message,
    ...(isRecord(data?.details) ? { details: data.details } : {}),
    ...(typeof data?.nextAllowedAt === "string"
      ? { nextAllowedAt: data.nextAllowedAt }
      : {}),
  };
}

export const canonicalErrorResponseBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["error", "message"],
  properties: {
    error: { type: "string", minLength: 1 },
    message: { type: "string" },
    details: {
      type: "object",
      additionalProperties: true,
      properties: {
        currentRevision: { type: "integer", minimum: 0 },
        currentPlan: { type: "object", additionalProperties: true },
        wcIDs: {
          type: "array",
          items: { type: "integer", minimum: 1 },
        },
        invitationID: { type: "string", format: "uuid" },
      },
    },
    nextAllowedAt: { type: "string", format: "date-time" },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
