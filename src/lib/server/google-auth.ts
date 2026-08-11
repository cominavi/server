import { AuthenticationError } from "./cominavi-auth";
import { decodeBase64URL } from "./auth-sessions";

export interface GoogleAuthBindings {
  COMINAVI_GOOGLE_CLIENT_IDS: string;
}

export interface GoogleIdentity {
  provider: "google";
  environment: "";
  subject: string;
  issuedAt?: number;
  email?: string;
  displayName?: string;
  avatarURL?: string;
}

interface GoogleClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  nonce: string;
}

interface GoogleJWKSet {
  keys: Array<JsonWebKey & { kid?: string }>;
}

let cachedKeys:
  { expiresAt: number; keys: Array<JsonWebKey & { kid?: string }> } | undefined;
let refreshingKeys: Promise<Array<JsonWebKey & { kid?: string }>> | undefined;

export async function authenticateGoogle(
  idToken: string,
  bindings: GoogleAuthBindings,
  expectedNonce: string,
  nowMilliseconds = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<GoogleIdentity> {
  if (!idToken || idToken.length > 16_384) throw invalidGoogleToken();
  const parts = idToken.split(".");
  if (parts.length !== 3) throw invalidGoogleToken();
  const [headerPart, payloadPart, signaturePart] = parts as [
    string,
    string,
    string,
  ];
  const header = parseJSON(headerPart);
  const claims = parseJSON(payloadPart);
  if (
    !isRecord(header) ||
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    !isGoogleClaims(claims)
  ) {
    throw invalidGoogleToken();
  }

  const audiences = new Set(
    bindings.COMINAVI_GOOGLE_CLIENT_IDS.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const now = Math.floor(nowMilliseconds / 1_000);
  if (
    audiences.size === 0 ||
    !audiences.has(claims.aud) ||
    (claims.iss !== "accounts.google.com" &&
      claims.iss !== "https://accounts.google.com") ||
    claims.exp <= now ||
    claims.iat > now + 60 ||
    claims.exp - claims.iat > 24 * 60 * 60 ||
    !(await equalSecret(claims.nonce, expectedNonce)) ||
    !/^[A-Za-z0-9_-]{6,255}$/.test(claims.sub) ||
    (claims.email !== undefined && claims.email_verified !== true)
  ) {
    throw invalidGoogleToken();
  }

  let keys = await loadGoogleKeys(nowMilliseconds, fetcher);
  let jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) {
    keys = await loadGoogleKeys(nowMilliseconds, fetcher, true);
    jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  }
  if (!jwk) throw invalidGoogleToken();
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      Uint8Array.from(decodeBase64URL(signaturePart)),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    if (!valid) throw invalidGoogleToken();
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw invalidGoogleToken();
  }

  return {
    provider: "google",
    environment: "",
    subject: claims.sub,
    issuedAt: claims.iat,
    ...(claims.email ? { email: claims.email } : {}),
    ...(claims.name ? { displayName: claims.name } : {}),
    ...(isHTTPSURL(claims.picture) ? { avatarURL: claims.picture } : {}),
  };
}

async function loadGoogleKeys(
  nowMilliseconds: number,
  fetcher: typeof fetch,
  forceRefresh = false,
): Promise<Array<JsonWebKey & { kid?: string }>> {
  if (!forceRefresh && cachedKeys && cachedKeys.expiresAt > nowMilliseconds)
    return cachedKeys.keys;
  if (refreshingKeys) return refreshingKeys;
  refreshingKeys = (async () => {
    let response: Response;
    try {
      response = await fetcher("https://www.googleapis.com/oauth2/v3/certs", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw googleUnavailable();
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw googleUnavailable();
    }
    if (!response.ok || !isJWKSet(body)) throw googleUnavailable();
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(
      response.headers.get("Cache-Control") ?? "",
    );
    const lifetime = Math.min(Number(maxAge?.[1] ?? 300), 3_600) * 1_000;
    cachedKeys = { expiresAt: nowMilliseconds + lifetime, keys: body.keys };
    return body.keys;
  })();
  try {
    return await refreshingKeys;
  } finally {
    refreshingKeys = undefined;
  }
}

function parseJSON(value: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64URL(value)));
  } catch {
    throw invalidGoogleToken();
  }
}

function isGoogleClaims(value: unknown): value is GoogleClaims {
  return (
    isRecord(value) &&
    typeof value.iss === "string" &&
    typeof value.aud === "string" &&
    typeof value.sub === "string" &&
    Number.isSafeInteger(value.exp) &&
    Number.isSafeInteger(value.iat) &&
    (value.email === undefined || typeof value.email === "string") &&
    (value.email_verified === undefined ||
      typeof value.email_verified === "boolean") &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.picture === undefined || typeof value.picture === "string") &&
    typeof value.nonce === "string"
  );
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    difference |= a[index]! ^ b[index]!;
  }
  return difference === 0;
}

function isJWKSet(value: unknown): value is GoogleJWKSet {
  return isRecord(value) && Array.isArray(value.keys);
}

function isHTTPSURL(value: string | undefined): value is string {
  if (!value || value.length > 2_048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function invalidGoogleToken(): AuthenticationError {
  return new AuthenticationError(
    "invalid_google_token",
    401,
    "The Google identity token is invalid.",
  );
}

function googleUnavailable(): AuthenticationError {
  return new AuthenticationError(
    "authentication_unavailable",
    503,
    "Google authentication is temporarily unavailable.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
