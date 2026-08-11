import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  parseCatalogPublisherArguments,
  validatePublisherBaseURL,
} from "../tools/publish-catalog";
import {
  assertCatalogBuilderRuntime,
  parseCatalogImportArguments,
} from "../tools/catalog-import";
import {
  decompressGzipArchive,
  downloadPrivateSource,
  acquireCatalogRefreshRunLock,
  renewRefresh,
  verifyArchiveMD5Pair,
} from "../tools/run-catalog-refresh";

test("publisher commands require HTTPS and never send authority to arbitrary HTTP", () => {
  assert.equal(
    validatePublisherBaseURL("https://catalog.example").protocol,
    "https:",
  );
  assert.equal(
    validatePublisherBaseURL("http://127.0.0.1:8787").protocol,
    "http:",
  );
  assert.throws(() => validatePublisherBaseURL("http://catalog.example"));
  assert.throws(() =>
    validatePublisherBaseURL("https://user:secret@catalog.example"),
  );
});

test("manual SQLite tools reject ambiguous provider archive MD5 flags", () => {
  assert.throws(() =>
    parseCatalogImportArguments([
      "--main",
      "main.sqlite",
      "--image",
      "image.sqlite",
      "--source-md5-hint",
      `${"a".repeat(32)}:${"b".repeat(32)}`,
    ]),
  );
  assert.throws(() =>
    parseCatalogPublisherArguments([
      "--base-url",
      "https://catalog.example",
      "--claim-id",
      "11111111-1111-4111-8111-111111111111",
      "--main",
      "main.sqlite",
      "--image",
      "image.sqlite",
      "--output",
      "derived.sqlite",
      "--state",
      "state.json",
      "--source-md5-hint",
      `${"a".repeat(32)}:${"b".repeat(32)}`,
    ]),
  );
});

test("catalog builder refuses a SQLite runtime outside the pinned Node release", () => {
  assert.doesNotThrow(() => assertCatalogBuilderRuntime("26.3.0"));
  assert.throws(
    () => assertCatalogBuilderRuntime("26.4.0"),
    /Node\.js 26\.3\.0/,
  );
});

test("source downloads resume an exact prefix with Range and a reminted URL", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cominavi-download-test-"));
  try {
    const path = join(directory, "source.sqlite.gz");
    writeFileSync(path, "hello ", { mode: 0o600 });
    writeFileSync(
      `${path}.download.json`,
      JSON.stringify({ validator: '"v1"', totalBytes: 11, complete: false }),
      { mode: 0o600 },
    );
    let minted = 0;
    let fetched = 0;
    await downloadPrivateSource(
      async () => {
        minted += 1;
        return `https://downloads.example/fresh-${minted}`;
      },
      path,
      async (_input, init) => {
        fetched += 1;
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("Range"), "bytes=6-");
        assert.equal(headers.get("If-Range"), '"v1"');
        return new Response("world", {
          status: 206,
          headers: {
            "Content-Range": "bytes 6-10/11",
            "Content-Length": "5",
            ETag: '"v1"',
          },
        });
      },
    );
    assert.equal(readFileSync(path, "utf8"), "hello world");
    assert.equal(minted, 1);
    await downloadPrivateSource(
      async () => {
        throw new Error("a completed restart must not remint or redownload");
      },
      path,
      async () => {
        fetched += 1;
        throw new Error("unexpected fetch");
      },
    );
    assert.equal(fetched, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider MD5 covers gzip archives before bounded SQLite decompression", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cominavi-gzip-test-"));
  try {
    const mainBytes = new TextEncoder().encode("SQLite format 3\0main fixture");
    const imageBytes = new TextEncoder().encode(
      "SQLite format 3\0image fixture",
    );
    const mainArchive = Uint8Array.from(gzipSync(mainBytes));
    const imageArchive = Uint8Array.from(gzipSync(imageBytes));
    const mainArchivePath = join(directory, "main.sqlite.gz");
    const imageArchivePath = join(directory, "image.sqlite.gz");
    writeFileSync(mainArchivePath, mainArchive);
    writeFileSync(imageArchivePath, imageArchive);
    const md5 = (bytes: Uint8Array<ArrayBuffer>) =>
      createHash("md5").update(bytes).digest("hex");
    await verifyArchiveMD5Pair(
      mainArchivePath,
      imageArchivePath,
      `${md5(mainArchive)}:${md5(imageArchive)}`,
    );
    await assert.rejects(
      verifyArchiveMD5Pair(
        mainArchivePath,
        imageArchivePath,
        `${"0".repeat(32)}:${md5(imageArchive)}`,
      ),
    );
    const mainPath = join(directory, "main.sqlite");
    const imagePath = join(directory, "image.sqlite");
    await decompressGzipArchive(mainArchivePath, mainPath);
    await decompressGzipArchive(imageArchivePath, imagePath);
    assert.deepEqual(Uint8Array.from(readFileSync(mainPath)), mainBytes);
    assert.deepEqual(Uint8Array.from(readFileSync(imagePath)), imageBytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lease renewal persists and exactly retries one command after response loss", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cominavi-renew-test-"));
  try {
    const activePath = join(directory, "active-refresh.json");
    const active = {
      leaseID: "11111111-1111-4111-8111-111111111111",
      phase: "working" as const,
      jobID: "22222222-2222-4222-8222-222222222222",
    };
    writeFileSync(activePath, JSON.stringify(active), { mode: 0o600 });
    const requests: Array<{ key: string | null; body: string }> = [];
    await renewRefresh(
      "http://127.0.0.1:8787",
      "s".repeat(32),
      active,
      activePath,
      `${"a".repeat(32)}:${"b".repeat(32)}`,
      async (_input, init) => {
        requests.push({
          key: new Headers(init?.headers).get("Idempotency-Key"),
          body: String(init?.body),
        });
        const persisted = JSON.parse(readFileSync(activePath, "utf8")) as {
          pendingRenewalID?: string;
        };
        assert.match(
          persisted.pendingRenewalID ?? "",
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        if (requests.length === 1) throw new Error("response lost");
        return Response.json({ accepted: true, leaseExpiresAt: 9_999 });
      },
    );
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(
      "pendingRenewalID" in
        (JSON.parse(readFileSync(activePath, "utf8")) as object),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("OS advisory locking admits one runner and never wedges on stale file bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cominavi-run-lock-test-"));
  try {
    const first = await acquireCatalogRefreshRunLock(directory);
    await assert.rejects(
      acquireCatalogRefreshRunLock(directory),
      /Another catalog refresh runner/,
    );
    await first.release();
    const second = await acquireCatalogRefreshRunLock(directory);
    await second.release();
    writeFileSync(
      join(directory, ".catalog-refresh.lock"),
      "stale-or-truncated-owner-bytes",
      { mode: 0o600 },
    );
    const stale = await acquireCatalogRefreshRunLock(directory);
    await stale.release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unexpected advisory-lock helper exit is fatal to the owning runner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cominavi-run-lock-loss-test-"));
  try {
    let lost: Error | null = null;
    const first = await acquireCatalogRefreshRunLock(directory, (error) => {
      lost = error;
    });
    process.kill(first.helperPID, "SIGKILL");
    for (let attempt = 0; attempt < 50 && !lost; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(lost);
    assert.match((lost as Error).message, /exited unexpectedly/);
    const successor = await acquireCatalogRefreshRunLock(directory);
    await successor.release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
