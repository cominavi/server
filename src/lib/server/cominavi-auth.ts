export type CirclemsEnvironment = "production" | "sandbox";

export interface CominaviAuthBindings {
  COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN: string;
  COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN: string;
  COMINAVI_JWT_SECRET: string;
}

export interface CirclemsIdentity {
  subject: string;
  circlemsEnvironment: CirclemsEnvironment;
  circlemsUserID: number;
  nickname?: string;
}

export interface CominaviIdentity extends CirclemsIdentity {
  userID: number;
  authVersion: number;
}

interface CirclemsUserInfoResponse {
  status: string;
  response: {
    pid: number | string;
    nickname?: string;
  };
}

interface CominaviJWTClaims {
  iss: "cominavi.net";
  aud: "cominavi-ios";
  sub: string;
  iat: number;
  exp: number;
  circlems_environment: CirclemsEnvironment;
  circlems_user_id: number;
  user_id: number;
  auth_version: number;
}

export class AuthenticationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const appJWTLifetimeSeconds = 15 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function authenticateCirclems(
  accessToken: string,
  environment: CirclemsEnvironment,
  bindings: CominaviAuthBindings,
  fetcher: typeof fetch = fetch,
): Promise<CirclemsIdentity> {
  if (!accessToken || accessToken.length > 8_192) {
    throw new AuthenticationError(
      "invalid_circlems_token",
      401,
      "A valid Circle.ms access token is required.",
    );
  }

  const origin =
    environment === "production"
      ? bindings.COMINAVI_CIRCLEMS_PRODUCTION_API_ORIGIN
      : bindings.COMINAVI_CIRCLEMS_SANDBOX_API_ORIGIN;
  if (!origin) {
    throw new AuthenticationError(
      "authentication_unavailable",
      503,
      "Circle.ms authentication is not configured.",
    );
  }

  let response: Response;
  try {
    response = await fetcher(new URL("/User/Info", origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AuthenticationError(
      "authentication_unavailable",
      503,
      "Circle.ms authentication is temporarily unavailable.",
    );
  }

  const body = await readJSON(response);
  if (
    !response.ok ||
    !isCirclemsUserInfoResponse(body) ||
    body.status !== "success"
  ) {
    throw new AuthenticationError(
      "invalid_circlems_token",
      401,
      "The Circle.ms session could not be verified.",
    );
  }

  const circlemsUserID = Number(body.response.pid);
  if (!Number.isSafeInteger(circlemsUserID) || circlemsUserID <= 0) {
    throw new AuthenticationError(
      "invalid_circlems_identity",
      502,
      "Circle.ms returned an invalid account identifier.",
    );
  }

  return {
    subject: `circlems:${environment}:${circlemsUserID}`,
    circlemsEnvironment: environment,
    circlemsUserID,
    nickname:
      typeof body.response.nickname === "string" &&
      body.response.nickname.trim()
        ? body.response.nickname
        : undefined,
  };
}

export async function issueCominaviJWT(
  identity: CominaviIdentity,
  secret: string,
  nowMilliseconds = Date.now(),
): Promise<{ token: string; expiresAt: string }> {
  return issueJWT(identity, secret, nowMilliseconds);
}

async function issueJWT(
  identity: CominaviIdentity,
  secret: string,
  nowMilliseconds: number,
): Promise<{ token: string; expiresAt: string }> {
  assertJWTSecret(secret);
  const issuedAt = Math.floor(nowMilliseconds / 1_000);
  const claims: CominaviJWTClaims = {
    iss: "cominavi.net",
    aud: "cominavi-ios",
    sub: identity.subject,
    iat: issuedAt,
    exp: issuedAt + appJWTLifetimeSeconds,
    circlems_environment: identity.circlemsEnvironment,
    circlems_user_id: identity.circlemsUserID,
    user_id: identity.userID,
    auth_version: identity.authVersion,
  };
  const header = encodeBase64URL(
    encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const payload = encodeBase64URL(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const signature = await sign(signingInput, secret);

  return {
    token: `${signingInput}.${encodeBase64URL(signature)}`,
    expiresAt: new Date(claims.exp * 1_000).toISOString(),
  };
}

export async function verifyCominaviJWT(
  token: string,
  secret: string,
  nowMilliseconds = Date.now(),
): Promise<CominaviIdentity> {
  return verifyJWT(token, secret, nowMilliseconds);
}

async function verifyJWT(
  token: string,
  secret: string,
  nowMilliseconds: number,
): Promise<CominaviIdentity> {
  assertJWTSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw invalidJWT();
  }

  const [headerPart, payloadPart, signaturePart] = parts as [
    string,
    string,
    string,
  ];
  const header = decodeJSON(headerPart);
  if (!isObject(header) || header.alg !== "HS256" || header.typ !== "JWT") {
    throw invalidJWT();
  }

  const signature = decodeBase64URL(signaturePart);
  const key = await hmacKey(secret, ["verify"]);
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(`${headerPart}.${payloadPart}`),
  );
  if (!verified) {
    throw invalidJWT();
  }

  const claims = decodeJSON(payloadPart);
  if (!isJWTClaims(claims)) {
    throw invalidJWT();
  }
  const now = Math.floor(nowMilliseconds / 1_000);
  if (
    claims.exp <= now ||
    claims.iat > now + 60 ||
    claims.exp - claims.iat > appJWTLifetimeSeconds
  ) {
    throw new AuthenticationError(
      "expired_token",
      401,
      "The ComiNavi session has expired.",
    );
  }

  const expectedSubject = `circlems:${claims.circlems_environment}:${claims.circlems_user_id}`;
  if (claims.sub !== expectedSubject) {
    throw invalidJWT();
  }

  return {
    subject: claims.sub,
    circlemsEnvironment: claims.circlems_environment,
    circlemsUserID: claims.circlems_user_id,
    userID: claims.user_id,
    authVersion: claims.auth_version,
  };
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) {
    throw new AuthenticationError(
      "missing_bearer_token",
      401,
      "A bearer token is required.",
    );
  }
  return match[1];
}

function assertJWTSecret(secret: string): void {
  if (secret.length < 32) {
    throw new AuthenticationError(
      "authentication_unavailable",
      503,
      "JWT signing is not configured.",
    );
  }
}

function invalidJWT(): AuthenticationError {
  return new AuthenticationError(
    "invalid_token",
    401,
    "The ComiNavi session is invalid.",
  );
}

async function sign(value: string, secret: string): Promise<Uint8Array> {
  const key = await hmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );
  return new Uint8Array(signature);
}

function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function encodeBase64URL(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64URL(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidJWT();
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const decoded = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      decoded[index] = binary.charCodeAt(index);
    }
    return decoded;
  } catch {
    throw invalidJWT();
  }
}

function decodeJSON(value: string): unknown {
  try {
    return JSON.parse(decoder.decode(decodeBase64URL(value)));
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw invalidJWT();
  }
}

function isJWTClaims(value: unknown): value is CominaviJWTClaims {
  return (
    isObject(value) &&
    value.iss === "cominavi.net" &&
    value.aud === "cominavi-ios" &&
    typeof value.sub === "string" &&
    Number.isSafeInteger(value.iat) &&
    Number.isSafeInteger(value.exp) &&
    (value.circlems_environment === "production" ||
      value.circlems_environment === "sandbox") &&
    Number.isSafeInteger(value.circlems_user_id) &&
    Number(value.circlems_user_id) > 0 &&
    Number.isSafeInteger(value.user_id) &&
    Number(value.user_id) > 0 &&
    Number.isSafeInteger(value.auth_version) &&
    Number(value.auth_version) > 0
  );
}

function isCirclemsUserInfoResponse(
  value: unknown,
): value is CirclemsUserInfoResponse {
  return (
    isObject(value) &&
    typeof value.status === "string" &&
    isObject(value.response) &&
    (typeof value.response.pid === "number" ||
      typeof value.response.pid === "string")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJSON(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
