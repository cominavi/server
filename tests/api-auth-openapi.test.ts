import assert from "node:assert/strict";
import test from "node:test";
import { createHomepageApp } from "../src/api/app";
import { canonicalErrorResponseBodySchema } from "../src/api/core";
import {
  canonicalErrorResponseReference,
  generateOpenAPIDocument,
} from "../src/api/openapi";

const environment = {} as Cloudflare.Env;
const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
  exports: {},
  tracing: {},
} as unknown as ExecutionContext;

const publicOperations = new Map([
  ["/api/v2/auth/circlems/start", "startCirclemsAuthentication"],
  ["/api/v2/auth/circlems/complete", "completeCirclemsAuthentication"],
  ["/api/v2/auth/google/entry-grant", "issueGoogleAuthenticationEntryGrant"],
  ["/api/v2/auth/google", "authenticateWithGoogle"],
  ["/api/v2/auth/apple/entry-grant", "issueAppleAuthenticationEntryGrant"],
  ["/api/v2/auth/apple", "authenticateWithApple"],
  ["/api/v2/auth/refresh", "refreshAuthenticationSession"],
]);

test("OpenAPI exposes the complete non-legacy authentication surface", async () => {
  const document = await generateOpenAPIDocument();
  const operationIDs = new Set<string>();

  for (const [path, expectedOperationID] of publicOperations) {
    const operation = document.paths?.[path]?.post;
    assert.equal(operation?.operationId, expectedOperationID);
    assert.deepEqual(operation?.security, []);
    assert.ok(!operationIDs.has(expectedOperationID));
    operationIDs.add(expectedOperationID);
  }

  const logout = document.paths?.["/api/v2/auth/logout"]?.post;
  assert.equal(logout?.operationId, "logoutAuthenticationSession");
  assert.deepEqual(logout?.security, [{ bearerAuth: [] }]);
  assert.match(logout?.description ?? "", /predecessor proof/);
  assert.match(logout?.description ?? "", /exact payload-bound logout receipt/);
});

test("generated auth errors use the canonical ComiNavi response body", async () => {
  const document = await generateOpenAPIDocument();
  const response =
    document.paths?.["/api/v2/auth/refresh"]?.post?.responses?.["401"];
  assert.ok(response && "content" in response);
  const schema = response.content?.["application/json"]?.schema;
  assert.deepEqual(schema, canonicalErrorResponseReference);
  assert.deepEqual(
    document.components?.schemas?.CanonicalErrorResponse,
    canonicalErrorResponseBodySchema,
  );
});

test("runtime auth errors preserve lowercase service codes without oRPC internals", async () => {
  const app = createHomepageApp(() => new Response("astro"));
  const response = await app.fetch(
    new Request("https://cominavi.net/api/v2/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: "not-a-refresh-token" }),
    }),
    environment,
    executionContext,
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(await response.json(), {
    error: "invalid_refresh_token",
    message: "The ComiNavi refresh token is invalid or has already been used.",
  });
});

test("logout requires bearer predecessor proof but not a current-session middleware", async () => {
  const app = createHomepageApp(() => new Response("astro"));
  const response = await app.fetch(
    new Request("https://cominavi.net/api/v2/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "11111111-1111-4111-8111-111111111111",
        refreshToken: "a".repeat(43),
      }),
    }),
    environment,
    executionContext,
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: "missing_bearer_token",
    message: "A bearer token is required.",
  });
});
