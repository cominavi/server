import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHomepageApp } from "../src/api/app";
import { generateOpenAPIDocument } from "../src/api/openapi";
import { SQLiteD1Database } from "./sqlite-d1";

const manualSecret = "catalog-control-manual-secret-at-least-32-bytes";
const scheduledSecret = "catalog-control-scheduled-secret-at-least-32-bytes";
const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
  exports: {},
  tracing: {},
} as unknown as ExecutionContext;

test("OpenAPI owns all four catalog control operations and documents exact-body HMAC", async () => {
  const document = await generateOpenAPIDocument();
  const operations = [
    [
      "/api/v2/internal/catalog-publications",
      "post",
      "executeCatalogPublication",
    ],
    [
      "/api/v2/internal/catalog-refresh-jobs",
      "post",
      "executeCatalogRefreshJob",
    ],
    [
      "/api/v2/internal/catalog-artifacts/multipart",
      "post",
      "executeCatalogMultipartUpload",
    ],
    [
      "/api/v2/internal/catalog-artifacts/multipart/{uploadID}/{partNumber}",
      "put",
      "uploadCatalogMultipartPart",
    ],
  ] as const;
  const security = [
    {
      catalogPublisherSignature: [],
      catalogPublisherTimestamp: [],
      catalogPublisherIdempotencyKey: [],
    },
  ];
  for (const [path, method, operationID] of operations) {
    const operation = document.paths?.[path]?.[method];
    assert.equal(operation?.operationId, operationID);
    assert.deepEqual(operation?.security, security);
  }

  const multipart =
    document.paths?.[
      "/api/v2/internal/catalog-artifacts/multipart/{uploadID}/{partNumber}"
    ]?.put;
  assert.deepEqual(
    multipart?.requestBody && "content" in multipart.requestBody
      ? multipart.requestBody.content?.["application/octet-stream"]?.schema
      : undefined,
    { type: "string", format: "binary" },
  );
  assert.ok(
    document.paths?.["/api/v2/internal/catalog-artifacts/multipart"]?.post
      ?.responses?.["201"],
  );
  assert.equal(
    document.components?.securitySchemes?.catalogPublisherSignature &&
      "name" in document.components.securitySchemes.catalogPublisherSignature
      ? document.components.securitySchemes.catalogPublisherSignature.name
      : undefined,
    "X-ComiNavi-Signature",
  );
  assert.match(
    JSON.stringify(
      document.components?.securitySchemes?.catalogPublisherSignature,
    ),
    /method.*path plus query.*SHA-256/i,
  );
});

test("publication status authenticates exact bytes and replays with 202", async () => {
  const database = setup();
  const app = createHomepageApp(() => new Response("astro"));
  const path = "/api/v2/internal/catalog-publications";
  const body = JSON.stringify({
    schemaVersion: 1,
    action: "status",
    input: { versionID: `c108-v1-${"a".repeat(24)}` },
  });
  const idempotencyKey = "manual:catalog-status:fixture";
  const environment = env(database, new RecordingBucket());
  const call = (requestBody: string, signatureBody = body) => {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    return app.fetch(
      new Request(`https://cominavi.net${path}`, {
        method: "POST",
        headers: signedHeaders(
          "POST",
          path,
          new TextEncoder().encode(signatureBody),
          idempotencyKey,
          timestamp,
          manualSecret,
          "application/json",
        ),
        body: requestBody,
      }),
      environment,
      executionContext,
    );
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await call(body);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      accepted: true,
      action: "status",
    });
  }
  const tampered = await call(`${body} `);
  assert.equal(tampered.status, 401);
  assert.deepEqual(await tampered.json(), {
    error: "invalid_catalog_publication_signature",
    message: "The catalog publication signature is invalid or expired.",
  });

  const invalid = await signedFetch(
    app,
    environment,
    "POST",
    path,
    new TextEncoder().encode("{"),
    "manual:catalog-status:invalid-json",
    manualSecret,
    "application/json",
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: "invalid_catalog_publication",
    message: "The catalog publication command is invalid.",
  });
});

test("multipart create keeps 201 replay semantics and creates storage once", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  const app = createHomepageApp(() => new Response("astro"));
  const path = "/api/v2/internal/catalog-artifacts/multipart";
  const body = JSON.stringify({
    schemaVersion: 1,
    action: "create",
    objectKey: "raw/catalogs/c108/source-main.sqlite",
    sha256: "a".repeat(64),
    bytes: 12,
    contentType: "application/vnd.sqlite3",
    visibility: "private_source",
  });
  const idempotencyKey = "manual:multipart-create:fixture";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await signedFetch(
      app,
      env(database, bucket),
      "POST",
      path,
      new TextEncoder().encode(body),
      idempotencyKey,
      manualSecret,
      "application/json",
    );
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      alreadyComplete: false,
      uploadID: "upload-fixture",
    });
  }
  assert.equal(bucket.createCount, 1);

  const timestamp = String(Math.floor(Date.now() / 1_000));
  const tampered = await app.fetch(
    new Request(`https://cominavi.net${path}`, {
      method: "POST",
      headers: signedHeaders(
        "POST",
        path,
        new TextEncoder().encode(body),
        "manual:multipart-create:tampered",
        timestamp,
        manualSecret,
        "application/json",
      ),
      body: `${body} `,
    }),
    env(database, bucket),
    executionContext,
  );
  assert.equal(tampered.status, 401);
});

test("refresh lease requires the scheduled signer and replays an empty lease result", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  const app = createHomepageApp(() => new Response("astro"));
  const path = "/api/v2/internal/catalog-refresh-jobs";
  const body = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      action: "lease",
      leaseID: "11111111-1111-4111-8111-111111111111",
    }),
  );
  const idempotencyKey = "scheduled:refresh-lease:fixture";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await signedFetch(
      app,
      env(database, bucket),
      "POST",
      path,
      body,
      idempotencyKey,
      scheduledSecret,
      "application/json",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {});
  }

  const wrongSigner = await signedFetch(
    app,
    env(database, bucket),
    "POST",
    path,
    body,
    "manual:refresh-lease:forbidden",
    manualSecret,
    "application/json",
  );
  assert.equal(wrongSigner.status, 401);
  assert.deepEqual(await wrongSigner.json(), {
    error: "invalid_catalog_publication_signature",
    message: "Catalog refresh jobs require the scheduled publisher signer.",
  });
});

test("multipart part preserves raw bytes and signs the exact path plus query", async () => {
  const database = setup();
  const bucket = new RecordingBucket();
  const app = createHomepageApp(() => new Response("astro"));
  database.native.exec(`
    INSERT INTO catalog_internal_command_receipts (
      idempotency_key, action_scope, payload_hash, created_at
    ) VALUES ('multipart-create-receipt', 'catalog_artifact:create', '${"b".repeat(64)}', 1);
    INSERT INTO catalog_multipart_upload_receipts (
      idempotency_key, state, object_key, sha256, byte_count,
      content_type, visibility, claim_id, lease_id, source_md5_hint,
      upload_id, expires_at, created_at, updated_at
    ) VALUES (
      'multipart-create-receipt', 'active',
      'raw/catalogs/c108/source-main.sqlite', '${"a".repeat(64)}', 12,
      'application/vnd.sqlite3', 'private_source', NULL, NULL, NULL,
      'upload-fixture', 4102444800, 1, 1
    );
  `);
  const query = new URLSearchParams({
    key: "raw/catalogs/c108/source-main.sqlite",
  });
  const path = `/api/v2/internal/catalog-artifacts/multipart/upload-fixture/1?${query}`;
  const bytes = Uint8Array.from([0, 1, 2, 3, 254, 255]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await signedFetch(
      app,
      env(database, bucket),
      "PUT",
      path,
      bytes,
      "manual:multipart-part:fixture",
      manualSecret,
      "application/octet-stream",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      partNumber: 1,
      etag: "etag-1",
    });
  }
  assert.deepEqual(bucket.uploaded, [
    { partNumber: 1, bytes: [...bytes] },
    { partNumber: 1, bytes: [...bytes] },
  ]);

  const tamperedPath = `${path}&unused=value`;
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const tampered = await app.fetch(
    new Request(`https://cominavi.net${tamperedPath}`, {
      method: "PUT",
      headers: signedHeaders(
        "PUT",
        path,
        bytes,
        "manual:multipart-part:tampered",
        timestamp,
        manualSecret,
        "application/octet-stream",
      ),
      body: Uint8Array.from(bytes).buffer,
    }),
    env(database, bucket),
    executionContext,
  );
  assert.equal(tampered.status, 401);
});

async function signedFetch(
  app: ReturnType<typeof createHomepageApp>,
  environment: Cloudflare.Env,
  method: string,
  path: string,
  body: Uint8Array,
  idempotencyKey: string,
  secret: string,
  contentType: string,
): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  return app.fetch(
    new Request(`https://cominavi.net${path}`, {
      method,
      headers: signedHeaders(
        method,
        path,
        body,
        idempotencyKey,
        timestamp,
        secret,
        contentType,
      ),
      body: Uint8Array.from(body).buffer,
    }),
    environment,
    executionContext,
  );
}

function signedHeaders(
  method: string,
  path: string,
  body: Uint8Array,
  idempotencyKey: string,
  timestamp: string,
  secret: string,
  contentType: string,
): HeadersInit {
  const payloadSHA256 = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", secret)
    .update(
      `${timestamp}\n${idempotencyKey}\n${method}\n${path}\n${payloadSHA256}`,
    )
    .digest("hex");
  return {
    "Content-Type": contentType,
    "Idempotency-Key": idempotencyKey,
    "X-ComiNavi-Timestamp": timestamp,
    "X-ComiNavi-Signature": `v1=${signature}`,
  };
}

function setup(): SQLiteD1Database {
  return new SQLiteD1Database(
    [
      "migrations/0001_following_imports.sql",
      "migrations/0002_realtime_service.sql",
      "migrations/0003_accounts_shared_plans.sql",
      "migrations/0004_sanitized_catalog.sql",
      "migrations/0005_shared_plan_crdt_notifications.sql",
      "migrations/0006_notification_inbox.sql",
      "migrations/0007_catalog_genres_all_days.sql",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  );
}

function env(
  database: SQLiteD1Database,
  bucket: RecordingBucket,
): Cloudflare.Env {
  return {
    COMINAVI_DB: database.binding,
    COMINAVI_CATALOGS: bucket.binding,
    COMINAVI_CATALOG_PUBLISH_SECRET: manualSecret,
    COMINAVI_CATALOG_SCHEDULED_PUBLISH_SECRET: scheduledSecret,
  } as unknown as Cloudflare.Env;
}

class RecordingBucket {
  createCount = 0;
  readonly uploaded: Array<{ partNumber: number; bytes: number[] }> = [];
  readonly binding = {
    head: async () => null,
    createMultipartUpload: async () => {
      this.createCount += 1;
      return { uploadId: "upload-fixture" };
    },
    resumeMultipartUpload: () => ({
      uploadPart: async (partNumber: number, value: ArrayBuffer) => {
        this.uploaded.push({
          partNumber,
          bytes: [...new Uint8Array(value)],
        });
        return { partNumber, etag: `etag-${partNumber}` };
      },
    }),
  } as unknown as R2Bucket;
}
