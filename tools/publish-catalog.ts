import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { importCatalog, readNormalizedCatalogArtifact } from "./catalog-import";
import type { CatalogNormalizedDataV1 } from "../src/lib/server/catalogs";

const partBytes = 10 * 1024 * 1024;
const collections = [
  "dates",
  "maps",
  "areas",
  "blocks",
  "floors",
  "mappings",
  "genres",
  "layouts",
  "circles",
  "images",
] as const;

export interface CatalogPublisherOptions {
  baseURL: string;
  claimID: string;
  leaseID?: string;
  mainPath: string;
  imagePath: string;
  outputPath: string;
  statePath: string;
  sourceMD5Hint?: string;
  sourceMD5AlreadyVerified?: boolean;
  sourceUpdatedAt?: string;
  renewLease?: () => Promise<void>;
}

interface UploadState {
  artifacts: Record<
    string,
    {
      objectKey: string;
      sha256: string;
      bytes: number;
      contentType: string;
      visibility: "private_source" | "authenticated_download";
      createRequestID: string;
      uploadID: string | null;
      completed: boolean;
      parts: Array<{ partNumber: number; etag: string }>;
    }
  >;
}

export async function publishCatalog(
  options: CatalogPublisherOptions,
): Promise<string> {
  validatePublisherBaseURL(options.baseURL);
  const secret = options.leaseID
    ? (process.env.COMINAVI_CATALOG_SCHEDULED_PUBLISH_SECRET ?? "")
    : (process.env.COMINAVI_CATALOG_PUBLISH_SECRET ?? "");
  if (secret.length < 32) {
    throw new Error(
      `${options.leaseID ? "COMINAVI_CATALOG_SCHEDULED_PUBLISH_SECRET" : "COMINAVI_CATALOG_PUBLISH_SECRET"} must be configured.`,
    );
  }
  let lastLeaseRenewal = 0;
  const renewLease = async (force = false): Promise<void> => {
    if (!options.renewLease) return;
    const now = Date.now();
    if (!force && now - lastLeaseRenewal < 5 * 60 * 1_000) return;
    await options.renewLease();
    lastLeaseRenewal = now;
  };
  await renewLease(true);
  const bundle = await importCatalog({
    mainDatabasePath: options.mainPath,
    imageDatabasePath: options.imagePath,
    outputDatabasePath: options.outputPath,
    sourceMD5Hint: options.sourceMD5Hint,
    sourceMD5AlreadyVerified: options.sourceMD5AlreadyVerified,
    sourceUpdatedAt: options.sourceUpdatedAt,
  });
  await renewLease(true);
  if (!bundle.derived)
    throw new Error("Derived catalog artifact was not built.");
  const status = await signedJSON<{ state?: string }>(
    options,
    secret,
    "/api/v2/internal/catalog-publications",
    {
      schemaVersion: 1,
      action: "status",
      input: {
        versionID: bundle.versionID,
        claimID: options.claimID,
        ...(options.leaseID ? { refreshLeaseID: options.leaseID } : {}),
        sourceMD5Hint: bundle.sourceMD5Hint,
      },
    },
    "status",
  );
  if (status.state === "published") {
    process.stdout.write(
      `${JSON.stringify({ versionID: bundle.versionID, published: true, replayed: true })}\n`,
    );
    return bundle.versionID;
  }
  const claim = await signedJSON<{ claimed: boolean }>(
    options,
    secret,
    "/api/v2/internal/catalog-publications",
    {
      schemaVersion: 1,
      action: "claim",
      input: {
        comiketNo: bundle.comiketNo,
        name: bundle.eventName,
        claimID: options.claimID,
        ...(options.leaseID ? { refreshLeaseID: options.leaseID } : {}),
        sourceMD5Hint: bundle.sourceMD5Hint,
        leaseSeconds: 7_200,
      },
    },
    "claim",
  );
  if (!claim.claimed) {
    process.stdout.write(
      `${JSON.stringify({ versionID: bundle.versionID, skipped: "source_md5_unchanged" })}\n`,
    );
    return bundle.versionID;
  }
  const state = loadState(options.statePath);
  const artifacts = [
    { ...bundle.sources.main, path: options.mainPath, name: "source-main" },
    { ...bundle.sources.image, path: options.imagePath, name: "source-image" },
    { ...bundle.derived, path: options.outputPath, name: "derived" },
  ];
  for (const artifact of artifacts) {
    await renewLease();
    await uploadArtifact(options, secret, state, artifact, true, renewLease);
  }
  await renewLease(true);
  await signedJSON(
    options,
    secret,
    "/api/v2/internal/catalog-publications",
    {
      schemaVersion: 1,
      action: "stage",
      input: {
        versionID: bundle.versionID,
        comiketNo: bundle.comiketNo,
        claimID: options.claimID,
        ...(options.leaseID ? { refreshLeaseID: options.leaseID } : {}),
        ...(bundle.sourceUpdatedAt
          ? {
              sourceUpdatedAt: Math.floor(
                Date.parse(bundle.sourceUpdatedAt) / 1_000,
              ),
            }
          : {}),
        sourceMD5Hint: bundle.sourceMD5Hint,
        sourceMainSHA256: bundle.sources.main.sha256,
        sourceImageSHA256: bundle.sources.image.sha256,
        derivedSHA256: bundle.derived.sha256,
        derivedBytes: bundle.derived.bytes,
        derivedObjectKey: bundle.derived.objectKey,
        dateCount: bundle.counts.dates,
        mapCount: bundle.counts.maps,
        areaCount: bundle.counts.areas,
        blockCount: bundle.counts.blocks,
        floorCount: bundle.counts.floors,
        mappingCount: bundle.counts.mappings,
        genreCount: bundle.counts.genres,
        circleCount: bundle.counts.circles,
        layoutCount: bundle.counts.layouts,
        imageCount: bundle.counts.circleImages + bundle.counts.commonImages,
        privateSources: {
          main: {
            objectKey: bundle.sources.main.objectKey,
            bytes: bundle.sources.main.bytes,
          },
          image: {
            objectKey: bundle.sources.image.objectKey,
            bytes: bundle.sources.image.bytes,
          },
        },
      },
    },
    "stage",
  );
  const normalized = readNormalizedCatalogArtifact(options.outputPath);
  for (const collection of collections) {
    const rows = normalized[collection] as unknown[];
    for (let start = 0; start < rows.length; start += 100) {
      await renewLease();
      const data = emptyNormalizedData();
      (data[collection] as unknown[]) = rows.slice(start, start + 100);
      await signedJSON(
        options,
        secret,
        "/api/v2/internal/catalog-publications",
        {
          schemaVersion: 1,
          action: "ingest",
          input: {
            versionID: bundle.versionID,
            comiketNo: bundle.comiketNo,
            claimID: options.claimID,
            ...(options.leaseID ? { refreshLeaseID: options.leaseID } : {}),
            sourceMD5Hint: bundle.sourceMD5Hint,
            data,
          },
        },
        `ingest:${collection}:${start}`,
      );
    }
  }
  await renewLease(true);
  await signedJSON(
    options,
    secret,
    "/api/v2/internal/catalog-publications",
    {
      schemaVersion: 1,
      action: "publish",
      input: {
        versionID: bundle.versionID,
        comiketNo: bundle.comiketNo,
        claimID: options.claimID,
        ...(options.leaseID ? { refreshLeaseID: options.leaseID } : {}),
        sourceMD5Hint: bundle.sourceMD5Hint,
      },
    },
    "publish",
  );
  process.stdout.write(
    `${JSON.stringify({ versionID: bundle.versionID, published: true, replayed: false })}\n`,
  );
  return bundle.versionID;
}

export function validatePublisherBaseURL(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error("Catalog publisher base URL must not contain credentials.");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "Catalog publisher base URL must use HTTPS (HTTP is loopback-only).",
    );
  }
  return url;
}

async function uploadArtifact(
  options: CatalogPublisherOptions,
  secret: string,
  state: UploadState,
  artifact: {
    name: string;
    path: string;
    objectKey: string;
    sha256: string;
    bytes: number;
    contentType: string;
    visibility: "private_source" | "authenticated_download";
  },
  resetExpiredUpload = true,
  renewLease: (force?: boolean) => Promise<void> = async () => undefined,
): Promise<void> {
  const stateKey = `${options.leaseID ?? "manual"}:${artifact.objectKey}:${artifact.sha256}`;
  let upload = state.artifacts[stateKey];
  if (
    upload &&
    (upload.objectKey !== artifact.objectKey ||
      upload.sha256 !== artifact.sha256 ||
      upload.bytes !== artifact.bytes ||
      upload.contentType !== artifact.contentType ||
      upload.visibility !== artifact.visibility)
  ) {
    throw new Error(
      "Catalog upload state metadata does not match the artifact.",
    );
  }
  if (!upload) {
    upload = {
      ...artifactMetadata(artifact),
      createRequestID: randomUUID(),
      uploadID: null,
      completed: false,
      parts: [],
    };
    state.artifacts[stateKey] = upload;
    saveState(options.statePath, state);
  }
  if (!upload.createRequestID) {
    upload.createRequestID = randomUUID();
    saveState(options.statePath, state);
  }
  if (!upload.completed && !upload.uploadID) {
    try {
      const created = await signedJSON<{
        alreadyComplete: boolean;
        uploadID: string | null;
      }>(
        options,
        secret,
        "/api/v2/internal/catalog-artifacts/multipart",
        {
          schemaVersion: 1,
          action: "create",
          ...artifactMetadata(artifact),
          ...publicationAuthority(options),
        },
        `upload:create:${artifact.name}:${upload.createRequestID}`,
      );
      upload.uploadID = created.uploadID;
      upload.completed = created.alreadyComplete;
      saveState(options.statePath, state);
    } catch (error) {
      if (
        resetExpiredUpload &&
        error instanceof PublisherHTTPError &&
        (error.status === 404 || error.status === 410)
      ) {
        delete state.artifacts[stateKey];
        saveState(options.statePath, state);
        return uploadArtifact(
          options,
          secret,
          state,
          artifact,
          false,
          renewLease,
        );
      }
      throw error;
    }
  }
  if (upload.completed) return;
  if (!upload.uploadID) throw new Error("Multipart upload ID is unavailable.");
  try {
    const handle = openSync(artifact.path, "r");
    try {
      const totalParts = Math.ceil(artifact.bytes / partBytes);
      for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
        await renewLease();
        if (upload.parts.some((part) => part.partNumber === partNumber))
          continue;
        const offset = (partNumber - 1) * partBytes;
        const length = Math.min(partBytes, artifact.bytes - offset);
        const bytes = new Uint8Array(length);
        const read = readSync(handle, bytes, 0, length, offset);
        if (read !== length)
          throw new Error("Catalog artifact changed during upload.");
        const authority = publicationAuthority(options);
        const query = new URLSearchParams({
          key: artifact.objectKey,
          ...(authority.claimID ? authority : {}),
        });
        const path = `/api/v2/internal/catalog-artifacts/multipart/${encodeURIComponent(upload.uploadID)}/${partNumber}?${query}`;
        const part = await signedRequest<{ partNumber: number; etag: string }>(
          options,
          secret,
          "PUT",
          path,
          bytes,
          `upload:part:${artifact.name}:${partNumber}`,
          "application/octet-stream",
        );
        upload.parts.push(part);
        upload.parts.sort((left, right) => left.partNumber - right.partNumber);
        saveState(options.statePath, state);
      }
    } finally {
      closeSync(handle);
    }
    await renewLease(true);
    await signedJSON(
      options,
      secret,
      "/api/v2/internal/catalog-artifacts/multipart",
      {
        schemaVersion: 1,
        action: "complete",
        uploadID: upload.uploadID,
        parts: upload.parts,
        ...artifactMetadata(artifact),
        ...publicationAuthority(options),
      },
      `upload:complete:${artifact.name}`,
    );
    upload.completed = true;
    saveState(options.statePath, state);
  } catch (error) {
    if (
      resetExpiredUpload &&
      error instanceof PublisherHTTPError &&
      error.status === 404
    ) {
      delete state.artifacts[stateKey];
      saveState(options.statePath, state);
      return uploadArtifact(
        options,
        secret,
        state,
        artifact,
        false,
        renewLease,
      );
    }
    throw error;
  }
}

function artifactMetadata(artifact: {
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: string;
  visibility: "private_source" | "authenticated_download";
}) {
  return {
    objectKey: artifact.objectKey,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    contentType: artifact.contentType,
    visibility: artifact.visibility,
  };
}

function publicationAuthority(options: CatalogPublisherOptions): {
  claimID?: string;
  leaseID?: string;
  sourceMD5Hint?: string;
} {
  if (!options.leaseID) return {};
  if (!options.sourceMD5Hint) {
    throw new Error("Scheduled publication requires the source MD5 pair.");
  }
  return {
    claimID: options.claimID,
    leaseID: options.leaseID,
    sourceMD5Hint: options.sourceMD5Hint,
  };
}

function emptyNormalizedData(): CatalogNormalizedDataV1 {
  return {
    dates: [],
    maps: [],
    areas: [],
    blocks: [],
    floors: [],
    mappings: [],
    genres: [],
    layouts: [],
    circles: [],
    images: [],
  };
}

async function signedJSON<T = Record<string, unknown>>(
  options: CatalogPublisherOptions,
  secret: string,
  path: string,
  value: unknown,
  action: string,
): Promise<T> {
  return signedRequest(
    options,
    secret,
    "POST",
    path,
    new TextEncoder().encode(JSON.stringify(value)),
    action,
    "application/json",
  );
}

async function signedRequest<T>(
  options: CatalogPublisherOptions,
  secret: string,
  method: string,
  path: string,
  body: Uint8Array,
  action: string,
  contentType: string,
): Promise<T> {
  const url = new URL(path, options.baseURL);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const authorityNamespace = options.leaseID
    ? `${options.claimID}:${options.leaseID}:${options.sourceMD5Hint}`
    : options.claimID;
  const idempotencyKey = `${authorityNamespace}:${action}`;
  const payloadSHA256 = createHash("sha256").update(body).digest("hex");
  const canonical = `${timestamp}\n${idempotencyKey}\n${method}\n${url.pathname}${url.search}\n${payloadSHA256}`;
  const signature = createHmac("sha256", secret)
    .update(canonical)
    .digest("hex");
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": contentType,
      "Idempotency-Key": idempotencyKey,
      "X-ComiNavi-Timestamp": timestamp,
      "X-ComiNavi-Signature": `v1=${signature}`,
    },
    body: Uint8Array.from(body).buffer,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new PublisherHTTPError(response.status, text.slice(0, 500));
  }
  return JSON.parse(text) as T;
}

class PublisherHTTPError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Catalog publisher request failed (${status}): ${body}`);
  }
}

function loadState(path: string): UploadState {
  if (!existsSync(path)) return { artifacts: {} };
  const value = JSON.parse(readFileSync(path, "utf8")) as UploadState;
  if (!value || typeof value !== "object" || !value.artifacts) {
    throw new Error("Catalog publication state is invalid.");
  }
  return value;
}

function saveState(path: string, state: UploadState): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  let descriptor = openSync(temporaryPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
  descriptor = openSync(dirname(path), "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function parseCatalogPublisherArguments(
  args: string[],
): CatalogPublisherOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value)
      throw new Error("Arguments must be --key value pairs.");
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (!value) throw new Error(`${key} is required.`);
    return value;
  };
  if (values.has("--source-md5-hint")) {
    throw new Error(
      "--source-md5-hint is ambiguous for decompressed SQLite; use --verified-source-md5-hint only after verifying the provider gzip archives.",
    );
  }
  return {
    baseURL: required("--base-url"),
    claimID: required("--claim-id"),
    ...(values.get("--lease-id") ? { leaseID: values.get("--lease-id")! } : {}),
    mainPath: required("--main"),
    imagePath: required("--image"),
    outputPath: required("--output"),
    statePath: required("--state"),
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await publishCatalog(parseCatalogPublisherArguments(process.argv.slice(2)));
}
