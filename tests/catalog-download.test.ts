import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHomepageApp } from "../src/api/app";
import { issueCominaviJWT } from "../src/lib/server/cominavi-auth";
import { serveCatalogArtifact } from "../src/lib/server/catalog-download";
import { SQLiteD1Database } from "./sqlite-d1";

const versionID = `c108-v1-${"a".repeat(24)}`;
const sha256 = "e".repeat(64);
const bytes = new TextEncoder().encode("0123456789abcdef");
const etag = `"sha256-${sha256}"`;

test("catalog artifact supports streaming full, HEAD, and validated range downloads", async () => {
  const database = setupPublishedCatalog();
  const bucket = new RangeBucket(bytes);
  const full = await serveCatalogArtifact(
    new Request("https://cominavi.net/catalog", { method: "GET" }),
    database.binding,
    bucket.binding,
    108,
    versionID,
  );
  assert.equal(full.status, 200);
  assert.equal(await full.text(), "0123456789abcdef");
  assert.equal(full.headers.get("Accept-Ranges"), "bytes");
  assert.equal(full.headers.get("ETag"), etag);
  assert.deepEqual(bucket.requests, [undefined]);

  const partial = await serveCatalogArtifact(
    new Request("https://cominavi.net/catalog", {
      headers: { Range: "bytes=2-5", "If-Range": etag },
    }),
    database.binding,
    bucket.binding,
    108,
    versionID,
  );
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), "2345");
  assert.equal(partial.headers.get("Content-Range"), "bytes 2-5/16");
  assert.equal(partial.headers.get("Content-Length"), "4");
  assert.deepEqual(bucket.requests[1], { offset: 2, length: 4 });

  const suffix = await serveCatalogArtifact(
    new Request("https://cominavi.net/catalog", {
      headers: { Range: "bytes=-3" },
    }),
    database.binding,
    bucket.binding,
    108,
    versionID,
  );
  assert.equal(await suffix.text(), "def");
  assert.equal(suffix.headers.get("Content-Range"), "bytes 13-15/16");

  const head = await serveCatalogArtifact(
    new Request("https://cominavi.net/catalog", { method: "HEAD" }),
    database.binding,
    bucket.binding,
    108,
    versionID,
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("Content-Length"), "16");
  assert.equal(bucket.heads, 1);
});

test("catalog ranges fail closed and If-Range mismatch falls back to full body", async () => {
  const database = setupPublishedCatalog();
  const bucket = new RangeBucket(bytes);
  const invalid = await serveCatalogArtifact(
    new Request("https://cominavi.net/catalog", {
      headers: { Range: "bytes=16-20" },
    }),
    database.binding,
    bucket.binding,
    108,
    versionID,
  );
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("Content-Range"), "bytes */16");
  assert.deepEqual(bucket.requests, []);

  const mismatch = await serveCatalogArtifact(
    new Request("https://cominavi.net/catalog", {
      headers: { Range: "bytes=2-5", "If-Range": '"old"' },
    }),
    database.binding,
    bucket.binding,
    108,
    versionID,
  );
  assert.equal(mismatch.status, 200);
  assert.equal(await mismatch.text(), "0123456789abcdef");
  assert.deepEqual(bucket.requests, [undefined]);

  const unchanged = await serveCatalogArtifact(
    new Request("https://cominavi.net/catalog", {
      headers: { "If-None-Match": etag },
    }),
    database.binding,
    bucket.binding,
    108,
    versionID,
  );
  assert.equal(unchanged.status, 304);
  assert.equal(bucket.requests.length, 1);
});

test("catalog download operation authenticates before accessing private R2", async () => {
  let bucketAccesses = 0;
  const bucket = {
    get: async () => {
      bucketAccesses += 1;
      throw new Error("private R2 must not be accessed before authentication");
    },
  } as unknown as R2Bucket;
  const app = createHomepageApp(() => new Response("astro"));
  const response = await app.fetch(
    new Request(
      `https://cominavi.net/api/v2/catalogs/108/versions/${versionID}/artifact`,
    ),
    {
      COMINAVI_CATALOG_DOWNLOADS: bucket,
    } as unknown as Cloudflare.Env,
    executionContext,
  );
  assert.equal(response.status, 401);
  assert.equal(bucketAccesses, 0);
});

test("authenticated catalog route streams resumable bytes only from the derived download bucket", async () => {
  const database = setupPublishedCatalog();
  const bucket = new RangeBucket(bytes);
  const secret = "catalog-proxy-jwt-secret-longer-than-thirty-two-bytes";
  const token = await issueCominaviJWT(
    {
      subject: "0123456789abcdef0123456789abcdef",
      userID: 1,
      authVersion: 1,
    },
    secret,
  );
  const app = createHomepageApp(() => new Response("astro"));
  const response = await app.fetch(
    new Request(
      `https://cominavi.net/api/v2/catalogs/108/versions/${versionID}/artifact`,
      {
        headers: {
          Authorization: `Bearer ${token.token}`,
          Range: "bytes=2-5",
          "If-Range": etag,
        },
      },
    ),
    {
      COMINAVI_DB: database.binding,
      COMINAVI_CATALOG_DOWNLOADS: bucket.binding,
      COMINAVI_CATALOGS: {
        get: async () => {
          throw new Error("raw catalog bucket must not serve downloads");
        },
      },
      COMINAVI_JWT_SECRET: secret,
    } as unknown as Cloudflare.Env,
    executionContext,
  );

  assert.equal(response.status, 206, await response.clone().text());
  assert.equal(response.headers.get("Content-Range"), "bytes 2-5/16");
  assert.equal(await response.text(), "2345");
  assert.deepEqual(bucket.requests, [{ offset: 2, length: 4 }]);
});

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
  exports: {},
  tracing: {},
} as unknown as ExecutionContext;

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
    INSERT INTO users (
      id, public_id, display_name, auth_version, deletion_pending_at,
      created_at, updated_at, last_authenticated_at
    ) VALUES (
      1, '0123456789abcdef0123456789abcdef', 'Catalog User', 1, NULL,
      1, 1, 1
    );
    INSERT INTO catalog_events (comiket_no, name, active_version_id, created_at, updated_at)
    VALUES (108, 'Comic Market 108', '${versionID}', 1, 1);
    INSERT INTO catalog_versions (
      id, comiket_no, schema_version, state, claim_id,
      source_main_sha256, source_image_sha256, derived_sha256, derived_bytes,
      created_at, published_at
    ) VALUES (
      '${versionID}', 108, 1, 'published',
      '11111111-1111-4111-8111-111111111111', '${"c".repeat(64)}',
      '${"d".repeat(64)}', '${sha256}', ${bytes.byteLength}, 1, 1
    );
    INSERT INTO catalog_artifacts (
      version_id, kind, visibility, object_key, sha256, byte_count,
      content_type, created_at
    ) VALUES (
      '${versionID}', 'derived_catalog', 'authenticated_download',
      'derived/catalogs/c108/${versionID}.sqlite', '${sha256}',
      ${bytes.byteLength}, 'application/vnd.cominavi.catalog-v1+sqlite', 1
    );
  `);
  return database;
}

class RangeBucket {
  readonly requests: Array<{ offset: number; length: number } | undefined> = [];
  heads = 0;
  readonly binding: R2Bucket;

  constructor(private readonly bytes: Uint8Array) {
    this.binding = {
      get: async (
        _key: string,
        options?: { range?: { offset: number; length: number } },
      ) => {
        const range = options?.range;
        this.requests.push(range);
        const body = range
          ? this.bytes.slice(range.offset, range.offset + range.length)
          : this.bytes;
        return objectBody(this.bytes.byteLength, body);
      },
      head: async () => {
        this.heads += 1;
        return objectBody(this.bytes.byteLength, new Uint8Array());
      },
    } as unknown as R2Bucket;
  }
}

function objectBody(size: number, body: Uint8Array): R2ObjectBody {
  const buffer = Uint8Array.from(body).buffer;
  return {
    key: "fixture",
    size,
    etag: "fixture",
    httpEtag: '"fixture"',
    uploaded: new Date(0),
    version: "fixture",
    checksums: {},
    customMetadata: { sha256, visibility: "authenticated_download" },
    httpMetadata: {
      contentType: "application/vnd.cominavi.catalog-v1+sqlite",
    },
    range: undefined,
    body: new Response(buffer).body!,
    bodyUsed: false,
    arrayBuffer: async () => buffer,
    bytes: async () => body,
    text: async () => new TextDecoder().decode(body),
    json: async () => JSON.parse(new TextDecoder().decode(body)),
    blob: async () => new Blob([buffer]),
    writeHttpMetadata: () => undefined,
  } as unknown as R2ObjectBody;
}
