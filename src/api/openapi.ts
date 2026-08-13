import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { canonicalErrorResponseBodySchema } from "./core";
import { apiRouter } from "./router";

const generator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

const canonicalErrorComponentName = "CanonicalErrorResponse";
export const canonicalErrorResponseReference = {
  $ref: `#/components/schemas/${canonicalErrorComponentName}`,
} as const;

export async function generateOpenAPIDocument() {
  const document = await generator.generate(apiRouter, {
    info: {
      title: "ComiNavi API",
      version: "2.0.0",
      description:
        "Type-safe HTTP API for the current ComiNavi clients. The generated contract is the authoritative client boundary.",
    },
    servers: [{ url: "https://cominavi.net" }],
    customErrorResponseBodySchema: canonicalErrorResponseBodySchema,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
        crawlerSignature: {
          type: "apiKey",
          in: "header",
          name: "X-ComiNavi-Signature",
          description:
            "Versioned lowercase HMAC-SHA256 signature: `v1=<64 lowercase hex characters>`. The signed bytes are `<X-ComiNavi-Timestamp>.<Idempotency-Key>.<exact request body>`.",
        },
        crawlerTimestamp: {
          type: "apiKey",
          in: "header",
          name: "X-ComiNavi-Timestamp",
          description:
            "Unix timestamp in seconds. The server accepts a maximum clock skew of five minutes.",
        },
        crawlerIdempotencyKey: {
          type: "apiKey",
          in: "header",
          name: "Idempotency-Key",
          description:
            "Stable collector batch identity. An exact replay returns the existing result; reusing it for different bytes conflicts.",
        },
        crawlerSnapshotSignature: {
          type: "apiKey",
          in: "header",
          name: "X-ComiNavi-Signature",
          description:
            "Dedicated snapshot-publisher HMAC-SHA256 signature: `v1=<64 lowercase hex characters>`. It uses COMINAVI_CRAWLER_SNAPSHOT_SECRET and signs `<X-ComiNavi-Timestamp>.<Idempotency-Key>.<exact request body>`.",
        },
        crawlerSnapshotTimestamp: {
          type: "apiKey",
          in: "header",
          name: "X-ComiNavi-Timestamp",
          description:
            "Unix timestamp in seconds. Snapshot publication accepts a maximum clock skew of five minutes.",
        },
        crawlerSnapshotIdempotencyKey: {
          type: "apiKey",
          in: "header",
          name: "Idempotency-Key",
          description:
            "Stable complete-snapshot publication identity. Exact replays recover the durable receipt; reusing it for different bytes conflicts.",
        },
        catalogPublisherSignature: {
          type: "apiKey",
          in: "header",
          name: "X-ComiNavi-Signature",
          description:
            "Versioned lowercase HMAC-SHA256 signature: `v1=<64 lowercase hex characters>`. The signed bytes are the newline-separated timestamp, idempotency key, HTTP method, path plus query, and SHA-256 digest of the exact request body. Manual publication and scheduled refresh runners use distinct secrets.",
        },
        catalogPublisherTimestamp: {
          type: "apiKey",
          in: "header",
          name: "X-ComiNavi-Timestamp",
          description:
            "Unix timestamp in seconds. The server accepts a maximum clock skew of five minutes.",
        },
        catalogPublisherIdempotencyKey: {
          type: "apiKey",
          in: "header",
          name: "Idempotency-Key",
          description:
            "Stable catalog command identity. Exact replays recover the durable result; reusing the key for another action or payload conflicts.",
        },
      },
    },
  });
  return hoistCanonicalErrorResponses(document);
}

function hoistCanonicalErrorResponses<T>(document: T): T {
  if (!isRecord(document)) return document;
  const components = ensureRecord(document, "components");
  const schemas = ensureRecord(components, "schemas");
  const existingComponent = schemas[canonicalErrorComponentName];
  if (
    existingComponent !== undefined &&
    !sameJSONStructure(existingComponent, canonicalErrorResponseBodySchema)
  ) {
    throw new Error(
      `OpenAPI component ${canonicalErrorComponentName} conflicts with the canonical error schema.`,
    );
  }
  schemas[canonicalErrorComponentName] = canonicalErrorResponseBodySchema;

  const paths = document.paths;
  if (!isRecord(paths)) return document;
  for (const pathItem of Object.values(paths)) {
    if (!isRecord(pathItem)) continue;
    for (const method of httpMethods) {
      const operation = pathItem[method];
      if (!isRecord(operation) || !isRecord(operation.responses)) continue;
      for (const [status, response] of Object.entries(operation.responses)) {
        if (status.startsWith("2") || !isRecord(response)) continue;
        const content = response.content;
        if (!isRecord(content)) continue;
        const json = content["application/json"];
        if (!isRecord(json)) continue;
        if (sameJSONStructure(json.schema, canonicalErrorResponseBodySchema)) {
          json.schema = canonicalErrorResponseReference;
        }
      }
    }
  }
  return document;
}

const httpMethods = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

function ensureRecord(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = parent[key];
  if (isRecord(value)) return value;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function sameJSONStructure(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJSONStructure(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) && sameJSONStructure(left[key], right[key]),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
