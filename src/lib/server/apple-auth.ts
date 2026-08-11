import { base64URL, decodeBase64URL, sha256Hex } from "./auth-sessions";
import { AuthenticationError } from "./cominavi-auth";

export interface AppleAuthBindings {
  COMINAVI_APPLE_CLIENT_IDS: string;
  COMINAVI_APPLE_TEAM_ID: string;
  COMINAVI_APPLE_KEY_ID: string;
  COMINAVI_APPLE_PRIVATE_KEY_P8_BASE64URL: string;
}

export interface AppleIdentity {
  provider: "apple";
  environment: "";
  subject: string;
  clientID: string;
  issuedAt?: number;
  email?: string;
}

export interface AppleAuthorizationTokens {
  refreshToken: string;
  clientID: string;
}

interface AppleClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
}

interface AppleJWKSet {
  keys: Array<JsonWebKey & { kid?: string }>;
}

let cachedKeys:
  { expiresAt: number; keys: Array<JsonWebKey & { kid?: string }> } | undefined;
let refreshingKeys: Promise<Array<JsonWebKey & { kid?: string }>> | undefined;

export async function authenticateApple(
  identityToken: string,
  bindings: Pick<AppleAuthBindings, "COMINAVI_APPLE_CLIENT_IDS">,
  rawNonce: string,
  nowMilliseconds = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<AppleIdentity> {
  if (!identityToken || identityToken.length > 16_384)
    throw invalidAppleToken();
  const parts = identityToken.split(".");
  if (parts.length !== 3) throw invalidAppleToken();
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
    !isAppleClaims(claims)
  ) {
    throw invalidAppleToken();
  }
  const audiences = configuredClientIDs(bindings.COMINAVI_APPLE_CLIENT_IDS);
  const now = Math.floor(nowMilliseconds / 1_000);
  const expectedNonce = await sha256Hex(rawNonce);
  if (
    audiences.size === 0 ||
    !audiences.has(claims.aud) ||
    claims.iss !== "https://appleid.apple.com" ||
    claims.exp <= now ||
    claims.iat > now + 60 ||
    claims.exp - claims.iat > 24 * 60 * 60 ||
    !claims.nonce ||
    !(await equalSecret(claims.nonce.toLowerCase(), expectedNonce)) ||
    !/^[A-Za-z0-9._-]{6,255}$/.test(claims.sub) ||
    (claims.email !== undefined && !verifiedEmail(claims.email_verified))
  ) {
    throw invalidAppleToken();
  }
  let keys = await loadAppleKeys(nowMilliseconds, fetcher);
  let jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) {
    keys = await loadAppleKeys(nowMilliseconds, fetcher, true);
    jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  }
  if (!jwk) throw invalidAppleToken();
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
    if (!valid) throw invalidAppleToken();
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw invalidAppleToken();
  }
  return {
    provider: "apple",
    environment: "",
    subject: claims.sub,
    clientID: claims.aud,
    issuedAt: claims.iat,
    ...(claims.email ? { email: claims.email } : {}),
  };
}

export async function exchangeAppleAuthorizationCode(
  authorizationCode: string,
  expected: AppleIdentity,
  rawNonce: string,
  bindings: AppleAuthBindings,
  nowMilliseconds = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<AppleAuthorizationTokens> {
  if (!authorizationCode || authorizationCode.length > 4_096) {
    throw invalidAppleAuthorization();
  }
  const clientSecret = await createAppleClientSecret(
    expected.clientID,
    bindings,
    nowMilliseconds,
  );
  let response: Response;
  try {
    response = await fetcher("https://appleid.apple.com/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: expected.clientID,
        client_secret: clientSecret,
        code: authorizationCode,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw appleUnavailable();
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw appleUnavailable();
  }
  if (
    !response.ok ||
    !isRecord(body) ||
    typeof body.refresh_token !== "string" ||
    body.refresh_token.length < 1 ||
    body.refresh_token.length > 8_192 ||
    typeof body.id_token !== "string"
  ) {
    throw invalidAppleAuthorization();
  }
  const exchangedIdentity = await authenticateApple(
    body.id_token,
    bindings,
    rawNonce,
    nowMilliseconds,
    fetcher,
  );
  if (
    exchangedIdentity.subject !== expected.subject ||
    exchangedIdentity.clientID !== expected.clientID
  ) {
    throw invalidAppleAuthorization();
  }
  return { refreshToken: body.refresh_token, clientID: expected.clientID };
}

export async function revokeAppleRefreshToken(
  refreshToken: string,
  clientID: string,
  bindings: AppleAuthBindings,
  nowMilliseconds = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher("https://appleid.apple.com/auth/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientID,
      client_secret: await createAppleClientSecret(
        clientID,
        bindings,
        nowMilliseconds,
      ),
      token: refreshToken,
      token_type_hint: "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw appleUnavailable();
}

async function createAppleClientSecret(
  clientID: string,
  bindings: AppleAuthBindings,
  nowMilliseconds: number,
): Promise<string> {
  if (!configuredClientIDs(bindings.COMINAVI_APPLE_CLIENT_IDS).has(clientID)) {
    throw appleUnavailable();
  }
  const now = Math.floor(nowMilliseconds / 1_000);
  const header = base64URL(
    new TextEncoder().encode(
      JSON.stringify({ alg: "ES256", kid: bindings.COMINAVI_APPLE_KEY_ID }),
    ),
  );
  const payload = base64URL(
    new TextEncoder().encode(
      JSON.stringify({
        iss: bindings.COMINAVI_APPLE_TEAM_ID,
        iat: now,
        exp: now + 5 * 60,
        aud: "https://appleid.apple.com",
        sub: clientID,
      }),
    ),
  );
  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(
        decodeBase64URL(bindings.COMINAVI_APPLE_PRIVATE_KEY_P8_BASE64URL),
      ),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw appleUnavailable();
  }
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64URL(new Uint8Array(signature))}`;
}

async function loadAppleKeys(
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
      response = await fetcher("https://appleid.apple.com/auth/keys", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw appleUnavailable();
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw appleUnavailable();
    }
    if (!response.ok || !isAppleJWKSet(body)) throw appleUnavailable();
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(
      response.headers.get("Cache-Control") ?? "",
    );
    cachedKeys = {
      expiresAt:
        nowMilliseconds + Math.min(Number(maxAge?.[1] ?? 300), 3_600) * 1_000,
      keys: body.keys,
    };
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
    throw invalidAppleToken();
  }
}

function isAppleClaims(value: unknown): value is AppleClaims {
  return (
    isRecord(value) &&
    typeof value.iss === "string" &&
    typeof value.aud === "string" &&
    typeof value.sub === "string" &&
    Number.isSafeInteger(value.exp) &&
    Number.isSafeInteger(value.iat) &&
    (value.nonce === undefined || typeof value.nonce === "string") &&
    (value.email === undefined || typeof value.email === "string") &&
    (value.email_verified === undefined ||
      typeof value.email_verified === "boolean" ||
      typeof value.email_verified === "string")
  );
}

function isAppleJWKSet(value: unknown): value is AppleJWKSet {
  return isRecord(value) && Array.isArray(value.keys);
}

function configuredClientIDs(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function verifiedEmail(value: boolean | string | undefined): boolean {
  return value === true || value === "true";
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aBuffer, bBuffer] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(aBuffer);
  const b = new Uint8Array(bBuffer);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    difference |= a[index]! ^ b[index]!;
  }
  return difference === 0;
}

function invalidAppleToken(): AuthenticationError {
  return new AuthenticationError(
    "invalid_apple_token",
    401,
    "The Apple identity token is invalid.",
  );
}

function invalidAppleAuthorization(): AuthenticationError {
  return new AuthenticationError(
    "invalid_apple_authorization",
    401,
    "The Apple authorization could not be validated.",
  );
}

function appleUnavailable(): AuthenticationError {
  return new AuthenticationError(
    "authentication_unavailable",
    503,
    "Apple authentication is temporarily unavailable.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
