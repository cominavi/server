import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { createReadStream, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { CatalogNormalizedDataV1 } from "../src/lib/server/catalogs";

const catalogSchemaVersion = 1;
const catalogBuilderNodeVersion = "26.3.0";
const requiredMainTables = [
  "ComiketAreaWC",
  "ComiketBlockWC",
  "ComiketCircleExtend",
  "ComiketCircleWC",
  "ComiketDateWC",
  "ComiketFloorWC",
  "ComiketGenreWC",
  "ComiketInfoWC",
  "ComiketLayoutWC",
  "ComiketMapWC",
  "ComiketMappingWC",
] as const;
const requiredImageTables = [
  "ComiketCircleImage",
  "ComiketCommonImage",
] as const;

export interface CatalogImportOptions {
  mainDatabasePath: string;
  imageDatabasePath: string;
  outputDatabasePath?: string;
  sourceMD5Hint?: string;
  sourceMD5AlreadyVerified?: boolean;
  sourceUpdatedAt?: string;
}

export interface CatalogPublicationBundleV1 {
  v: 1;
  schemaVersion: 1;
  versionID: string;
  comiketNo: number;
  eventName: string;
  sourceUpdatedAt: string | null;
  sourceMD5Hint: string | null;
  sources: {
    main: CatalogArtifactDescriptor;
    image: CatalogArtifactDescriptor;
  };
  derived: CatalogArtifactDescriptor | null;
  counts: CatalogCounts;
}

interface CatalogArtifactDescriptor {
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: string;
  visibility: "private_source" | "authenticated_download";
}

interface CatalogCounts {
  dates: number;
  maps: number;
  areas: number;
  blocks: number;
  floors: number;
  mappings: number;
  genres: number;
  layouts: number;
  circles: number;
  circleImages: number;
  commonImages: number;
}

interface EventInfoRow extends Record<string, SQLiteValue> {
  comiketNo: number;
  comiketName: string | null;
  cutSizeW: number;
  cutSizeH: number;
  cutOriginX: number;
  cutOriginY: number;
  cutOffsetX: number;
  cutOffsetY: number;
  map2SizeW: number;
  map2SizeH: number;
  map2OriginX: number;
  map2OriginY: number;
}

interface CircleRow extends Record<string, SQLiteValue> {
  wcID: number;
  day: number;
  blockID: number;
  spaceNo: number;
  spaceNoSub: number;
  genreID: number;
  name: string | null;
  kana: string | null;
  penName: string | null;
  bookName: string | null;
  websiteURL: string | null;
  description: string | null;
  twitterURL: string | null;
  pixivURL: string | null;
  updateID: number | null;
}

interface ImageRow {
  wcID?: number;
  name?: string;
  width: number;
  height: number;
  type: string;
  size: number;
  bytes: Uint8Array;
}

type SQLiteValue = null | number | bigint | string | Uint8Array;

export async function importCatalog(
  options: CatalogImportOptions,
): Promise<CatalogPublicationBundleV1> {
  assertCatalogBuilderRuntime();
  validateOptions(options);
  const [mainSHA256, imageSHA256] = await Promise.all([
    sha256File(options.mainDatabasePath),
    sha256File(options.imageDatabasePath),
  ]);
  if (options.sourceMD5Hint && !options.sourceMD5AlreadyVerified) {
    const [expectedMainMD5, expectedImageMD5] =
      options.sourceMD5Hint.split(":");
    const [actualMainMD5, actualImageMD5] = await Promise.all([
      md5File(options.mainDatabasePath),
      md5File(options.imageDatabasePath),
    ]);
    if (
      actualMainMD5 !== expectedMainMD5 ||
      actualImageMD5 !== expectedImageMD5
    ) {
      fail(
        "Downloaded catalog bytes do not match the upstream MD5 change hints.",
      );
    }
  }
  const main = openReadOnlyDatabase(options.mainDatabasePath);
  const image = openReadOnlyDatabase(options.imageDatabasePath);
  let output: DatabaseSync | undefined;
  try {
    validateSQLite(main, requiredMainTables, "main catalog");
    validateSQLite(image, requiredImageTables, "image catalog");
    const infoRows = main
      .prepare("SELECT * FROM ComiketInfoWC")
      .all() as EventInfoRow[];
    if (infoRows.length !== 1)
      fail("Source must contain exactly one ComiketInfoWC row.");
    const info = infoRows[0]!;
    positiveInteger(info.comiketNo, "comiketNo");
    const eventName =
      sanitizedText(info.comiketName, 100) || `Comiket ${info.comiketNo}`;
    const circles = readCircles(main);
    const circleIDs = new Set(circles.map((circle) => circle.wcID));
    validateMainRelations(main);
    const circleImageCount = validateImages(image, "circle", circleIDs);
    const commonImageCount = validateImages(image, "common", circleIDs);
    if (circleImageCount !== circles.length) {
      fail("Every sanitized circle must have exactly one cut image.");
    }
    const counts = readCounts(
      main,
      circles.length,
      circleImageCount,
      commonImageCount,
    );
    for (const [collection, count] of Object.entries(counts)) {
      if (count < 1) fail(`Source catalog has no usable ${collection} rows.`);
    }
    const versionID = catalogVersionID(info.comiketNo, mainSHA256, imageSHA256);
    let derived: CatalogArtifactDescriptor | null = null;
    if (options.outputDatabasePath) {
      rmSync(options.outputDatabasePath, { force: true });
      output = new DatabaseSync(options.outputDatabasePath);
      buildArtifact(output, main, image, info, circles, {
        versionID,
        eventName,
        mainSHA256,
        imageSHA256,
        sourceUpdatedAt: canonicalSourceTime(options.sourceUpdatedAt),
      });
      output.close();
      output = undefined;
      const derivedSHA256 = await sha256File(options.outputDatabasePath);
      derived = {
        objectKey: `derived/catalogs/c${info.comiketNo}/${versionID}.sqlite`,
        sha256: derivedSHA256,
        bytes: statSync(options.outputDatabasePath).size,
        contentType: "application/vnd.cominavi.catalog-v1+sqlite",
        visibility: "authenticated_download",
      };
    }
    return {
      v: 1,
      schemaVersion: 1,
      versionID,
      comiketNo: info.comiketNo,
      eventName,
      sourceUpdatedAt: canonicalSourceTime(options.sourceUpdatedAt),
      sourceMD5Hint: options.sourceMD5Hint ?? null,
      sources: {
        main: {
          objectKey: `raw/catalogs/c${info.comiketNo}/${mainSHA256}/main.sqlite`,
          sha256: mainSHA256,
          bytes: statSync(options.mainDatabasePath).size,
          contentType: "application/vnd.sqlite3",
          visibility: "private_source",
        },
        image: {
          objectKey: `raw/catalogs/c${info.comiketNo}/${imageSHA256}/images.sqlite`,
          sha256: imageSHA256,
          bytes: statSync(options.imageDatabasePath).size,
          contentType: "application/vnd.sqlite3",
          visibility: "private_source",
        },
      },
      derived,
      counts,
    };
  } catch (error) {
    output?.close();
    if (options.outputDatabasePath)
      rmSync(options.outputDatabasePath, { force: true });
    throw error;
  } finally {
    main.close();
    image.close();
  }
}

export function assertCatalogBuilderRuntime(
  nodeVersion = process.versions.node,
): void {
  if (nodeVersion !== catalogBuilderNodeVersion) {
    fail(
      `Catalog artifacts require Node.js ${catalogBuilderNodeVersion}; received ${nodeVersion}.`,
    );
  }
}

export function readNormalizedCatalogArtifact(
  artifactPath: string,
): CatalogNormalizedDataV1 {
  const database = openReadOnlyDatabase(artifactPath);
  try {
    validateSQLite(
      database,
      [
        "dates",
        "maps",
        "areas",
        "blocks",
        "floors",
        "mappings",
        "genres",
        "layouts",
        "circles",
        "circle_images",
        "common_images",
      ],
      "derived catalog",
    );
    const all = <T>(query: string): T[] =>
      database.prepare(query).all() as unknown as T[];
    return {
      dates: all(
        `SELECT day, date_iso AS dateISO, weekday FROM dates ORDER BY day`,
      ),
      maps: all(
        `SELECT map_id AS mapID, name, width, height, x AS originX,
                y AS originY, rotation, filename AS artworkName
         FROM maps ORDER BY map_id`,
      ),
      areas: all(
        `SELECT area_id AS areaID, map_id AS mapID, name,
                simple_name AS simpleName, x, y, width, height
         FROM areas ORDER BY area_id`,
      ),
      blocks: all(
        `SELECT block_id AS blockID, area_id AS areaID, name
         FROM blocks ORDER BY block_id`,
      ),
      floors: all(
        `SELECT floor_id AS floorID, day, map_id AS mapID, name
         FROM floors ORDER BY floor_id`,
      ),
      mappings: all(
        `SELECT day, block_id AS blockID, map_id AS mapID,
                area_id AS areaID, floor_id AS floorID
         FROM mappings ORDER BY day, block_id`,
      ),
      genres: all(
        `SELECT genre_id AS genreID, code, NULLIF(day, 0) AS day, name
         FROM genres ORDER BY genre_id`,
      ),
      layouts: all(
        `SELECT block_id AS blockID, space_no AS spaceNo, map_id AS mapID,
                hall_id AS hallID, x, y, orientation
         FROM layouts ORDER BY block_id, space_no`,
      ),
      circles: all(
        `SELECT wc_id AS wcID, day, block_id AS blockID,
                space_no AS spaceNo, space_no_sub AS spaceNoSub,
                genre_id AS genreID, name, kana, pen_name AS penName,
                book_name AS bookName, website_url AS websiteURL, description,
                twitter_url AS twitterURL, pixiv_url AS pixivURL,
                update_id AS updateID
         FROM circles ORDER BY wc_id`,
      ),
      images: [
        ...all<{
          kind: "circle_cut";
          assetKey: string;
          wcID: number;
          width: number;
          height: number;
          contentType: "image/jpeg" | "image/png" | "image/webp";
          byteCount: number;
          sha256: string;
        }>(
          `SELECT 'circle_cut' AS kind, CAST(wc_id AS TEXT) AS assetKey,
                  wc_id AS wcID, width, height, content_type AS contentType,
                  byte_count AS byteCount, sha256
           FROM circle_images ORDER BY wc_id`,
        ),
        ...all<{
          kind: "common";
          assetKey: string;
          wcID: null;
          width: number;
          height: number;
          contentType: "image/jpeg" | "image/png" | "image/webp";
          byteCount: number;
          sha256: string;
        }>(
          `SELECT 'common' AS kind, name AS assetKey, NULL AS wcID,
                  width, height, content_type AS contentType,
                  byte_count AS byteCount, sha256
           FROM common_images ORDER BY name`,
        ),
      ],
    };
  } finally {
    database.close();
  }
}

function validateOptions(options: CatalogImportOptions): void {
  if (
    options.sourceMD5Hint !== undefined &&
    !/^[0-9a-f]{32}:[0-9a-f]{32}$/.test(options.sourceMD5Hint)
  ) {
    fail("sourceMD5Hint must contain lowercase main:image upstream MD5 hints.");
  }
  if (options.sourceMD5AlreadyVerified && !options.sourceMD5Hint) {
    fail("sourceMD5AlreadyVerified requires a canonical upstream MD5 pair.");
  }
  canonicalSourceTime(options.sourceUpdatedAt);
}

function canonicalSourceTime(value: string | undefined): string | null {
  if (value === undefined) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds))
    fail("sourceUpdatedAt must be an ISO-8601 time.");
  return new Date(milliseconds).toISOString();
}

function validateSQLite(
  database: DatabaseSync,
  requiredTables: readonly string[],
  label: string,
): void {
  const quick = database.prepare("PRAGMA quick_check").get() as Record<
    string,
    SQLiteValue
  >;
  if (Object.values(quick)[0] !== "ok")
    fail(`${label} failed SQLite quick_check.`);
  const tables = new Set(
    (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  const missing = requiredTables.filter((table) => !tables.has(table));
  if (missing.length)
    fail(`${label} is missing tables: ${missing.join(", ")}.`);
}

function validateMainRelations(database: DatabaseSync): void {
  const failures = database
    .prepare(
      `SELECT
         (SELECT count(*) FROM ComiketCircleWC AS circle
          LEFT JOIN ComiketCircleExtend AS extension
            ON extension.comiketNo = circle.comiketNo AND extension.id = circle.id
          WHERE extension.WCId IS NULL OR extension.WCId <= 0) AS circle_identity,
         (SELECT count(*) FROM (
           SELECT WCId FROM ComiketCircleExtend GROUP BY comiketNo, WCId
           HAVING count(*) <> 1
         )) AS duplicate_wcid,
         (SELECT count(*) FROM ComiketLayoutWC AS layout
          LEFT JOIN ComiketBlockWC AS block
            ON block.comiketNo = layout.comiketNo AND block.id = layout.blockId
          LEFT JOIN ComiketMapWC AS map
            ON map.comiketNo = layout.comiketNo AND map.id = layout.mapId
          WHERE block.id IS NULL OR map.id IS NULL OR layout.layout NOT BETWEEN 1 AND 4) AS layout_relation,
         (SELECT count(*) FROM ComiketCircleWC AS circle
          LEFT JOIN ComiketDateWC AS date
            ON date.comiketNo = circle.comiketNo AND date.id = circle.day
          LEFT JOIN ComiketBlockWC AS block
            ON block.comiketNo = circle.comiketNo AND block.id = circle.blockId
          LEFT JOIN ComiketGenreWC AS genre
            ON genre.comiketNo = circle.comiketNo AND genre.id = circle.genreId
          WHERE date.id IS NULL OR block.id IS NULL OR genre.id IS NULL) AS circle_relation,
         (SELECT count(*) FROM ComiketCircleWC AS circle
          WHERE NOT EXISTS (
            SELECT 1 FROM ComiketLayoutWC AS layout
            WHERE layout.comiketNo = circle.comiketNo
              AND layout.blockId = circle.blockId
              AND layout.spaceNo = circle.spaceNo
          )) AS circle_layout_coverage`,
    )
    .get() as Record<string, number>;
  for (const [name, count] of Object.entries(failures)) {
    if (count !== 0) fail(`Source catalog has ${count} invalid ${name} rows.`);
  }
}

function readCircles(database: DatabaseSync): CircleRow[] {
  const rows = database
    .prepare(
      `SELECT extension.WCId AS wcID, circle.day,
              circle.blockId AS blockID, circle.spaceNo,
              circle.spaceNoSub, circle.genreId AS genreID,
              circle.circleName AS name, circle.circleKana AS kana,
              circle.penName, circle.bookName, circle.url AS websiteURL,
              circle.description, extension.twitterURL,
              extension.pixivURL, circle.updateId AS updateID
       FROM ComiketCircleWC AS circle
       JOIN ComiketCircleExtend AS extension
         ON extension.comiketNo = circle.comiketNo AND extension.id = circle.id
       ORDER BY extension.WCId`,
    )
    .all() as CircleRow[];
  let previous = 0;
  for (const row of rows) {
    positiveInteger(row.wcID, "WCID");
    if (row.wcID <= previous)
      fail("WCIDs must be unique and strictly ordered.");
    previous = row.wcID;
    positiveInteger(row.day, "circle day");
    positiveInteger(row.blockID, "circle block");
    positiveInteger(row.spaceNo, "circle space");
    positiveInteger(row.genreID, "circle genre");
    if (row.spaceNoSub !== 0 && row.spaceNoSub !== 1)
      fail("Invalid circle subspace.");
  }
  return rows;
}

function validateImages(
  database: DatabaseSync,
  kind: "circle" | "common",
  circleIDs: Set<number>,
): number {
  const query =
    kind === "circle"
      ? `SELECT WCId AS wcID, width, height, type, size, cutImage AS bytes
         FROM ComiketCircleImage ORDER BY WCId`
      : `SELECT name, width, height, type, size, image AS bytes
         FROM ComiketCommonImage ORDER BY name`;
  let count = 0;
  let previousCircleID = 0;
  let previousCommonName = "";
  for (const raw of iterateRows<ImageRow>(database.prepare(query))) {
    if (kind === "circle") {
      if (!raw.wcID || raw.wcID <= previousCircleID)
        fail("Duplicate or unordered circle image key.");
      previousCircleID = raw.wcID;
    } else {
      const name = String(raw.name ?? "");
      if (!name || name <= previousCommonName)
        fail("Duplicate or unordered common image key.");
      previousCommonName = name;
    }
    if (kind === "circle" && !circleIDs.has(Number(raw.wcID))) {
      fail(`Circle image references unknown WCID ${raw.wcID}.`);
    }
    validateImage(raw);
    count += 1;
  }
  return count;
}

function validateImage(row: ImageRow): void {
  positiveInteger(row.width, "image width");
  positiveInteger(row.height, "image height");
  positiveInteger(row.size, "image size");
  if (!(row.bytes instanceof Uint8Array) || row.bytes.byteLength !== row.size) {
    fail("Image byte count does not match its declared size.");
  }
  const detected = detectImage(row.bytes);
  const declaredType =
    row.type.toLowerCase() === "jpeg" ? "jpg" : row.type.toLowerCase();
  if (!detected || detected.extension !== declaredType) {
    fail("Image magic bytes do not match the declared supported type.");
  }
}

function readCounts(
  main: DatabaseSync,
  circles: number,
  circleImages: number,
  commonImages: number,
): CatalogCounts {
  const tableCount = (table: string): number =>
    Number(
      (
        main.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
          count: number;
        }
      ).count,
    );
  return {
    dates: tableCount("ComiketDateWC"),
    maps: tableCount("ComiketMapWC"),
    areas: tableCount("ComiketAreaWC"),
    blocks: tableCount("ComiketBlockWC"),
    floors: tableCount("ComiketFloorWC"),
    mappings: tableCount("ComiketMappingWC"),
    genres: tableCount("ComiketGenreWC"),
    layouts: tableCount("ComiketLayoutWC"),
    circles,
    circleImages,
    commonImages,
  };
}

function buildArtifact(
  output: DatabaseSync,
  main: DatabaseSync,
  image: DatabaseSync,
  info: EventInfoRow,
  circles: CircleRow[],
  metadata: {
    versionID: string;
    eventName: string;
    mainSHA256: string;
    imageSHA256: string;
    sourceUpdatedAt: string | null;
  },
): void {
  output.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA page_size = 4096;
    PRAGMA user_version = 1;
    CREATE TABLE catalog_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      version_id TEXT NOT NULL,
      comiket_no INTEGER NOT NULL,
      event_name TEXT NOT NULL,
      source_updated_at TEXT,
      source_main_sha256 TEXT NOT NULL,
      source_image_sha256 TEXT NOT NULL,
      cut_width INTEGER NOT NULL,
      cut_height INTEGER NOT NULL,
      cut_origin_x INTEGER NOT NULL,
      cut_origin_y INTEGER NOT NULL,
      cut_offset_x INTEGER NOT NULL,
      cut_offset_y INTEGER NOT NULL,
      table_width INTEGER NOT NULL,
      table_height INTEGER NOT NULL,
      table_origin_x INTEGER NOT NULL,
      table_origin_y INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE dates (day INTEGER PRIMARY KEY, date_iso TEXT NOT NULL, weekday INTEGER NOT NULL) STRICT;
    CREATE TABLE maps (map_id INTEGER PRIMARY KEY, name TEXT NOT NULL, filename TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, rotation INTEGER NOT NULL) STRICT;
    CREATE TABLE areas (area_id INTEGER PRIMARY KEY, map_id INTEGER NOT NULL, name TEXT NOT NULL, simple_name TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL) STRICT;
    CREATE TABLE blocks (block_id INTEGER PRIMARY KEY, area_id INTEGER NOT NULL, name TEXT NOT NULL) STRICT;
    CREATE TABLE floors (floor_id INTEGER PRIMARY KEY, name TEXT NOT NULL, day INTEGER NOT NULL, map_id INTEGER NOT NULL) STRICT;
    CREATE TABLE mappings (day INTEGER NOT NULL, block_id INTEGER NOT NULL, map_id INTEGER NOT NULL, area_id INTEGER NOT NULL, floor_id INTEGER NOT NULL, PRIMARY KEY (day, block_id)) STRICT, WITHOUT ROWID;
    CREATE TABLE genres (genre_id INTEGER PRIMARY KEY, name TEXT NOT NULL, code INTEGER, day INTEGER NOT NULL) STRICT;
    CREATE TABLE layouts (block_id INTEGER NOT NULL, space_no INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, orientation INTEGER NOT NULL, map_id INTEGER NOT NULL, hall_id INTEGER, PRIMARY KEY (block_id, space_no)) STRICT, WITHOUT ROWID;
    CREATE TABLE circles (wc_id INTEGER PRIMARY KEY, day INTEGER NOT NULL, block_id INTEGER NOT NULL, space_no INTEGER NOT NULL, space_no_sub INTEGER NOT NULL, genre_id INTEGER NOT NULL, name TEXT NOT NULL, kana TEXT NOT NULL, pen_name TEXT NOT NULL, book_name TEXT NOT NULL, website_url TEXT, description TEXT NOT NULL, twitter_url TEXT, pixiv_url TEXT, update_id INTEGER) STRICT;
    CREATE INDEX circles_location ON circles (day, block_id, space_no, space_no_sub);
    CREATE INDEX circles_name ON circles (name, kana, pen_name);
    CREATE TABLE circle_images (wc_id INTEGER PRIMARY KEY, width INTEGER NOT NULL, height INTEGER NOT NULL, content_type TEXT NOT NULL, byte_count INTEGER NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL) STRICT;
    CREATE TABLE common_images (name TEXT PRIMARY KEY, width INTEGER NOT NULL, height INTEGER NOT NULL, content_type TEXT NOT NULL, byte_count INTEGER NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL) STRICT, WITHOUT ROWID;
    CREATE VIEW ComiketInfoWC AS
      SELECT comiket_no AS comiketNo, event_name AS comiketName,
             cut_width AS cutSizeW, cut_height AS cutSizeH,
             cut_origin_x AS cutOriginX, cut_origin_y AS cutOriginY,
             cut_offset_x AS cutOffsetX, cut_offset_y AS cutOffsetY,
             table_width AS map2SizeW, table_height AS map2SizeH,
             table_origin_x AS map2OriginX, table_origin_y AS map2OriginY
      FROM catalog_metadata;
    CREATE VIEW ComiketDateWC AS
      SELECT metadata.comiket_no AS comiketNo, date.day AS id,
             CAST(substr(date.date_iso, 1, 4) AS INTEGER) AS year,
             CAST(substr(date.date_iso, 6, 2) AS INTEGER) AS month,
             CAST(substr(date.date_iso, 9, 2) AS INTEGER) AS day,
             date.weekday
      FROM dates AS date CROSS JOIN catalog_metadata AS metadata;
    CREATE VIEW ComiketMapWC AS
      SELECT metadata.comiket_no AS comiketNo, map.map_id AS id, map.name,
             map.filename, map.x AS x2, map.y AS y2, map.width AS w2,
             map.height AS h2, map.rotation AS rotate
      FROM maps AS map CROSS JOIN catalog_metadata AS metadata;
    CREATE VIEW ComiketAreaWC AS
      SELECT metadata.comiket_no AS comiketNo, area.area_id AS id, area.name,
             area.simple_name AS simpleName, area.map_id AS mapId,
             area.x AS x2, area.y AS y2, area.width AS w2, area.height AS h2
      FROM areas AS area CROSS JOIN catalog_metadata AS metadata;
    CREATE VIEW ComiketBlockWC AS
      SELECT metadata.comiket_no AS comiketNo, block.block_id AS id,
             block.name, block.area_id AS areaId
      FROM blocks AS block CROSS JOIN catalog_metadata AS metadata;
    CREATE VIEW ComiketFloorWC AS
      SELECT metadata.comiket_no AS comiketNo, floor.floor_id AS id,
             floor.name, floor.day, floor.map_id AS mapId
      FROM floors AS floor CROSS JOIN catalog_metadata AS metadata;
    CREATE VIEW ComiketMappingWC AS
      SELECT metadata.comiket_no AS comiketNo, mapping.day,
             mapping.map_id AS mapId, mapping.area_id AS areaId,
             mapping.floor_id AS floorId, mapping.block_id AS blockId
      FROM mappings AS mapping CROSS JOIN catalog_metadata AS metadata;
    CREATE VIEW ComiketGenreWC AS
      SELECT metadata.comiket_no AS comiketNo, genre.genre_id AS id,
             genre.name, genre.code, genre.day
      FROM genres AS genre CROSS JOIN catalog_metadata AS metadata;
    CREATE VIEW ComiketLayoutWC AS
      SELECT metadata.comiket_no AS comiketNo, layout.block_id AS blockId,
             layout.space_no AS spaceNo, layout.x AS xpos2,
             layout.y AS ypos2, layout.orientation AS layout,
             layout.map_id AS mapId, layout.hall_id AS hallId
      FROM layouts AS layout CROSS JOIN catalog_metadata AS metadata;
    CREATE VIEW ComiketCircleWC AS
      SELECT metadata.comiket_no AS comiketNo, circle.wc_id AS id, circle.day,
             circle.block_id AS blockId, circle.space_no AS spaceNo,
             circle.space_no_sub AS spaceNoSub, circle.genre_id AS genreId,
             circle.name AS circleName, circle.kana AS circleKana,
             circle.pen_name AS penName, circle.book_name AS bookName,
             circle.website_url AS url, circle.description,
             COALESCE(circle.update_id, circle.wc_id) AS updateId,
             NULL AS circlems
      FROM circles AS circle CROSS JOIN catalog_metadata AS metadata;
    CREATE VIEW ComiketCircleExtend AS
      SELECT metadata.comiket_no AS comiketNo, circle.wc_id AS id,
             circle.wc_id AS WCId, circle.twitter_url AS twitterURL,
             circle.pixiv_url AS pixivURL, NULL AS CirclemsPortalURL
      FROM circles AS circle CROSS JOIN catalog_metadata AS metadata;
    CREATE VIEW ComiketCircleImage AS
      SELECT metadata.comiket_no AS comiketNo, image.wc_id AS id,
             image.wc_id AS WCId, image.width, image.height,
             CASE image.content_type WHEN 'image/jpeg' THEN 'jpg'
                  WHEN 'image/webp' THEN 'webp' ELSE 'png' END AS type,
             image.byte_count AS size, image.bytes AS cutImage
      FROM circle_images AS image CROSS JOIN catalog_metadata AS metadata;
    CREATE VIEW ComiketCommonImage AS
      SELECT metadata.comiket_no AS comiketNo, image.name, image.width,
             image.height,
             CASE image.content_type WHEN 'image/jpeg' THEN 'jpg'
                  WHEN 'image/webp' THEN 'webp' ELSE 'png' END AS type,
             image.byte_count AS size, image.bytes AS image
      FROM common_images AS image CROSS JOIN catalog_metadata AS metadata;
    BEGIN IMMEDIATE;
  `);
  let transactionOpen = true;
  try {
    output
      .prepare(
        `INSERT INTO catalog_metadata VALUES
         (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        catalogSchemaVersion,
        metadata.versionID,
        info.comiketNo,
        metadata.eventName,
        metadata.sourceUpdatedAt,
        metadata.mainSHA256,
        metadata.imageSHA256,
        info.cutSizeW,
        info.cutSizeH,
        info.cutOriginX,
        info.cutOriginY,
        info.cutOffsetX,
        info.cutOffsetY,
        info.map2SizeW,
        info.map2SizeH,
        info.map2OriginX,
        info.map2OriginY,
      );
    copySimpleTable(output, main, {
      select:
        "SELECT id, year, month, day, weekday FROM ComiketDateWC ORDER BY id",
      insert: "INSERT INTO dates VALUES (?, ?, ?)",
      values: (row) => [
        row.id,
        isoDate(row.year, row.month, row.day),
        row.weekday,
      ],
    });
    copySimpleTable(output, main, {
      select:
        "SELECT id, name, filename, x2, y2, w2, h2, rotate FROM ComiketMapWC ORDER BY id",
      insert: "INSERT INTO maps VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      values: (row) => [
        row.id,
        text(row.name),
        text(row.filename),
        row.x2,
        row.y2,
        row.w2,
        row.h2,
        row.rotate,
      ],
    });
    copySimpleTable(output, main, {
      select:
        "SELECT id, mapId, name, simpleName, x2, y2, w2, h2 FROM ComiketAreaWC ORDER BY id",
      insert: "INSERT INTO areas VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      values: (row) => [
        row.id,
        row.mapId,
        text(row.name),
        text(row.simpleName),
        row.x2,
        row.y2,
        row.w2,
        row.h2,
      ],
    });
    copySimpleTable(output, main, {
      select: "SELECT id, areaId, name FROM ComiketBlockWC ORDER BY id",
      insert: "INSERT INTO blocks VALUES (?, ?, ?)",
      values: (row) => [row.id, row.areaId, text(row.name)],
    });
    copySimpleTable(output, main, {
      select: "SELECT id, name, day, mapId FROM ComiketFloorWC ORDER BY id",
      insert: "INSERT INTO floors VALUES (?, ?, ?, ?)",
      values: (row) => [row.id, text(row.name), row.day, row.mapId],
    });
    copySimpleTable(output, main, {
      select:
        "SELECT day, blockId, mapId, areaId, floorId FROM ComiketMappingWC ORDER BY day, blockId",
      insert: "INSERT INTO mappings VALUES (?, ?, ?, ?, ?)",
      values: (row) => [
        row.day,
        row.blockId,
        row.mapId,
        row.areaId,
        row.floorId,
      ],
    });
    copySimpleTable(output, main, {
      select: "SELECT id, name, code, day FROM ComiketGenreWC ORDER BY id",
      insert: "INSERT INTO genres VALUES (?, ?, ?, ?)",
      values: (row) => [row.id, text(row.name), row.code, row.day],
    });
    copySimpleTable(output, main, {
      select:
        "SELECT blockId, spaceNo, xpos2, ypos2, layout, mapId, hallId FROM ComiketLayoutWC ORDER BY blockId, spaceNo",
      insert: "INSERT INTO layouts VALUES (?, ?, ?, ?, ?, ?, ?)",
      values: (row) => [
        row.blockId,
        row.spaceNo,
        row.xpos2,
        row.ypos2,
        row.layout,
        row.mapId,
        row.hallId,
      ],
    });
    const circleInsert = output.prepare(
      "INSERT INTO circles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const circle of circles) {
      const links = sanitizeCatalogLinks(
        circle.websiteURL,
        circle.twitterURL,
        circle.pixivURL,
      );
      circleInsert.run(
        circle.wcID,
        circle.day,
        circle.blockID,
        circle.spaceNo,
        circle.spaceNoSub,
        circle.genreID,
        sanitizedText(circle.name, 100),
        sanitizedText(circle.kana, 100),
        sanitizedText(circle.penName, 200),
        sanitizedText(circle.bookName, 200),
        links.websiteURL,
        sanitizedText(circle.description, 4_000),
        links.twitterURL,
        links.pixivURL,
        circle.updateID,
      );
    }
    copyImages(output, image, "circle");
    copyImages(output, image, "common");
    output.exec("COMMIT");
    transactionOpen = false;
    output.exec("VACUUM");
    const quick = output.prepare("PRAGMA quick_check").get() as Record<
      string,
      SQLiteValue
    >;
    if (Object.values(quick)[0] !== "ok")
      fail("Derived catalog failed quick_check.");
  } catch (error) {
    if (transactionOpen) output.exec("ROLLBACK");
    throw error;
  }
}

function copySimpleTable(
  output: DatabaseSync,
  source: DatabaseSync,
  spec: {
    select: string;
    insert: string;
    values: (row: Record<string, SQLiteValue>) => SQLiteValue[];
  },
): void {
  const insert = output.prepare(spec.insert);
  for (const row of iterateRows<Record<string, SQLiteValue>>(
    source.prepare(spec.select),
  )) {
    insert.run(...spec.values(row));
  }
}

function copyImages(
  output: DatabaseSync,
  source: DatabaseSync,
  kind: "circle" | "common",
): void {
  const query =
    kind === "circle"
      ? `SELECT WCId AS wcID, width, height, type, size, cutImage AS bytes
         FROM ComiketCircleImage ORDER BY WCId`
      : `SELECT name, width, height, type, size, image AS bytes
         FROM ComiketCommonImage ORDER BY name`;
  const insert = output.prepare(
    kind === "circle"
      ? "INSERT INTO circle_images VALUES (?, ?, ?, ?, ?, ?, ?)"
      : "INSERT INTO common_images VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of iterateRows<ImageRow>(source.prepare(query))) {
    const detected = detectImage(row.bytes)!;
    insert.run(
      kind === "circle" ? row.wcID! : row.name!,
      row.width,
      row.height,
      detected.contentType,
      row.bytes.byteLength,
      sha256Bytes(row.bytes),
      row.bytes,
    );
  }
}

function openReadOnlyDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA query_only = ON");
  return database;
}

function iterateRows<T>(statement: unknown): Iterable<T> {
  return (statement as { iterate(): Iterable<T> }).iterate();
}

function detectImage(
  bytes: Uint8Array,
): { extension: "png" | "jpg" | "webp"; contentType: string } | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { extension: "jpg", contentType: "image/jpeg" };
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((value, index) => bytes[index] === value))
    return { extension: "png", contentType: "image/png" };
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return { extension: "webp", contentType: "image/webp" };
  }
  return null;
}

function isoDate(
  year: SQLiteValue,
  month: SQLiteValue,
  day: SQLiteValue,
): string {
  const values = [year, month, day].map(Number);
  const date = new Date(Date.UTC(values[0]!, values[1]! - 1, values[2]!));
  if (
    date.getUTCFullYear() !== values[0] ||
    date.getUTCMonth() + 1 !== values[1] ||
    date.getUTCDate() !== values[2]
  ) {
    fail("Catalog date is invalid.");
  }
  return date.toISOString().slice(0, 10);
}

export function sanitizeCatalogLinks(
  website: string | null,
  twitter: string | null,
  pixiv: string | null,
): {
  websiteURL: string | null;
  twitterURL: string | null;
  pixivURL: string | null;
} {
  const websiteTokens = urlTokens(website);
  const twitterURL =
    [...urlTokens(twitter), ...websiteTokens]
      .map(normalizedXURL)
      .find(Boolean) ?? null;
  const pixivURL =
    [...urlTokens(pixiv), ...websiteTokens]
      .map(normalizedPixivURL)
      .find(Boolean) ?? null;
  const websiteURL =
    websiteTokens
      .filter((token) => !normalizedXURL(token) && !normalizedPixivURL(token))
      .map(sanitizedWebsiteURL)
      .find(Boolean) ?? null;
  return { websiteURL, twitterURL, pixivURL };
}

function sanitizedWebsiteURL(value: string | null): string | null {
  const raw = value?.trim() ?? null;
  if (!raw || /(^|[^\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(raw)) {
    return null;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      !host.includes(".") ||
      isIP(host.replace(/^\[|\]$/g, "")) !== 0 ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host.endsWith(".localhost") ||
      host.endsWith(".lan") ||
      host.endsWith(".home") ||
      host.endsWith(".test") ||
      host.endsWith(".invalid") ||
      host.endsWith(".example")
    ) {
      return null;
    }
    if (host === "x.com" || host === "twitter.com" || host === "pixiv.net") {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 2_048);
  } catch {
    return null;
  }
}

function normalizedXURL(value: string | null): string | null {
  const raw = value?.normalize("NFKC").trim();
  if (
    !raw ||
    (raw.includes("@") && /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(raw))
  ) {
    return null;
  }
  const explicitHandle =
    /^(?:https?:\/\/)?@([A-Za-z0-9_]{1,15})(?:\s*\((?:X|Twitter)\))?\/?$/i.exec(
      raw,
    )?.[1];
  if (explicitHandle) return `https://x.com/${explicitHandle}`;
  try {
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      host !== "x.com" &&
      host !== "twitter.com" &&
      host !== "mobile.twitter.com"
    ) {
      return null;
    }
    const handle = url.pathname.split("/").filter(Boolean)[0];
    const reserved = new Set([
      "compose",
      "explore",
      "home",
      "i",
      "intent",
      "messages",
      "notifications",
      "search",
      "settings",
      "share",
    ]);
    if (
      !handle ||
      !/^[A-Za-z0-9_]{1,15}$/.test(handle) ||
      reserved.has(handle.toLowerCase())
    ) {
      return null;
    }
    return `https://x.com/${handle}`;
  } catch {
    return null;
  }
}

function normalizedPixivURL(value: string | null): string | null {
  const raw = value?.normalize("NFKC").trim();
  if (!raw) return null;
  try {
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "pixiv.net") return null;
    const pathID = /^\/users\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
    const queryID =
      url.pathname === "/member.php" ? url.searchParams.get("id") : null;
    const id = pathID ?? queryID;
    if (!id || !/^\d+$/.test(id)) return null;
    return `https://www.pixiv.net/users/${id}`;
  } catch {
    return null;
  }
}

function urlTokens(value: string | null): string[] {
  const normalized = value
    ?.replace(/%20/gi, " ")
    .replaceAll("\u3000", " ")
    .trim();
  return normalized?.split(/[\s、，,;；|｜]+/).filter(Boolean) ?? [];
}

function sanitizedText(value: string | null, maximum: number): string {
  return (value ?? "")
    .replaceAll("\0", "")
    .normalize("NFC")
    .trim()
    .slice(0, maximum);
}

function text(value: SQLiteValue): string {
  return sanitizedText(typeof value === "string" ? value : "", 200);
}

function positiveInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    fail(`${label} must be positive.`);
}

function catalogVersionID(
  comiketNo: number,
  main: string,
  image: string,
): string {
  return `c${comiketNo}-v1-${sha256Bytes(new TextEncoder().encode(`${main}:${image}`)).slice(0, 24)}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function md5File(path: string): Promise<string> {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message: string): never {
  throw new Error(message);
}

export function parseCatalogImportArguments(
  arguments_: string[],
): CatalogImportOptions & {
  manifestPath?: string;
  normalizedManifestPath?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || !value)
      fail("Catalog import arguments must be --key value pairs.");
    values.set(key, value);
  }
  const mainDatabasePath = values.get("--main");
  const imageDatabasePath = values.get("--image");
  if (!mainDatabasePath || !imageDatabasePath)
    fail("--main and --image are required.");
  if (values.has("--source-md5-hint")) {
    fail(
      "--source-md5-hint is ambiguous for decompressed SQLite; use --verified-source-md5-hint only after verifying the provider gzip archives.",
    );
  }
  return {
    mainDatabasePath,
    imageDatabasePath,
    ...(values.get("--output")
      ? { outputDatabasePath: values.get("--output")! }
      : {}),
    ...(values.get("--manifest")
      ? { manifestPath: values.get("--manifest")! }
      : {}),
    ...(values.get("--normalized-manifest")
      ? { normalizedManifestPath: values.get("--normalized-manifest")! }
      : {}),
    ...(values.get("--verified-source-md5-hint")
      ? {
          sourceMD5Hint: values.get("--verified-source-md5-hint")!,
          sourceMD5AlreadyVerified: true,
        }
      : {}),
    ...(values.get("--source-updated-at")
      ? { sourceUpdatedAt: values.get("--source-updated-at")! }
      : {}),
  };
}

async function main(): Promise<void> {
  const options = parseCatalogImportArguments(process.argv.slice(2));
  const bundle = await importCatalog(options);
  const json = `${JSON.stringify(bundle, null, 2)}\n`;
  if (options.manifestPath)
    writeFileSync(options.manifestPath, json, { flag: "wx" });
  else process.stdout.write(json);
  if (options.normalizedManifestPath) {
    if (!options.outputDatabasePath) {
      fail("--normalized-manifest requires --output.");
    }
    writeFileSync(
      options.normalizedManifestPath,
      `${JSON.stringify(readNormalizedCatalogArtifact(options.outputDatabasePath))}\n`,
      { flag: "wx" },
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
