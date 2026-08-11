import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import {
  canonicalErrorResponseBody,
  canonicalErrorResponseBodySchema,
} from "../src/api/core";
import { identityAvatarImportRouter } from "../src/api/routers/identity-avatar-import";
import { issueCominaviJWT } from "../src/lib/server/cominavi-auth";
import {
  finishCirclemsOAuthCallback,
  type CirclemsOAuthFlowBindings,
} from "../src/lib/server/circlems-oauth-flow";
import { SQLiteD1Database } from "./sqlite-d1";

const subject = "0123456789abcdef0123456789abcdef";
const jwtSecret = "identity-router-jwt-secret-at-least-32-bytes";
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const requestId = "11111111-1111-4111-8111-111111111111";
const clientInstanceID = "22222222-2222-4222-8222-222222222222";
const avatarBytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

test("identity, avatar, and import OpenAPI is stable, binary, and non-nullable", async () => {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });
  const document = await generator.generate(identityAvatarImportRouter, {
    info: { title: "Identity and media contract", version: "2" },
    customErrorResponseBodySchema: canonicalErrorResponseBodySchema,
  });
  const expected = new Map([
    [
      "/api/v2/me/identities/circlems/start",
      ["post", "startCirclemsIdentityLink"],
    ],
    [
      "/api/v2/me/identities/circlems/complete",
      ["post", "completeCirclemsIdentityLink"],
    ],
    ["/api/v2/me/avatar", ["put", "replaceCurrentUserAvatar"]],
    ["/api/v2/users/{userID}/avatar", ["get", "getUserAvatar"]],
    ["/api/v2/imports/x-followings", ["post", "importXFollowings"]],
  ] as const);
  for (const [path, [method, operationID]] of expected) {
    assert.equal(document.paths?.[path]?.[method]?.operationId, operationID);
  }
  assert.equal(
    document.paths?.["/api/v2/me/avatar"]?.delete?.operationId,
    "removeCurrentUserAvatar",
  );

  const avatarUpload = document.paths?.["/api/v2/me/avatar"]?.put;
  assert.deepEqual(
    Object.keys(
      avatarUpload?.requestBody && "content" in avatarUpload.requestBody
        ? avatarUpload.requestBody.content
        : {},
    ).sort(),
    ["image/jpeg", "image/png", "image/webp"],
  );
  const avatarDownload =
    document.paths?.["/api/v2/users/{userID}/avatar"]?.get?.responses?.["200"];
  assert.ok(avatarDownload && "content" in avatarDownload);
  assert.deepEqual(Object.keys(avatarDownload.content ?? {}).sort(), [
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);
  assert.ok("headers" in avatarDownload && avatarDownload.headers?.ETag);

  const serialized = JSON.stringify(document);
  assert.doesNotMatch(serialized, /"nullable"\s*:/);
  assert.doesNotMatch(serialized, /"type"\s*:\s*\[[^\]]*"null"/);
});

test("v2 link, raw avatar, controlled download, deletion, and cached import reuse current services", async () => {
  const database = setup();
  const avatars = new RecordingAvatarBucket();
  const snapshots = new SnapshotKV();
  const configured = bindings(database, avatars, snapshots);
  const token = await issueCominaviJWT(
    { subject, userID: 1, authVersion: 1 },
    jwtSecret,
  );
  const handler = new OpenAPIHandler(identityAvatarImportRouter, {
    customErrorResponseBodyEncoder: canonicalErrorResponseBody,
  });
  const call = async (path: string, init?: RequestInit) => {
    const request = new Request(`https://cominavi.net${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token.token}`,
        ...Object.fromEntries(new Headers(init?.headers)),
      },
    });
    const result = await handler.handle(request, {
      context: { request, env: configured as unknown as Cloudflare.Env },
    });
    assert.equal(result.matched, true);
    if (!result.matched) throw new Error("identity route did not match");
    return result.response;
  };

  const start = await call("/api/v2/me/identities/circlems/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId,
      clientInstanceID,
      environment: "production",
      codeChallenge: challenge,
    }),
  });
  assert.equal(start.status, 200);
  const authorizationURL = new URL(
    (await start.json<{ authorizationURL: string }>()).authorizationURL,
  );
  const state = authorizationURL.searchParams.get("state");
  assert.ok(state);
  const now = Math.floor(Date.now() / 1_000);
  const completionCode = await finishCirclemsOAuthCallback(
    configured,
    state,
    "provider-code",
    circleFetcher(42, "Circle Alice"),
    now,
  );
  const complete = await call("/api/v2/me/identities/circlems/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId,
      clientInstanceID,
      completionCode,
      codeVerifier: verifier,
    }),
  });
  assert.equal(complete.status, 200);
  const linked = await complete.json<{
    user: { identities: Array<{ provider: string }> };
    credentialReceipt: { subject: string; credentialRevision: number };
  }>();
  assert.deepEqual(
    linked.user.identities.map((identity) => identity.provider),
    ["google", "circlems"],
  );
  assert.deepEqual(linked.credentialReceipt, {
    requestId,
    clientInstanceID,
    provider: "circlems",
    environment: "production",
    subject: "42",
    credentialRevision: 1,
  });

  const upload = await call("/api/v2/me/avatar", {
    method: "PUT",
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(avatarBytes.byteLength),
      "If-Match": '"profile:1"',
      "Idempotency-Key": "33333333-3333-4333-8333-333333333333",
    },
    body: avatarBytes,
  });
  assert.equal(upload.status, 200);
  const uploaded = await upload.json<{
    user: { avatarURL: string; revision: number };
  }>();
  assert.deepEqual(uploaded.user, {
    id: subject,
    displayName: "Google owner",
    avatarURL: `/api/v2/users/${subject}/avatar`,
    revision: 2,
    identities: [
      {
        provider: "google",
        email: "owner@example.test",
      },
      {
        provider: "circlems",
        environment: "production",
        providerUserID: 42,
      },
    ],
  });

  const avatar = await call(`/api/v2/users/${subject}/avatar`);
  assert.equal(avatar.status, 200);
  assert.equal(avatar.headers.get("Content-Type"), "image/png");
  assert.equal(avatar.headers.get("Content-Length"), "12");
  assert.deepEqual(new Uint8Array(await avatar.arrayBuffer()), avatarBytes);

  const removed = await call("/api/v2/me/avatar", {
    method: "DELETE",
    headers: {
      "If-Match": '"profile:2"',
      "Idempotency-Key": "44444444-4444-4444-8444-444444444444",
    },
  });
  assert.equal(removed.status, 200);
  const removedProfile = await removed.json<{
    user: Record<string, unknown>;
  }>();
  assert.equal(removedProfile.user.revision, 3);
  assert.equal("avatarURL" in removedProfile.user, false);

  const snapshotKey = `following-import/${subject}/fixture`;
  const snapshot = {
    twitterUserName: "circle_owner",
    importedAt: "2026-08-11T00:00:00.000Z",
    nextAllowedAt: "2099-01-01T00:00:00.000Z",
    followings: [
      {
        id: "x-1",
        userName: "circle_a",
        name: "Circle A",
        url: "https://x.com/circle_a",
      },
    ],
  };
  snapshots.values.set(snapshotKey, snapshot);
  database.native
    .prepare(
      `INSERT INTO following_imports (
         subject, twitter_username, status, lease_id, attempted_at,
         next_allowed_at, successful_at, snapshot_key, following_count,
         last_error
       ) VALUES (?, ?, 'ready', NULL, 1, ?, 1, ?, 1, NULL)`,
    )
    .run(subject, "circle_owner", 4_000_000_000, snapshotKey);
  const imported = await call("/api/v2/imports/x-followings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userName: "@Circle_Owner" }),
  });
  assert.equal(imported.status, 200);
  assert.deepEqual(await imported.json(), { ...snapshot, source: "cache" });
});

function setup(): SQLiteD1Database {
  const database = new SQLiteD1Database(
    [
      "migrations/0001_following_imports.sql",
      "migrations/0002_realtime_service.sql",
      "migrations/0003_accounts_shared_plans.sql",
      "migrations/0004_sanitized_catalog.sql",
      "migrations/0005_shared_plan_crdt_notifications.sql",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  );
  database.native.exec(`
    INSERT INTO users (
      id, public_id, display_name, profile_revision, auth_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (1, '${subject}', 'Google owner', 1, 1, 1, 1, 1);
    INSERT INTO user_identities (
      id, user_id, provider, provider_environment, provider_subject,
      provider_email, created_at, updated_at, last_authenticated_at
    ) VALUES (
      1, 1, 'google', '', 'google-owner', 'owner@example.test', 1, 1, 1
    );
  `);
  return database;
}

function bindings(
  database: SQLiteD1Database,
  avatars: RecordingAvatarBucket,
  snapshots: SnapshotKV,
): CirclemsOAuthFlowBindings & {
  COMINAVI_AVATARS: R2Bucket;
  COMINAVI_FOLLOWING_SNAPSHOTS: KVNamespace;
  TWITTERAPI_IO_API_KEY: string;
} {
  return {
    COMINAVI_DB: database.binding,
    COMINAVI_JWT_SECRET: jwtSecret,
    COMINAVI_PROVIDER_CREDENTIAL_KEY_V1: credentialKey(),
    COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_ORIGIN: "https://auth1.circle.test",
    COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_ID: "production-client",
    COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_SECRET: "production-secret",
    COMINAVI_OAUTH_CIRCLEMS_SANDBOX_ORIGIN: "https://auth1-sandbox.circle.test",
    COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID: "sandbox-client",
    COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET: "sandbox-secret",
    COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN: "https://api1.circle.test",
    COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN: "https://api1-sandbox.circle.test",
    COMINAVI_AVATARS: avatars.binding,
    COMINAVI_FOLLOWING_SNAPSHOTS: snapshots.binding,
    TWITTERAPI_IO_API_KEY: "unused-cached-fixture",
  };
}

function circleFetcher(userID: number, nickname: string): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/OAuth2/Token") {
      return Response.json({
        access_token: "provider-access-secret",
        refresh_token: "provider-refresh-secret",
        token_type: "Bearer",
        expires_in: 3_600,
      });
    }
    assert.equal(url.pathname, "/User/Info");
    return Response.json({
      status: "success",
      response: { pid: userID, nickname },
    });
  };
}

function credentialKey(): string {
  return Buffer.from(
    Uint8Array.from({ length: 32 }, (_, index) => index),
  ).toString("base64url");
}

class RecordingAvatarBucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly binding = {
    put: async (key: string, value: Uint8Array) => {
      this.objects.set(key, Uint8Array.from(value));
      return {};
    },
    delete: async (key: string) => {
      this.objects.delete(key);
    },
    get: async (key: string) => {
      const value = this.objects.get(key);
      if (!value) return null;
      return {
        body: new Response(Uint8Array.from(value).buffer).body,
        size: value.byteLength,
        httpEtag: '"fixture-avatar"',
      };
    },
  } as unknown as R2Bucket;
}

class SnapshotKV {
  readonly values = new Map<string, unknown>();
  readonly binding = {
    get: async (key: string) => this.values.get(key) ?? null,
    put: async (key: string, value: string) => {
      this.values.set(key, JSON.parse(value));
    },
    delete: async (key: string) => {
      this.values.delete(key);
    },
  } as unknown as KVNamespace;
}
