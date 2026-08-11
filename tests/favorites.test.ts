import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  loadFavoriteSnapshot,
  parseFavoriteSnapshotBody,
  replaceFavoriteSnapshot,
} from "../src/lib/server/favorites";
import {
  claimCatalogImport,
  ingestCatalogRows,
  publishCatalogVersion,
  stageCatalogVersion,
} from "../src/lib/server/catalogs";
import { SQLiteD1Database } from "./sqlite-d1";

const identity = {
  subject: "a".repeat(32),
  userID: 1,
  authVersion: 1,
};
const firstID = "11111111-1111-4111-8111-111111111111";
const secondID = "22222222-2222-4222-8222-222222222222";
const catalogClaimID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const catalogVersionID = `c108-v1-${"f".repeat(24)}`;

test("favorites receipts bind canonical mutation ID to payload and survive later revisions", async () => {
  const database = setup();
  await publishFixtureCatalog(database);
  const first = parseFavoriteSnapshotBody({
    baseRevision: 0,
    mutationID: firstID,
    favorites: [{ wcID: 101, color: 2, notificationsEnabled: true }],
  });
  const snapshot1 = await replaceFavoriteSnapshot(
    database.binding,
    identity,
    108,
    first,
    100_000,
  );
  assert.equal(snapshot1.revision, 1);
  const second = parseFavoriteSnapshotBody({
    baseRevision: 1,
    mutationID: secondID,
    favorites: [{ wcID: 102, color: 3, notificationsEnabled: false }],
  });
  const snapshot2 = await replaceFavoriteSnapshot(
    database.binding,
    identity,
    108,
    second,
    101_000,
  );
  assert.equal(snapshot2.revision, 2);
  const lostResponseReplay = await replaceFavoriteSnapshot(
    database.binding,
    identity,
    108,
    first,
    102_000,
  );
  assert.deepEqual(lostResponseReplay, snapshot2);
  await assert.rejects(
    replaceFavoriteSnapshot(
      database.binding,
      identity,
      108,
      { ...first, favorites: [{ ...first.favorites[0]!, color: 9 }] },
      103_000,
    ),
    (error: unknown) => hasCode(error, "idempotency_conflict"),
  );
  assert.equal(
    database.rows("SELECT count(*) AS count FROM favorite_mutation_receipts")[0]
      ?.count,
    2,
  );
});

test("a stale favorites CAS rolls back companions and writes no false receipt", async () => {
  const database = setup();
  await publishFixtureCatalog(database);
  await replaceFavoriteSnapshot(
    database.binding,
    identity,
    108,
    parseFavoriteSnapshotBody({
      baseRevision: 0,
      mutationID: firstID,
      favorites: [{ wcID: 101, color: 1, notificationsEnabled: true }],
    }),
    100_000,
  );
  await assert.rejects(
    replaceFavoriteSnapshot(
      database.binding,
      identity,
      108,
      parseFavoriteSnapshotBody({
        baseRevision: 0,
        mutationID: secondID,
        favorites: [{ wcID: 102, color: 8, notificationsEnabled: false }],
      }),
      101_000,
    ),
    (error: unknown) => hasCode(error, "favorite_revision_conflict"),
  );
  assert.deepEqual(
    database.rows(
      "SELECT mutation_id FROM favorite_mutation_receipts ORDER BY mutation_id",
    ),
    [{ mutation_id: firstID }],
  );
  assert.deepEqual(
    database.rows("SELECT wc_id, active FROM user_favorites ORDER BY wc_id"),
    [{ wc_id: 101, active: 1 }],
  );
});

test("deletion fencing between favorites pre-read and commit leaves no state or receipt", async () => {
  const database = setup();
  await publishFixtureCatalog(database);
  database.beforeNextBatch = () => {
    database.native.exec(
      `UPDATE users SET auth_version = 2, deletion_pending_at = 100
       WHERE id = 1`,
    );
  };
  await assert.rejects(() =>
    replaceFavoriteSnapshot(
      database.binding,
      identity,
      108,
      parseFavoriteSnapshotBody({
        baseRevision: 0,
        mutationID: firstID,
        favorites: [{ wcID: 101, color: 1, notificationsEnabled: true }],
      }),
      100_000,
    ),
  );
  assert.deepEqual(database.rows("SELECT * FROM favorite_sets"), []);
  assert.deepEqual(database.rows("SELECT * FROM user_favorites"), []);
  assert.deepEqual(
    database.rows("SELECT * FROM favorite_mutation_receipts"),
    [],
  );
});

test("favorites reject noncanonical uppercase UUID mutation IDs", () => {
  assert.throws(
    () =>
      parseFavoriteSnapshotBody({
        baseRevision: 0,
        mutationID: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        favorites: [],
      }),
    (error: unknown) => hasCode(error, "invalid_request_id"),
  );
});

test("favorite snapshot revision and rows are loaded by one SQLite statement", async () => {
  const database = setup();
  await publishFixtureCatalog(database);
  await replaceFavoriteSnapshot(
    database.binding,
    identity,
    108,
    parseFavoriteSnapshotBody({
      baseRevision: 0,
      mutationID: firstID,
      favorites: [{ wcID: 101, color: 4, notificationsEnabled: true }],
    }),
    100_000,
  );
  let statements = 0;
  const oneStatementBinding = {
    prepare(query: string) {
      statements += 1;
      return database.binding.prepare(query);
    },
  } as D1Database;
  const snapshot = await loadFavoriteSnapshot(
    oneStatementBinding,
    identity,
    108,
  );
  assert.equal(statements, 1);
  assert.deepEqual(snapshot, {
    eventNumber: 108,
    revision: 1,
    favorites: [{ wcID: 101, color: 4, notificationsEnabled: true }],
  });
});

test("a superseding catalog omission cannot poison an existing stable favorite", async () => {
  const database = setup();
  await publishFixtureCatalog(database);
  await replaceFavoriteSnapshot(
    database.binding,
    identity,
    108,
    parseFavoriteSnapshotBody({
      baseRevision: 0,
      mutationID: firstID,
      favorites: [{ wcID: 101, color: 1, notificationsEnabled: true }],
    }),
    100_000,
  );
  const secondVersion = `c108-v1-${"e".repeat(24)}`;
  await publishFixtureCatalog(
    database,
    secondVersion,
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    [102],
    "second",
    `${"7".repeat(32)}:${"8".repeat(32)}`,
  );
  const updated = await replaceFavoriteSnapshot(
    database.binding,
    identity,
    108,
    parseFavoriteSnapshotBody({
      baseRevision: 1,
      mutationID: secondID,
      favorites: [
        { wcID: 101, color: 1, notificationsEnabled: true },
        { wcID: 102, color: 2, notificationsEnabled: false },
      ],
    }),
    101_000,
  );
  assert.equal(updated.revision, 2);
  assert.deepEqual(
    database.rows(
      `SELECT wc_id, first_version_id, last_version_id
       FROM catalog_stable_circles ORDER BY wc_id`,
    ),
    [
      {
        wc_id: 101,
        first_version_id: catalogVersionID,
        last_version_id: catalogVersionID,
      },
      {
        wc_id: 102,
        first_version_id: catalogVersionID,
        last_version_id: secondVersion,
      },
    ],
  );
});

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

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
    ) VALUES (1, '${"a".repeat(32)}', 'Owner', 1, 1, 1, 1, 1);
  `);
  return database;
}

async function publishFixtureCatalog(
  database: SQLiteD1Database,
  versionID = catalogVersionID,
  claimID = catalogClaimID,
  wcIDs: number[] = [101, 102],
  artifactSuffix = "favorites",
  sourceMD5Hint = `${"1".repeat(32)}:${"2".repeat(32)}`,
): Promise<void> {
  const [mainMD5, imageMD5] = sourceMD5Hint.split(":") as [string, string];
  const mainSHA = mainMD5.repeat(2);
  const imageSHA = imageMD5.repeat(2);
  const derivedSHA = versionID.slice(-1).repeat(64);
  await claimCatalogImport(database.binding, {
    comiketNo: 108,
    name: "Comic Market 108",
    claimID,
    sourceMD5Hint,
    now: 90,
  });
  await stageCatalogVersion(database.binding, {
    versionID,
    comiketNo: 108,
    claimID,
    sourceMD5Hint,
    sourceMainSHA256: mainSHA,
    sourceImageSHA256: imageSHA,
    derivedSHA256: derivedSHA,
    derivedBytes: 1234,
    derivedObjectKey: `derived/catalogs/c108/${artifactSuffix}.sqlite`,
    privateSources: {
      main: {
        objectKey: `raw/catalogs/c108/${artifactSuffix}-main.sqlite`,
        bytes: 100,
      },
      image: {
        objectKey: `raw/catalogs/c108/${artifactSuffix}-image.sqlite`,
        bytes: 200,
      },
    },
    dateCount: 1,
    mapCount: 1,
    areaCount: 1,
    blockCount: 1,
    floorCount: 1,
    mappingCount: 1,
    genreCount: 1,
    circleCount: wcIDs.length,
    layoutCount: 1,
    imageCount: wcIDs.length + 1,
    now: 91,
  });
  await ingestCatalogRows(database.binding, {
    versionID,
    comiketNo: 108,
    claimID,
    now: 92,
    data: normalizedCatalogFixture(wcIDs),
  });
  await publishCatalogVersion(
    database.binding,
    catalogBucket(artifactSuffix, mainSHA, imageSHA, derivedSHA),
    {
      versionID,
      comiketNo: 108,
      claimID,
      now: 93,
    },
  );
}

function normalizedCatalogFixture(wcIDs: number[]) {
  const circle = (wcID: number, spaceNoSub: number) => ({
    wcID,
    day: 1,
    blockID: 1,
    spaceNo: 1,
    spaceNoSub,
    genreID: 1,
    name: `Circle ${wcID}`,
    kana: `circle-${wcID}`,
    penName: "",
    bookName: "",
    websiteURL: null,
    description: "",
    twitterURL: null,
    pixivURL: null,
    updateID: wcID,
  });
  return {
    dates: [{ day: 1, dateISO: "2026-08-15", weekday: 7 }],
    maps: [
      {
        mapID: 1,
        name: "East",
        width: 1000,
        height: 800,
        originX: 0,
        originY: 0,
        rotation: 0,
        artworkName: "east.png",
      },
    ],
    areas: [
      {
        areaID: 1,
        mapID: 1,
        name: "East 1",
        simpleName: "E1",
        x: 0,
        y: 0,
        width: 500,
        height: 400,
      },
    ],
    blocks: [{ blockID: 1, areaID: 1, name: "A" }],
    floors: [{ floorID: 1, day: 1, mapID: 1, name: "East day 1" }],
    mappings: [{ day: 1, blockID: 1, mapID: 1, areaID: 1, floorID: 1 }],
    genres: [{ genreID: 1, code: 100, day: 1, name: "Original" }],
    layouts: [
      {
        blockID: 1,
        spaceNo: 1,
        mapID: 1,
        hallID: 1,
        x: 100,
        y: 200,
        orientation: 1,
      },
    ],
    circles: wcIDs.map((wcID, index) => circle(wcID, index % 2)),
    images: [
      ...wcIDs.map((wcID) => ({
        kind: "circle_cut" as const,
        assetKey: String(wcID),
        wcID,
        width: 211,
        height: 300,
        contentType: "image/png" as const,
        byteCount: 12,
        sha256: String(wcID).padStart(64, "0"),
      })),
      {
        kind: "common" as const,
        assetKey: "east.png",
        wcID: null,
        width: 1000,
        height: 800,
        contentType: "image/png" as const,
        byteCount: 12,
        sha256: "6".repeat(64),
      },
    ],
  };
}

function catalogBucket(
  artifactSuffix: string,
  mainSHA: string,
  imageSHA: string,
  derivedSHA: string,
): R2Bucket {
  const objects = new Map<string, readonly [number, string, string, string]>([
    [
      `derived/catalogs/c108/${artifactSuffix}.sqlite`,
      [
        1234,
        derivedSHA,
        "authenticated_download",
        "application/vnd.cominavi.catalog-v1+sqlite",
      ],
    ],
    [
      `raw/catalogs/c108/${artifactSuffix}-main.sqlite`,
      [100, mainSHA, "private_source", "application/vnd.sqlite3"],
    ],
    [
      `raw/catalogs/c108/${artifactSuffix}-image.sqlite`,
      [200, imageSHA, "private_source", "application/vnd.sqlite3"],
    ],
  ]);
  return {
    head: async (key: string) => {
      const object = objects.get(key);
      if (!object) return null;
      return {
        size: object[0],
        customMetadata: { sha256: object[1], visibility: object[2] },
        httpMetadata: { contentType: object[3] },
      } as unknown as R2Object;
    },
  } as unknown as R2Bucket;
}
