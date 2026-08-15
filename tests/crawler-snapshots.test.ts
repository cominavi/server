import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createHomepageApp } from "../src/api/app";
import {
  calculateCrawlerSnapshotRevision,
  loadActiveCrawlerSnapshot,
  publishCrawlerSnapshot,
  type CrawlerRealtimeSnapshot,
} from "../src/lib/server/crawler-snapshots";
import { generateOpenAPIDocument } from "../src/api/openapi";
import { SQLiteD1Database } from "./sqlite-d1";

const snapshotSecret = "snapshot-secret-is-independent-and-long-enough";
const webhookSecret = "webhook-secret-is-different-and-long-enough";
const catalogSourceBytes = new TextEncoder().encode(
  "SQLite format 3\u0000fixture-source-main",
);
const catalogDigest = createHash("sha256")
  .update(catalogSourceBytes)
  .digest("hex");
const catalogSourceKey = "catalogs/c108/c108-v1/source-main.sqlite";
const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
  exports: {},
  tracing: {},
} as unknown as ExecutionContext;

test("snapshot revision matches the collector cross-language vector", async () => {
  const snapshot: CrawlerRealtimeSnapshot = {
    schemaVersion: 1,
    source: "cominavi-collector",
    eventNumber: 108,
    revision: "0".repeat(64),
    generation: 1,
    catalogPayloadSHA256: "a".repeat(64),
    matchingPolicyRevision: "c108-shinagaki-placement-v5",
    observedAt: "2026-08-13T12:00:00+00:00",
    events: [
      {
        eventKey: "snapshot:108:2084936700451807510:shinagaki:v1",
        sourceRevision: 1,
        updateKind: "shinagaki_published",
        stateKind: "shinagaki",
        stateValue: "2084936700451807510",
        confidence: "high",
        notifiable: false,
        post: {
          id: "2084936700451807510",
          url: "https://x.com/circle/status/2084936700451807510",
          text: "#C108 お品書き",
          occurredAt: "2026-08-05T09:37:00+00:00",
          author: {
            xUserID: "author",
            handle: "circle",
            name: "Circle",
            profileImageURL: "https://pbs.twimg.com/profile.jpg",
          },
          media: [
            {
              key: "b1b50a3b8f330f903c816c6e8b1d3540a0fe229e41f7e7fa89e2a8cfa3d1353b",
              type: "photo",
              role: "shinagaki",
              url: "https://pbs.twimg.com/menu.jpg",
            },
          ],
        },
        circles: [
          {
            comiketNo: 108,
            wcID: 23_000_010,
            circleID: 10,
            circleName: "Circle",
            penName: "Pen",
            day: 1,
            areaName: "西1",
            blockName: "あ",
            spaceNo: 1,
            spaceNoSub: 0,
            location: "西1 あ01a",
            catalogPayloadSHA256: "a".repeat(64),
          },
        ],
      },
    ],
  };
  assert.equal(
    await calculateCrawlerSnapshotRevision(snapshot),
    "3910756124c27b753beec9e2475c1c876c7bd47e868ba43c457cda7649a868db",
  );
});

test("snapshot publication accepts media-less attendance, mixed-case handles, and RFC3339 offsets", async () => {
  const database = setup();
  seedCatalog(database);
  const bucket = new MemoryBucket();
  const app = createHomepageApp(() => new Response("astro"));
  const publication = await fixturePublication();
  publication.snapshot.observedAt = "2026-08-15T03:00:00+00:00";
  publication.snapshot.events[0]!.post.occurredAt = "2026-08-15T03:00:00+00:00";
  publication.snapshot.events[0]!.post.author.handle = "Sent_Kurokawa";
  publication.snapshot.events[0]!.eventKey =
    "snapshot:108:2090000000000000001:attendance:v1";
  publication.snapshot.events[0]!.updateKind = "attendance_absent";
  publication.snapshot.events[0]!.stateKind = "attendance";
  publication.snapshot.events[0]!.stateValue = "absent";
  publication.snapshot.events[0]!.post.media = [];
  publication.snapshot.revision = await calculateCrawlerSnapshotRevision(
    publication.snapshot,
  );
  const body = JSON.stringify(publication);
  const idempotencyKey = "snapshot:c108:g1:fixture";
  const call = (secret: string, requestBody = body) => {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${idempotencyKey}.`)
      .update(requestBody)
      .digest("hex");
    return app.fetch(
      new Request(
        "https://cominavi.net/api/v2/internal/crawler/realtime-snapshots",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
            "X-ComiNavi-Timestamp": timestamp,
            "X-ComiNavi-Signature": `v1=${signature}`,
          },
          body: requestBody,
        },
      ),
      environment(database, bucket),
      executionContext,
    );
  };

  assert.equal((await call(webhookSecret)).status, 401);
  const accepted = await call(snapshotSecret);
  assert.equal(accepted.status, 202);
  const first = await accepted.json<Record<string, unknown>>();
  assert.equal(first.revision, publication.snapshot.revision);
  assert.equal(first.generation, 1);
  assert.equal(first.publicationCursor, 0);
  assert.equal(first.duplicate, false);
  const stored = await loadActiveCrawlerSnapshot(
    database.binding,
    bucket.binding,
    108,
    true,
  );
  assert.equal(
    stored?.events?.[0]?.post.author.handle,
    publication.snapshot.events[0]!.post.author.handle,
  );
  const reset = await app.fetch(
    new Request(
      "https://cominavi.net/api/v2/events/108/updates?afterCursor=0&publicationRevision=none",
    ),
    environment(database, bucket),
    executionContext,
  );
  assert.equal(reset.status, 200);
  const resetBody = await reset.json<{
    updates: Array<{ occurredAt: string }>;
  }>();
  assert.equal(
    resetBody.updates[0]?.occurredAt,
    publication.snapshot.events[0]!.post.occurredAt,
  );
  assert.equal((await call(snapshotSecret)).status, 200);

  const tamperedPublication = structuredClone(publication);
  tamperedPublication.snapshot.observedAt = "2026-08-15T03:00:01Z";
  tamperedPublication.snapshot.revision =
    await calculateCrawlerSnapshotRevision(tamperedPublication.snapshot);
  const tampered = JSON.stringify(tamperedPublication);
  const conflict = await call(snapshotSecret, tampered);
  assert.equal(conflict.status, 409);
  assert.equal(
    (await conflict.json<{ error: string }>()).error,
    "idempotency_conflict",
  );
});

test("empty append log snapshot does not consume the first realtime cursor", async () => {
  const database = setup();
  seedCatalog(database);
  const bucket = new MemoryBucket();
  const publication = await fixturePublication();
  const published = await publishCrawlerSnapshot(
    database.binding,
    bucket.binding,
    auth(publication, "snapshot:c108:g1:empty-watermark"),
  );
  assert.equal(published.publicationCursor, 0);

  seedFirstPostPublicationPresence(database);
  const app = createHomepageApp(() => new Response("astro"));
  const response = await app.fetch(
    new Request(
      `https://cominavi.net/api/v2/events/108/updates?afterCursor=0&publicationRevision=${published.revision}`,
    ),
    environment(database, bucket),
    executionContext,
  );
  assert.equal(response.status, 200);
  const body = await response.json<{
    resetRequired: boolean;
    updates: Array<{ cursor: number; eventKey: string }>;
  }>();
  assert.equal(body.resetRequired, false);
  assert.deepEqual(
    body.updates.map(({ cursor, eventKey }) => ({ cursor, eventKey })),
    [{ cursor: 1, eventKey: "state:presence:first-after-publication" }],
  );
});

test("snapshot watermark retains a deleted append sequence", async () => {
  const database = setup();
  seedCatalog(database);
  seedAndRetireFirstRealtimeEvent(database);
  const bucket = new MemoryBucket();
  const publication = await fixturePublication();
  const published = await publishCrawlerSnapshot(
    database.binding,
    bucket.binding,
    auth(publication, "snapshot:c108:g1:retired-watermark"),
  );
  assert.equal(published.publicationCursor, 1);

  seedFirstPostPublicationPresence(database);
  const app = createHomepageApp(() => new Response("astro"));
  const response = await app.fetch(
    new Request(
      `https://cominavi.net/api/v2/events/108/updates?afterCursor=1&publicationRevision=${published.revision}`,
    ),
    environment(database, bucket),
    executionContext,
  );
  assert.equal(response.status, 200);
  const body = await response.json<{
    resetRequired: boolean;
    updates: Array<{ cursor: number; eventKey: string }>;
  }>();
  assert.equal(body.resetRequired, false);
  assert.deepEqual(
    body.updates.map(({ cursor, eventKey }) => ({ cursor, eventKey })),
    [{ cursor: 2, eventKey: "state:presence:first-after-publication" }],
  );
});

test("reset baseline projects a multi-target state event to its current heads", async () => {
  const database = setup();
  seedCatalog(database);
  seedPartiallySupersededMultiTargetState(database);
  const bucket = new MemoryBucket();
  const publication = await fixturePublication();
  const published = await publishCrawlerSnapshot(
    database.binding,
    bucket.binding,
    auth(publication, "snapshot:c108:g1:partial-heads"),
  );

  const app = createHomepageApp(() => new Response("astro"));
  const response = await app.fetch(
    new Request(
      "https://cominavi.net/api/v2/events/108/updates?afterCursor=0&publicationRevision=none",
    ),
    environment(database, bucket),
    executionContext,
  );
  assert.equal(response.status, 200);
  const body = await response.json<{
    resetRequired: boolean;
    updates: Array<{
      eventKey: string;
      stateKind: string;
      circles: Array<{ wcID: number }>;
    }>;
  }>();
  assert.equal(body.resetRequired, true);
  assert.deepEqual(
    body.updates
      .filter(({ stateKind }) => stateKind === "presence")
      .map(({ eventKey, circles }) => ({
        eventKey,
        wcIDs: circles.map(({ wcID }) => wcID),
      })),
    [
      { eventKey: "state:presence:multi", wcIDs: [101] },
      { eventKey: "state:presence:superseding", wcIDs: [202] },
    ],
  );
  assert.equal(published.publicationCursor, 2);
});

test("snapshot revision, generation, canonical order, catalog and WCID fail closed", async () => {
  const database = setup();
  seedCatalog(database);
  const bucket = new MemoryBucket();
  const publication = await fixturePublication();
  const authenticated = auth(publication, "snapshot:c108:g1:validation");
  const { publishCrawlerSnapshot } =
    await import("../src/lib/server/crawler-snapshots");

  const artworkWithoutMedia = structuredClone(publication);
  artworkWithoutMedia.snapshot.events[0]!.post.media = [];
  artworkWithoutMedia.snapshot.revision =
    await calculateCrawlerSnapshotRevision(artworkWithoutMedia.snapshot);
  await assert.rejects(
    () =>
      publishCrawlerSnapshot(
        database.binding,
        bucket.binding,
        auth(artworkWithoutMedia, "snapshot:c108:g1:artwork-without-media"),
      ),
    (error: unknown) => hasCode(error, "invalid_crawler_snapshot"),
  );

  const artworkWithDifferentPostID = structuredClone(publication);
  artworkWithDifferentPostID.snapshot.events[0]!.stateValue =
    "2090000000000000002";
  artworkWithDifferentPostID.snapshot.revision =
    await calculateCrawlerSnapshotRevision(artworkWithDifferentPostID.snapshot);
  await assert.rejects(
    () =>
      publishCrawlerSnapshot(
        database.binding,
        bucket.binding,
        auth(
          artworkWithDifferentPostID,
          "snapshot:c108:g1:artwork-different-post-id",
        ),
      ),
    (error: unknown) => hasCode(error, "invalid_crawler_snapshot"),
  );

  const badDigest = structuredClone(publication);
  badDigest.snapshot.revision = "0".repeat(64);
  await assert.rejects(
    () =>
      publishCrawlerSnapshot(
        database.binding,
        bucket.binding,
        auth(badDigest, "snapshot:c108:g1:bad-digest"),
      ),
    (error: unknown) => hasCode(error, "invalid_crawler_snapshot"),
  );

  const badWCID = structuredClone(publication);
  badWCID.snapshot.events[0]!.circles[0]!.wcID = 999;
  badWCID.snapshot.revision = await calculateCrawlerSnapshotRevision(
    badWCID.snapshot,
  );
  await assert.rejects(
    () =>
      publishCrawlerSnapshot(
        database.binding,
        bucket.binding,
        auth(badWCID, "snapshot:c108:g1:bad-wcid"),
      ),
    (error: unknown) =>
      hasCodeAndStatus(error, "crawler_snapshot_unknown_circle", 409),
  );

  const first = await publishCrawlerSnapshot(
    database.binding,
    bucket.binding,
    authenticated,
  );
  const stale = await fixturePublication({ generation: 1 });
  stale.baseRevision = first.revision;
  await assert.rejects(
    () =>
      publishCrawlerSnapshot(
        database.binding,
        bucket.binding,
        auth(stale, "snapshot:c108:g1:rollback"),
      ),
    (error: unknown) => hasCode(error, "crawler_snapshot_revision_conflict"),
  );
});

test("production-scale snapshot catalog validation stays within the D1 bind limit", async () => {
  const database = setup();
  seedCatalog(database);
  const wcIDs = Array.from({ length: 4_698 }, (_, index) => 10_000 + index);
  seedStableCatalogCircles(database, wcIDs);
  const bucket = new MemoryBucket();
  const publication = await fixturePublication();
  publication.snapshot.events = productionScaleSnapshotEvents(
    publication.snapshot.events[0]!,
    wcIDs,
  );
  publication.snapshot.revision = await calculateCrawlerSnapshotRevision(
    publication.snapshot,
  );

  const published = await publishCrawlerSnapshot(
    enforceD1BindingLimit(database.binding, 100),
    bucket.binding,
    auth(publication, "snapshot:c108:g1:production-scale"),
  );

  assert.equal(published.revision, publication.snapshot.revision);
  assert.equal(published.generation, 1);
});

test("publication cursor fences concurrent append and reset keeps non-artwork state", async () => {
  const database = setup();
  seedCatalog(database);
  seedLegacyUpdates(database);
  const bucket = new MemoryBucket();
  const publication = await fixturePublication();
  const { publishCrawlerSnapshot } =
    await import("../src/lib/server/crawler-snapshots");
  database.beforeNextBatch = () => seedConcurrentInventory(database);
  const result = await publishCrawlerSnapshot(
    database.binding,
    bucket.binding,
    auth(publication, "snapshot:c108:g1:concurrent-fence"),
  );
  assert.equal(result.publicationCursor, 3);

  const app = createHomepageApp(() => new Response("astro"));
  const resetResponse = await app.fetch(
    new Request(
      "https://cominavi.net/api/v2/events/108/updates?afterCursor=0&publicationRevision=none",
    ),
    environment(database, bucket),
    executionContext,
  );
  assert.equal(resetResponse.status, 200);
  const reset = await resetResponse.json<{
    resetRequired: boolean;
    publicationRevision: string;
    publicationGeneration: number;
    publicationCursor: number;
    updates: Array<{ eventKey: string; stateKind: string; cursor: number }>;
  }>();
  assert.equal(reset.resetRequired, true);
  assert.equal(reset.publicationRevision, publication.snapshot.revision);
  assert.equal(reset.publicationGeneration, 1);
  assert.equal(reset.publicationCursor, 3);
  assert.deepEqual(
    reset.updates.map((item) => [item.eventKey, item.stateKind, item.cursor]),
    [
      [publication.snapshot.events[0]!.eventKey, "shinagaki", 3],
      ["state:attendance", "attendance", 3],
      ["state:inventory:concurrent", "inventory", 3],
    ],
  );

  const legacy = await app.fetch(
    new Request("https://cominavi.net/api/v2/events/108/updates"),
    environment(database, bucket),
    executionContext,
  );
  const legacyBody = await legacy.json<{
    updates: Array<{ eventKey: string }>;
  }>();
  assert.equal(
    legacyBody.updates.some((item) => item.eventKey === "seed:stale:artwork"),
    false,
  );

  seedPostPublicationPresence(database);
  const incremental = await app.fetch(
    new Request(
      `https://cominavi.net/api/v2/events/108/updates?afterCursor=3&publicationRevision=${publication.snapshot.revision}`,
    ),
    environment(database, bucket),
    executionContext,
  );
  const incrementalBody = await incremental.json<{
    resetRequired: boolean;
    updates: Array<{ eventKey: string; cursor: number }>;
  }>();
  assert.equal(incrementalBody.resetRequired, false);
  assert.equal(incrementalBody.updates.length, 1);
  assert.equal(incrementalBody.updates[0]?.cursor, 4);
  assert.equal(
    incrementalBody.updates[0]?.eventKey,
    "state:presence:after-publication",
  );
});

test("signed authority and raw catalog source are operation-bound and no-store", async () => {
  const database = setup();
  seedCatalog(database);
  const bucket = new MemoryBucket();
  bucket.seedPrivateSource();
  const app = createHomepageApp(() => new Response("astro"));
  const authorityBody = {
    schemaVersion: 1,
    operation: "readSnapshotAuthority",
    eventNumber: 108,
    proposedPublication: { revision: "0".repeat(64), generation: 1 },
  };
  const authority = await signedCrawlerRead(
    app,
    database,
    bucket,
    "/api/v2/internal/crawler/realtime-snapshot-authority",
    authorityBody,
    "crawler-snapshot-authority:108",
  );
  assert.equal(authority.status, 200);
  assert.match(authority.headers.get("Cache-Control") ?? "", /no-store/);
  assert.equal(authority.headers.get("CDN-Cache-Control"), "no-store");
  const authorityJSON = await authority.json<{
    publicationRevision: string;
    publicationGeneration: number;
    publicationCursor: number;
    snapshotCatalogSourceMainSHA256: string;
    proposedPublication: unknown;
    activeCatalog: {
      versionID: string;
      sourceMainSHA256: string;
      sourceMainBytes: number;
      contentType: string;
      downloadPath: string;
    };
  }>();
  assert.equal(authorityJSON.publicationRevision, "none");
  assert.equal(authorityJSON.publicationGeneration, 0);
  assert.equal(authorityJSON.publicationCursor, 0);
  assert.equal(authorityJSON.snapshotCatalogSourceMainSHA256, "none");
  assert.deepEqual(authorityJSON.proposedPublication, {
    revision: "0".repeat(64),
    generation: 1,
    status: "notActivated",
  });
  assert.deepEqual(authorityJSON.activeCatalog, {
    versionID: "c108-v1",
    sourceMainSHA256: catalogDigest,
    sourceMainBytes: catalogSourceBytes.byteLength,
    contentType: "application/vnd.sqlite3",
    downloadPath: "/api/v2/internal/crawler/catalog-source-main",
  });

  const catalogBody = {
    schemaVersion: 1,
    operation: "downloadActiveCatalogSourceMain",
    eventNumber: 108,
    versionID: "c108-v1",
    sourceMainSHA256: catalogDigest,
  };
  const crossRouteReplay = await signedCrawlerRead(
    app,
    database,
    bucket,
    "/api/v2/internal/crawler/catalog-source-main",
    catalogBody,
    "crawler-snapshot-authority:108",
  );
  assert.equal(crossRouteReplay.status, 401);

  const download = await signedCrawlerRead(
    app,
    database,
    bucket,
    "/api/v2/internal/crawler/catalog-source-main",
    catalogBody,
    `crawler-catalog-source-main:108:${catalogDigest}`,
  );
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("Cache-Control"), "private, no-store");
  assert.equal(
    download.headers.get("Content-Length"),
    String(catalogSourceBytes.byteLength),
  );
  assert.equal(download.headers.get("Content-Type"), "application/vnd.sqlite3");
  assert.equal(download.headers.get("X-ComiNavi-Catalog-Version"), "c108-v1");
  assert.equal(
    download.headers.get("X-ComiNavi-Source-Main-SHA256"),
    catalogDigest,
  );
  assert.equal(download.headers.get("ETag"), `"sha256-${catalogDigest}"`);
  assert.equal(
    download.headers.get("Digest"),
    `sha-256=:${Buffer.from(catalogDigest, "hex").toString("base64")}:`,
  );
  assert.deepEqual(
    new Uint8Array(await download.arrayBuffer()),
    catalogSourceBytes,
  );

  seedCatalogRollover(database, "7".repeat(64));
  const staleDownload = await signedCrawlerRead(
    app,
    database,
    bucket,
    "/api/v2/internal/crawler/catalog-source-main",
    catalogBody,
    `crawler-catalog-source-main:108:${catalogDigest}`,
  );
  assert.equal(staleDownload.status, 409);
});

test("authority gives authenticated historical publication proof after supersession", async () => {
  const database = setup();
  seedCatalog(database);
  const bucket = new MemoryBucket();
  bucket.seedPrivateSource();
  const firstPublication = await fixturePublication();
  const first = await publishCrawlerSnapshot(
    database.binding,
    bucket.binding,
    auth(firstPublication, "snapshot:c108:g1:authority-proof"),
  );
  const secondPublication = await fixturePublication({
    generation: 2,
    observedAt: "2026-08-15T03:01:00Z",
  });
  secondPublication.baseRevision = first.revision;
  await publishCrawlerSnapshot(
    database.binding,
    bucket.binding,
    auth(secondPublication, "snapshot:c108:g2:authority-proof"),
  );

  const app = createHomepageApp(() => new Response("astro"));
  const response = await signedCrawlerRead(
    app,
    database,
    bucket,
    "/api/v2/internal/crawler/realtime-snapshot-authority",
    {
      schemaVersion: 1,
      operation: "readSnapshotAuthority",
      eventNumber: 108,
      proposedPublication: { revision: first.revision, generation: 1 },
    },
    "crawler-snapshot-authority:108",
  );
  assert.equal(response.status, 200);
  const body = await response.json<{
    publicationRevision: string;
    proposedPublication: {
      revision: string;
      generation: number;
      status: string;
      publicationCursor: number;
      publishedAt: string;
      active: boolean;
    } | null;
  }>();
  assert.equal(body.publicationRevision, secondPublication.snapshot.revision);
  assert.deepEqual(body.proposedPublication, {
    revision: first.revision,
    generation: 1,
    status: "activated",
    publicationCursor: first.publicationCursor,
    publishedAt: first.publishedAt,
    active: false,
  });
});

test("catalog rollover serves the last snapshot and permits a stable-circle bridge", async () => {
  const database = setup();
  seedCatalog(database);
  const bucket = new MemoryBucket();
  const firstPublication = await fixturePublication();
  const first = await publishCrawlerSnapshot(
    database.binding,
    bucket.binding,
    auth(firstPublication, "snapshot:c108:g1:rollover"),
  );
  const nextCatalogDigest = "7".repeat(64);
  seedCatalogRollover(database, nextCatalogDigest);

  const app = createHomepageApp(() => new Response("astro"));
  const legacy = await app.fetch(
    new Request("https://cominavi.net/api/v2/events/108/updates"),
    environment(database, bucket),
    executionContext,
  );
  assert.equal(legacy.status, 200);
  assert.equal(
    (await legacy.json<{ publicationRevision: string }>()).publicationRevision,
    first.revision,
  );

  const bridgePublication = await fixturePublication({
    generation: 2,
    observedAt: "2026-08-15T03:02:00Z",
  });
  bridgePublication.baseRevision = first.revision;
  const bridge = await publishCrawlerSnapshot(
    database.binding,
    bucket.binding,
    auth(bridgePublication, "snapshot:c108:g2:rollover-bridge"),
  );
  assert.equal(bridge.generation, 2);

  const currentCatalogPublication = await fixturePublication({
    generation: 3,
    catalogPayloadSHA256: nextCatalogDigest,
    observedAt: "2026-08-15T03:03:00Z",
  });
  currentCatalogPublication.baseRevision = bridge.revision;
  const current = await publishCrawlerSnapshot(
    database.binding,
    bucket.binding,
    auth(currentCatalogPublication, "snapshot:c108:g3:current-catalog"),
  );
  assert.equal(current.generation, 3);
});

test("snapshot R2 reads retry when the D1 head changes mid-read", async () => {
  const database = setup();
  seedCatalog(database);
  const bucket = new MemoryBucket();
  const firstPublication = await fixturePublication();
  const first = await publishCrawlerSnapshot(
    database.binding,
    bucket.binding,
    auth(firstPublication, "snapshot:c108:g1:read-race"),
  );
  const secondPublication = await fixturePublication({
    generation: 2,
    observedAt: "2026-08-15T03:04:00Z",
  });
  secondPublication.baseRevision = first.revision;
  bucket.beforeNextGet = async () => {
    await publishCrawlerSnapshot(
      database.binding,
      bucket.binding,
      auth(secondPublication, "snapshot:c108:g2:read-race"),
    );
  };
  const loaded = await loadActiveCrawlerSnapshot(
    database.binding,
    bucket.binding,
    108,
    true,
  );
  assert.equal(loaded?.revision, secondPublication.snapshot.revision);
  assert.equal(loaded?.generation, 2);
  assert.equal(
    loaded?.events?.[0]?.eventKey,
    secondPublication.snapshot.events[0]?.eventKey,
  );
});

test("legacy seed retirement is production-pinned, atomic, and idempotent", () => {
  const productionCleanup = readFileSync(
    "tools/retire-c108-legacy-realtime-seed.sql",
    "utf8",
  );
  assert.doesNotMatch(productionCleanup, /^\s*PRAGMA\s+foreign_keys/im);
  assert.doesNotMatch(
    productionCleanup,
    /^\s*CREATE\s+TEMP(?:ORARY)?\s+TABLE/im,
  );
  for (const authority of [
    "b51beff176fae5b9868382d1fa77f53dd94bb46d19ee576833a243d5b9f75e4c",
    "8ba60301ce35f1c9c3ba49033235175ababf92655724e1f5a55fb5120e20ba56",
    "67cfc72931c7d77c2d72bc0cca6d8c7d765e6a2607e81c7efe3a36b6ca3f3341",
    "version.update_count = 5402",
    "version.byte_count = 8299125",
    "head.publication_cursor = 3406",
    "3406 /* legacy-event-count */",
    "9161 /* legacy-target-count */",
    "7071 /* legacy-head-count */",
    "3249 /* orphan-post-count */",
    "4566 /* orphan-media-count */",
  ]) {
    assert.ok(productionCleanup.includes(authority), authority);
  }
  assert.match(productionCleanup, /state_kind NOT IN \('shinagaki', 'cover'\)/);
  assert.match(productionCleanup, /target\.comiket_no <> 108/);
  assert.match(productionCleanup, /notification_deliveries AS delivery/);

  const cleanup = cleanupForFixture(productionCleanup);
  const guarded = setup();
  seedCatalog(guarded);
  seedLegacyCleanupFixture(guarded);
  assert.throws(() => executeAtomically(guarded, cleanup));
  assert.equal(
    guarded.native
      .prepare("SELECT count(*) AS n FROM circle_update_events")
      .get()?.n,
    3,
  );
  assert.equal(
    guarded.native
      .prepare("SELECT count(*) AS n FROM circle_update_targets")
      .get()?.n,
    3,
  );
  assert.deepEqual(cleanupStagingTables(guarded), []);

  const database = setup();
  seedCatalog(database);
  seedLegacyCleanupFixture(database);
  seedProductionCleanupAuthority(database);
  executeAtomically(database, cleanup);
  assert.deepEqual(
    database.rows(
      "SELECT event_key, source FROM circle_update_events ORDER BY event_key",
    ),
    [{ event_key: "state:attendance", source: "cominavi-collector" }],
  );
  assert.equal(
    database.native
      .prepare("SELECT count(*) AS n FROM circle_update_targets")
      .get()?.n,
    1,
  );
  assert.deepEqual(
    database.rows(
      "SELECT state_kind, update_event_id FROM circle_state_heads ORDER BY state_kind",
    ),
    [{ state_kind: "attendance", update_event_id: 2 }],
  );
  assert.deepEqual(
    database.rows("SELECT source FROM ingest_batches ORDER BY source"),
    [{ source: "cominavi-collector" }],
  );
  assert.equal(
    database.native.prepare("SELECT count(*) AS n FROM seed_imports").get()?.n,
    0,
  );
  assert.equal(
    database.native
      .prepare(
        "SELECT count(*) AS n FROM social_posts WHERE post_id = 'shared-post'",
      )
      .get()?.n,
    1,
  );
  assert.equal(
    database.native
      .prepare(
        "SELECT count(*) AS n FROM post_media WHERE post_id = 'shared-post'",
      )
      .get()?.n,
    1,
  );
  assert.equal(
    database.native
      .prepare(
        "SELECT count(*) AS n FROM social_posts WHERE post_id = 'seed-only-post'",
      )
      .get()?.n,
    0,
  );
  assert.equal(
    database.native
      .prepare(
        "SELECT count(*) AS n FROM post_media WHERE post_id = 'seed-only-post'",
      )
      .get()?.n,
    0,
  );
  assert.equal(
    database.native
      .prepare(
        "SELECT count(*) AS n FROM social_posts WHERE post_id = 'unrelated-post'",
      )
      .get()?.n,
    1,
  );
  assert.equal(
    database.native
      .prepare(
        "SELECT count(*) AS n FROM crawler_snapshot_publication_receipts",
      )
      .get()?.n,
    1,
  );
  assert.deepEqual(cleanupStagingTables(database), []);

  executeAtomically(database, cleanup);
  assert.deepEqual(
    database.rows(
      "SELECT event_key, source FROM circle_update_events ORDER BY event_key",
    ),
    [{ event_key: "state:attendance", source: "cominavi-collector" }],
  );
  assert.deepEqual(cleanupStagingTables(database), []);

  const unexpectedState = setup();
  seedCatalog(unexpectedState);
  seedLegacyCleanupFixture(unexpectedState);
  seedProductionCleanupAuthority(unexpectedState);
  unexpectedState.native.exec(`
    UPDATE circle_update_events
    SET state_kind = 'inventory', update_kind = 'inventory_sold_out'
    WHERE event_key = 'seed:stale:artwork'
  `);
  assert.throws(() => executeAtomically(unexpectedState, cleanup));
  assert.equal(
    unexpectedState.native
      .prepare(
        "SELECT count(*) AS n FROM circle_update_events WHERE source = 'seed:c108-local'",
      )
      .get()?.n,
    2,
  );
  assert.deepEqual(cleanupStagingTables(unexpectedState), []);
});

test("OpenAPI documents dedicated snapshot authority and convergence fields", async () => {
  const document = await generateOpenAPIDocument();
  const expectedSecurity = [
    {
      crawlerSnapshotSignature: [],
      crawlerSnapshotTimestamp: [],
      crawlerSnapshotIdempotencyKey: [],
    },
  ];
  const operation =
    document.paths?.["/api/v2/internal/crawler/realtime-snapshots"]?.post;
  assert.equal(operation?.operationId, "publishCrawlerRealtimeSnapshot");
  assert.deepEqual(operation?.security, expectedSecurity);
  const authority =
    document.paths?.["/api/v2/internal/crawler/realtime-snapshot-authority"]
      ?.post;
  assert.equal(authority?.operationId, "getCrawlerRealtimeSnapshotAuthority");
  assert.deepEqual(authority?.security, expectedSecurity);
  assert.match(JSON.stringify(authority), /readSnapshotAuthority/);
  assert.match(JSON.stringify(authority), /proposedPublication/);
  const source =
    document.paths?.["/api/v2/internal/crawler/catalog-source-main"]?.post;
  assert.equal(source?.operationId, "downloadCrawlerCatalogSourceMain");
  assert.deepEqual(source?.security, expectedSecurity);
  assert.match(JSON.stringify(source), /downloadActiveCatalogSourceMain/);
  assert.match(JSON.stringify(source), /application\/vnd\.sqlite3/);
  const updates = document.paths?.["/api/v2/events/{eventNumber}/updates"]?.get;
  assert.match(JSON.stringify(updates), /publicationRevision/);
  assert.match(JSON.stringify(updates), /publicationGeneration/);
  assert.match(JSON.stringify(updates), /resetRequired/);
});

async function fixturePublication(
  override: Partial<CrawlerRealtimeSnapshot> = {},
) {
  const snapshot: CrawlerRealtimeSnapshot = {
    schemaVersion: 1,
    source: "cominavi-collector",
    eventNumber: 108,
    revision: "0".repeat(64),
    generation: 1,
    catalogPayloadSHA256: catalogDigest,
    matchingPolicyRevision: "shinagaki-v4",
    observedAt: "2026-08-15T03:00:00Z",
    events: [
      {
        eventKey: "snapshot:shinagaki:2090000000000000001:v4",
        sourceRevision: 4,
        updateKind: "shinagaki_published",
        stateKind: "shinagaki",
        stateValue: "2090000000000000001",
        confidence: "high",
        notifiable: false,
        post: {
          id: "2090000000000000001",
          url: "https://x.com/circle101/status/2090000000000000001",
          text: "品書き",
          occurredAt: "2026-08-15T03:00:00Z",
          author: { xUserID: "101", handle: "circle101", name: "Circle 101" },
          media: [
            {
              key: "m1",
              type: "photo",
              role: "shinagaki",
              url: "https://pbs.twimg.com/media/fixture.jpg",
            },
          ],
        },
        circles: [
          { comiketNo: 108, wcID: 101, circleID: 1, circleName: "Circle 101" },
        ],
        evidence: { policy: "shinagaki-v4" },
      },
    ],
    ...override,
  };
  snapshot.revision = await calculateCrawlerSnapshotRevision(snapshot);
  return { baseRevision: "none", snapshot };
}

function auth(publication: unknown, idempotencyKey: string) {
  const rawBody = new TextEncoder().encode(JSON.stringify(publication));
  return {
    idempotencyKey,
    rawBody,
    payloadSHA256: createHash("sha256").update(rawBody).digest("hex"),
  };
}

async function signedCrawlerRead(
  app: ReturnType<typeof createHomepageApp>,
  database: SQLiteD1Database,
  bucket: MemoryBucket,
  path: string,
  value: unknown,
  idempotencyKey: string,
): Promise<Response> {
  const body = JSON.stringify(value);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac("sha256", snapshotSecret)
    .update(`${timestamp}.${idempotencyKey}.`)
    .update(body)
    .digest("hex");
  return app.fetch(
    new Request(`https://cominavi.net${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "X-ComiNavi-Timestamp": timestamp,
        "X-ComiNavi-Signature": `v1=${signature}`,
      },
      body,
    }),
    environment(database, bucket),
    executionContext,
  );
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
      "migrations/0009_crawler_realtime_snapshots.sql",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  );
}

function seedCatalog(database: SQLiteD1Database): void {
  database.native.exec(`
    INSERT INTO catalog_events (comiket_no, name, created_at, updated_at)
    VALUES (108, 'C108', 1, 1);
    INSERT INTO catalog_versions (
      id, comiket_no, schema_version, state, claim_id,
      source_main_sha256, source_image_sha256, circle_count,
      created_at, published_at
    ) VALUES (
      'c108-v1', 108, 1, 'published', 'claim',
      '${catalogDigest}', '${"9".repeat(64)}', 2, 1, 1
    );
    INSERT INTO catalog_dates (version_id, day, date_iso, weekday)
    VALUES ('c108-v1', 1, '2026-08-15', 6);
    INSERT INTO catalog_circles (
      version_id, comiket_no, wc_id, day, name, kana, pen_name,
      book_name, description
    ) VALUES
      ('c108-v1', 108, 101, 1, 'Circle 101', '', '', '', ''),
      ('c108-v1', 108, 202, 1, 'Circle 202', '', '', '', '');
    INSERT INTO catalog_stable_circles (
      comiket_no, wc_id, first_version_id, last_version_id,
      first_published_at, last_published_at
    ) VALUES
      (108, 101, 'c108-v1', 'c108-v1', 1, 1),
      (108, 202, 'c108-v1', 'c108-v1', 1, 1);
    INSERT INTO catalog_artifacts (
      version_id, kind, visibility, object_key, sha256,
      byte_count, content_type, created_at
    ) VALUES (
      'c108-v1', 'source_main', 'private_source', '${catalogSourceKey}',
      '${catalogDigest}', ${catalogSourceBytes.byteLength},
      'application/vnd.sqlite3', 1
    );
    INSERT INTO circles (
      comiket_no, wc_id, circle_name, created_at, updated_at
    ) VALUES (108, 101, 'Circle 101', 1, 1);
    UPDATE catalog_events SET active_version_id = 'c108-v1'
    WHERE comiket_no = 108;
  `);
}

function seedStableCatalogCircles(
  database: SQLiteD1Database,
  wcIDs: readonly number[],
): void {
  const insert = database.native.prepare(`
    INSERT INTO catalog_stable_circles (
      comiket_no, wc_id, first_version_id, last_version_id,
      first_published_at, last_published_at
    ) VALUES (108, ?, 'c108-v1', 'c108-v1', 1, 1)
  `);
  database.native.exec("BEGIN");
  try {
    for (const wcID of wcIDs) insert.run(wcID);
    database.native.exec("COMMIT");
  } catch (error) {
    database.native.exec("ROLLBACK");
    throw error;
  }
}

function productionScaleSnapshotEvents(
  template: CrawlerRealtimeSnapshot["events"][number],
  wcIDs: readonly number[],
): CrawlerRealtimeSnapshot["events"] {
  const events: CrawlerRealtimeSnapshot["events"] = [];
  for (let offset = 0; offset < wcIDs.length; offset += 20) {
    const event = structuredClone(template);
    const eventIndex = offset / 20;
    const postID = (2_090_000_000_000_100_000n + BigInt(eventIndex)).toString();
    event.eventKey = `snapshot:shinagaki:${postID}:v4`;
    event.sourceRevision = eventIndex + 1;
    event.stateValue = postID;
    event.post.id = postID;
    event.post.url = `https://x.com/circle101/status/${postID}`;
    event.circles = wcIDs.slice(offset, offset + 20).map((wcID) => ({
      comiketNo: 108,
      wcID,
      circleID: wcID,
      circleName: `Circle ${wcID}`,
    }));
    events.push(event);
  }
  return events;
}

function seedCatalogRollover(
  database: SQLiteD1Database,
  sourceMainSHA256: string,
): void {
  database.native.exec(`
    INSERT INTO catalog_versions (
      id, comiket_no, schema_version, state, claim_id,
      source_main_sha256, source_image_sha256, circle_count,
      created_at, published_at
    ) VALUES (
      'c108-v2', 108, 1, 'published', 'claim-v2',
      '${sourceMainSHA256}', '${"6".repeat(64)}', 0, 2, 2
    );
    INSERT INTO catalog_artifacts (
      version_id, kind, visibility, object_key, sha256,
      byte_count, content_type, created_at
    ) VALUES (
      'c108-v2', 'source_main', 'private_source',
      'catalogs/c108/c108-v2/source-main.sqlite', '${sourceMainSHA256}',
      1, 'application/vnd.sqlite3', 2
    );
    UPDATE catalog_events
    SET active_version_id = 'c108-v2', updated_at = 2
    WHERE comiket_no = 108;
  `);
}

function seedLegacyUpdates(database: SQLiteD1Database): void {
  database.native.exec(`
    INSERT INTO ingest_batches (
      id, source, idempotency_key, payload_sha256, schema_version,
      observed_at, received_at, raw_payload_json
    ) VALUES
      (1, 'seed:c108-local', 'seed:legacy:batch', '${"1".repeat(64)}', 1, 1, 1, '{}'),
      (2, 'cominavi-collector', 'realtime:state:batch', '${"2".repeat(64)}', 1, 1, 1, '{}');
    INSERT INTO social_posts (
      post_id, author_handle, text, occurred_at, latest_observed_at, raw_post_json
    ) VALUES
      ('shared-post', 'circle101', 'shared', 1786762800, 1786762800, '{}');
    INSERT INTO circle_update_events (
      id, event_key, ingest_batch_id, source, source_revision, post_id,
      update_kind, state_kind, state_value, confidence, occurred_at,
      notifiable, evidence_json, created_at
    ) VALUES
      (1, 'seed:stale:artwork', 1, 'seed:c108-local', 1, 'shared-post',
       'shinagaki_published', 'shinagaki', 'shared-post', 'high', 1786762800, 0, '{}', 1),
      (2, 'state:attendance', 2, 'cominavi-collector', 1, 'shared-post',
       'attendance_attending', 'attendance', 'attending', 'high', 1786762860, 1, '{}', 1);
    INSERT INTO circle_update_targets (update_event_id, comiket_no, wc_id)
    VALUES (1, 108, 101), (2, 108, 101);
    INSERT INTO circle_state_heads (
      comiket_no, wc_id, state_kind, state_value, occurred_at,
      source_revision, event_key, update_event_id, updated_at
    ) VALUES (
      108, 101, 'attendance', 'attending', 1786762860,
      1, 'state:attendance', 2, 1
    );
  `);
}

function seedLegacyCleanupFixture(database: SQLiteD1Database): void {
  database.native.exec(`
    INSERT INTO ingest_batches (
      id, source, idempotency_key, payload_sha256, schema_version,
      observed_at, received_at, raw_payload_json
    ) VALUES
      (1, 'seed:c108-local', 'seed:legacy:batch', '${"1".repeat(64)}', 1, 1, 1, '{}'),
      (2, 'cominavi-collector', 'realtime:state:batch', '${"2".repeat(64)}', 1, 1, 1, '{}');
    INSERT INTO social_posts (
      post_id, author_handle, text, occurred_at, latest_observed_at, raw_post_json
    ) VALUES
      ('shared-post', 'circle101', 'shared', 1786762800, 1786762800, '{}'),
      ('seed-only-post', 'circle101', 'legacy only', 1786762800, 1786762800, '{}'),
      ('unrelated-post', 'circle101', 'unrelated', 1786762800, 1786762800, '{}');
    INSERT INTO post_media (
      post_id, media_index, media_key, media_type, role, url
    ) VALUES
      ('shared-post', 0, 'shared-media', 'photo', 'shinagaki', 'https://example.com/shared.jpg'),
      ('seed-only-post', 0, 'seed-only-media', 'photo', 'cover', 'https://example.com/seed.jpg'),
      ('unrelated-post', 0, 'unrelated-media', 'photo', 'post_image', 'https://example.com/unrelated.jpg');
    INSERT INTO circle_update_events (
      id, event_key, ingest_batch_id, source, source_revision, post_id,
      update_kind, state_kind, state_value, confidence, occurred_at,
      notifiable, evidence_json, created_at
    ) VALUES
      (1, 'seed:stale:artwork', 1, 'seed:c108-local', 1, 'shared-post',
       'shinagaki_published', 'shinagaki', 'shared-post', 'high', 1786762800, 0, '{}', 1),
      (2, 'state:attendance', 2, 'cominavi-collector', 1, 'shared-post',
       'attendance_attending', 'attendance', 'attending', 'high', 1786762860, 1, '{}', 1),
      (3, 'seed:stale:cover', 1, 'seed:c108-local', 1, 'seed-only-post',
       'cover_published', 'cover', 'seed-only-post', 'high', 1786762800, 0, '{}', 1);
    INSERT INTO circle_update_targets (update_event_id, comiket_no, wc_id)
    VALUES (1, 108, 101), (2, 108, 101), (3, 108, 101);
    INSERT INTO circle_state_heads (
      comiket_no, wc_id, state_kind, state_value, occurred_at,
      source_revision, event_key, update_event_id, updated_at
    ) VALUES
      (108, 101, 'shinagaki', 'shared-post', 1786762800,
       1, 'seed:stale:artwork', 1, 1),
      (108, 101, 'attendance', 'attending', 1786762860,
       1, 'state:attendance', 2, 1),
      (108, 101, 'cover', 'seed-only-post', 1786762800,
       1, 'seed:stale:cover', 3, 1);
    INSERT INTO seed_imports (
      seed_key, payload_sha256, imported_at, circle_count, post_count, update_count
    ) VALUES ('c108:old', '${"b".repeat(64)}', 1, 1, 2, 2);
  `);
}

function seedProductionCleanupAuthority(database: SQLiteD1Database): void {
  const revision =
    "b51beff176fae5b9868382d1fa77f53dd94bb46d19ee576833a243d5b9f75e4c";
  database.native.exec(`
    INSERT INTO crawler_snapshot_versions (
      event_number, revision, schema_version, generation,
      catalog_payload_sha256, matching_policy_revision, observed_at,
      update_count, object_key, object_sha256, byte_count,
      publication_cursor, published_at
    ) VALUES (
      108, '${revision}', 1, 1,
      '8ba60301ce35f1c9c3ba49033235175ababf92655724e1f5a55fb5120e20ba56',
      'test-v1', 1, 5402, 'object',
      '67cfc72931c7d77c2d72bc0cca6d8c7d765e6a2607e81c7efe3a36b6ca3f3341',
      8299125, 3406, 1
    );
    INSERT INTO crawler_snapshot_heads (
      event_number, revision, generation, publication_cursor,
      publication_idempotency_key, updated_at
    ) VALUES (108, '${revision}', 1, 3406, 'snapshot:retirement:fixture', 1);
    INSERT INTO crawler_snapshot_publication_receipts (
      idempotency_key, payload_sha256, event_number, base_revision,
      revision, generation, result_json, created_at
    ) VALUES (
      'snapshot:retirement:fixture', '${"c".repeat(64)}', 108, 'none',
      '${revision}', 1, '{}', 1
    );
  `);
}

function cleanupForFixture(productionCleanup: string): string {
  return productionCleanup
    .replace("3406 /* legacy-event-count */", "2 /* legacy-event-count */")
    .replace(
      "3406 /* legacy-c108-event-count */",
      "2 /* legacy-c108-event-count */",
    )
    .replace("9161 /* legacy-target-count */", "2 /* legacy-target-count */")
    .replace("7071 /* legacy-head-count */", "2 /* legacy-head-count */")
    .replace("3249 /* orphan-post-count */", "1 /* orphan-post-count */")
    .replace("4566 /* orphan-media-count */", "1 /* orphan-media-count */");
}

function executeAtomically(database: SQLiteD1Database, sql: string): void {
  database.native.exec("BEGIN");
  try {
    database.native.exec(sql);
    database.native.exec("COMMIT");
  } catch (error) {
    database.native.exec("ROLLBACK");
    throw error;
  }
}

function cleanupStagingTables(
  database: SQLiteD1Database,
): Array<Record<string, unknown>> {
  return database.rows(
    "SELECT name FROM sqlite_schema WHERE name LIKE 'cominavi_cleanup_%'",
  );
}

function seedConcurrentInventory(database: SQLiteD1Database): void {
  database.native.exec(`
    INSERT INTO social_posts (
      post_id, author_handle, text, occurred_at, latest_observed_at, raw_post_json
    ) VALUES ('2090000000000000003', 'circle101', 'sold out', 1786762920, 1786762920, '{}');
    INSERT INTO circle_update_events (
      id, event_key, ingest_batch_id, source, source_revision, post_id,
      update_kind, state_kind, state_value, confidence, occurred_at,
      notifiable, evidence_json, created_at
    ) VALUES (3, 'state:inventory:concurrent', 2, 'cominavi-collector', 1,
      '2090000000000000003', 'inventory_sold_out', 'inventory', 'sold_out',
      'high', 1786762920, 1, '{}', 1);
    INSERT INTO circle_update_targets VALUES (3, 108, 101);
    INSERT INTO circle_state_heads (
      comiket_no, wc_id, state_kind, state_value, occurred_at,
      source_revision, event_key, update_event_id, updated_at
    ) VALUES (
      108, 101, 'inventory', 'sold_out', 1786762920,
      1, 'state:inventory:concurrent', 3, 1
    );
  `);
}

function seedPostPublicationPresence(database: SQLiteD1Database): void {
  database.native.exec(`
    INSERT INTO social_posts (
      post_id, author_handle, text, occurred_at, latest_observed_at, raw_post_json
    ) VALUES ('2090000000000000004', 'circle101', 'present', 1786762980, 1786762980, '{}');
    INSERT INTO circle_update_events (
      id, event_key, ingest_batch_id, source, source_revision, post_id,
      update_kind, state_kind, state_value, confidence, occurred_at,
      notifiable, evidence_json, created_at
    ) VALUES (4, 'state:presence:after-publication', 2, 'cominavi-collector', 1,
      '2090000000000000004', 'presence_present', 'presence', 'present',
      'high', 1786762980, 1, '{}', 1);
    INSERT INTO circle_update_targets VALUES (4, 108, 101);
  `);
}

function seedFirstPostPublicationPresence(database: SQLiteD1Database): void {
  database.native.exec(`
    INSERT INTO ingest_batches (
      source, idempotency_key, payload_sha256, schema_version,
      observed_at, received_at, raw_payload_json
    ) VALUES (
      'cominavi-collector', 'realtime:first-state:batch', '${"3".repeat(64)}',
      1, 1, 1, '{}'
    );
    INSERT INTO social_posts (
      post_id, author_handle, text, occurred_at, latest_observed_at, raw_post_json
    ) VALUES (
      '2090000000000000005', 'circle101', 'present', 1786763040, 1786763040, '{}'
    );
    INSERT INTO circle_update_events (
      event_key, ingest_batch_id, source, source_revision, post_id,
      update_kind, state_kind, state_value, confidence, occurred_at,
      notifiable, evidence_json, created_at
    ) VALUES (
      'state:presence:first-after-publication',
      (SELECT id FROM ingest_batches WHERE idempotency_key = 'realtime:first-state:batch'),
      'cominavi-collector', 1,
      '2090000000000000005', 'presence_present', 'presence', 'present',
      'high', 1786763040, 1, '{}', 1
    );
    INSERT INTO circle_update_targets (update_event_id, comiket_no, wc_id)
    SELECT id, 108, 101 FROM circle_update_events
    WHERE event_key = 'state:presence:first-after-publication';
  `);
}

function seedAndRetireFirstRealtimeEvent(database: SQLiteD1Database): void {
  database.native.exec(`
    INSERT INTO ingest_batches (
      source, idempotency_key, payload_sha256, schema_version,
      observed_at, received_at, raw_payload_json
    ) VALUES (
      'cominavi-collector', 'realtime:retired:batch', '${"4".repeat(64)}',
      1, 1, 1, '{}'
    );
    INSERT INTO social_posts (
      post_id, author_handle, text, occurred_at, latest_observed_at, raw_post_json
    ) VALUES ('2090000000000000006', 'circle101', 'retired', 1, 1, '{}');
    INSERT INTO circle_update_events (
      event_key, ingest_batch_id, source, source_revision, post_id,
      update_kind, state_kind, state_value, confidence, occurred_at,
      notifiable, evidence_json, created_at
    ) VALUES (
      'state:presence:retired',
      (SELECT id FROM ingest_batches WHERE idempotency_key = 'realtime:retired:batch'),
      'cominavi-collector', 1, '2090000000000000006', 'presence_present',
      'presence', 'present', 'high', 1, 0, '{}', 1
    );
    DELETE FROM circle_update_events WHERE event_key = 'state:presence:retired';
    DELETE FROM social_posts WHERE post_id = '2090000000000000006';
    DELETE FROM ingest_batches WHERE idempotency_key = 'realtime:retired:batch';
  `);
}

function seedPartiallySupersededMultiTargetState(
  database: SQLiteD1Database,
): void {
  database.native.exec(`
    INSERT INTO circles (
      comiket_no, wc_id, circle_name, created_at, updated_at
    ) VALUES (108, 202, 'Circle 202', 1, 1);
    INSERT INTO ingest_batches (
      id, source, idempotency_key, payload_sha256, schema_version,
      observed_at, received_at, raw_payload_json
    ) VALUES (1, 'cominavi-collector', 'realtime:multi-head:batch',
      '${"5".repeat(64)}', 1, 1, 1, '{}');
    INSERT INTO social_posts (
      post_id, author_handle, text, occurred_at, latest_observed_at, raw_post_json
    ) VALUES
      ('2090000000000000007', 'circle101', 'present together', 10, 10, '{}'),
      ('2090000000000000008', 'circle202', 'temporarily away', 20, 20, '{}');
    INSERT INTO circle_update_events (
      id, event_key, ingest_batch_id, source, source_revision, post_id,
      update_kind, state_kind, state_value, confidence, occurred_at,
      notifiable, evidence_json, created_at
    ) VALUES
      (1, 'state:presence:multi', 1, 'cominavi-collector', 1,
       '2090000000000000007', 'presence_present', 'presence', 'present',
       'high', 10, 0, '{}', 1),
      (2, 'state:presence:superseding', 1, 'cominavi-collector', 1,
       '2090000000000000008', 'presence_temporarily_away', 'presence',
       'temporarily_away', 'high', 20, 0, '{}', 1);
    INSERT INTO circle_update_targets (update_event_id, comiket_no, wc_id)
    VALUES (1, 108, 101), (1, 108, 202), (2, 108, 202);
    INSERT INTO circle_state_heads (
      comiket_no, wc_id, state_kind, state_value, occurred_at,
      source_revision, event_key, update_event_id, updated_at
    ) VALUES
      (108, 101, 'presence', 'present', 10, 1, 'state:presence:multi', 1, 1),
      (108, 202, 'presence', 'temporarily_away', 20, 1,
       'state:presence:superseding', 2, 1);
  `);
}

function environment(
  database: SQLiteD1Database,
  bucket: MemoryBucket,
): Cloudflare.Env {
  return {
    COMINAVI_DB: database.binding,
    COMINAVI_CATALOGS: bucket.binding,
    COMINAVI_CRAWLER_SNAPSHOT_SECRET: snapshotSecret,
    COMINAVI_CRAWLER_WEBHOOK_SECRET: webhookSecret,
  } as unknown as Cloudflare.Env;
}

class MemoryBucket {
  readonly values = new Map<string, Uint8Array>();
  readonly metadata = new Map<
    string,
    { contentType?: string; customMetadata?: Record<string, string> }
  >();
  beforeNextGet?: (key: string) => void | Promise<void>;
  readonly binding = {
    get: async (key: string) => {
      const beforeGet = this.beforeNextGet;
      this.beforeNextGet = undefined;
      await beforeGet?.(key);
      const value = this.values.get(key);
      return value ? objectBody(key, value, this.metadata.get(key)) : null;
    },
    put: async (key: string, value: Uint8Array, options?: R2PutOptions) => {
      this.values.set(key, Uint8Array.from(value));
      this.metadata.set(key, {
        contentType:
          options?.httpMetadata instanceof Headers
            ? (options.httpMetadata.get("Content-Type") ?? undefined)
            : options?.httpMetadata?.contentType,
        customMetadata: options?.customMetadata,
      });
      return objectBody(key, this.values.get(key)!, this.metadata.get(key));
    },
    delete: async (key: string) => {
      this.values.delete(key);
    },
  } as unknown as R2Bucket;

  seedPrivateSource(): void {
    this.values.set(catalogSourceKey, catalogSourceBytes);
    this.metadata.set(catalogSourceKey, {
      contentType: "application/vnd.sqlite3",
      customMetadata: {
        sha256: catalogDigest,
        visibility: "private_source",
      },
    });
  }
}

function objectBody(
  key: string,
  bytes: Uint8Array,
  metadata?: {
    contentType?: string;
    customMetadata?: Record<string, string>;
  },
): R2ObjectBody {
  return {
    key,
    size: bytes.byteLength,
    etag: "fixture",
    httpEtag: '"fixture"',
    uploaded: new Date(0),
    version: "fixture",
    checksums: {},
    httpMetadata: { contentType: metadata?.contentType },
    customMetadata: metadata?.customMetadata ?? {},
    range: undefined,
    body: new Response(Uint8Array.from(bytes).buffer).body!,
    bodyUsed: false,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    blob: async () => new Blob([Uint8Array.from(bytes)]),
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

function hasCodeAndStatus(
  error: unknown,
  code: string,
  status: number,
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code &&
    "status" in error &&
    error.status === status
  );
}

function enforceD1BindingLimit(
  database: D1Database,
  maximumBindings: number,
): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "bind") {
                return (...values: unknown[]) => {
                  assert.ok(
                    values.length <= maximumBindings,
                    `D1 query binds ${values.length} values, exceeding the ${maximumBindings}-value limit.\nSQL: ${query}`,
                  );
                  return statementTarget.bind(...values);
                };
              }
              const value = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget,
              );
              return typeof value === "function"
                ? value.bind(statementTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
