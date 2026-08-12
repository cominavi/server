import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityLifetimeSeconds,
  catalogDownloadCapabilityRedirect,
  timedHMACToken,
} from "../src/lib/server/catalog-download-capability";
import { mirrorDerivedCatalogArtifact } from "../src/api/routers/catalog-control";
import { SQLiteD1Database } from "./sqlite-d1";
import { readFileSync } from "node:fs";

const versionID = `c108-v1-${"a".repeat(24)}`;
const sha256 = "e".repeat(64);
const objectKey = `derived/catalogs/c108/${versionID}.sqlite`;
const contentType = "application/vnd.cominavi.catalog-v1+sqlite";

test("catalog capability is short-lived, exact-path-bound, and redirects without leaking auth", async () => {
  const database = setupPublishedCatalog();
  const bucket = matchingDownloadBucket();
  const now = 1_800_000_000;
  const secret = "catalog-download-secret-longer-than-thirty-two-bytes";
  const response = await catalogDownloadCapabilityRedirect(
    database.binding,
    bucket,
    108,
    versionID,
    "GET",
    {
      mode: "custom-domain-hmac",
      origin: "https://catalogs.cominavi.net",
      secret,
    },
    now,
  );

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const location = new URL(response.headers.get("Location")!);
  assert.equal(location.origin, "https://catalogs.cominavi.net");
  assert.equal(location.pathname, `/${objectKey}`);
  assert.equal(
    location.searchParams.get("verify"),
    await timedHMACToken(`/${objectKey}`, now, secret),
  );
  assert.equal(location.searchParams.size, 1);
  assert.equal(capabilityLifetimeSeconds, 300);
});

test("catalog capability fails closed when the derived-only object is absent or mismatched", async () => {
  const database = setupPublishedCatalog();
  const configuration = {
    mode: "custom-domain-hmac" as const,
    origin: "https://catalogs.cominavi.net",
    secret: "catalog-download-secret-longer-than-thirty-two-bytes",
  };
  await assert.rejects(
    catalogDownloadCapabilityRedirect(
      database.binding,
      { head: async () => null } as unknown as R2Bucket,
      108,
      versionID,
      "GET",
      configuration,
    ),
    /temporarily unavailable/,
  );
  await assert.rejects(
    catalogDownloadCapabilityRedirect(
      database.binding,
      {
        head: async () => ({
          ...matchingObject(),
          customMetadata: {
            sha256: "f".repeat(64),
            visibility: "authenticated_download",
          },
        }),
      } as unknown as R2Bucket,
      108,
      versionID,
      "GET",
      configuration,
    ),
    /temporarily unavailable/,
  );
});

test("catalog capability can mint a short-lived direct R2 SigV4 URL", async () => {
  const now = 1_800_000_000;
  const response = await catalogDownloadCapabilityRedirect(
    setupPublishedCatalog().binding,
    matchingDownloadBucket(),
    108,
    versionID,
    "GET",
    {
      mode: "r2-presigned",
      accessKeyID: "fixture-access-key",
      secretAccessKey: "fixture-secret-access-key",
    },
    now,
  );

  const location = new URL(response.headers.get("Location")!);
  assert.equal(
    location.host,
    "bee683f3b5473a422feaa41e040ac176.r2.cloudflarestorage.com",
  );
  assert.equal(location.pathname, `/cominavi-catalog-downloads/${objectKey}`);
  assert.equal(location.searchParams.get("X-Amz-Expires"), "300");
  assert.equal(location.searchParams.get("X-Amz-Date"), "20270115T080000Z");
  assert.equal(
    location.searchParams.get("X-Amz-Algorithm"),
    "AWS4-HMAC-SHA256",
  );
  assert.ok(location.searchParams.get("X-Amz-Signature"));
});

test("publication mirrors only verified derived catalogs into the download bucket", async () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  let storedBody: ReadableStream | ArrayBuffer | ArrayBufferView | null = null;
  let storedOptions: R2PutOptions | undefined;
  let stored = false;
  const metadata = {
    objectKey,
    sha256,
    bytes: body.byteLength,
    contentType,
    visibility: "authenticated_download" as const,
  };
  const source = {
    get: async (key: string) =>
      key === objectKey
        ? ({
            ...matchingObject(body.byteLength),
            body: new Blob([body]).stream(),
          } as unknown as R2ObjectBody)
        : null,
  } as unknown as R2Bucket;
  const destination = {
    head: async (key: string) =>
      stored && key === objectKey ? matchingObject(body.byteLength) : null,
    put: async (
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
      options?: R2PutOptions,
    ) => {
      assert.equal(key, objectKey);
      stored = true;
      storedBody = value as ReadableStream | ArrayBuffer | ArrayBufferView;
      storedOptions = options;
      return matchingObject(body.byteLength);
    },
  } as unknown as R2Bucket;

  await mirrorDerivedCatalogArtifact(
    {
      COMINAVI_CATALOGS: source,
      COMINAVI_CATALOG_DOWNLOADS: destination,
    } as Cloudflare.Env,
    metadata,
  );

  assert.ok(storedBody);
  assert.deepEqual(storedOptions?.httpMetadata, { contentType });
  assert.deepEqual(storedOptions?.customMetadata, {
    sha256,
    visibility: "authenticated_download",
  });
});

function matchingDownloadBucket(): R2Bucket {
  return {
    head: async (key: string) => (key === objectKey ? matchingObject() : null),
  } as unknown as R2Bucket;
}

function matchingObject(size = 16): R2Object {
  return {
    key: objectKey,
    size,
    etag: "fixture",
    httpEtag: '"fixture"',
    uploaded: new Date(0),
    version: "fixture",
    checksums: {},
    customMetadata: { sha256, visibility: "authenticated_download" },
    httpMetadata: { contentType },
    range: undefined,
    writeHttpMetadata: () => undefined,
  } as unknown as R2Object;
}

function setupPublishedCatalog(): SQLiteD1Database {
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
    INSERT INTO catalog_events (comiket_no, name, active_version_id, created_at, updated_at)
    VALUES (108, 'Comic Market 108', '${versionID}', 1, 1);
    INSERT INTO catalog_versions (
      id, comiket_no, schema_version, state, claim_id,
      source_main_sha256, source_image_sha256, derived_sha256, derived_bytes,
      created_at, published_at
    ) VALUES (
      '${versionID}', 108, 1, 'published',
      '11111111-1111-4111-8111-111111111111', '${"c".repeat(64)}',
      '${"d".repeat(64)}', '${sha256}', 16, 1, 1
    );
    INSERT INTO catalog_artifacts (
      version_id, kind, visibility, object_key, sha256, byte_count,
      content_type, created_at
    ) VALUES (
      '${versionID}', 'derived_catalog', 'authenticated_download',
      '${objectKey}', '${sha256}', 16, '${contentType}', 1
    );
  `);
  return database;
}
