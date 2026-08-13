import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createHomepageApp } from "../src/api/app";
import { generateOpenAPIDocument } from "../src/api/openapi";
import { authenticateCrawlerRequest } from "../src/lib/server/crawler-ingest";
import {
  calculateTagOverlayRevision,
  canonicalTagOverlaySemanticJSON,
  maximumTagOverlayPublicationBytes,
  parseTagOverlayPublication,
  publishTagOverlay,
  type CircleTagOverlay,
} from "../src/lib/server/tag-overlays";
import { processPendingCircleTagOverlayCleanup } from "../src/lib/server/tag-overlay-cleanup";
import { SQLiteD1Database } from "./sqlite-d1";

const crawlerSecret = "tag-overlay-crawler-secret-at-least-32-bytes";
const catalogPayloadSHA256 = "8ba603".padEnd(64, "0");
const catalogVersionID = "c108-catalog-fixture-v1";
const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
  exports: {},
  tracing: {},
} as unknown as ExecutionContext;

test("tag publication raises the crawler body bound to exactly 16 MiB", async () => {
  assert.equal(maximumTagOverlayPublicationBytes, 16 * 1024 * 1024);
  const body = JSON.stringify({ padding: "x".repeat(1_000_000) });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const idempotencyKey = "tag-overlay:size-bound-fixture";
  const signature = createHmac("sha256", crawlerSecret)
    .update(`${timestamp}.${idempotencyKey}.`)
    .update(body)
    .digest("hex");
  const request = () =>
    new Request("https://cominavi.net/api/v2/internal/crawler/tag-overlays", {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "X-ComiNavi-Timestamp": timestamp,
        "X-ComiNavi-Signature": `v1=${signature}`,
      },
      body,
    });
  await assert.rejects(
    () => authenticateCrawlerRequest(request(), crawlerSecret),
    (error: unknown) => hasCode(error, "invalid_crawler_payload"),
  );
  const authenticated = await authenticateCrawlerRequest(
    request(),
    crawlerSecret,
    Date.now(),
    maximumTagOverlayPublicationBytes,
  );
  assert.equal(
    authenticated.rawBody.byteLength,
    new TextEncoder().encode(body).byteLength,
  );
});

test("one complete 22,854-circle overlay fits the bounded publication contract", async () => {
  const overlay: CircleTagOverlay = {
    schemaVersion: 1,
    revision: "0".repeat(64),
    catalogPayloadSHA256,
    taxonomyRevision: "cominavi-c108-v1",
    matchingPolicyRevision: "keyword-evidence-v1",
    evaluatedCircleCount: 22_854,
    taggedCircleCount: 22_854,
    terms: [{ id: "content.r18", label: "R-18", kind: "content" }],
    circles: Array.from({ length: 22_854 }, (_, index) => ({
      wcID: index + 1,
      tagIDs: ["content.r18"],
    })),
  };
  overlay.revision = await calculateTagOverlayRevision(overlay);
  const body = bytes(publicationRequest(overlay, "none"));
  assert.ok(body.byteLength < maximumTagOverlayPublicationBytes);
  assert.deepEqual(await parseTagOverlayPublication(body), {
    eventNumber: 108,
    baseRevision: "none",
    overlay,
  });
});

test("canonical overlay hashing excludes only revision and retains honest labels", async () => {
  const overlay = await fixtureOverlay();
  assert.equal(overlay.revision, await calculateTagOverlayRevision(overlay));
  assert.deepEqual(
    overlay.terms.map((term) => term.label),
    ["初音ミク", "BL", "R-18", "百合", "アークナイツ"],
  );

  const changedRevisionOnly = { ...overlay, revision: "f".repeat(64) };
  assert.equal(
    canonicalTagOverlaySemanticJSON(changedRevisionOnly),
    canonicalTagOverlaySemanticJSON(overlay),
  );
  const changedLabel = structuredClone(overlay);
  changedLabel.terms[2].label = "R18";
  assert.notEqual(
    await calculateTagOverlayRevision(changedLabel),
    overlay.revision,
  );
});

test("overlay validation enforces canonical order, references, counts, and usable labels", async () => {
  const overlay = await fixtureOverlay();
  await assert.rejects(
    () =>
      parseTagOverlayPublication(
        bytes({
          eventNumber: 108,
          baseRevision: "none",
          overlay: {
            ...overlay,
            terms: overlay.terms.toReversed(),
          },
        }),
      ),
    (error: unknown) => hasCode(error, "invalid_tag_overlay"),
  );
  await assert.rejects(
    () =>
      parseTagOverlayPublication(
        bytes({
          eventNumber: 108,
          baseRevision: "none",
          overlay: {
            ...overlay,
            circles: [{ wcID: 1, tagIDs: ["missing.term"] }],
            taggedCircleCount: 1,
          },
        }),
      ),
    (error: unknown) => hasCode(error, "invalid_tag_overlay"),
  );
  await assert.rejects(
    () =>
      parseTagOverlayPublication(
        bytes({
          eventNumber: 108,
          baseRevision: "none",
          overlay: {
            ...overlay,
            terms: overlay.terms.map((term, index) =>
              index === 0 ? { ...term, label: " \n " } : term,
            ),
          },
        }),
      ),
    (error: unknown) => hasCode(error, "invalid_tag_overlay"),
  );
});

test("publication writes immutable R2 first, activates with CAS, and recovers exact receipts", async () => {
  const database = setup();
  seedActiveCatalog(database);
  const bucket = new MemoryBucket();
  const overlay = await fixtureOverlay();
  const request = publicationRequest(overlay, "none");

  const first = await publishTagOverlay(
    database.binding,
    bucket.binding,
    authenticated(request, `tag-overlay:108:${overlay.revision}`),
    Date.parse("2026-08-13T00:00:00Z"),
  );
  assert.deepEqual(first, {
    eventNumber: 108,
    revision: overlay.revision,
    activeRevision: overlay.revision,
    active: true,
    publishedAt: "2026-08-13T00:00:00.000Z",
    duplicate: false,
  });
  assert.equal(bucket.putCount, 1);
  assert.deepEqual(
    database.rows(
      `SELECT event_number, revision, catalog_version_id,
              catalog_payload_sha256, tagged_circle_count, term_count
       FROM circle_tag_overlay_versions`,
    ),
    [
      {
        event_number: 108,
        revision: overlay.revision,
        catalog_version_id: catalogVersionID,
        catalog_payload_sha256: catalogPayloadSHA256,
        tagged_circle_count: 2,
        term_count: 5,
      },
    ],
  );
  assert.deepEqual(
    database.rows(
      "SELECT event_number, revision FROM circle_tag_overlay_heads",
    ),
    [{ event_number: 108, revision: overlay.revision }],
  );
  assert.deepEqual(
    database.rows("SELECT * FROM circle_tag_overlay_object_cleanup"),
    [],
    "the activation batch must consume the prewrite cleanup intent",
  );

  bucket.objects.clear();
  const replay = await publishTagOverlay(
    database.binding,
    bucket.binding,
    authenticated(request, `tag-overlay:108:${overlay.revision}`),
    Date.parse("2026-08-14T00:00:00Z"),
  );
  assert.deepEqual(replay, { ...first, duplicate: true });
  assert.equal(
    bucket.putCount,
    2,
    "receipt replay must repair a missing R2 object",
  );
  assert.equal(bucket.objects.size, 1);
  assert.deepEqual(
    database.rows("SELECT * FROM circle_tag_overlay_object_cleanup"),
    [],
  );

  const repairedObject = [...bucket.objects.values()][0];
  assert.ok(repairedObject);
  repairedObject.customMetadata.sha256 = "0".repeat(64);
  await assert.rejects(
    () =>
      publishTagOverlay(
        database.binding,
        bucket.binding,
        authenticated(request, `tag-overlay:108:${overlay.revision}`),
      ),
    (error: unknown) => hasCode(error, "tag_overlay_unavailable"),
  );
  repairedObject.customMetadata.sha256 = createHash("sha256")
    .update(repairedObject.bytes)
    .digest("hex");

  const replacement = await fixtureOverlay({
    matchingPolicyRevision: "policy-v2",
  });
  await assert.rejects(
    () =>
      publishTagOverlay(
        database.binding,
        bucket.binding,
        authenticated(
          publicationRequest(replacement, overlay.revision),
          `tag-overlay:108:${overlay.revision}`,
        ),
      ),
    (error: unknown) => hasCode(error, "idempotency_conflict"),
  );
  await assert.rejects(
    () =>
      publishTagOverlay(
        database.binding,
        bucket.binding,
        authenticated(
          publicationRequest(replacement, "none"),
          `tag-overlay:108:${replacement.revision}`,
        ),
      ),
    (error: unknown) =>
      hasCode(error, "tag_overlay_revision_conflict") &&
      hasDetail(error, "activeRevision", overlay.revision),
  );
});

test("publication rejects missing or mismatched active catalogs before writing R2", async () => {
  const overlay = await fixtureOverlay();
  for (const seed of ["none", "mismatch"] as const) {
    const database = setup();
    if (seed === "mismatch") seedActiveCatalog(database, "9".repeat(64));
    const bucket = new MemoryBucket();
    const request = publicationRequest(overlay, "none");
    await assert.rejects(
      () =>
        publishTagOverlay(
          database.binding,
          bucket.binding,
          authenticated(request, `tag-overlay:108:${overlay.revision}`),
        ),
      (error: unknown) => hasCode(error, "tag_overlay_catalog_mismatch"),
      seed,
    );
    assert.equal(bucket.putCount, 0);
    assert.deepEqual(
      database.rows("SELECT * FROM circle_tag_overlay_heads"),
      [],
    );
  }
});

test("publication binds claimed coverage and every tagged WCID to the active catalog", async () => {
  const database = setup();
  seedActiveCatalog(database);
  const bucket = new MemoryBucket();
  const wrongCount = await fixtureOverlay({ evaluatedCircleCount: 3 });
  await assert.rejects(
    () =>
      publishTagOverlay(
        database.binding,
        bucket.binding,
        authenticated(
          publicationRequest(wrongCount, "none"),
          `tag-overlay:count:${wrongCount.revision}`,
        ),
      ),
    (error: unknown) => hasCode(error, "invalid_tag_overlay"),
  );

  const unknownCircle = await fixtureOverlay({
    circles: [
      { wcID: 101, tagIDs: ["content.r18", "work.arknights"] },
      {
        wcID: 999_999,
        tagIDs: ["character.hatsune_miku", "content.bl", "theme.yuri"],
      },
    ],
  });
  await assert.rejects(
    () =>
      publishTagOverlay(
        database.binding,
        bucket.binding,
        authenticated(
          publicationRequest(unknownCircle, "none"),
          `tag-overlay:wcid:${unknownCircle.revision}`,
        ),
      ),
    (error: unknown) => hasCode(error, "invalid_tag_overlay"),
  );
  assert.equal(bucket.putCount, 0);
});

test("catalog authority is rechecked atomically after the R2 write", async () => {
  const database = setup();
  seedActiveCatalog(database);
  const bucket = new MemoryBucket();
  const overlay = await fixtureOverlay();
  const publishedAt = Date.parse("2026-08-13T00:00:00Z");
  database.beforeNextBatch = () => {
    database.native.exec(`
      INSERT INTO catalog_versions (
        id, comiket_no, schema_version, state, claim_id,
        source_main_sha256, source_image_sha256, created_at, published_at
      ) VALUES (
        'c108-raced-v2', 108, 1, 'published', 'raced-claim',
        '${"7".repeat(64)}', '${"d".repeat(64)}', 2, 2
      );
      UPDATE catalog_versions SET state = 'superseded'
      WHERE id = '${catalogVersionID}';
      UPDATE catalog_events SET active_version_id = 'c108-raced-v2'
      WHERE comiket_no = 108;
    `);
  };
  await assert.rejects(
    () =>
      publishTagOverlay(
        database.binding,
        bucket.binding,
        authenticated(
          publicationRequest(overlay, "none"),
          `tag-overlay:108:${overlay.revision}`,
        ),
        publishedAt,
      ),
    (error: unknown) => hasCode(error, "tag_overlay_catalog_mismatch"),
  );
  assert.equal(bucket.putCount, 1, "R2 must precede the D1 activation attempt");
  assert.deepEqual(database.rows("SELECT * FROM circle_tag_overlay_heads"), []);
  assert.deepEqual(
    database.rows("SELECT * FROM circle_tag_overlay_publication_receipts"),
    [],
  );
  assert.equal(
    database.rows("SELECT * FROM circle_tag_overlay_object_cleanup").length,
    1,
  );
  assert.equal(
    await processPendingCircleTagOverlayCleanup(
      database.binding,
      bucket.binding,
      publishedAt + 600_000,
    ),
    1,
  );
  assert.equal(bucket.objects.size, 0);
});

test("an image-only catalog rotation keeps an identical main-bound overlay usable", async () => {
  const database = setup();
  seedActiveCatalog(database);
  const bucket = new MemoryBucket();
  const overlay = await fixtureOverlay();
  await publishTagOverlay(
    database.binding,
    bucket.binding,
    authenticated(
      publicationRequest(overlay, "none"),
      `tag-overlay:image-rotation:${overlay.revision}`,
    ),
  );
  database.native.exec(`
    INSERT INTO catalog_versions (
      id, comiket_no, schema_version, state, claim_id,
      source_main_sha256, source_image_sha256, circle_count,
      created_at, published_at
    ) VALUES (
      'c108-image-only-v2', 108, 1, 'published', 'image-only-claim',
      '${catalogPayloadSHA256}', '${"d".repeat(64)}', 2, 2, 2
    );
    INSERT INTO catalog_dates (
      version_id, day, date_iso, weekday
    ) VALUES ('c108-image-only-v2', 1, '2026-08-15', 6);
    INSERT INTO catalog_circles (
      version_id, comiket_no, wc_id, day, name, kana, pen_name,
      book_name, description
    ) VALUES
      ('c108-image-only-v2', 108, 101, 1, 'Circle 101', '', '', '', ''),
      ('c108-image-only-v2', 108, 202, 1, 'Circle 202', '', '', '', '');
    UPDATE catalog_versions SET state = 'superseded'
    WHERE id = '${catalogVersionID}';
    UPDATE catalog_events SET active_version_id = 'c108-image-only-v2'
    WHERE comiket_no = 108;
  `);

  const app = createHomepageApp(() => new Response("astro"));
  const url = "https://cominavi.net/api/v2/events/108/updates";
  database.native.exec("DROP TABLE catalog_circles;");
  const unknownAfterRotation = await app.fetch(
    new Request(`${url}?tagRevision=${"e".repeat(64)}`),
    environment(database, bucket),
    executionContext,
  );
  assert.equal(
    (await unknownAfterRotation.json<{ tagOverlayStatus: string }>())
      .tagOverlayStatus,
    "invalidated",
  );
  assert.equal(
    unknownAfterRotation.headers.get("Cache-Control"),
    "private, no-store",
  );
  seedCatalogCirclesTable(database);
  const unchanged = await app.fetch(
    new Request(`${url}?tagRevision=${overlay.revision}`),
    environment(database, bucket),
    executionContext,
  );
  assert.equal(
    (await unchanged.json<{ tagOverlayStatus: string }>()).tagOverlayStatus,
    "current",
  );
  const requested = await app.fetch(
    new Request(`${url}?tagRevision=none`),
    environment(database, bucket),
    executionContext,
  );
  assert.equal(
    (await requested.json<{ tagOverlay: CircleTagOverlay }>()).tagOverlay
      .revision,
    overlay.revision,
  );

  database.native.exec(`
    DELETE FROM catalog_circles
    WHERE version_id = 'c108-image-only-v2' AND wc_id = 202;
    INSERT INTO catalog_circles (
      version_id, comiket_no, wc_id, day, name, kana, pen_name,
      book_name, description
    ) VALUES (
      'c108-image-only-v2', 108, 303, 1, 'Circle 303', '', '', '', ''
    );
  `);
  const changedCircleSet = await app.fetch(
    new Request(`${url}?tagRevision=${overlay.revision}`),
    environment(database, bucket),
    executionContext,
  );
  assert.equal(
    (await changedCircleSet.json<{ tagOverlayStatus: string }>())
      .tagOverlayStatus,
    "invalidated",
  );
  assert.equal(
    changedCircleSet.headers.get("Cache-Control"),
    "private, no-store",
  );
});

test("updates API preserves legacy bodies and conditionally serves a verified overlay", async () => {
  const database = setup();
  seedActiveCatalog(database);
  const bucket = new MemoryBucket();
  const app = createHomepageApp(() => new Response("astro"));
  const env = environment(database, bucket);
  const legacyURL = "https://cominavi.net/api/v2/events/108/updates";
  const legacyBefore = await app.fetch(
    new Request(legacyURL),
    env,
    executionContext,
  );
  const legacyBody = await legacyBefore.text();
  assert.equal(legacyBody, '{"eventNumber":108,"hasMore":false,"updates":[]}');

  const absent = await app.fetch(
    new Request(`${legacyURL}?tagRevision=none`),
    env,
    executionContext,
  );
  assert.deepEqual(await absent.json(), {
    eventNumber: 108,
    hasMore: false,
    updates: [],
    tagOverlayStatus: "absent",
  });

  const getsBeforeAbsentUnknownRevision = bucket.getCount;
  const unknownBeforePublication = await app.fetch(
    new Request(`${legacyURL}?tagRevision=${"e".repeat(64)}`),
    env,
    executionContext,
  );
  assert.equal(
    (await unknownBeforePublication.json<{ tagOverlayStatus: string }>())
      .tagOverlayStatus,
    "invalidated",
  );
  assert.equal(bucket.getCount, getsBeforeAbsentUnknownRevision);
  assert.equal(
    unknownBeforePublication.headers.get("Cache-Control"),
    "private, no-store",
  );
  assert.equal(
    unknownBeforePublication.headers.get("Access-Control-Allow-Origin"),
    "*",
  );

  const overlay = await fixtureOverlay();
  const request = publicationRequest(overlay, "none");
  const idempotencyKey = `tag-overlay:108:${overlay.revision}`;
  const accepted = await app.fetch(
    signedPublicationRequest(request, idempotencyKey),
    env,
    executionContext,
  );
  assert.equal(accepted.status, 202, await accepted.clone().text());
  assert.equal(
    (await accepted.json<{ duplicate: boolean }>()).duplicate,
    false,
  );

  const replay = await app.fetch(
    signedPublicationRequest(request, idempotencyKey),
    env,
    executionContext,
  );
  assert.equal(replay.status, 200);
  assert.equal((await replay.json<{ duplicate: boolean }>()).duplicate, true);

  const legacyAfter = await app.fetch(
    new Request(legacyURL),
    env,
    executionContext,
  );
  assert.equal(await legacyAfter.text(), legacyBody);
  assert.equal(
    legacyAfter.headers.get("ETag"),
    legacyBefore.headers.get("ETag"),
  );

  const withOverlay = await app.fetch(
    new Request(`${legacyURL}?tagRevision=none`),
    env,
    executionContext,
  );
  assert.equal(withOverlay.status, 200, await withOverlay.clone().text());
  const overlayBody = await withOverlay.json<{
    updates: unknown[];
    tagOverlayStatus: string;
    tagOverlay: CircleTagOverlay;
  }>();
  assert.deepEqual(overlayBody.updates, []);
  assert.equal(overlayBody.tagOverlayStatus, "current");
  assert.deepEqual(overlayBody.tagOverlay, overlay);
  assert.notEqual(
    withOverlay.headers.get("ETag"),
    legacyAfter.headers.get("ETag"),
  );

  const current = await app.fetch(
    new Request(`${legacyURL}?tagRevision=${overlay.revision}`),
    env,
    executionContext,
  );
  assert.deepEqual(await current.json(), {
    eventNumber: 108,
    hasMore: false,
    updates: [],
    tagOverlayStatus: "current",
  });

  const page = await app.fetch(
    new Request(`${legacyURL}?afterCursor=0&tagRevision=none`),
    env,
    executionContext,
  );
  assert.equal(page.status, 200, await page.clone().text());
  assert.equal(
    (await page.json<{ tagOverlay: CircleTagOverlay }>()).tagOverlay.revision,
    overlay.revision,
  );

  const getsBeforeUnknownRevision = bucket.getCount;
  const unknownRevision = await app.fetch(
    new Request(`${legacyURL}?tagRevision=${"f".repeat(64)}`),
    env,
    executionContext,
  );
  assert.equal(
    (await unknownRevision.json<{ tagOverlayStatus: string }>())
      .tagOverlayStatus,
    "invalidated",
  );
  assert.equal(bucket.getCount, getsBeforeUnknownRevision);
  assert.equal(
    unknownRevision.headers.get("Cache-Control"),
    "private, no-store",
  );
  assert.equal(unknownRevision.headers.get("Access-Control-Allow-Origin"), "*");

  seedRealtimeUpdate(database);

  for (const query of [
    `tagRevision=none&afterCursor=0`,
    `tagRevision=${overlay.revision.toUpperCase()}`,
    `tagRevision=none&tagRevision=none`,
    `afterCursor=00&tagRevision=none`,
  ]) {
    const rejected = await app.fetch(
      new Request(`${legacyURL}?${query}`),
      env,
      executionContext,
    );
    assert.equal(rejected.status, 400, query);
    assert.equal(rejected.headers.get("Cache-Control"), "private, no-store");
    assert.equal(
      rejected.headers.get("Cloudflare-CDN-Cache-Control"),
      "no-store",
    );
  }

  const [objectKey, storedObject] = [...bucket.objects.entries()][0];
  assert.ok(objectKey && storedObject);
  const originalMetadata = { ...storedObject.customMetadata };
  storedObject.customMetadata.sha256 = "0".repeat(64);
  const mismatchedMetadata = await app.fetch(
    new Request(`${legacyURL}?tagRevision=none`),
    env,
    executionContext,
  );
  assert.equal(mismatchedMetadata.status, 200);
  assert.equal(
    (
      await mismatchedMetadata.json<{
        tagOverlayStatus: string;
        updates: unknown[];
      }>()
    ).tagOverlayStatus,
    "unavailable",
  );
  const realtimeWhileOverlayUnavailable = await app.fetch(
    new Request(`${legacyURL}?tagRevision=none`),
    env,
    executionContext,
  );
  assert.equal(
    (await realtimeWhileOverlayUnavailable.json<{ updates: unknown[] }>())
      .updates.length,
    1,
  );
  assert.equal(
    mismatchedMetadata.headers.get("Cache-Control"),
    "private, no-store",
  );
  assert.equal(
    mismatchedMetadata.headers.get("Access-Control-Allow-Origin"),
    "*",
  );
  storedObject.customMetadata = originalMetadata;

  const originalBytes = Uint8Array.from(storedObject.bytes);
  storedObject.bytes[storedObject.bytes.length - 1] ^= 1;
  const mismatchedBody = await app.fetch(
    new Request(`${legacyURL}?tagRevision=none`),
    env,
    executionContext,
  );
  assert.equal(mismatchedBody.status, 200);
  assert.equal(
    (await mismatchedBody.json<{ tagOverlayStatus: string }>())
      .tagOverlayStatus,
    "unavailable",
  );
  storedObject.bytes = originalBytes;

  database.native.exec(`
    INSERT INTO catalog_versions (
      id, comiket_no, schema_version, state, claim_id,
      source_main_sha256, source_image_sha256, created_at, published_at
    ) VALUES (
      'c108-catalog-fixture-v2', 108, 1, 'published', 'fixture-claim-v2',
      '${"9".repeat(64)}', '${"c".repeat(64)}', 2, 2
    );
    UPDATE catalog_versions SET state = 'superseded'
    WHERE id = '${catalogVersionID}';
    UPDATE catalog_events SET active_version_id = 'c108-catalog-fixture-v2'
    WHERE comiket_no = 108;
  `);
  const mismatchedCatalog = await app.fetch(
    new Request(`${legacyURL}?tagRevision=none`),
    env,
    executionContext,
  );
  assert.equal(mismatchedCatalog.status, 200);
  assert.equal(
    (await mismatchedCatalog.json<{ tagOverlayStatus: string }>())
      .tagOverlayStatus,
    "invalidated",
  );
  database.native.exec(`
    UPDATE catalog_versions SET state = 'superseded'
    WHERE id = 'c108-catalog-fixture-v2';
    UPDATE catalog_versions SET state = 'published'
    WHERE id = '${catalogVersionID}';
    UPDATE catalog_events SET active_version_id = '${catalogVersionID}'
    WHERE comiket_no = 108;
  `);

  bucket.objects.clear();
  const missing = await app.fetch(
    new Request(`${legacyURL}?tagRevision=none`),
    env,
    executionContext,
  );
  assert.equal(missing.status, 200);
  assert.equal(
    (await missing.json<{ tagOverlayStatus: string }>()).tagOverlayStatus,
    "unavailable",
  );
  assert.equal(missing.headers.get("Cache-Control"), "private, no-store");
});

test("crawler publication OpenAPI documents HMAC, conditional updates, and receipt statuses", async () => {
  const document = await generateOpenAPIDocument();
  const publication =
    document.paths?.["/api/v2/internal/crawler/tag-overlays"]?.post;
  assert.equal(publication?.operationId, "publishCrawlerTagOverlay");
  assert.deepEqual(publication?.security, [
    {
      crawlerSignature: [],
      crawlerTimestamp: [],
      crawlerIdempotencyKey: [],
    },
  ]);
  assert.equal(
    publication?.responses?.["202"]?.description,
    "The tag overlay was activated for the first time.",
  );
  assert.equal(
    publication?.responses?.["200"]?.description,
    "The exact tag overlay publication was replayed.",
  );

  const updates = document.paths?.["/api/v2/events/{eventNumber}/updates"]?.get;
  assert.deepEqual(
    (updates?.parameters ?? []).map((parameter) =>
      "name" in parameter ? parameter.name : undefined,
    ),
    ["eventNumber", "afterCursor", "tagRevision"],
  );
  assert.match(JSON.stringify(updates), /tagOverlay/);
});

async function fixtureOverlay(
  override: Partial<CircleTagOverlay> = {},
): Promise<CircleTagOverlay> {
  const overlay: CircleTagOverlay = {
    schemaVersion: 1,
    revision: "0".repeat(64),
    catalogPayloadSHA256,
    taxonomyRevision: "cominavi-c108-v1",
    matchingPolicyRevision: "keyword-evidence-v1",
    evaluatedCircleCount: 2,
    taggedCircleCount: 2,
    terms: [
      { id: "character.hatsune_miku", label: "初音ミク", kind: "character" },
      { id: "content.bl", label: "BL", kind: "content" },
      { id: "content.r18", label: "R-18", kind: "content" },
      { id: "theme.yuri", label: "百合", kind: "theme" },
      { id: "work.arknights", label: "アークナイツ", kind: "work" },
    ],
    circles: [
      {
        wcID: 101,
        tagIDs: ["content.r18", "work.arknights"],
      },
      {
        wcID: 202,
        tagIDs: ["character.hatsune_miku", "content.bl", "theme.yuri"],
      },
    ],
    ...override,
  };
  overlay.revision = await calculateTagOverlayRevision(overlay);
  return overlay;
}

function publicationRequest(overlay: CircleTagOverlay, baseRevision: string) {
  return { eventNumber: 108, baseRevision, overlay };
}

function authenticated(
  request: ReturnType<typeof publicationRequest>,
  idempotencyKey: string,
) {
  const rawBody = bytes(request);
  return {
    idempotencyKey,
    rawBody,
    payloadSHA256: createHash("sha256").update(rawBody).digest("hex"),
  };
}

function signedPublicationRequest(
  request: ReturnType<typeof publicationRequest>,
  idempotencyKey: string,
): Request {
  const body = JSON.stringify(request);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac("sha256", crawlerSecret)
    .update(`${timestamp}.${idempotencyKey}.`)
    .update(body)
    .digest("hex");
  return new Request(
    "https://cominavi.net/api/v2/internal/crawler/tag-overlays",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "X-ComiNavi-Timestamp": timestamp,
        "X-ComiNavi-Signature": `v1=${signature}`,
      },
      body,
    },
  );
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
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
      "migrations/0008_circle_tag_overlays.sql",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  );
}

function seedActiveCatalog(
  database: SQLiteD1Database,
  sourceMainSHA256 = catalogPayloadSHA256,
): void {
  database.native.exec(`
    INSERT INTO catalog_events (
      comiket_no, name, created_at, updated_at
    ) VALUES (108, 'Comic Market 108', 1, 1);
    INSERT INTO catalog_versions (
      id, comiket_no, schema_version, state, claim_id,
      source_main_sha256, source_image_sha256, circle_count,
      created_at, published_at
    ) VALUES (
      '${catalogVersionID}', 108, 1, 'published', 'fixture-claim',
      '${sourceMainSHA256}', '${"b".repeat(64)}', 2, 1, 1
    );
    INSERT INTO catalog_dates (
      version_id, day, date_iso, weekday
    ) VALUES ('${catalogVersionID}', 1, '2026-08-15', 6);
    INSERT INTO catalog_circles (
      version_id, comiket_no, wc_id, day, name, kana, pen_name,
      book_name, description
    ) VALUES
      ('${catalogVersionID}', 108, 101, 1, 'Circle 101', '', '', '', ''),
      ('${catalogVersionID}', 108, 202, 1, 'Circle 202', '', '', '', '');
    UPDATE catalog_events SET active_version_id = '${catalogVersionID}'
    WHERE comiket_no = 108;
  `);
}

function seedCatalogCirclesTable(database: SQLiteD1Database): void {
  database.native.exec(`
    CREATE TABLE catalog_circles (
      version_id TEXT NOT NULL,
      comiket_no INTEGER NOT NULL,
      wc_id INTEGER NOT NULL,
      day INTEGER NOT NULL,
      block_id INTEGER,
      space_no INTEGER,
      space_no_sub INTEGER,
      genre_id INTEGER,
      name TEXT NOT NULL,
      kana TEXT NOT NULL,
      pen_name TEXT NOT NULL,
      book_name TEXT NOT NULL,
      website_url TEXT,
      description TEXT NOT NULL,
      twitter_url TEXT,
      pixiv_url TEXT,
      update_id INTEGER,
      PRIMARY KEY (version_id, wc_id),
      FOREIGN KEY (version_id) REFERENCES catalog_versions(id) ON DELETE CASCADE
    );
    INSERT INTO catalog_circles (
      version_id, comiket_no, wc_id, day, name, kana, pen_name,
      book_name, description
    ) VALUES
      ('${catalogVersionID}', 108, 101, 1, 'Circle 101', '', '', '', ''),
      ('${catalogVersionID}', 108, 202, 1, 'Circle 202', '', '', '', ''),
      ('c108-image-only-v2', 108, 101, 1, 'Circle 101', '', '', '', ''),
      ('c108-image-only-v2', 108, 202, 1, 'Circle 202', '', '', '', '');
  `);
}

function seedRealtimeUpdate(database: SQLiteD1Database): void {
  database.native.exec(`
    INSERT INTO circles (
      comiket_no, wc_id, circle_name, day, area_name, block_name,
      space_no, space_no_sub, location, created_at, updated_at
    ) VALUES (
      108, 101, 'Circle 101', 1, 'East', 'A', 1, 1, '東A-01a',
      1700000000, 1700000000
    );
    INSERT INTO ingest_batches (
      id, source, idempotency_key, payload_sha256, schema_version,
      observed_at, received_at, raw_payload_json
    ) VALUES (
      1, 'fixture', 'tag-overlay-update', '${"a".repeat(64)}', 1,
      1700000000, 1700000000, '{}'
    );
    INSERT INTO social_posts (
      post_id, author_handle, text, occurred_at, latest_observed_at,
      raw_post_json
    ) VALUES (
      'tag-post-1', 'circle_101', 'Realtime update', 1700000000,
      1700000000, '{}'
    );
    INSERT INTO circle_update_events (
      id, event_key, ingest_batch_id, source, source_revision, post_id,
      update_kind, state_kind, state_value, confidence, occurred_at,
      evidence_json, created_at
    ) VALUES (
      1, 'tag-event-1', 1, 'fixture', 1, 'tag-post-1',
      'presence_present', 'presence', 'present', 'high', 1700000000,
      '{}', 1700000000
    );
    INSERT INTO circle_update_targets (update_event_id, comiket_no, wc_id)
    VALUES (1, 108, 101);
  `);
}

function environment(
  database: SQLiteD1Database,
  bucket: MemoryBucket,
): Cloudflare.Env {
  return {
    COMINAVI_DB: database.binding,
    COMINAVI_CATALOGS: bucket.binding,
    COMINAVI_CRAWLER_WEBHOOK_SECRET: crawlerSecret,
  } as unknown as Cloudflare.Env;
}

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
  customMetadata: Record<string, string>;
}

class MemoryBucket {
  readonly objects = new Map<string, StoredObject>();
  putCount = 0;
  getCount = 0;
  deleteCount = 0;
  readonly binding = {
    get: async (key: string) => {
      this.getCount += 1;
      const stored = this.objects.get(key);
      return stored ? objectBody(key, stored) : null;
    },
    head: async (key: string) => {
      const stored = this.objects.get(key);
      return stored ? objectBody(key, stored) : null;
    },
    put: async (
      key: string,
      value: Uint8Array,
      options: {
        httpMetadata?: { contentType?: string };
        customMetadata?: Record<string, string>;
      },
    ) => {
      this.putCount += 1;
      this.objects.set(key, {
        bytes: Uint8Array.from(value),
        contentType: options.httpMetadata?.contentType ?? "",
        customMetadata: { ...options.customMetadata },
      });
      return objectBody(key, this.objects.get(key)!);
    },
    delete: async (key: string) => {
      this.deleteCount += 1;
      this.objects.delete(key);
    },
  } as unknown as R2Bucket;
}

function objectBody(key: string, stored: StoredObject): R2ObjectBody {
  return {
    key,
    size: stored.bytes.byteLength,
    etag: "fixture",
    httpEtag: '"fixture"',
    uploaded: new Date(0),
    version: "fixture",
    checksums: {},
    httpMetadata: { contentType: stored.contentType },
    customMetadata: { ...stored.customMetadata },
    range: undefined,
    body: new ReadableStream(),
    bodyUsed: false,
    arrayBuffer: async () => Uint8Array.from(stored.bytes).buffer,
    text: async () => new TextDecoder().decode(stored.bytes),
    json: async () => JSON.parse(new TextDecoder().decode(stored.bytes)),
    blob: async () => new Blob([Uint8Array.from(stored.bytes)]),
    writeHttpMetadata() {},
  } as unknown as R2ObjectBody;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function hasDetail(error: unknown, key: string, value: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("details" in error) ||
    typeof error.details !== "object" ||
    error.details === null
  ) {
    return false;
  }
  const details = error.details as Record<string, unknown>;
  return details[key] === value;
}
