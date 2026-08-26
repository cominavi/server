import { ServiceError } from "./service-error";

export type ReviewDemoCatalogDatabase = "main" | "images";

type ReviewDemoCatalogArtifact = {
  objectKey: string;
  sha256: string;
  byteCount: number;
  filename: string;
};

export const reviewDemoCatalogArtifacts: Record<
  ReviewDemoCatalogDatabase,
  ReviewDemoCatalogArtifact
> = {
  main: {
    objectKey: "review-demo/catalogs/c104/v2/main.sqlite.gz",
    sha256: "1f50889958a2d239b081fed63fa96746cfd25f03539ec5892bf059425ad94592",
    byteCount: 8_479_436,
    filename: "cominavi-demo-c104-main.sqlite.gz",
  },
  images: {
    objectKey: "review-demo/catalogs/c104/v2/images.sqlite.gz",
    sha256: "8acc38b0cfcbbda1a2fc10296c25b018011d4d6a93657936aea02bfa92ceb9ce",
    byteCount: 34_039_870,
    filename: "cominavi-demo-c104-images.sqlite.gz",
  },
};

export function reviewDemoCatalogDatabase(
  filename: string,
): ReviewDemoCatalogDatabase | null {
  if (filename === "main.sqlite.gz") return "main";
  if (filename === "images.sqlite.gz") return "images";
  return null;
}

export async function serveReviewDemoCatalogArtifact(
  request: Request,
  bucket: R2Bucket,
  database: ReviewDemoCatalogDatabase,
): Promise<Response> {
  const artifact = reviewDemoCatalogArtifacts[database];
  const etag = `"sha256-${artifact.sha256}"`;
  const headers = baseHeaders(artifact, etag);

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
    ? parseByteRange(rangeHeader, artifact.byteCount)
    : null;

  if (shouldApplyRange && !range) {
    headers.set("Content-Range", `bytes */${artifact.byteCount}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }

  if (request.method === "HEAD") {
    const object = await bucket.head(artifact.objectKey);
    assertObject(object, artifact);
    return new Response(null, { status: 200, headers });
  }

  const object = await bucket.get(
    artifact.objectKey,
    range
      ? { range: { offset: range.start, length: range.length } }
      : undefined,
  );
  assertObject(object, artifact);

  if (range) {
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.start + range.length - 1}/${artifact.byteCount}`,
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
  artifact: ReviewDemoCatalogArtifact,
  etag: string,
): Headers {
  return new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "CDN-Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": `attachment; filename="${artifact.filename}"`,
    "Content-Length": String(artifact.byteCount),
    "Content-Type": "application/gzip",
    Digest: `sha-256=:${hexToBase64(artifact.sha256)}:`,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  });
}

function assertObject(
  object: R2Object | R2ObjectBody | null,
  artifact: ReviewDemoCatalogArtifact,
): asserts object is R2ObjectBody {
  if (!object || object.size !== artifact.byteCount) {
    throw new ServiceError(
      "review_demo_catalog_unavailable",
      503,
      "The review demo catalog is temporarily unavailable.",
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
