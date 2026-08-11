import { and, eq, gt, lte, sql, type SQLWrapper } from "drizzle-orm";
import { createDatabase } from "../db/client";
import {
  catalogInternalCommandReceipts,
  catalogMultipartUploadReceipts,
} from "../db/schema";
import { ServiceError } from "./service-error";

const defaultMaximumBodyBytes = 1_000_000;

export async function authenticateCatalogPublisherRequest(
  request: Request,
  secrets: string | { manual: string; scheduled: string },
  maximumBodyBytes = defaultMaximumBodyBytes,
  nowMilliseconds = Date.now(),
): Promise<{
  rawBody: Uint8Array;
  payloadSHA256: string;
  idempotencyKey: string;
  signerScope: "manual" | "scheduled";
}> {
  const candidates =
    typeof secrets === "string"
      ? ([{ scope: "manual", secret: secrets }] as const)
      : ([
          { scope: "manual", secret: secrets.manual },
          { scope: "scheduled", secret: secrets.scheduled },
        ] as const);
  if (
    typeof secrets !== "string" &&
    secrets.manual.length >= 32 &&
    secrets.scheduled.length >= 32 &&
    secrets.manual === secrets.scheduled
  ) {
    throw unavailable();
  }
  if (candidates.every((candidate) => candidate.secret.length < 32)) {
    throw unavailable();
  }
  const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
  const timestampText = request.headers.get("X-ComiNavi-Timestamp") ?? "";
  const signatureText = request.headers.get("X-ComiNavi-Signature") ?? "";
  const timestamp = Number(timestampText);
  const signature = /^v1=([0-9a-f]{64})$/.exec(signatureText)?.[1];
  if (
    !/^[A-Za-z0-9._:-]{16,200}$/.test(idempotencyKey) ||
    !Number.isSafeInteger(timestamp) ||
    !signature ||
    Math.abs(Math.floor(nowMilliseconds / 1_000) - timestamp) > 300
  ) {
    throw unauthorized();
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maximumBodyBytes) {
    throw new ServiceError(
      "catalog_publication_too_large",
      413,
      "The catalog publication request is too large.",
    );
  }
  const rawBody = new Uint8Array(buffer);
  const payloadSHA256 = await sha256Hex(rawBody);
  const url = new URL(request.url);
  const canonical = `${timestampText}\n${idempotencyKey}\n${request.method}\n${url.pathname}${url.search}\n${payloadSHA256}`;
  let signerScope: "manual" | "scheduled" | null = null;
  for (const candidate of candidates) {
    if (candidate.secret.length < 32) continue;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(candidate.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(canonical),
      ),
    );
    if (constantTimeEqual(expected, hexBytes(signature))) {
      signerScope = candidate.scope;
    }
  }
  if (!signerScope) throw unauthorized();
  return { rawBody, payloadSHA256, idempotencyKey, signerScope };
}

export async function bindCatalogPublisherCommand(
  database: D1Database,
  idempotencyKey: string,
  actionScope: string,
  payloadSHA256: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<void> {
  const db = createDatabase(database);
  await db
    .insert(catalogInternalCommandReceipts)
    .values({
      idempotencyKey,
      actionScope,
      payloadHash: payloadSHA256,
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
  const row = await db
    .select({
      actionScope: catalogInternalCommandReceipts.actionScope,
      payloadHash: catalogInternalCommandReceipts.payloadHash,
    })
    .from(catalogInternalCommandReceipts)
    .where(eq(catalogInternalCommandReceipts.idempotencyKey, idempotencyKey))
    .get();
  if (
    !row ||
    row.actionScope !== actionScope ||
    row.payloadHash !== payloadSHA256
  ) {
    throw new ServiceError(
      "idempotency_conflict",
      409,
      "The internal idempotency key was used with a different command.",
    );
  }
}

export async function loadCatalogPublisherCommandResult<T>(
  database: D1Database,
  idempotencyKey: string,
  actionScope: string,
  payloadSHA256: string,
): Promise<T | null> {
  const row = await createDatabase(database)
    .select({
      actionScope: catalogInternalCommandReceipts.actionScope,
      payloadHash: catalogInternalCommandReceipts.payloadHash,
      resultJSON: catalogInternalCommandReceipts.resultJSON,
    })
    .from(catalogInternalCommandReceipts)
    .where(eq(catalogInternalCommandReceipts.idempotencyKey, idempotencyKey))
    .get();
  if (
    !row ||
    row.actionScope !== actionScope ||
    row.payloadHash !== payloadSHA256
  ) {
    throw new ServiceError(
      "idempotency_conflict",
      409,
      "The internal idempotency key was used with a different command.",
    );
  }
  return row.resultJSON === null ? null : (JSON.parse(row.resultJSON) as T);
}

export interface CatalogMultipartReceiptMetadata {
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: string;
  visibility: "private_source" | "authenticated_download";
  claimID?: string;
  leaseID?: string;
  sourceMD5Hint?: string;
}

export async function beginCatalogMultipartUpload(
  database: D1Database,
  idempotencyKey: string,
  metadata: CatalogMultipartReceiptMetadata,
  now = Math.floor(Date.now() / 1_000),
): Promise<{ create: true } | { create: false; uploadID: string }> {
  const db = createDatabase(database);
  const inserted = await db
    .insert(catalogMultipartUploadReceipts)
    .values({
      idempotencyKey,
      state: "creating",
      objectKey: metadata.objectKey,
      sha256: metadata.sha256,
      byteCount: metadata.bytes,
      contentType: metadata.contentType,
      visibility: metadata.visibility,
      claimID: metadata.claimID ?? null,
      leaseID: metadata.leaseID ?? null,
      sourceMD5Hint: metadata.sourceMD5Hint ?? null,
      uploadID: null,
      expiresAt: now + 60,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  const row = await loadMultipartReceipt(database, idempotencyKey);
  if (!row || !matchesMultipartReceipt(row, metadata)) {
    throw idempotencyConflict();
  }
  if (row.state === "active" && row.upload_id && row.expires_at > now) {
    return { create: false, uploadID: row.upload_id };
  }
  if (row.state === "active" || row.state === "completed") {
    throw multipartUploadExpired();
  }
  if (row.state === "creating" && row.expires_at <= now) {
    const reclaimed = await db
      .update(catalogMultipartUploadReceipts)
      .set({ expiresAt: now + 60, updatedAt: now })
      .where(
        and(
          eq(catalogMultipartUploadReceipts.idempotencyKey, idempotencyKey),
          eq(catalogMultipartUploadReceipts.state, "creating"),
          lte(catalogMultipartUploadReceipts.expiresAt, now),
        ),
      )
      .run();
    if ((reclaimed.meta.changes ?? 0) === 1) return { create: true };
  }
  if ((inserted.meta.changes ?? 0) !== 1) {
    throw new ServiceError(
      "catalog_multipart_create_in_progress",
      409,
      "The multipart upload is still being created; retry this exact command.",
    );
  }
  return { create: true };
}

export async function recordCatalogMultipartUpload(
  database: D1Database,
  idempotencyKey: string,
  metadata: CatalogMultipartReceiptMetadata,
  uploadID: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<void> {
  const result = await createDatabase(database)
    .update(catalogMultipartUploadReceipts)
    .set({
      state: "active",
      uploadID,
      expiresAt: now + 6 * 24 * 60 * 60,
      updatedAt: now,
    })
    .where(
      and(
        eq(catalogMultipartUploadReceipts.idempotencyKey, idempotencyKey),
        eq(catalogMultipartUploadReceipts.state, "creating"),
        eq(catalogMultipartUploadReceipts.objectKey, metadata.objectKey),
        eq(catalogMultipartUploadReceipts.sha256, metadata.sha256),
        eq(catalogMultipartUploadReceipts.byteCount, metadata.bytes),
        eq(catalogMultipartUploadReceipts.contentType, metadata.contentType),
        eq(catalogMultipartUploadReceipts.visibility, metadata.visibility),
        nullableEquals(
          catalogMultipartUploadReceipts.claimID,
          metadata.claimID,
        ),
        nullableEquals(
          catalogMultipartUploadReceipts.leaseID,
          metadata.leaseID,
        ),
        nullableEquals(
          catalogMultipartUploadReceipts.sourceMD5Hint,
          metadata.sourceMD5Hint,
        ),
      ),
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) throw idempotencyConflict();
}

export async function assertCatalogMultipartUpload(
  database: D1Database,
  objectKey: string,
  uploadID: string,
  authority: Pick<
    CatalogMultipartReceiptMetadata,
    "claimID" | "leaseID" | "sourceMD5Hint"
  >,
  now = Math.floor(Date.now() / 1_000),
): Promise<void> {
  const row = await createDatabase(database)
    .select({ authorized: catalogMultipartUploadReceipts.idempotencyKey })
    .from(catalogMultipartUploadReceipts)
    .where(
      and(
        eq(catalogMultipartUploadReceipts.objectKey, objectKey),
        eq(catalogMultipartUploadReceipts.uploadID, uploadID),
        eq(catalogMultipartUploadReceipts.state, "active"),
        gt(catalogMultipartUploadReceipts.expiresAt, now),
        nullableEquals(
          catalogMultipartUploadReceipts.claimID,
          authority.claimID,
        ),
        nullableEquals(
          catalogMultipartUploadReceipts.leaseID,
          authority.leaseID,
        ),
        nullableEquals(
          catalogMultipartUploadReceipts.sourceMD5Hint,
          authority.sourceMD5Hint,
        ),
      ),
    )
    .get();
  if (!row) throw multipartUploadExpired();
}

export async function completeCatalogMultipartUploadReceipt(
  database: D1Database,
  objectKey: string,
  uploadID: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<void> {
  await createDatabase(database)
    .update(catalogMultipartUploadReceipts)
    .set({ state: "completed", updatedAt: now })
    .where(
      and(
        eq(catalogMultipartUploadReceipts.objectKey, objectKey),
        eq(catalogMultipartUploadReceipts.uploadID, uploadID),
        eq(catalogMultipartUploadReceipts.state, "active"),
      ),
    )
    .run();
}

interface MultipartReceiptRow {
  state: "creating" | "active" | "completed";
  object_key: string;
  sha256: string;
  byte_count: number;
  content_type: string;
  visibility: "private_source" | "authenticated_download";
  claim_id: string | null;
  lease_id: string | null;
  source_md5_hint: string | null;
  upload_id: string | null;
  expires_at: number;
}

async function loadMultipartReceipt(
  database: D1Database,
  idempotencyKey: string,
): Promise<MultipartReceiptRow | null> {
  const row = await createDatabase(database)
    .select()
    .from(catalogMultipartUploadReceipts)
    .where(eq(catalogMultipartUploadReceipts.idempotencyKey, idempotencyKey))
    .get();
  return row
    ? {
        state: row.state,
        object_key: row.objectKey,
        sha256: row.sha256,
        byte_count: row.byteCount,
        content_type: row.contentType,
        visibility: row.visibility,
        claim_id: row.claimID,
        lease_id: row.leaseID,
        source_md5_hint: row.sourceMD5Hint,
        upload_id: row.uploadID,
        expires_at: row.expiresAt,
      }
    : null;
}

function nullableEquals(column: SQLWrapper, value: string | undefined) {
  return sql`${column} IS ${value ?? null}`;
}

function matchesMultipartReceipt(
  row: MultipartReceiptRow,
  metadata: CatalogMultipartReceiptMetadata,
): boolean {
  return (
    row.object_key === metadata.objectKey &&
    row.sha256 === metadata.sha256 &&
    row.byte_count === metadata.bytes &&
    row.content_type === metadata.contentType &&
    row.visibility === metadata.visibility &&
    row.claim_id === (metadata.claimID ?? null) &&
    row.lease_id === (metadata.leaseID ?? null) &&
    row.source_md5_hint === (metadata.sourceMD5Hint ?? null)
  );
}

function idempotencyConflict(): ServiceError {
  return new ServiceError(
    "idempotency_conflict",
    409,
    "The internal idempotency key was used with a different command.",
  );
}

function multipartUploadExpired(): ServiceError {
  return new ServiceError(
    "catalog_multipart_upload_expired",
    410,
    "The multipart upload is no longer resumable; start a new upload command.",
  );
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(value);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function unavailable(): ServiceError {
  return new ServiceError(
    "catalog_publication_unavailable",
    503,
    "Catalog publication authentication is not configured.",
  );
}

function unauthorized(): ServiceError {
  return new ServiceError(
    "invalid_catalog_publication_signature",
    401,
    "The catalog publication signature is invalid or expired.",
  );
}
