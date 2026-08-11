import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import { publishCatalog, validatePublisherBaseURL } from "./publish-catalog";

const maximumCompressedBytes = 1_500_000_000;
const maximumDecompressedBytes = 2_000_000_000;
const canonicalUUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface RefreshJob {
  id: string;
  comiketNo: number;
  sourceMD5Hint: string;
  sourceMainURL: string;
  sourceImageURL: string;
  sourceUpdatedAt?: number;
}

interface ActiveState {
  leaseID: string;
  phase: "leasing" | "working" | "completing" | "releasing";
  jobID?: string;
  versionID?: string;
  errorCode?: string;
  pendingRenewalID?: string;
}

interface DownloadState {
  validator: string | null;
  totalBytes: number | null;
  complete: boolean;
}

export async function runCatalogRefresh(
  baseURL: string,
  workRoot: string,
  recoveryDepth = 0,
): Promise<void> {
  validatePublisherBaseURL(baseURL);
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const lock = await acquireCatalogRefreshRunLock(workRoot);
  try {
    await runCatalogRefreshLocked(baseURL, workRoot, recoveryDepth);
  } finally {
    await lock.release();
  }
}

async function runCatalogRefreshLocked(
  baseURL: string,
  workRoot: string,
  recoveryDepth: number,
): Promise<void> {
  const secret = process.env.COMINAVI_CATALOG_SCHEDULED_PUBLISH_SECRET ?? "";
  if (secret.length < 32) {
    throw new Error(
      "COMINAVI_CATALOG_SCHEDULED_PUBLISH_SECRET must be configured.",
    );
  }
  const activePath = join(workRoot, "active-refresh.json");
  let active = loadActiveState(activePath) ?? {
    leaseID: randomUUID(),
    phase: "leasing",
  };
  saveJSON(activePath, active);

  if (active.phase === "completing") {
    try {
      await completeRefresh(baseURL, secret, active);
    } catch (error) {
      if (recoveryDepth < 1 && isAuthorityLost(error)) {
        rmSync(activePath, { force: true });
        return runCatalogRefreshLocked(baseURL, workRoot, recoveryDepth + 1);
      }
      throw error;
    }
    cleanupCompletedWork(workRoot, active, activePath);
    process.stdout.write(
      `${JSON.stringify({ processed: true, versionID: active.versionID, replayed: true })}\n`,
    );
    return;
  }
  if (active.phase === "releasing") {
    try {
      await releaseRefresh(baseURL, secret, active);
    } catch (error) {
      if (recoveryDepth < 1 && isAuthorityLost(error)) {
        rmSync(activePath, { force: true });
        return runCatalogRefreshLocked(baseURL, workRoot, recoveryDepth + 1);
      }
      throw error;
    }
    rmSync(activePath, { force: true });
    active = { leaseID: randomUUID(), phase: "leasing" };
    saveJSON(activePath, active);
  }

  let leased: { job: RefreshJob | null };
  try {
    leased = await leaseRefresh(baseURL, secret, active.leaseID);
  } catch (error) {
    if (recoveryDepth < 1 && isAuthorityLost(error)) {
      rmSync(activePath, { force: true });
      return runCatalogRefreshLocked(baseURL, workRoot, recoveryDepth + 1);
    }
    throw error;
  }
  if (!leased.job) {
    rmSync(activePath, { force: true });
    process.stdout.write(`${JSON.stringify({ processed: false })}\n`);
    return;
  }
  const job = leased.job;
  if (!canonicalUUID.test(job.id)) throw new Error("Invalid refresh job ID.");
  if (active.jobID && active.jobID !== job.id) {
    throw new Error("Refresh lease replay returned a different job.");
  }
  active = { ...active, phase: "working", jobID: job.id };
  saveJSON(activePath, active);
  const directory = join(workRoot, job.id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  try {
    const currentJob = async (): Promise<RefreshJob> => {
      await renewRefresh(
        baseURL,
        secret,
        active,
        activePath,
        job.sourceMD5Hint,
      );
      const refreshed = await leaseRefresh(baseURL, secret, active.leaseID);
      if (
        !refreshed.job ||
        refreshed.job.id !== job.id ||
        refreshed.job.sourceMD5Hint !== job.sourceMD5Hint
      ) {
        throw new Error("Refresh source authority changed during download.");
      }
      return refreshed.job;
    };
    const mainArchive = join(directory, "source-main.sqlite.gz");
    const imageArchive = join(directory, "source-image.sqlite.gz");
    await downloadPrivateSource(
      async () => (await currentJob()).sourceMainURL,
      mainArchive,
    );
    await downloadPrivateSource(
      async () => (await currentJob()).sourceImageURL,
      imageArchive,
    );
    await verifyArchiveMD5Pair(mainArchive, imageArchive, job.sourceMD5Hint);
    const mainPath = join(directory, "source-main.sqlite");
    const imagePath = join(directory, "source-image.sqlite");
    await renewRefresh(baseURL, secret, active, activePath, job.sourceMD5Hint);
    await decompressGzipArchive(mainArchive, mainPath);
    await renewRefresh(baseURL, secret, active, activePath, job.sourceMD5Hint);
    await decompressGzipArchive(imageArchive, imagePath);
    await renewRefresh(baseURL, secret, active, activePath, job.sourceMD5Hint);
    const versionID = await publishCatalog({
      baseURL,
      claimID: job.id,
      leaseID: active.leaseID,
      mainPath,
      imagePath,
      outputPath: join(directory, "derived.sqlite"),
      statePath: join(directory, "publication-state.json"),
      sourceMD5Hint: job.sourceMD5Hint,
      sourceMD5AlreadyVerified: true,
      renewLease: () =>
        renewRefresh(baseURL, secret, active, activePath, job.sourceMD5Hint),
      ...(job.sourceUpdatedAt
        ? {
            sourceUpdatedAt: new Date(
              job.sourceUpdatedAt * 1_000,
            ).toISOString(),
          }
        : {}),
    });
    active = { ...active, phase: "completing", versionID };
    saveJSON(activePath, active);
    await completeRefresh(baseURL, secret, active);
    cleanupCompletedWork(workRoot, active, activePath);
    process.stdout.write(`${JSON.stringify({ processed: true, versionID })}\n`);
  } catch (error) {
    active = {
      ...active,
      phase: "releasing",
      errorCode: "trusted_runner_failed",
    };
    saveJSON(activePath, active);
    await releaseRefresh(baseURL, secret, active).catch(() => undefined);
    throw error;
  }
}

export interface CatalogRefreshRunLock {
  helperPID: number;
  release(): Promise<void>;
}

export async function acquireCatalogRefreshRunLock(
  workRoot: string,
  onUnexpectedExit: (error: Error) => void = (error) => {
    queueMicrotask(() => {
      throw error;
    });
  },
): Promise<CatalogRefreshRunLock> {
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const path = join(workRoot, ".catalog-refresh.lock");
  const helper =
    'process.stdout.write("cominavi-lock-ready\\n");' +
    "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
  const command = process.platform === "darwin" ? "/usr/bin/lockf" : "flock";
  const arguments_ =
    process.platform === "darwin"
      ? ["-t", "0", "-k", path, process.execPath, "-e", helper]
      : ["-n", path, process.execPath, "-e", helper];
  const child = spawn(command, arguments_, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let acquired = false;
  let releasing = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Catalog refresh runner lock acquisition timed out."));
    }, 5_000);
    const finishStartup = (callback: () => void) => {
      clearTimeout(timeout);
      child.stdout.removeAllListeners();
      callback();
    };
    child.once("error", (error) => {
      if (!acquired) finishStartup(() => reject(error));
      else if (!releasing) onUnexpectedExit(error);
    });
    child.once("exit", () => {
      if (!acquired) {
        finishStartup(() =>
          reject(
            new Error(
              `Another catalog refresh runner owns this work root.${
                stderr.trim() ? ` ${stderr.trim()}` : ""
              }`,
            ),
          ),
        );
      } else if (!releasing) {
        onUnexpectedExit(
          new Error(
            "The catalog refresh advisory-lock helper exited unexpectedly.",
          ),
        );
      }
    });
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (value: string) => {
      if (value.startsWith("cominavi-lock-ready")) {
        acquired = true;
        finishStartup(resolve);
      } else
        finishStartup(() =>
          reject(
            new Error("Catalog refresh lock helper did not become ready."),
          ),
        );
    });
  });
  if (!child.pid) throw new Error("Catalog refresh lock helper has no PID.");
  return {
    helperPID: child.pid,
    release: async () => {
      if (child.exitCode !== null) return;
      releasing = true;
      child.stdin.end();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  };
}

async function leaseRefresh(
  baseURL: string,
  secret: string,
  leaseID: string,
): Promise<{ job: RefreshJob | null }> {
  return signedJSON(
    baseURL,
    secret,
    leaseID,
    "/api/v2/internal/catalog-refresh-jobs",
    { schemaVersion: 1, action: "lease", leaseID },
    "lease",
  );
}

async function completeRefresh(
  baseURL: string,
  secret: string,
  active: ActiveState,
): Promise<void> {
  if (!active.jobID || !active.versionID)
    throw new Error("Invalid completion state.");
  await signedJSON(
    baseURL,
    secret,
    active.leaseID,
    "/api/v2/internal/catalog-refresh-jobs",
    {
      schemaVersion: 1,
      action: "complete",
      jobID: active.jobID,
      leaseID: active.leaseID,
      versionID: active.versionID,
    },
    "complete",
  );
}

export async function renewRefresh(
  baseURL: string,
  secret: string,
  active: ActiveState,
  activePath: string,
  sourceMD5Hint: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!active.jobID) throw new Error("Invalid renewal state.");
  active.pendingRenewalID ??= randomUUID();
  saveJSON(activePath, active);
  const request = {
    schemaVersion: 1,
    action: "renew",
    jobID: active.jobID,
    leaseID: active.leaseID,
    sourceMD5Hint,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await signedJSON<{ leaseExpiresAt: number }>(
        baseURL,
        secret,
        active.leaseID,
        "/api/v2/internal/catalog-refresh-jobs",
        request,
        `renew:${active.pendingRenewalID}`,
        fetcher,
      );
      if (!Number.isSafeInteger(result.leaseExpiresAt)) {
        throw new Error("Catalog refresh renewal response is invalid.");
      }
      delete active.pendingRenewalID;
      saveJSON(activePath, active);
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

async function releaseRefresh(
  baseURL: string,
  secret: string,
  active: ActiveState,
): Promise<void> {
  if (!active.jobID || !active.errorCode)
    throw new Error("Invalid release state.");
  await signedJSON(
    baseURL,
    secret,
    active.leaseID,
    "/api/v2/internal/catalog-refresh-jobs",
    {
      schemaVersion: 1,
      action: "release",
      jobID: active.jobID,
      leaseID: active.leaseID,
      errorCode: active.errorCode,
    },
    "release",
  );
}

// Download state is persisted before streaming. A crash leaves the exact byte
// prefix plus validator, and the next process remints a provider URL before a
// validated Range continuation.
export async function downloadPrivateSource(
  loadURL: () => Promise<string>,
  path: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const statePath = `${path}.download.json`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = loadDownloadState(statePath);
    const existingBytes = existsSync(path) ? statSync(path).size : 0;
    if (
      state?.complete &&
      state.totalBytes !== null &&
      state.totalBytes === existingBytes
    ) {
      return;
    }
    const url = safeSourceURL(await loadURL());
    const headers = new Headers();
    if (existingBytes > 0 && state?.validator) {
      headers.set("Range", `bytes=${existingBytes}-`);
      headers.set("If-Range", state.validator);
    }
    let response: Response;
    try {
      response = await fetcher(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(600_000),
      });
    } catch (error) {
      if (attempt === 3) throw error;
      continue;
    }
    if (response.status === 416 && existingBytes > 0) {
      const total = parseUnsatisfiedRange(
        response.headers.get("Content-Range"),
      );
      if (total === existingBytes) {
        saveJSON(statePath, {
          validator: state?.validator ?? null,
          totalBytes: total,
          complete: true,
        } satisfies DownloadState);
        return;
      }
    }
    if ((!response.ok && response.status !== 206) || !response.body) {
      if (attempt === 3) {
        throw new Error(`Catalog source download failed (${response.status}).`);
      }
      continue;
    }
    const contentRange = parseContentRange(
      response.headers.get("Content-Range"),
    );
    const append =
      response.status === 206 &&
      existingBytes > 0 &&
      contentRange?.start === existingBytes;
    if (response.status === 206 && !append) {
      throw new Error("Catalog source returned an invalid byte range.");
    }
    const contentLength = numericHeader(response.headers.get("Content-Length"));
    const totalBytes = append ? (contentRange?.total ?? null) : contentLength;
    if (totalBytes !== null && totalBytes > maximumCompressedBytes) {
      throw new Error("Compressed catalog source exceeds the size limit.");
    }
    const validator =
      response.headers.get("ETag") ?? response.headers.get("Last-Modified");
    saveJSON(statePath, {
      validator,
      totalBytes,
      complete: false,
    } satisfies DownloadState);
    try {
      await pipeline(
        Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream,
        ),
        createWriteStream(path, {
          mode: 0o600,
          flags: append ? "a" : "w",
        }),
      );
    } catch (error) {
      if (attempt === 3) throw error;
      continue;
    }
    const completedBytes = statSync(path).size;
    if (completedBytes > maximumCompressedBytes) {
      throw new Error("Compressed catalog source exceeds the size limit.");
    }
    if (totalBytes !== null && completedBytes !== totalBytes) {
      if (attempt === 3)
        throw new Error("Catalog source download is incomplete.");
      continue;
    }
    fsyncFile(path);
    saveJSON(statePath, {
      validator,
      totalBytes: totalBytes ?? completedBytes,
      complete: true,
    } satisfies DownloadState);
    return;
  }
  throw new Error("Catalog source download did not complete.");
}

export async function verifyArchiveMD5Pair(
  mainArchivePath: string,
  imageArchivePath: string,
  sourceMD5Hint: string,
): Promise<void> {
  if (!/^[0-9a-f]{32}:[0-9a-f]{32}$/.test(sourceMD5Hint)) {
    throw new Error("Invalid catalog source MD5 pair.");
  }
  const [expectedMain, expectedImage] = sourceMD5Hint.split(":");
  const [actualMain, actualImage] = await Promise.all([
    hashFile(mainArchivePath, "md5"),
    hashFile(imageArchivePath, "md5"),
  ]);
  if (actualMain !== expectedMain || actualImage !== expectedImage) {
    throw new Error(
      "Downloaded gzip archives do not match the provider MD5 pair.",
    );
  }
}

export async function decompressGzipArchive(
  archivePath: string,
  outputPath: string,
): Promise<void> {
  if (existsSync(outputPath)) return;
  const temporaryPath = `${outputPath}.partial`;
  rmSync(temporaryPath, { force: true });
  let outputBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumDecompressedBytes) {
        callback(new Error("Decompressed catalog exceeds the size limit."));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(archivePath),
      createGunzip(),
      limiter,
      createWriteStream(temporaryPath, { mode: 0o600, flags: "wx" }),
    );
    fsyncFile(temporaryPath);
    renameSync(temporaryPath, outputPath);
    fsyncDirectory(dirname(outputPath));
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function signedJSON<T = Record<string, unknown>>(
  baseURL: string,
  secret: string,
  idempotencyPrefix: string,
  path: string,
  value: unknown,
  action: string,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const url = new URL(path, validatePublisherBaseURL(baseURL));
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const idempotencyKey = `${idempotencyPrefix}:${action}`;
  const digest = createHash("sha256").update(body).digest("hex");
  const canonical = `${timestamp}\n${idempotencyKey}\nPOST\n${url.pathname}${url.search}\n${digest}`;
  const signature = createHmac("sha256", secret)
    .update(canonical)
    .digest("hex");
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "X-ComiNavi-Timestamp": timestamp,
      "X-ComiNavi-Signature": `v1=${signature}`,
    },
    body: body.buffer,
  });
  const text = await response.text();
  if (!response.ok) {
    let code: string | null = null;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      code = typeof parsed.error === "string" ? parsed.error : null;
    } catch {
      // The bounded response text remains diagnostic without exposing secrets.
    }
    throw new CatalogRefreshHTTPError(
      response.status,
      code,
      text.slice(0, 500),
    );
  }
  return JSON.parse(text) as T;
}

class CatalogRefreshHTTPError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    body: string,
  ) {
    super(`Catalog refresh request failed (${status}): ${body}`);
  }
}

function isAuthorityLost(error: unknown): boolean {
  return (
    error instanceof CatalogRefreshHTTPError &&
    error.status === 409 &&
    (error.code === "catalog_refresh_authority_lost" ||
      error.code === "catalog_publication_authority_lost")
  );
}

function safeSourceURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Catalog source URL is unsafe.");
  }
  return url;
}

function parseContentRange(
  value: string | null,
): { start: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    Number.isSafeInteger(total) &&
    start <= end &&
    end < total
    ? { start, total }
    : null;
}

function parseUnsatisfiedRange(value: string | null): number | null {
  const match = /^bytes \*\/(\d+)$/.exec(value ?? "");
  const total = Number(match?.[1]);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

function numericHeader(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function hashFile(
  path: string,
  algorithm: "md5" | "sha256",
): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function loadDownloadState(path: string): DownloadState | null {
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as DownloadState;
  if (
    !value ||
    typeof value !== "object" ||
    (value.validator !== null && typeof value.validator !== "string") ||
    (value.totalBytes !== null && !Number.isSafeInteger(value.totalBytes)) ||
    typeof value.complete !== "boolean"
  ) {
    throw new Error("Catalog download state is invalid.");
  }
  return value;
}

function loadActiveState(path: string): ActiveState | null {
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as ActiveState;
  if (
    !value ||
    !canonicalUUID.test(value.leaseID) ||
    (value.pendingRenewalID !== undefined &&
      !canonicalUUID.test(value.pendingRenewalID)) ||
    !["leasing", "working", "completing", "releasing"].includes(value.phase)
  ) {
    throw new Error("Catalog refresh runner state is invalid.");
  }
  return value;
}

function saveJSON(path: string, value: unknown): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fsyncFile(temporaryPath);
  renameSync(temporaryPath, path);
  fsyncDirectory(dirname(path));
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function cleanupCompletedWork(
  workRoot: string,
  active: ActiveState,
  activePath: string,
): void {
  if (active.jobID) {
    rmSync(join(workRoot, active.jobID), { recursive: true, force: true });
  }
  rmSync(activePath, { force: true });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const baseURL = process.argv[2];
  const workRoot = process.argv[3];
  if (!baseURL || !workRoot) {
    throw new Error(
      "Usage: catalog:refresh <backend-base-url> <durable-work-root>",
    );
  }
  await runCatalogRefresh(baseURL, workRoot);
}
