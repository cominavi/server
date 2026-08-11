import assert from "node:assert/strict";
import test from "node:test";
import { canonicalErrorResponseBodySchema } from "../src/api/core";
import {
  canonicalErrorResponseReference,
  generateOpenAPIDocument,
} from "../src/api/openapi";

const authenticatedOperations = [
  ["/api/v2/me", "get", "getCurrentUserProfile"],
  ["/api/v2/me", "patch", "updateCurrentUserProfile"],
  ["/api/v2/me", "delete", "deleteCurrentUserAccount"],
  ["/api/v2/me/favorites/{eventNumber}", "get", "getFavoriteSnapshot"],
  ["/api/v2/me/favorites/{eventNumber}", "put", "replaceFavoriteSnapshot"],
  [
    "/api/v2/me/circlems-favorites/{eventNumber}",
    "get",
    "listCirclemsFavoriteImport",
  ],
  ["/api/v2/me/notifications", "get", "listNotifications"],
  ["/api/v2/me/notifications/{eventID}/read", "put", "markNotificationRead"],
] as const;

test("profile, favorites, and notification operations are typed and bearer secured", async () => {
  const document = await generateOpenAPIDocument();
  for (const [path, method, operationID] of authenticatedOperations) {
    const operation = document.paths?.[path]?.[method];
    assert.ok(operation, `${method.toUpperCase()} ${path} must be documented`);
    assert.equal(operation.operationId, operationID);
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    assert.ok(operation.responses?.["200"] ?? operation.responses?.["202"]);
    assert.ok(operation.responses?.["401"]);
  }
});

test("generated client contract contains no unsupported null-only schema branches", async () => {
  const document = await generateOpenAPIDocument();
  assert.equal(containsNullSchema(document), false);
});

test("every non-success JSON response references one canonical error component", async () => {
  const document = await generateOpenAPIDocument();
  assert.deepEqual(
    document.components?.schemas?.CanonicalErrorResponse,
    canonicalErrorResponseBodySchema,
  );

  let documentedErrorResponses = 0;
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of httpMethods) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      for (const [status, response] of Object.entries(
        operation.responses ?? {},
      )) {
        if (status.startsWith("2") || "$ref" in response) continue;
        const mediaType = response.content?.["application/json"];
        if (!mediaType) continue;
        documentedErrorResponses += 1;
        assert.deepEqual(
          mediaType.schema,
          canonicalErrorResponseReference,
          `${method.toUpperCase()} ${path} response ${status}`,
        );
      }
    }
  }
  assert.ok(documentedErrorResponses > 0);
});

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

function containsNullSchema(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsNullSchema);
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "null") return true;
  return Object.values(record).some(containsNullSchema);
}
