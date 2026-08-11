import { loadPublishedArtifact } from "./catalogs";
import { ServiceError } from "./service-error";

export async function serveCatalogArtifact(
  request: Request,
  database: D1Database,
  bucket: R2Bucket,
  comiketNo: number,
  versionID: string,
): Promise<Response> {
  const artifact = await loadPublishedArtifact(database, comiketNo, versionID);
  const etag = `"sha256-${artifact.sha256}"`;
  const headers = baseHeaders(
    artifact.byte_count,
    artifact.content_type,
    artifact.sha256,
    etag,
    comiketNo,
    versionID,
  );
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  const rangeHeader = request.headers.get("Range");
  const ifRange = request.headers.get("If-Range");
  const shouldApplyRange =
    request.method !== "HEAD" &&
    rangeHeader !== null &&
    (ifRange === null || ifRange === etag);
  const range = shouldApplyRange
    ? parseByteRange(rangeHeader, artifact.byte_count)
    : null;
  if (shouldApplyRange && !range) {
    headers.set("Content-Range", `bytes */${artifact.byte_count}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }
  if (request.method === "HEAD") {
    const object = await bucket.head(artifact.object_key);
    assertObject(object, artifact.byte_count);
    return new Response(null, { status: 200, headers });
  }
  const object = await bucket.get(
    artifact.object_key,
    range
      ? { range: { offset: range.start, length: range.length } }
      : undefined,
  );
  assertObject(object, artifact.byte_count);
  if (range) {
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.start + range.length - 1}/${artifact.byte_count}`,
    );
    headers.set("Content-Length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

function parseByteRange(
  value: string,
  size: number,
): { start: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    const length = Math.min(suffix, size);
    return { start: size - length, length };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return null;
  }
  const end = Math.min(requestedEnd, size - 1);
  return { start, length: end - start + 1 };
}

function baseHeaders(
  size: number,
  contentType: string,
  sha256: string,
  etag: string,
  comiketNo: number,
  versionID: string,
): Headers {
  return new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600, immutable",
    "Content-Disposition": `attachment; filename="cominavi-c${comiketNo}-${versionID}.sqlite"`,
    "Content-Length": String(size),
    "Content-Type": contentType,
    Digest: `sha-256=:${hexToBase64(sha256)}:`,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  });
}

function assertObject(
  object: R2Object | R2ObjectBody | null,
  expectedSize: number,
): asserts object is R2ObjectBody {
  if (!object || object.size !== expectedSize) {
    throw new ServiceError(
      "catalog_artifact_unavailable",
      503,
      "The published catalog artifact is temporarily unavailable.",
    );
  }
}

function hexToBase64(hex: string): string {
  let binary = "";
  for (let index = 0; index < hex.length; index += 2) {
    binary += String.fromCharCode(
      Number.parseInt(hex.slice(index, index + 2), 16),
    );
  }
  return btoa(binary);
}
