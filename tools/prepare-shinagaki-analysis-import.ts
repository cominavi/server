import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type AnalysisStatus = "complete" | "partial" | "insufficient";

interface AnalysisIndexEntry {
  tweet_id: string;
  tweet_url: string;
  author_handle: string;
  model: string;
  status: AnalysisStatus;
  overall_confidence: number;
  product_count: number;
  offer_count: number;
}

interface AnalysisResult {
  status: AnalysisStatus;
  overall_confidence: number;
  products: unknown[];
  offers: unknown[];
  conflicts: unknown[];
  circle: Record<string, unknown>;
  event: Record<string, unknown>;
  [key: string]: unknown;
}

interface ProductionUpdate {
  stateKind: string;
  confidence: string;
  post: {
    id: string;
    author: { handle: string };
    media: unknown[];
  };
  circles: Array<{ wcID: number }>;
}

interface ProductionSnapshot {
  publicationRevision: string;
  publicationGeneration: number;
  updates: ProductionUpdate[];
}

interface ProductionPostAuthority {
  authorHandle: string;
  confidences: Set<string>;
  stateKinds: Set<string>;
  wcIDs: Set<number>;
  maximumMediaCount: number;
}

interface PreparedRecord {
  postID: string;
  wcID: number;
  authorHandle: string;
  model: string;
  status: AnalysisStatus;
  overallConfidence: number;
  productCount: number;
  offerCount: number;
  conflictCount: number;
  resultSHA256: string;
  resultJSON: string;
}

export interface ShinagakiAnalysisImportOptions {
  archivePath: string;
  extractedDirectory: string;
  productionSnapshotPath: string;
  outputPath: string;
  eventNumber?: number;
  importedAt?: number;
}

export interface ShinagakiAnalysisImportSummary {
  eventNumber: number;
  revision: string;
  sourceArchiveSHA256: string;
  sourceIndexSHA256: string;
  sourceSnapshotRevision: string;
  sourceSnapshotGeneration: number;
  models: Record<string, number>;
  recordCount: number;
  completeCount: number;
  partialCount: number;
  insufficientCount: number;
  productCount: number;
  offerCount: number;
  conflictRecordCount: number;
  conflictCount: number;
  resultJSONBytes: number;
  sqlBytes: number;
  maximumStatementBytes: number;
  outputPath: string;
}

const digestPattern = /^[0-9a-f]{64}$/;
const postIDPattern = /^[0-9]{1,24}$/;
const handlePattern = /^[A-Za-z0-9_]{1,15}$/;
const resultFilePattern = /^[0-9]{1,24}\.json$/;
const maximumSQLStatementBytes = 100_000;

export async function prepareShinagakiAnalysisImport(
  options: ShinagakiAnalysisImportOptions,
): Promise<ShinagakiAnalysisImportSummary> {
  const eventNumber = options.eventNumber ?? 108;
  const importedAt = options.importedAt ?? Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(eventNumber) ||
    eventNumber < 1 ||
    eventNumber > 10_000
  )
    fail("Event number must be an integer from 1 to 10000.");
  if (!Number.isSafeInteger(importedAt) || importedAt < 0)
    fail("Import timestamp must be a nonnegative Unix timestamp.");

  const archivePath = resolve(options.archivePath);
  const extractedDirectory = resolve(options.extractedDirectory);
  const productionSnapshotPath = resolve(options.productionSnapshotPath);
  const outputPath = resolve(options.outputPath);
  const indexPath = join(extractedDirectory, "output/index.jsonl");
  const resultsDirectory = join(extractedDirectory, "output/results");

  const [archiveBytes, indexBytes, snapshotBytes, resultNames] =
    await Promise.all([
      readFile(archivePath),
      readFile(indexPath),
      readFile(productionSnapshotPath),
      readdir(resultsDirectory),
    ]);
  const sourceArchiveSHA256 = sha256(archiveBytes);
  const sourceIndexSHA256 = sha256(indexBytes);
  const indexEntries = parseIndex(indexBytes.toString("utf8"));
  const productionSnapshot = parseProductionSnapshot(
    snapshotBytes.toString("utf8"),
  );
  const productionPosts = productionAuthority(productionSnapshot);

  const resultFiles = resultNames
    .filter((name) => resultFilePattern.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (resultFiles.length === 0)
    fail("The analysis archive has no result files.");
  if (resultFiles.length !== indexEntries.size) {
    fail(
      `Analysis result/index cardinality mismatch: ${resultFiles.length} results, ${indexEntries.size} index rows.`,
    );
  }

  const records: PreparedRecord[] = [];
  const models = new Set<string>();
  for (const resultName of resultFiles) {
    const postID = basename(resultName, ".json");
    const index = indexEntries.get(postID);
    if (!index) fail(`Result ${postID} is missing from output/index.jsonl.`);
    const rawResult = await readFile(
      join(resultsDirectory, resultName),
      "utf8",
    );
    const result = parseAnalysisResult(rawResult, postID);
    const authority = productionPosts.get(postID);
    if (!authority)
      fail(`Analysis post ${postID} is absent from the production snapshot.`);
    validateIndexAndAuthority(index, result, authority);
    const [wcID] = authority.wcIDs;
    if (wcID === undefined) fail(`Analysis post ${postID} has no WCID.`);
    const resultJSON = JSON.stringify(result);
    records.push({
      postID,
      wcID,
      authorHandle: authority.authorHandle,
      model: index.model,
      status: result.status,
      overallConfidence: result.overall_confidence,
      productCount: result.products.length,
      offerCount: result.offers.length,
      conflictCount: result.conflicts.length,
      resultSHA256: sha256(resultJSON),
      resultJSON,
    });
    models.add(index.model);
  }
  for (const postID of indexEntries.keys()) {
    if (!records.some((record) => record.postID === postID))
      fail(`Index post ${postID} is missing its result file.`);
  }
  if (models.size === 0 || models.size > 20)
    fail(`Analysis model count must be from 1 to 20; found ${models.size}.`);
  const modelCounts = Object.fromEntries(
    [...models]
      .sort((left, right) => left.localeCompare(right))
      .map((model) => [
        model,
        records.filter((record) => record.model === model).length,
      ]),
  );
  const modelsJSON = JSON.stringify(modelCounts);

  const revision = analysisRevision({
    eventNumber,
    snapshotRevision: productionSnapshot.publicationRevision,
    snapshotGeneration: productionSnapshot.publicationGeneration,
    records,
  });
  const counts = analysisCounts(records);
  const statements = analysisImportStatements({
    eventNumber,
    importedAt,
    revision,
    sourceArchiveSHA256,
    sourceIndexSHA256,
    sourceSnapshotRevision: productionSnapshot.publicationRevision,
    sourceSnapshotGeneration: productionSnapshot.publicationGeneration,
    modelsJSON,
    modelCount: models.size,
    records,
    counts,
  });
  let maximumStatementBytes = 0;
  for (const statement of statements) {
    const byteCount = Buffer.byteLength(statement);
    maximumStatementBytes = Math.max(maximumStatementBytes, byteCount);
    if (byteCount > maximumSQLStatementBytes) {
      fail(
        `Generated SQL statement exceeds D1's ${maximumSQLStatementBytes}-byte limit: ${byteCount} bytes.`,
      );
    }
  }
  const sql = `${statements.join("\n")}\n`;
  await writeFile(outputPath, sql, { encoding: "utf8", flag: "wx" });

  return {
    eventNumber,
    revision,
    sourceArchiveSHA256,
    sourceIndexSHA256,
    sourceSnapshotRevision: productionSnapshot.publicationRevision,
    sourceSnapshotGeneration: productionSnapshot.publicationGeneration,
    models: modelCounts,
    ...counts,
    sqlBytes: Buffer.byteLength(sql),
    maximumStatementBytes,
    outputPath,
  };
}

function parseIndex(contents: string): Map<string, AnalysisIndexEntry> {
  const entries = new Map<string, AnalysisIndexEntry>();
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fail(`Index line ${index + 1} is not valid JSON.`);
    }
    if (!isRecord(value)) fail(`Index line ${index + 1} is not an object.`);
    const entry: AnalysisIndexEntry = {
      tweet_id: requiredString(value.tweet_id, "index tweet_id"),
      tweet_url: requiredString(value.tweet_url, "index tweet_url"),
      author_handle: requiredString(value.author_handle, "index author_handle"),
      model: requiredString(value.model, "index model"),
      status: analysisStatus(value.status, "index status"),
      overall_confidence: boundedConfidence(
        value.overall_confidence,
        "index overall_confidence",
      ),
      product_count: nonnegativeInteger(
        value.product_count,
        "index product_count",
      ),
      offer_count: nonnegativeInteger(value.offer_count, "index offer_count"),
    };
    if (!postIDPattern.test(entry.tweet_id))
      fail(`Index post ID ${entry.tweet_id} is invalid.`);
    if (!entry.tweet_url.endsWith(`/status/${entry.tweet_id}`))
      fail(`Index URL does not bind post ${entry.tweet_id}.`);
    if (entry.model.trim().length === 0 || entry.model.length > 100)
      fail(`Index model for post ${entry.tweet_id} is invalid.`);
    if (entries.has(entry.tweet_id))
      fail(`Index post ${entry.tweet_id} is duplicated.`);
    entries.set(entry.tweet_id, entry);
  }
  return entries;
}

function parseProductionSnapshot(contents: string): ProductionSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    fail("Production snapshot is not valid JSON.");
  }
  if (!isRecord(value)) fail("Production snapshot is not an object.");
  const publicationRevision = requiredString(
    value.publicationRevision,
    "production publicationRevision",
  );
  const publicationGeneration = positiveInteger(
    value.publicationGeneration,
    "production publicationGeneration",
  );
  if (!digestPattern.test(publicationRevision))
    fail("Production publication revision is invalid.");
  if (!Array.isArray(value.updates))
    fail("Production snapshot updates are missing.");
  return {
    publicationRevision,
    publicationGeneration,
    updates: value.updates as ProductionUpdate[],
  };
}

function productionAuthority(
  snapshot: ProductionSnapshot,
): Map<string, ProductionPostAuthority> {
  const posts = new Map<string, ProductionPostAuthority>();
  for (const update of snapshot.updates) {
    if (
      !isRecord(update) ||
      !isRecord(update.post) ||
      !postIDPattern.test(String(update.post.id)) ||
      !isRecord(update.post.author) ||
      !handlePattern.test(String(update.post.author.handle)) ||
      !Array.isArray(update.post.media) ||
      !Array.isArray(update.circles)
    ) {
      fail("Production snapshot contains an invalid update.");
    }
    const postID = String(update.post.id);
    const authorHandle = String(update.post.author.handle);
    const existing = posts.get(postID) ?? {
      authorHandle,
      confidences: new Set<string>(),
      stateKinds: new Set<string>(),
      wcIDs: new Set<number>(),
      maximumMediaCount: 0,
    };
    if (existing.authorHandle.toLowerCase() !== authorHandle.toLowerCase())
      fail(`Production post ${postID} has inconsistent author handles.`);
    existing.confidences.add(String(update.confidence));
    existing.stateKinds.add(String(update.stateKind));
    existing.maximumMediaCount = Math.max(
      existing.maximumMediaCount,
      update.post.media.length,
    );
    for (const circle of update.circles) {
      if (
        !isRecord(circle) ||
        !Number.isSafeInteger(circle.wcID) ||
        circle.wcID <= 0
      )
        fail(`Production post ${postID} has an invalid WCID.`);
      existing.wcIDs.add(circle.wcID);
    }
    posts.set(postID, existing);
  }
  return posts;
}

function parseAnalysisResult(contents: string, postID: string): AnalysisResult {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    fail(`Analysis result ${postID} is not valid JSON.`);
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value.products) ||
    !Array.isArray(value.offers) ||
    !Array.isArray(value.conflicts) ||
    !isRecord(value.circle) ||
    !isRecord(value.event)
  ) {
    fail(`Analysis result ${postID} is missing required fields.`);
  }
  return {
    ...value,
    status: analysisStatus(value.status, `result ${postID} status`),
    overall_confidence: boundedConfidence(
      value.overall_confidence,
      `result ${postID} overall_confidence`,
    ),
    products: value.products,
    offers: value.offers,
    conflicts: value.conflicts,
    circle: value.circle,
    event: value.event,
  };
}

function validateIndexAndAuthority(
  index: AnalysisIndexEntry,
  result: AnalysisResult,
  authority: ProductionPostAuthority,
): void {
  if (index.status !== result.status)
    fail(`Analysis post ${index.tweet_id} has inconsistent statuses.`);
  if (index.overall_confidence !== result.overall_confidence)
    fail(`Analysis post ${index.tweet_id} has inconsistent confidence.`);
  if (index.product_count !== result.products.length)
    fail(`Analysis post ${index.tweet_id} has inconsistent product counts.`);
  if (index.offer_count !== result.offers.length)
    fail(`Analysis post ${index.tweet_id} has inconsistent offer counts.`);
  if (
    index.author_handle.toLowerCase() !== authority.authorHandle.toLowerCase()
  ) {
    fail(
      `Analysis post ${index.tweet_id} does not match its production author.`,
    );
  }
  if (
    authority.confidences.size !== 1 ||
    !authority.confidences.has("high") ||
    !authority.stateKinds.has("shinagaki") ||
    authority.wcIDs.size !== 1 ||
    authority.maximumMediaCount === 0
  ) {
    fail(
      `Analysis post ${index.tweet_id} is not one high-confidence, media-backed production Shinagaki target.`,
    );
  }
}

function analysisRevision(input: {
  eventNumber: number;
  snapshotRevision: string;
  snapshotGeneration: number;
  records: PreparedRecord[];
}): string {
  const digest = createHash("sha256");
  digest.update("cominavi-shinagaki-analysis-v1\0");
  digest.update(
    `${input.eventNumber}\0${input.snapshotRevision}\0${input.snapshotGeneration}\0`,
  );
  for (const record of input.records) {
    digest.update(
      `${record.postID}\0${record.wcID}\0${record.authorHandle}\0${record.model}\0${record.status}\0${record.overallConfidence}\0${record.productCount}\0${record.offerCount}\0${record.conflictCount}\0${record.resultSHA256}\0`,
    );
  }
  return digest.digest("hex");
}

function analysisCounts(records: PreparedRecord[]) {
  return {
    recordCount: records.length,
    completeCount: records.filter((record) => record.status === "complete")
      .length,
    partialCount: records.filter((record) => record.status === "partial")
      .length,
    insufficientCount: records.filter(
      (record) => record.status === "insufficient",
    ).length,
    productCount: records.reduce(
      (total, record) => total + record.productCount,
      0,
    ),
    offerCount: records.reduce((total, record) => total + record.offerCount, 0),
    conflictRecordCount: records.filter((record) => record.conflictCount > 0)
      .length,
    conflictCount: records.reduce(
      (total, record) => total + record.conflictCount,
      0,
    ),
    resultJSONBytes: records.reduce(
      (total, record) => total + Buffer.byteLength(record.resultJSON),
      0,
    ),
  };
}

function analysisImportStatements(input: {
  eventNumber: number;
  importedAt: number;
  revision: string;
  sourceArchiveSHA256: string;
  sourceIndexSHA256: string;
  sourceSnapshotRevision: string;
  sourceSnapshotGeneration: number;
  modelsJSON: string;
  modelCount: number;
  records: PreparedRecord[];
  counts: ReturnType<typeof analysisCounts>;
}): string[] {
  const { counts } = input;
  const statements = [
    "PRAGMA foreign_keys = ON;",
    `-- Immutable Shinagaki analysis ${input.revision} for C${input.eventNumber}.`,
    `INSERT INTO shinagaki_analysis_versions (event_number,revision,schema_version,source_archive_sha256,source_index_sha256,source_snapshot_revision,source_snapshot_generation,models_json,model_count,record_count,complete_count,partial_count,insufficient_count,product_count,offer_count,conflict_record_count,conflict_count,result_json_bytes,imported_at) VALUES (${input.eventNumber},${quote(input.revision)},1,${quote(input.sourceArchiveSHA256)},${quote(input.sourceIndexSHA256)},${quote(input.sourceSnapshotRevision)},${input.sourceSnapshotGeneration},${quote(input.modelsJSON)},${input.modelCount},${counts.recordCount},${counts.completeCount},${counts.partialCount},${counts.insufficientCount},${counts.productCount},${counts.offerCount},${counts.conflictRecordCount},${counts.conflictCount},${counts.resultJSONBytes},${input.importedAt}) ON CONFLICT(event_number,revision) DO NOTHING;`,
  ];
  for (const record of input.records) {
    statements.push(
      `INSERT INTO shinagaki_analysis_records (event_number,revision,post_id,wc_id,author_handle,model,status,overall_confidence,product_count,offer_count,conflict_count,result_sha256,result_json) VALUES (${input.eventNumber},${quote(input.revision)},${quote(record.postID)},${record.wcID},${quote(record.authorHandle)},${quote(record.model)},${quote(record.status)},${record.overallConfidence},${record.productCount},${record.offerCount},${record.conflictCount},${quote(record.resultSHA256)},${quote(record.resultJSON)}) ON CONFLICT(event_number,revision,post_id) DO NOTHING;`,
    );
  }
  statements.push(
    `INSERT INTO shinagaki_analysis_heads (event_number,revision,updated_at) SELECT version.event_number,version.revision,${input.importedAt} FROM shinagaki_analysis_versions AS version WHERE version.event_number=${input.eventNumber} AND version.revision=${quote(input.revision)} AND version.record_count=(SELECT COUNT(*) FROM shinagaki_analysis_records AS record WHERE record.event_number=version.event_number AND record.revision=version.revision) AND version.complete_count=(SELECT COUNT(*) FROM shinagaki_analysis_records AS record WHERE record.event_number=version.event_number AND record.revision=version.revision AND record.status='complete') AND version.partial_count=(SELECT COUNT(*) FROM shinagaki_analysis_records AS record WHERE record.event_number=version.event_number AND record.revision=version.revision AND record.status='partial') AND version.insufficient_count=(SELECT COUNT(*) FROM shinagaki_analysis_records AS record WHERE record.event_number=version.event_number AND record.revision=version.revision AND record.status='insufficient') AND version.product_count=(SELECT SUM(record.product_count) FROM shinagaki_analysis_records AS record WHERE record.event_number=version.event_number AND record.revision=version.revision) AND version.offer_count=(SELECT SUM(record.offer_count) FROM shinagaki_analysis_records AS record WHERE record.event_number=version.event_number AND record.revision=version.revision) AND version.conflict_record_count=(SELECT COUNT(*) FROM shinagaki_analysis_records AS record WHERE record.event_number=version.event_number AND record.revision=version.revision AND record.conflict_count>0) AND version.conflict_count=(SELECT SUM(record.conflict_count) FROM shinagaki_analysis_records AS record WHERE record.event_number=version.event_number AND record.revision=version.revision) AND version.result_json_bytes=(SELECT SUM(length(CAST(record.result_json AS BLOB))) FROM shinagaki_analysis_records AS record WHERE record.event_number=version.event_number AND record.revision=version.revision) ON CONFLICT(event_number) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at;`,
  );
  return statements;
}

function analysisStatus(value: unknown, label: string): AnalysisStatus {
  if (value === "complete" || value === "partial" || value === "insufficient")
    return value;
  fail(`${label} is invalid.`);
}

function boundedConfidence(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    fail(`${label} must be a number from 0 to 1.`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    fail(`${label} must be a nonnegative integer.`);
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    fail(`${label} must be a positive integer.`);
  return Number(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    fail(`${label} must be a nonempty string.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArguments(arguments_: string[]): ShinagakiAnalysisImportOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || !value)
      fail("Arguments must be --key value pairs.");
    values.set(key, value);
  }
  const archivePath = values.get("--archive");
  const extractedDirectory = values.get("--extracted");
  const productionSnapshotPath = values.get("--production-snapshot");
  const outputPath = values.get("--output");
  if (
    !archivePath ||
    !extractedDirectory ||
    !productionSnapshotPath ||
    !outputPath
  ) {
    fail(
      "--archive, --extracted, --production-snapshot, and --output are required.",
    );
  }
  return {
    archivePath,
    extractedDirectory,
    productionSnapshotPath,
    outputPath,
    ...(values.get("--event-number")
      ? { eventNumber: Number(values.get("--event-number")) }
      : {}),
    ...(values.get("--imported-at")
      ? { importedAt: Number(values.get("--imported-at")) }
      : {}),
  };
}

async function main(): Promise<void> {
  const summary = await prepareShinagakiAnalysisImport(
    parseArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
