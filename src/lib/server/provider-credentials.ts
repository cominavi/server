import { and, eq, exists, isNull, lte, or, sql } from "drizzle-orm";
import { runDrizzleBatch } from "../db/batch";
import { createDatabase } from "../db/client";
import {
  providerCredentialHandoffReceipts,
  providerCredentials,
  userIdentities,
  users,
} from "../db/schema";
import { ServiceError } from "./service-error";
import { sha256Hex } from "./auth-sessions";

const cipherVersion = 1;
const keyVersion = 1;

export interface CircleCredentialInput {
  accessToken: string;
  refreshToken?: string | null;
  accessExpiresAt?: number | null;
  scopes?: string[];
}

export interface CircleCredential extends CircleCredentialInput {
  refreshToken: string | null;
  accessExpiresAt: number | null;
  scopes: string[];
}

export interface EncryptedCircleCredential {
  nonce: string;
  ciphertext: string;
  accessExpiresAt: number | null;
  scopesJSON: string;
}

export async function encryptCircleCredentialForOwner(
  input: CircleCredentialInput,
  ownerUserID: number,
  identityID: number,
  encodedKey: string,
): Promise<EncryptedCircleCredential> {
  const credential = normalizedCredential(input);
  const encrypted = await encryptCredential(
    credential,
    ownerUserID,
    identityID,
    encodedKey,
  );
  return {
    ...encrypted,
    accessExpiresAt: credential.accessExpiresAt,
    scopesJSON: JSON.stringify(credential.scopes),
  };
}

export interface CircleCredentialRefreshBindings {
  COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_ORIGIN: string;
  COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_ID: string;
  COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_SECRET: string;
  COMINAVI_OAUTH_CIRCLEMS_SANDBOX_ORIGIN: string;
  COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID: string;
  COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET: string;
}

export type CircleCredentialHandoffScope = "circlems_auth" | "circlems_link";

export interface CircleCredentialReceipt {
  requestId: string;
  provider: "circlems";
  environment: "production" | "sandbox";
  subject: string;
  credentialRevision: number;
}

export interface CircleCredentialReplay {
  receipt: CircleCredentialReceipt;
  identity: { subject: string; userID: number; authVersion: number };
}

export async function circleCredentialPayloadHash(
  environment: "production" | "sandbox",
  input: CircleCredentialInput,
  baseCredentialRevision: number | null = null,
): Promise<string> {
  const credential = normalizedCredential(input);
  return sha256Hex(
    JSON.stringify({
      v: 1,
      provider: "circlems",
      environment,
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      accessExpiresAt: credential.accessExpiresAt,
      scopes: credential.scopes,
      baseCredentialRevision,
    }),
  );
}

export async function loadCircleCredentialHandoffReplay(
  database: D1Database,
  scope: CircleCredentialHandoffScope,
  requestID: string,
  payloadHash: string,
  expectedOwnerUserID?: number,
): Promise<CircleCredentialReplay | null> {
  const row = await createDatabase(database)
    .select({
      payloadHash: providerCredentialHandoffReceipts.payloadHash,
      credentialRevision: providerCredentialHandoffReceipts.credentialRevision,
      providerEnvironment: userIdentities.providerEnvironment,
      providerSubject: userIdentities.providerSubject,
      userID: users.id,
      publicID: users.publicID,
      authVersion: users.authVersion,
    })
    .from(providerCredentialHandoffReceipts)
    .innerJoin(
      userIdentities,
      eq(userIdentities.id, providerCredentialHandoffReceipts.userIdentityID),
    )
    .innerJoin(users, eq(users.id, userIdentities.userID))
    .where(
      and(
        eq(providerCredentialHandoffReceipts.actionScope, scope),
        eq(providerCredentialHandoffReceipts.requestID, requestID),
      ),
    )
    .get();
  if (!row) return null;
  if (
    row.payloadHash !== payloadHash ||
    (expectedOwnerUserID !== undefined && row.userID !== expectedOwnerUserID)
  ) {
    throw handoffConflict();
  }
  return {
    receipt: {
      requestId: requestID,
      provider: "circlems",
      environment: circleEnvironment(row.providerEnvironment),
      subject: row.providerSubject,
      credentialRevision: row.credentialRevision,
    },
    identity: {
      subject: row.publicID,
      userID: row.userID,
      authVersion: row.authVersion,
    },
  };
}

export async function transferOwnedCircleCredential(
  database: D1Database,
  ownerUserID: number,
  environment: "production" | "sandbox",
  providerSubject: string,
  input: CircleCredentialInput,
  encodedKey: string,
  scope: CircleCredentialHandoffScope,
  requestID: string,
  payloadHash: string,
  baseCredentialRevision: number | null = null,
  now = Math.floor(Date.now() / 1_000),
): Promise<CircleCredentialReceipt> {
  const replay = await loadCircleCredentialHandoffReplay(
    database,
    scope,
    requestID,
    payloadHash,
    ownerUserID,
  );
  if (replay) return replay.receipt;

  const db = createDatabase(database);
  const identity = await db
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userID, ownerUserID),
        eq(userIdentities.provider, "circlems"),
        eq(userIdentities.providerEnvironment, environment),
        eq(userIdentities.providerSubject, providerSubject),
      ),
    )
    .get();
  if (!identity) throw unavailableCredential();
  const credential = normalizedCredential(input);
  const encrypted = await encryptCredential(
    credential,
    ownerUserID,
    identity.id,
    encodedKey,
  );
  const completesHandoff = credential.refreshToken !== null ? 1 : 0;
  await runDrizzleBatch(database, [
    sql`INSERT INTO provider_credentials (
           user_identity_id, cipher_version, key_version, nonce, ciphertext,
           access_expires_at, scopes_json, credential_revision,
           handoff_completed_at, last_handoff_request_id,
           last_handoff_payload_hash, refresh_lease_id,
           refresh_lease_expires_at, created_at, updated_at
         )
         SELECT identity.id, ${cipherVersion}, ${keyVersion},
                ${encrypted.nonce}, ${encrypted.ciphertext},
                ${credential.accessExpiresAt},
                ${JSON.stringify(credential.scopes)}, 1,
                CASE WHEN ${completesHandoff} = 1 THEN ${now} ELSE NULL END,
                ${requestID}, ${payloadHash}, NULL, NULL, ${now}, ${now}
         FROM user_identities AS identity
         WHERE identity.id = ${identity.id}
           AND identity.user_id = ${ownerUserID}
           AND identity.provider = 'circlems'
           AND ${baseCredentialRevision} IS NULL
         ON CONFLICT(user_identity_id) DO NOTHING`,
    sql`UPDATE provider_credentials SET
           cipher_version = ${cipherVersion}, key_version = ${keyVersion},
           nonce = ${encrypted.nonce}, ciphertext = ${encrypted.ciphertext},
           access_expires_at = ${credential.accessExpiresAt},
           scopes_json = ${JSON.stringify(credential.scopes)},
           credential_revision = credential_revision + 1,
           handoff_completed_at = ${now},
           last_handoff_request_id = ${requestID},
           last_handoff_payload_hash = ${payloadHash}, updated_at = ${now}
         WHERE user_identity_id = ${identity.id}
           AND ${completesHandoff} = 1
           AND (
             (handoff_completed_at IS NULL AND ${baseCredentialRevision} IS NULL)
             OR (handoff_completed_at IS NOT NULL
               AND credential_revision = ${baseCredentialRevision})
           )
           AND (refresh_lease_id IS NULL OR refresh_lease_expires_at <= ${now})`,
    sql`INSERT INTO provider_credential_handoff_receipts (
           action_scope, request_id, user_identity_id, payload_hash,
           credential_revision, created_at
         )
         SELECT ${scope}, ${requestID}, credential.user_identity_id,
                ${payloadHash}, credential.credential_revision, ${now}
         FROM provider_credentials AS credential
         WHERE credential.user_identity_id = ${identity.id}
           AND (
             (${completesHandoff} = 1
               AND credential.last_handoff_request_id = ${requestID}
               AND credential.last_handoff_payload_hash = ${payloadHash})
             OR ${completesHandoff} = 0
           )
         ON CONFLICT(action_scope, request_id) DO NOTHING`,
  ]);
  const stored = await loadCircleCredentialHandoffReplay(
    database,
    scope,
    requestID,
    payloadHash,
    ownerUserID,
  );
  if (!stored) {
    const current = await db
      .select({ credentialRevision: providerCredentials.credentialRevision })
      .from(providerCredentials)
      .where(eq(providerCredentials.userIdentityID, identity.id))
      .get();
    if (credential.refreshToken !== null) {
      throw new ServiceError(
        "provider_credential_revision_conflict",
        409,
        "The Circle.ms credential changed before this handoff.",
        { currentCredentialRevision: current?.credentialRevision ?? null },
      );
    }
    throw new ServiceError(
      "provider_credential_already_transferred",
      409,
      "The Circle.ms refresh credential is already owned by the backend.",
    );
  }
  return stored.receipt;
}

export async function storeOwnedCircleCredential(
  database: D1Database,
  ownerUserID: number,
  environment: "production" | "sandbox",
  providerSubject: string,
  input: CircleCredentialInput,
  encodedKey: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<void> {
  const identity = await createDatabase(database)
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userID, ownerUserID),
        eq(userIdentities.provider, "circlems"),
        eq(userIdentities.providerEnvironment, environment),
        eq(userIdentities.providerSubject, providerSubject),
      ),
    )
    .get();
  if (!identity) throw unavailableCredential();
  await storeCircleCredential(
    database,
    ownerUserID,
    identity.id,
    input,
    encodedKey,
    now,
  );
}

/** Production OAuth callback ownership. Unlike the legacy migration handoff,
 * this is an explicit new provider authorization family and may replace the
 * prior backend-owned family when no refresh lease is active. */
export async function replaceOwnedCircleCredentialFromOAuth(
  database: D1Database,
  ownerUserID: number,
  environment: "production" | "sandbox",
  providerSubject: string,
  input: CircleCredentialInput,
  encodedKey: string,
  oauthFlowID: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<number> {
  const db = createDatabase(database);
  const identity = await db
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userID, ownerUserID),
        eq(userIdentities.provider, "circlems"),
        eq(userIdentities.providerEnvironment, environment),
        eq(userIdentities.providerSubject, providerSubject),
      ),
    )
    .get();
  if (!identity) throw unavailableCredential();
  const replay = await db
    .select({ credentialRevision: providerCredentials.credentialRevision })
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userIdentityID, identity.id),
        eq(providerCredentials.lastOAuthFlowID, oauthFlowID),
      ),
    )
    .get();
  if (replay) return replay.credentialRevision;
  const credential = normalizedCredential(input);
  const encrypted = await encryptCredential(
    credential,
    ownerUserID,
    identity.id,
    encodedKey,
  );
  const result = await db.run(
    sql`INSERT INTO provider_credentials (
         user_identity_id, cipher_version, key_version, nonce, ciphertext,
         access_expires_at, scopes_json, credential_revision,
         handoff_completed_at, last_oauth_flow_id,
         refresh_lease_id, refresh_lease_expires_at, created_at, updated_at
       ) VALUES (${identity.id}, ${cipherVersion}, ${keyVersion},
                 ${encrypted.nonce}, ${encrypted.ciphertext},
                 ${credential.accessExpiresAt},
                 ${JSON.stringify(credential.scopes)}, 1, ${now},
                 ${oauthFlowID}, NULL, NULL, ${now}, ${now})
       ON CONFLICT(user_identity_id) DO UPDATE SET
         cipher_version = excluded.cipher_version,
         key_version = excluded.key_version,
         nonce = excluded.nonce,
         ciphertext = excluded.ciphertext,
         access_expires_at = excluded.access_expires_at,
         scopes_json = excluded.scopes_json,
         credential_revision = provider_credentials.credential_revision + 1,
         handoff_completed_at = excluded.handoff_completed_at,
         last_oauth_flow_id = excluded.last_oauth_flow_id,
         refresh_lease_id = NULL, refresh_lease_expires_at = NULL,
         updated_at = excluded.updated_at
       WHERE provider_credentials.refresh_lease_id IS NULL
          OR provider_credentials.refresh_lease_expires_at <= ${now}`,
  );
  if ((result.meta.changes ?? 0) !== 1) throw unavailableCredential();
  const stored = await db
    .select({ credentialRevision: providerCredentials.credentialRevision })
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userIdentityID, identity.id),
        eq(providerCredentials.lastOAuthFlowID, oauthFlowID),
      ),
    )
    .get();
  if (!stored) throw unavailableCredential();
  return stored.credentialRevision;
}

export async function storeCircleCredential(
  database: D1Database,
  ownerUserID: number,
  identityID: number,
  input: CircleCredentialInput,
  encodedKey: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<void> {
  const credential = normalizedCredential(input);
  const encrypted = await encryptCredential(
    credential,
    ownerUserID,
    identityID,
    encodedKey,
  );
  const result = await createDatabase(database).run(
    sql`INSERT INTO provider_credentials (
         user_identity_id, cipher_version, key_version, nonce, ciphertext,
         access_expires_at, scopes_json, credential_revision,
         refresh_lease_id, refresh_lease_expires_at, created_at, updated_at
       )
       SELECT identity.id, ${cipherVersion}, ${keyVersion},
              ${encrypted.nonce}, ${encrypted.ciphertext},
              ${credential.accessExpiresAt},
              ${JSON.stringify(credential.scopes)}, 1, NULL, NULL,
              ${now}, ${now}
       FROM user_identities AS identity
       WHERE identity.id = ${identityID} AND identity.user_id = ${ownerUserID}
         AND identity.provider = 'circlems'
       ON CONFLICT(user_identity_id) DO UPDATE SET
         cipher_version = excluded.cipher_version,
         key_version = excluded.key_version,
         nonce = excluded.nonce,
         ciphertext = excluded.ciphertext,
         access_expires_at = excluded.access_expires_at,
         scopes_json = excluded.scopes_json,
         credential_revision = provider_credentials.credential_revision + 1,
         refresh_lease_id = NULL, refresh_lease_expires_at = NULL,
         updated_at = excluded.updated_at
       WHERE (
           provider_credentials.refresh_lease_id IS NULL
           OR provider_credentials.refresh_lease_expires_at <= ${now}
         ) AND provider_credentials.handoff_completed_at IS NULL`,
  );
  if ((result.meta.changes ?? 0) !== 1) throw unavailableCredential();
}

export async function loadCircleCredential(
  database: D1Database,
  ownerUserID: number,
  identityID: number,
  encodedKey: string,
): Promise<CircleCredential> {
  const row = await createDatabase(database)
    .select({
      cipherVersion: providerCredentials.cipherVersion,
      keyVersion: providerCredentials.keyVersion,
      nonce: providerCredentials.nonce,
      ciphertext: providerCredentials.ciphertext,
    })
    .from(providerCredentials)
    .innerJoin(
      userIdentities,
      eq(userIdentities.id, providerCredentials.userIdentityID),
    )
    .where(
      and(
        eq(userIdentities.id, identityID),
        eq(userIdentities.userID, ownerUserID),
        eq(userIdentities.provider, "circlems"),
      ),
    )
    .get();
  if (
    !row ||
    row.cipherVersion !== cipherVersion ||
    row.keyVersion !== keyVersion
  ) {
    throw unavailableCredential();
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64URL(row.nonce),
        additionalData: additionalData(ownerUserID, identityID),
      },
      await importKey(encodedKey),
      decodeBase64URL(row.ciphertext),
    );
    return normalizedCredential(
      JSON.parse(new TextDecoder().decode(plaintext)) as CircleCredentialInput,
    );
  } catch {
    throw unavailableCredential();
  }
}

export async function refreshOwnedCircleCredential(
  database: D1Database,
  ownerUserID: number,
  identityID: number,
  encodedKey: string,
  bindings: CircleCredentialRefreshBindings,
  fetcher: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1_000),
): Promise<CircleCredential> {
  const db = createDatabase(database);
  const identity = await db
    .select({ providerEnvironment: userIdentities.providerEnvironment })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.id, identityID),
        eq(userIdentities.userID, ownerUserID),
        eq(userIdentities.provider, "circlems"),
      ),
    )
    .get();
  if (!identity) throw unavailableCredential();
  const leaseID = crypto.randomUUID();
  const ownedIdentity = db
    .select({ value: sql`1` })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.id, identityID),
        eq(userIdentities.userID, ownerUserID),
        eq(userIdentities.provider, "circlems"),
      ),
    );
  const leased = await db
    .update(providerCredentials)
    .set({
      refreshLeaseID: leaseID,
      refreshLeaseExpiresAt: now + 60,
      updatedAt: now,
    })
    .where(
      and(
        eq(providerCredentials.userIdentityID, identityID),
        or(
          isNull(providerCredentials.refreshLeaseID),
          lte(providerCredentials.refreshLeaseExpiresAt, now),
        ),
        exists(ownedIdentity),
      ),
    )
    .run();
  if ((leased.meta.changes ?? 0) !== 1) throw unavailableCredential();
  let current: CircleCredential;
  try {
    current = await loadCircleCredential(
      database,
      ownerUserID,
      identityID,
      encodedKey,
    );
    if (!current.refreshToken) throw unavailableCredential();
  } catch (error) {
    await releaseRefreshLease(database, identityID, leaseID, now);
    throw error;
  }
  const production =
    circleEnvironment(identity.providerEnvironment) === "production";
  const origin = production
    ? bindings.COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_ORIGIN
    : bindings.COMINAVI_OAUTH_CIRCLEMS_SANDBOX_ORIGIN;
  const clientID = production
    ? bindings.COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_ID
    : bindings.COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_ID;
  const clientSecret = production
    ? bindings.COMINAVI_OAUTH_CIRCLEMS_PRODUCTION_CLIENT_SECRET
    : bindings.COMINAVI_OAUTH_CIRCLEMS_SANDBOX_CLIENT_SECRET;
  if (!origin || !clientID || !clientSecret) {
    await releaseRefreshLease(database, identityID, leaseID, now);
    throw unavailableCredential();
  }
  let response: Response;
  try {
    response = await fetcher(new URL("/OAuth2/Token", origin), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: clientID,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    await releaseRefreshLease(database, identityID, leaseID, now);
    throw unavailableCredential();
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    await releaseRefreshLease(database, identityID, leaseID, now);
    throw unavailableCredential();
  }
  if (!response.ok || !isTokenResponse(value)) {
    await releaseRefreshLease(database, identityID, leaseID, now);
    throw unavailableCredential();
  }
  const expiresIn = Number(value.expires_in);
  const refreshed: CircleCredential = {
    accessToken: value.access_token,
    refreshToken:
      typeof value.refresh_token === "string" && value.refresh_token
        ? value.refresh_token
        : current.refreshToken,
    accessExpiresAt:
      Number.isSafeInteger(expiresIn) && expiresIn > 0 ? now + expiresIn : null,
    scopes: current.scopes,
  };
  const encrypted = await encryptCredential(
    refreshed,
    ownerUserID,
    identityID,
    encodedKey,
  );
  const stored = await db
    .update(providerCredentials)
    .set({
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext,
      accessExpiresAt: refreshed.accessExpiresAt,
      scopesJSON: JSON.stringify(refreshed.scopes),
      credentialRevision: sql`${providerCredentials.credentialRevision} + 1`,
      refreshLeaseID: null,
      refreshLeaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(providerCredentials.userIdentityID, identityID),
        eq(providerCredentials.refreshLeaseID, leaseID),
      ),
    )
    .run();
  if ((stored.meta.changes ?? 0) !== 1) throw unavailableCredential();
  return refreshed;
}

async function encryptCredential(
  credential: CircleCredential,
  ownerUserID: number,
  identityID: number,
  encodedKey: string,
): Promise<{ nonce: string; ciphertext: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: additionalData(ownerUserID, identityID),
    },
    await importKey(encodedKey),
    new TextEncoder().encode(JSON.stringify(credential)),
  );
  return {
    nonce: encodeBase64URL(nonce),
    ciphertext: encodeBase64URL(new Uint8Array(ciphertext)),
  };
}

async function releaseRefreshLease(
  database: D1Database,
  identityID: number,
  leaseID: string,
  now: number,
): Promise<void> {
  await createDatabase(database)
    .update(providerCredentials)
    .set({
      refreshLeaseID: null,
      refreshLeaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(providerCredentials.userIdentityID, identityID),
        eq(providerCredentials.refreshLeaseID, leaseID),
      ),
    )
    .run();
}

function normalizedCredential(input: CircleCredentialInput): CircleCredential {
  if (!input || typeof input.accessToken !== "string" || !input.accessToken)
    throw new TypeError("Circle.ms access token is required.");
  const refreshToken = input.refreshToken ?? null;
  if (refreshToken !== null && typeof refreshToken !== "string")
    throw new TypeError("Invalid Circle.ms refresh token.");
  const accessExpiresAt = input.accessExpiresAt ?? null;
  if (
    accessExpiresAt !== null &&
    (!Number.isSafeInteger(accessExpiresAt) || accessExpiresAt < 1)
  ) {
    throw new TypeError("Invalid Circle.ms credential expiry.");
  }
  const scopes = [...new Set(input.scopes ?? [])].sort();
  if (scopes.some((scope) => typeof scope !== "string" || !scope))
    throw new TypeError("Invalid Circle.ms credential scope.");
  return {
    accessToken: input.accessToken,
    refreshToken,
    accessExpiresAt,
    scopes,
  };
}

function isTokenResponse(value: unknown): value is {
  access_token: string;
  refresh_token?: string;
  expires_in?: string | number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "access_token" in value &&
    typeof value.access_token === "string" &&
    value.access_token.length > 0
  );
}

async function importKey(value: string): Promise<CryptoKey> {
  const bytes = decodeBase64URL(value);
  if (bytes.byteLength !== 32)
    throw new TypeError("Credential encryption key must be 32 bytes.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function additionalData(
  userID: number,
  identityID: number,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `cominavi:circlems-credential:v1:${userID}:${identityID}`,
  );
}

function encodeBase64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64URL(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw unavailableCredential();
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    decoded[index] = binary.charCodeAt(index);
  }
  return decoded;
}

function unavailableCredential(): ServiceError {
  return new ServiceError(
    "provider_credential_unavailable",
    404,
    "Circle.ms credentials are unavailable for this identity.",
  );
}

function circleEnvironment(
  value: "" | "production" | "sandbox",
): "production" | "sandbox" {
  if (value === "production" || value === "sandbox") return value;
  throw unavailableCredential();
}

function handoffConflict(): ServiceError {
  return new ServiceError(
    "idempotency_conflict",
    409,
    "The requestId was already used with a different credential payload.",
  );
}
