import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { catalogsRouter } from "../src/api/routers/catalogs";
import {
  canonicalErrorResponseBody,
  canonicalErrorResponseBodySchema,
} from "../src/api/core";
import { issueCominaviJWT } from "../src/lib/server/cominavi-auth";
import { SQLiteD1Database } from "./sqlite-d1";

const versionID = `c108-v1-${"a".repeat(24)}`;
const sha256 = "e".repeat(64);
const bytes = new TextEncoder().encode("0123456789abcdef");
const etag = `"sha256-${sha256}"`;
const secret = "catalog-orpc-test-secret-at-least-32-bytes";

test("catalog oRPC contract is stable, binary, header-complete, and non-nullable", async () => {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });
  const document = await generator.generate(catalogsRouter, {
    info: { title: "Catalog contract", version: "2" },
    customErrorResponseBodySchema: canonicalErrorResponseBodySchema,
  });

  assert.equal(
    document.paths?.["/api/v2/catalogs"]?.get?.operationId,
    "listCatalogs",
  );
  assert.equal(
    document.paths?.["/api/v2/catalogs/{comiketNo}"]?.get?.operationId,
    "getCatalogManifest",
  );
  const artifactPath =
    document.paths?.[
      "/api/v2/catalogs/{comiketNo}/versions/{versionID}/artifact"
    ];
  assert.equal(artifactPath?.get?.operationId, "downloadCatalogArtifact");
  assert.equal(artifactPath?.head?.operationId, "headCatalogArtifact");

  const full = artifactPath?.get?.responses?.["200"];
  const partial = artifactPath?.get?.responses?.["206"];
  const unchanged = artifactPath?.get?.responses?.["304"];
  const unsatisfied = artifactPath?.get?.responses?.["416"];
  assert.ok(full && "content" in full && "headers" in full);
  assert.ok(partial && "content" in partial && "headers" in partial);
  assert.ok(unchanged && !("content" in unchanged));
  assert.ok(unsatisfied && "headers" in unsatisfied);
  assert.deepEqual(
    full.content?.["application/vnd.cominavi.catalog-v1+sqlite"]?.schema,
    { type: "string", format: "binary" },
  );
  assert.ok(partial.headers?.["Content-Range"]);
  assert.ok(full.headers?.ETag);
  assert.ok(artifactPath?.head?.responses?.["200"]);
  assert.ok(artifactPath?.head?.responses?.["304"]);

  const serialized = JSON.stringify(document);
  assert.doesNotMatch(serialized, /"nullable"\s*:/);
  assert.doesNotMatch(serialized, /"type"\s*:\s*\[[^\]]*"null"/);
});

test("catalog oRPC routes list manifests and preserve resumable artifact behavior", async () => {
  const database = setupPublishedCatalog();
  const bucket = new RangeBucket(bytes);
  const token = await issueCominaviJWT(
    {
      subject: "0123456789abcdef0123456789abcdef",
      userID: 1,
      authVersion: 1,
    },
    secret,
  );
  const handler = new OpenAPIHandler(catalogsRouter, {
    customErrorResponseBodyEncoder: canonicalErrorResponseBody,
  });
  const environment = {
    COMINAVI_DB: database.binding,
    COMINAVI_CATALOG_DOWNLOADS: bucket.binding,
    COMINAVI_JWT_SECRET: secret,
  } as unknown as Cloudflare.Env;
  const fetchCatalog = async (path: string, init?: RequestInit) => {
    const request = new Request(`https://cominavi.net${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token.token}`,
        ...Object.fromEntries(new Headers(init?.headers)),
      },
    });
    const result = await handler.handle(request, {
      context: { request, env: environment },
    });
    assert.equal(result.matched, true);
    if (!result.matched) throw new Error("catalog route did not match");
    return result.response;
  };

  const index = await fetchCatalog("/api/v2/catalogs");
  assert.equal(index.status, 200);
  const indexBody = await index.json<{
    items: Array<Record<string, unknown>>;
  }>();
  assert.equal(indexBody.items.length, 1);
  assert.equal("sourceUpdatedAt" in indexBody.items[0]!, false);
  assert.equal(indexBody.items[0]?.sourceMainSHA256, "c".repeat(64));

  const manifest = await fetchCatalog("/api/v2/catalogs/108");
  assert.equal(manifest.status, 200);
  const manifestBody = await manifest.json<{
    sourceMainSHA256: string;
    artifact: { url: string };
  }>();
  assert.equal(
    manifestBody.artifact.url,
    `/api/v2/catalogs/108/versions/${versionID}/artifact`,
  );
  assert.equal(manifestBody.sourceMainSHA256, "c".repeat(64));

  const path = `/api/v2/catalogs/108/versions/${versionID}/artifact`;
  const full = await fetchCatalog(path);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("Accept-Ranges"), "bytes");
  assert.equal(full.headers.get("ETag"), etag);
  assert.equal(await full.text(), "0123456789abcdef");

  const partial = await fetchCatalog(path, {
    headers: { Range: "bytes=2-5", "If-Range": etag },
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("Content-Range"), "bytes 2-5/16");
  assert.equal(partial.headers.get("Content-Length"), "4");
  assert.equal(await partial.text(), "2345");

  const replaced = await fetchCatalog(path, {
    headers: { Range: "bytes=6-9", "If-Range": '"stale"' },
  });
  assert.equal(replaced.status, 200);
  assert.equal(await replaced.text(), "0123456789abcdef");

  const unchanged = await fetchCatalog(path, {
    headers: { "If-None-Match": etag },
  });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");

  const invalid = await fetchCatalog(path, {
    headers: { Range: "bytes=16-20" },
  });
  assert.equal(invalid.status, 416);
  assert.deepEqual(await invalid.json(), {
    error: "catalog_range_not_satisfiable",
    message: "The requested catalog byte range is not satisfiable.",
    details: { contentRange: "bytes */16" },
  });

  const head = await fetchCatalog(path, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), "16");
  assert.equal(head.headers.get("ETag"), etag);
  assert.equal(await head.text(), "");

  const unchangedHead = await fetchCatalog(path, {
    method: "HEAD",
    headers: { "If-None-Match": etag },
  });
  assert.equal(unchangedHead.status, 304);
  assert.equal(await unchangedHead.text(), "");
  assert.equal(bucket.heads, 1);
  assert.deepEqual(bucket.requests, [
    undefined,
    { offset: 2, length: 4 },
    undefined,
  ]);
});

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
    INSERT INTO catalog_events (
      comiket_no, name, active_version_id, created_at, updated_at
    ) VALUES (108, 'Comic Market 108', '${versionID}', 1, 1);
    INSERT INTO catalog_versions (
      id, comiket_no, schema_version, state, claim_id,
      source_updated_at, source_main_sha256, source_image_sha256,
      derived_sha256, derived_bytes, circle_count, layout_count, image_count,
      created_at, published_at
    ) VALUES (
      '${versionID}', 108, 1, 'published',
      '11111111-1111-4111-8111-111111111111', NULL, '${"c".repeat(64)}',
      '${"d".repeat(64)}', '${sha256}', ${bytes.byteLength}, 1, 1, 1, 1, 1
    );
    INSERT INTO catalog_artifacts (
      version_id, kind, visibility, object_key, sha256, byte_count,
      content_type, created_at
    ) VALUES (
      '${versionID}', 'derived_catalog', 'authenticated_download',
      'derived/catalogs/c108/${versionID}.sqlite', '${sha256}',
      ${bytes.byteLength}, '${"application/vnd.cominavi.catalog-v1+sqlite"}', 1
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
