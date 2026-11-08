import assert from "node:assert/strict";
import test from "node:test";
import { createHomepageApp } from "../src/api/app";
import {
  reviewDemoCatalogArtifacts,
  type ReviewDemoCatalogDatabase,
} from "../src/lib/server/review-demo-catalog";

test("public review demo route streams immutable R2 bytes without authentication", async () => {
  const bucket = new ReviewDemoBucket();
  const app = createHomepageApp(() => new Response("astro"));
  const artifact = reviewDemoCatalogArtifacts.main;
  const etag = `"sha256-${artifact.sha256}"`;

  const response = await app.fetch(
    new Request(
      "https://cominavi.net/api/v2/review-demo/catalogs/c104/v2/main.sqlite.gz",
      {
        headers: {
          Range: "bytes=2-5",
          "If-Range": etag,
        },
      },
    ),
    { COMINAVI_CATALOG_DOWNLOADS: bucket.binding } as Cloudflare.Env,
    executionContext,
  );

  assert.equal(response.status, 206, await response.clone().text());
  assert.equal(await response.text(), "view");
  assert.equal(response.headers.get("Accept-Ranges"), "bytes");
  assert.equal(
    response.headers.get("Content-Range"),
    `bytes 2-5/${artifact.byteCount}`,
  );
  assert.equal(response.headers.get("Content-Length"), "4");
  assert.equal(response.headers.get("ETag"), etag);
  assert.equal(response.headers.get("Content-Type"), "application/gzip");
  assert.equal(
    response.headers.get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
  assert.deepEqual(bucket.requests, [
    {
      key: artifact.objectKey,
      range: { offset: 2, length: 4 },
    },
  ]);
});

test("public review demo route supports HEAD and rejects unknown files", async () => {
  const bucket = new ReviewDemoBucket();
  const app = createHomepageApp(() => new Response("astro"));

  const head = await app.fetch(
    new Request(
      "https://cominavi.net/api/v2/review-demo/catalogs/c104/v2/images.sqlite.gz",
      { method: "HEAD" },
    ),
    { COMINAVI_CATALOG_DOWNLOADS: bucket.binding } as Cloudflare.Env,
    executionContext,
  );
  assert.equal(head.status, 200);
  assert.equal(
    head.headers.get("Content-Length"),
    String(reviewDemoCatalogArtifacts.images.byteCount),
  );
  assert.deepEqual(bucket.heads, [reviewDemoCatalogArtifacts.images.objectKey]);

  const missing = await app.fetch(
    new Request(
      "https://cominavi.net/api/v2/review-demo/catalogs/c104/v2/private.sqlite.gz",
    ),
    { COMINAVI_CATALOG_DOWNLOADS: bucket.binding } as Cloudflare.Env,
    executionContext,
  );
  assert.equal(missing.status, 404);
  assert.equal(bucket.requests.length, 0);
});

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
  exports: {},
  tracing: {},
} as unknown as ExecutionContext;

class ReviewDemoBucket {
  readonly requests: Array<{
    key: string;
    range: { offset: number; length: number } | undefined;
  }> = [];
  readonly heads: string[] = [];
  readonly binding: R2Bucket;

  constructor() {
    this.binding = {
      get: async (
        key: string,
        options?: { range?: { offset: number; length: number } },
      ) => {
        const database = databaseForKey(key);
        this.requests.push({ key, range: options?.range });
        const bytes = new TextEncoder().encode("review-demo");
        const body = options?.range
          ? bytes.slice(
              options.range.offset,
              options.range.offset + options.range.length,
            )
          : bytes;
        return objectBody(reviewDemoCatalogArtifacts[database].byteCount, body);
      },
      head: async (key: string) => {
        const database = databaseForKey(key);
        this.heads.push(key);
        return objectBody(
          reviewDemoCatalogArtifacts[database].byteCount,
          new Uint8Array(),
        );
      },
    } as unknown as R2Bucket;
  }
}

function databaseForKey(key: string): ReviewDemoCatalogDatabase {
  if (key === reviewDemoCatalogArtifacts.main.objectKey) return "main";
  if (key === reviewDemoCatalogArtifacts.images.objectKey) return "images";
  throw new Error(`unexpected R2 key: ${key}`);
}

function objectBody(size: number, body: Uint8Array): R2ObjectBody {
  return {
    key: "fixture",
    size,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
  } as unknown as R2ObjectBody;
}
