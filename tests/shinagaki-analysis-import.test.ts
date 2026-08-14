import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { prepareShinagakiAnalysisImport } from "../tools/prepare-shinagaki-analysis-import";

test("Shinagaki analysis import binds raw results to production WCIDs and activates only a complete version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cominavi-shinagaki-analysis-"));
  try {
    const extracted = join(directory, "extracted");
    const results = join(extracted, "output/results");
    mkdirSync(results, { recursive: true });
    const archivePath = join(directory, "analysis.tar");
    const snapshotPath = join(directory, "production.json");
    const outputPath = join(directory, "import.sql");
    writeFileSync(archivePath, "fixture archive bytes");

    const complete = analysisResult("complete", 0.98, 2, 1, 0);
    const partial = analysisResult("partial", 0.84, 1, 2, 1);
    writeFileSync(join(results, "101.json"), JSON.stringify(complete, null, 2));
    writeFileSync(join(results, "102.json"), JSON.stringify(partial, null, 2));
    writeFileSync(
      join(extracted, "output/index.jsonl"),
      `${JSON.stringify(indexRow("101", "Alpha", "complete", 0.98, 2, 1))}\n${JSON.stringify(indexRow("102", "Beta", "partial", 0.84, 1, 2))}\n`,
    );
    const snapshotRevision = "a".repeat(64);
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        publicationRevision: snapshotRevision,
        publicationGeneration: 2,
        updates: [
          productionUpdate("101", "Alpha", 9001, "shinagaki"),
          productionUpdate("102", "Beta", 9002, "cover"),
          productionUpdate("102", "Beta", 9002, "shinagaki"),
        ],
      }),
    );

    const summary = await prepareShinagakiAnalysisImport({
      archivePath,
      extractedDirectory: extracted,
      productionSnapshotPath: snapshotPath,
      outputPath,
      eventNumber: 108,
      importedAt: 1_786_700_000,
    });
    assert.equal(summary.recordCount, 2);
    assert.equal(summary.completeCount, 1);
    assert.equal(summary.partialCount, 1);
    assert.equal(summary.insufficientCount, 0);
    assert.equal(summary.productCount, 3);
    assert.equal(summary.offerCount, 3);
    assert.equal(summary.conflictRecordCount, 1);
    assert.equal(summary.conflictCount, 1);
    assert.deepEqual(summary.models, { "gpt-fixture": 2 });
    assert.equal(summary.sourceSnapshotRevision, snapshotRevision);
    assert.match(summary.revision, /^[0-9a-f]{64}$/);
    assert.ok(summary.maximumStatementBytes < 100_000);

    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE crawler_snapshot_versions (
        event_number INTEGER NOT NULL,
        revision TEXT NOT NULL,
        PRIMARY KEY (event_number, revision)
      );
      CREATE TABLE catalog_stable_circles (
        comiket_no INTEGER NOT NULL,
        wc_id INTEGER NOT NULL,
        PRIMARY KEY (comiket_no, wc_id)
      );
      INSERT INTO crawler_snapshot_versions VALUES (108, '${snapshotRevision}');
      INSERT INTO catalog_stable_circles VALUES (108, 9001), (108, 9002);
    `);
    database.exec(
      readFileSync("migrations/0010_shinagaki_analysis.sql", "utf8"),
    );
    const sql = readFileSync(outputPath, "utf8");
    database.exec(sql);
    database.exec(sql);

    assert.deepEqual(
      database
        .prepare(
          `SELECT event_number, revision, record_count, product_count,
                  offer_count, conflict_record_count, conflict_count
           FROM shinagaki_analysis_versions`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          event_number: 108,
          revision: summary.revision,
          record_count: 2,
          product_count: 3,
          offer_count: 3,
          conflict_record_count: 1,
          conflict_count: 1,
        },
      ],
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT post_id, wc_id, author_handle, model, status, product_count,
                  offer_count, conflict_count, json_valid(result_json) AS valid
           FROM shinagaki_analysis_records ORDER BY post_id`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          post_id: "101",
          wc_id: 9001,
          author_handle: "Alpha",
          model: "gpt-fixture",
          status: "complete",
          product_count: 2,
          offer_count: 1,
          conflict_count: 0,
          valid: 1,
        },
        {
          post_id: "102",
          wc_id: 9002,
          author_handle: "Beta",
          model: "gpt-fixture",
          status: "partial",
          product_count: 1,
          offer_count: 2,
          conflict_count: 1,
          valid: 1,
        },
      ],
    );
    assert.deepEqual(
      database
        .prepare("SELECT event_number, revision FROM shinagaki_analysis_heads")
        .all()
        .map((row) => ({ ...row })),
      [{ event_number: 108, revision: summary.revision }],
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function indexRow(
  postID: string,
  handle: string,
  status: "complete" | "partial",
  confidence: number,
  productCount: number,
  offerCount: number,
) {
  return {
    tweet_id: postID,
    tweet_url: `https://x.com/${handle}/status/${postID}`,
    author_handle: handle,
    model: "gpt-fixture",
    status,
    overall_confidence: confidence,
    product_count: productCount,
    offer_count: offerCount,
  };
}

function analysisResult(
  status: "complete" | "partial",
  confidence: number,
  productCount: number,
  offerCount: number,
  conflictCount: number,
) {
  return {
    circle: { circle_name: "Fixture" },
    conflicts: Array.from({ length: conflictCount }, () => ({
      field: "price",
    })),
    event: { name: "コミックマーケット108" },
    genre_analysis: {},
    missing_information: [],
    offers: Array.from({ length: offerCount }, (_, index) => ({ id: index })),
    overall_confidence: confidence,
    products: Array.from({ length: productCount }, (_, index) => ({
      id: index,
    })),
    purchase_summary: {},
    status,
    uncertainties: [],
  };
}

function productionUpdate(
  postID: string,
  handle: string,
  wcID: number,
  stateKind: "shinagaki" | "cover",
) {
  return {
    stateKind,
    confidence: "high",
    post: {
      id: postID,
      author: { handle },
      media: [{ key: `${postID}-media` }],
    },
    circles: [{ wcID }],
  };
}
