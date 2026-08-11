import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  importCatalog,
  readNormalizedCatalogArtifact,
  sanitizeCatalogLinks,
} from "../tools/catalog-import";

test("catalog link sanitation rejects PII and canonicalizes social handles", () => {
  assert.deepEqual(
    sanitizeCatalogLinks("http://@agets_kurokawa (X)", null, null),
    {
      websiteURL: null,
      twitterURL: "https://x.com/agets_kurokawa",
      pixivURL: null,
    },
  );
  assert.deepEqual(
    sanitizeCatalogLinks(
      "https://site.example.jp/path,https://x.com/comma_artist;https://pixiv.net/users/2468|https://later.example.jp",
      null,
      null,
    ),
    {
      websiteURL: "https://site.example.jp/path",
      twitterURL: "https://x.com/comma_artist",
      pixivURL: "https://www.pixiv.net/users/2468",
    },
  );
  for (const unsafe of [
    "http://127.0.0.1/private",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://printer.local/",
    "https://printer.lan/",
    "https://fixture.test/",
    "https://fixture.invalid/",
    "https://fixture.example/",
  ]) {
    assert.deepEqual(sanitizeCatalogLinks(unsafe, null, null), {
      websiteURL: null,
      twitterURL: null,
      pixivURL: null,
    });
  }
  assert.deepEqual(
    sanitizeCatalogLinks(
      "https://site.example.jp、https://x.com/later_artist https://pixiv.net/users/987",
      null,
      null,
    ),
    {
      websiteURL: "https://site.example.jp/",
      twitterURL: "https://x.com/later_artist",
      pixivURL: "https://www.pixiv.net/users/987",
    },
  );
  assert.deepEqual(sanitizeCatalogLinks("https://x.com/compose", null, null), {
    websiteURL: null,
    twitterURL: null,
    pixivURL: null,
  });
  assert.deepEqual(
    sanitizeCatalogLinks(
      "https://www.youtube.com/@Eunjipyo、https://cupick.jp",
      null,
      null,
    ),
    {
      websiteURL: "https://www.youtube.com/@Eunjipyo",
      twitterURL: null,
      pixivURL: null,
    },
  );
  assert.deepEqual(
    sanitizeCatalogLinks(
      "https://thttps//x.com/homewitter.com/path",
      null,
      null,
    ),
    { websiteURL: null, twitterURL: null, pixivURL: null },
  );
  assert.deepEqual(sanitizeCatalogLinks("http://@KiuJony", null, null), {
    websiteURL: null,
    twitterURL: "https://x.com/KiuJony",
    pixivURL: null,
  });
  assert.deepEqual(sanitizeCatalogLinks("@KiuJony (Twitter)", null, null), {
    websiteURL: null,
    twitterURL: "https://x.com/KiuJony",
    pixivURL: null,
  });
  assert.deepEqual(
    sanitizeCatalogLinks(
      "https://circle.example.jp/path?utm_source=circlems#top",
      "https://twitter.com/fixture?t=s&ref_src=twsrc%5Etfw#x",
      "https://www.pixiv.net/member.php?id=12345&utm_source=x",
    ),
    {
      websiteURL: "https://circle.example.jp/path",
      twitterURL: "https://x.com/fixture",
      pixivURL: "https://www.pixiv.net/users/12345",
    },
  );
  assert.deepEqual(
    sanitizeCatalogLinks("http://piisuke9387@icloud.com", null, null),
    { websiteURL: null, twitterURL: null, pixivURL: null },
  );
  assert.deepEqual(
    sanitizeCatalogLinks(
      "https://mastodon.social/@artist?ref=profile",
      null,
      null,
    ),
    {
      websiteURL: "https://mastodon.social/@artist",
      twitterURL: null,
      pixivURL: null,
    },
  );
});

test("catalog importer deterministically creates a complete sanitized artifact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cominavi-catalog-"));
  try {
    const mainPath = join(directory, "source.sqlite");
    const imagePath = join(directory, "images.sqlite");
    createMainFixture(mainPath);
    createImageFixture(imagePath);
    const sourceMD5Hint = `${md5(mainPath)}:${md5(imagePath)}`;
    const firstPath = join(directory, "first.sqlite");
    const secondPath = join(directory, "second.sqlite");
    const first = await importCatalog({
      mainDatabasePath: mainPath,
      imageDatabasePath: imagePath,
      outputDatabasePath: firstPath,
      sourceMD5Hint,
      sourceUpdatedAt: "2026-08-01T00:00:00Z",
    });
    const second = await importCatalog({
      mainDatabasePath: mainPath,
      imageDatabasePath: imagePath,
      outputDatabasePath: secondPath,
      sourceMD5Hint,
      sourceUpdatedAt: "2026-08-01T00:00:00Z",
    });
    assert.equal(first.versionID, second.versionID);
    assert.equal(first.derived?.sha256, second.derived?.sha256);
    assert.deepEqual(readFileSync(firstPath), readFileSync(secondPath));
    assert.equal(first.sourceMD5Hint, sourceMD5Hint);
    assert.equal(first.counts.circles, 1);
    assert.equal(first.counts.circleImages, 1);
    assert.equal(first.sources.main.visibility, "private_source");
    assert.equal(first.derived?.visibility, "authenticated_download");
    assert.deepEqual(
      readNormalizedCatalogArtifact(firstPath).genres.map((row) => ({
        ...row,
      })),
      [
        { genreID: 1, code: 100, day: 1, name: "Original" },
        { genreID: 2, code: 900, day: null, name: "All days" },
      ],
    );

    const artifact = new DatabaseSync(firstPath);
    artifact.exec("PRAGMA query_only = ON");
    assert.equal(
      (artifact.prepare("PRAGMA quick_check").get() as { quick_check: string })
        .quick_check,
      "ok",
    );
    assert.deepEqual(
      {
        ...(artifact
          .prepare(
            `SELECT wc_id, name, website_url, twitter_url, pixiv_url
             FROM circles`,
          )
          .get() as Record<string, unknown>),
      },
      {
        wc_id: 9001,
        name: "Fixture Circle",
        website_url: "https://example.com/",
        twitter_url: "https://x.com/fixture",
        pixiv_url: null,
      },
    );
    const circleColumns = (
      artifact.prepare("PRAGMA table_info(circles)").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    assert.equal(circleColumns.includes("mail_addr"), false);
    assert.equal(circleColumns.includes("circlems_url"), false);
    assert.deepEqual(
      {
        ...(artifact
          .prepare(
            `SELECT content_type, byte_count, length(bytes) AS actual_bytes
             FROM circle_images WHERE wc_id = 9001`,
          )
          .get() as Record<string, unknown>),
      },
      { content_type: "image/png", byte_count: 12, actual_bytes: 12 },
    );
    const fixture = JSON.parse(
      readFileSync("tests/fixtures/sanitized-catalog-v1.json", "utf8"),
    ) as {
      compatibilitySmoke: { query: string; row: Record<string, unknown> };
    };
    assert.deepEqual(
      {
        ...(artifact.prepare(fixture.compatibilitySmoke.query).get() as Record<
          string,
          unknown
        >),
      },
      fixture.compatibilitySmoke.row,
    );
    const compatibilityColumns = (
      artifact.prepare("PRAGMA table_info(ComiketCircleWC)").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    assert.equal(compatibilityColumns.includes("mailAddr"), false);
    assert.equal(compatibilityColumns.includes("memo"), false);
    assert.equal(compatibilityColumns.includes("circlems"), true);
    assert.equal(
      (
        artifact
          .prepare(
            `SELECT circle.circlems, extension.CirclemsPortalURL
             FROM ComiketCircleWC AS circle
             JOIN ComiketCircleExtend AS extension ON extension.id = circle.id`,
          )
          .get() as { circlems: null; CirclemsPortalURL: null }
      ).circlems,
      null,
    );
    artifact.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("catalog importer rejects either mismatched upstream MD5 hint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cominavi-catalog-md5-"));
  try {
    const mainPath = join(directory, "source.sqlite");
    const imagePath = join(directory, "images.sqlite");
    createMainFixture(mainPath);
    createImageFixture(imagePath);
    await assert.rejects(
      importCatalog({
        mainDatabasePath: mainPath,
        imageDatabasePath: imagePath,
        sourceMD5Hint: `${"0".repeat(32)}:${md5(imagePath)}`,
      }),
      /MD5 change hints/,
    );
    await assert.rejects(
      importCatalog({
        mainDatabasePath: mainPath,
        imageDatabasePath: imagePath,
        sourceMD5Hint: `${md5(mainPath)}:${"0".repeat(32)}`,
      }),
      /MD5 change hints/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("catalog importer rejects malformed image bytes and removes partial output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cominavi-catalog-invalid-"));
  try {
    const mainPath = join(directory, "source.sqlite");
    const imagePath = join(directory, "images.sqlite");
    const outputPath = join(directory, "derived.sqlite");
    createMainFixture(mainPath);
    createImageFixture(
      imagePath,
      Uint8Array.from({ length: 12 }, () => 1),
    );
    await assert.rejects(
      importCatalog({
        mainDatabasePath: mainPath,
        imageDatabasePath: imagePath,
        outputDatabasePath: outputPath,
      }),
      /magic bytes/,
    );
    assert.throws(() => readFileSync(outputPath));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a structurally valid but empty catalog cannot replace a usable version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cominavi-catalog-empty-"));
  try {
    const mainPath = join(directory, "source.sqlite");
    const imagePath = join(directory, "images.sqlite");
    createMainFixture(mainPath);
    createImageFixture(imagePath);
    const main = new DatabaseSync(mainPath);
    for (const table of [
      "ComiketDateWC",
      "ComiketMapWC",
      "ComiketAreaWC",
      "ComiketBlockWC",
      "ComiketFloorWC",
      "ComiketMappingWC",
      "ComiketGenreWC",
      "ComiketLayoutWC",
      "ComiketCircleWC",
      "ComiketCircleExtend",
    ]) {
      main.exec(`DELETE FROM ${table}`);
    }
    main.close();
    const image = new DatabaseSync(imagePath);
    image.exec(
      "DELETE FROM ComiketCircleImage; DELETE FROM ComiketCommonImage",
    );
    image.close();
    await assert.rejects(
      importCatalog({
        mainDatabasePath: mainPath,
        imageDatabasePath: imagePath,
      }),
      /no usable/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createMainFixture(path: string): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE ComiketInfoWC (comiketNo INTEGER, comiketName TEXT,
      cutSizeW INTEGER, cutSizeH INTEGER, cutOriginX INTEGER, cutOriginY INTEGER,
      cutOffsetX INTEGER, cutOffsetY INTEGER, map2SizeW INTEGER,
      map2SizeH INTEGER, map2OriginX INTEGER, map2OriginY INTEGER);
    CREATE TABLE ComiketDateWC (comiketNo INTEGER, id INTEGER, year INTEGER,
      month INTEGER, day INTEGER, weekday INTEGER);
    CREATE TABLE ComiketMapWC (comiketNo INTEGER, id INTEGER, name TEXT,
      filename TEXT, x2 INTEGER, y2 INTEGER, w2 INTEGER, h2 INTEGER,
      rotate INTEGER);
    CREATE TABLE ComiketAreaWC (comiketNo INTEGER, id INTEGER, mapId INTEGER,
      name TEXT, simpleName TEXT, x2 INTEGER, y2 INTEGER, w2 INTEGER, h2 INTEGER);
    CREATE TABLE ComiketBlockWC (comiketNo INTEGER, id INTEGER, areaId INTEGER,
      name TEXT);
    CREATE TABLE ComiketFloorWC (comiketNo INTEGER, id INTEGER, name TEXT,
      day INTEGER, mapId INTEGER);
    CREATE TABLE ComiketMappingWC (comiketNo INTEGER, day INTEGER,
      blockId INTEGER, mapId INTEGER, areaId INTEGER, floorId INTEGER);
    CREATE TABLE ComiketGenreWC (comiketNo INTEGER, id INTEGER, name TEXT,
      code INTEGER, day INTEGER);
    CREATE TABLE ComiketLayoutWC (comiketNo INTEGER, blockId INTEGER,
      spaceNo INTEGER, xpos2 INTEGER, ypos2 INTEGER, layout INTEGER,
      mapId INTEGER, hallId INTEGER);
    CREATE TABLE ComiketCircleWC (comiketNo INTEGER, id INTEGER, day INTEGER,
      blockId INTEGER, spaceNo INTEGER, spaceNoSub INTEGER, genreId INTEGER,
      circleName TEXT, circleKana TEXT, penName TEXT, bookName TEXT, url TEXT,
      description TEXT, updateId INTEGER);
    CREATE TABLE ComiketCircleExtend (comiketNo INTEGER, id INTEGER,
      WCId INTEGER, twitterURL TEXT, pixivURL TEXT);
    INSERT INTO ComiketInfoWC VALUES
      (108, 'Comic Market 108', 211, 300, 1, 2, 3, 4, 1000, 800, 10, 20);
    INSERT INTO ComiketDateWC VALUES (108, 1, 2026, 8, 15, 7);
    INSERT INTO ComiketMapWC VALUES (108, 1, 'East', 'east.png', 0, 0, 1000, 800, 0);
    INSERT INTO ComiketAreaWC VALUES (108, 1, 1, 'East 1', 'E1', 0, 0, 500, 400);
    INSERT INTO ComiketBlockWC VALUES (108, 1, 1, 'A');
    INSERT INTO ComiketFloorWC VALUES (108, 1, 'East day 1', 1, 1);
    INSERT INTO ComiketMappingWC VALUES (108, 1, 1, 1, 1, 1);
    INSERT INTO ComiketGenreWC VALUES
      (108, 1, 'Original', 100, 1),
      (108, 2, 'All days', 900, 0);
    INSERT INTO ComiketLayoutWC VALUES (108, 1, 1, 100, 200, 1, 1, 1);
    INSERT INTO ComiketCircleWC VALUES
      (108, 1, 1, 1, 1, 0, 1, 'Fixture Circle', 'fixture', 'Pen', 'Book',
       'https://example.com', 'Description', 4);
    INSERT INTO ComiketCircleExtend VALUES
      (108, 1, 9001, 'https://x.com/fixture', 'javascript:bad');
  `);
  database.close();
}

function createImageFixture(
  path: string,
  bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
  ]),
): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE ComiketCircleImage (WCId INTEGER, width INTEGER,
      height INTEGER, type TEXT, size INTEGER, cutImage BLOB);
    CREATE TABLE ComiketCommonImage (name TEXT, width INTEGER,
      height INTEGER, type TEXT, size INTEGER, image BLOB);
  `);
  database
    .prepare(
      "INSERT INTO ComiketCircleImage VALUES (9001, 211, 300, 'png', ?, ?)",
    )
    .run(bytes.byteLength, bytes);
  database
    .prepare(
      "INSERT INTO ComiketCommonImage VALUES ('east.png', 1000, 800, 'png', ?, ?)",
    )
    .run(bytes.byteLength, bytes);
  database.close();
}

function md5(path: string): string {
  return createHash("md5")
    .update(Uint8Array.from(readFileSync(path)))
    .digest("hex");
}
