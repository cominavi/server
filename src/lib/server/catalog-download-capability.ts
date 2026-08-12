import { loadPublishedArtifact } from "./catalogs";
import { ServiceError } from "./service-error";

const capabilityLifetimeSeconds = 5 * 60;
const r2AccountID = "bee683f3b5473a422feaa41e040ac176";
const r2Bucket = "cominavi-catalog-downloads";
const r2Origin = `https://${r2AccountID}.r2.cloudflarestorage.com`;

type CatalogDownloadCapabilityConfiguration =
  | {
      mode: "r2-presigned";
      accessKeyID: string;
      secretAccessKey: string;
    }
  | {
      mode: "custom-domain-hmac";
      origin: string;
      secret: string;
    };

export async function catalogDownloadCapabilityRedirect(
  database: D1Database,
  bucket: R2Bucket,
  comiketNo: number,
  versionID: string,
  method: "GET" | "HEAD",
  configuration: CatalogDownloadCapabilityConfiguration,
  now = Math.floor(Date.now() / 1_000),
): Promise<Response> {
  const artifact = await loadPublishedArtifact(database, comiketNo, versionID);
  const object = await bucket.head(artifact.object_key);
  if (
    !object ||
    object.size !== artifact.byte_count ||
    object.httpMetadata?.contentType !== artifact.content_type ||
    object.customMetadata?.sha256 !== artifact.sha256 ||
    object.customMetadata?.visibility !== "authenticated_download"
  ) {
    throw unavailable("catalog_download_artifact_unavailable");
  }

  const location =
    configuration.mode === "r2-presigned"
      ? await r2PresignedURL(
          artifact.object_key,
          method,
          configuration.accessKeyID,
          configuration.secretAccessKey,
          now,
        )
      : await customDomainHMACURL(
          artifact.object_key,
          now,
          configuration.origin,
          configuration.secret,
        );
  return new Response(null, {
    status: 307,
    headers: {
      "Cache-Control": "private, no-store",
      Location: location.toString(),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function catalogDownloadCapabilityConfiguration(
  env: Cloudflare.Env,
): CatalogDownloadCapabilityConfiguration | null {
  const accessKeyID = env.COMINAVI_CATALOG_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.COMINAVI_CATALOG_R2_SECRET_ACCESS_KEY?.trim();
  if (accessKeyID || secretAccessKey) {
    if (!accessKeyID || !secretAccessKey || !env.COMINAVI_CATALOG_DOWNLOADS) {
      throw unavailable("catalog_download_capability_misconfigured");
    }
    return { mode: "r2-presigned", accessKeyID, secretAccessKey };
  }

  const origin = env.COMINAVI_CATALOG_DOWNLOAD_ORIGIN?.trim();
  const secret = env.COMINAVI_CATALOG_DOWNLOAD_HMAC_SECRET?.trim();
  if (!origin && !secret && !env.COMINAVI_CATALOG_DOWNLOADS) return null;
  if (!origin || !secret || !env.COMINAVI_CATALOG_DOWNLOADS) {
    throw unavailable("catalog_download_capability_misconfigured");
  }
  return { mode: "custom-domain-hmac", origin, secret };
}

export async function timedHMACToken(
  path: string,
  issuedAt: number,
  secret: string,
): Promise<string> {
  if (
    !path.startsWith("/derived/catalogs/") ||
    !Number.isSafeInteger(issuedAt)
  ) {
    throw new Error("Invalid catalog download capability input.");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${path}${issuedAt}`),
  );
  return `${issuedAt}-${base64(mac)}`;
}

export { capabilityLifetimeSeconds };

async function r2PresignedURL(
  objectKey: string,
  method: "GET" | "HEAD",
  accessKeyID: string,
  secretAccessKey: string,
  now: number,
): Promise<URL> {
  const date = new Date(now * 1_000);
  const amzDate = date
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "")
    .replace("Z", "Z");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const target = new URL(`/${r2Bucket}/${objectKey}`, r2Origin);
  target.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  target.searchParams.set("X-Amz-Credential", `${accessKeyID}/${scope}`);
  target.searchParams.set("X-Amz-Date", amzDate);
  target.searchParams.set("X-Amz-Expires", String(capabilityLifetimeSeconds));
  target.searchParams.set("X-Amz-SignedHeaders", "host");
  const canonicalQuery = [...target.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? asciiCompare(leftValue, rightValue)
        : asciiCompare(leftKey, rightKey),
    )
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .join("&");
  const canonicalRequest = [
    method,
    target.pathname,
    canonicalQuery,
    `host:${target.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const dateKey = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = await hmac(dateKey, "auto");
  const serviceKey = await hmac(regionKey, "s3");
  const signingKey = await hmac(serviceKey, "aws4_request");
  target.searchParams.set(
    "X-Amz-Signature",
    hex(await hmac(signingKey, stringToSign)),
  );
  return target;
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function customDomainHMACURL(
  objectKey: string,
  now: number,
  originValue: string,
  secret: string,
): Promise<URL> {
  const origin = validatedCustomDomainOrigin(originValue);
  if (secret.length < 32)
    throw unavailable("catalog_download_capability_unavailable");
  const path = `/${objectKey}`;
  const location = new URL(path, origin);
  location.searchParams.set("verify", await timedHMACToken(path, now, secret));
  return location;
}

function validatedCustomDomainOrigin(value: string): URL {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:" ||
    origin.hostname !== "catalogs.cominavi.net" ||
    origin.port ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw unavailable("catalog_download_capability_misconfigured");
  }
  return origin;
}

function unavailable(code: string): ServiceError {
  return new ServiceError(
    code,
    503,
    "Catalog download capabilities are temporarily unavailable.",
  );
}

function base64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(value: string): Promise<string> {
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function hmac(
  key: string | ArrayBuffer,
  value: string,
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : key,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
