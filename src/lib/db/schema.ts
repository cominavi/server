import { desc, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// This schema mirrors the final D1 shape after migrations 0001-0008.
// The checked-in SQL migrations remain deployment authority; this module
// provides the typed query surface for Worker services.

export const accountDeletionJobs = sqliteTable(
  "account_deletion_jobs",
  {
    requestID: text("request_id").primaryKey(),
    payloadHash: text("payload_hash").notNull(),
    originalSubjectHash: text("original_subject_hash").notNull(),
    originalAuthVersion: integer("original_auth_version").notNull(),
    userID: integer("user_id"),
    planIdsJSON: text("plan_ids_json").notNull(),
    followingSnapshotKey: text("following_snapshot_key"),
    avatarObjectKey: text("avatar_object_key"),
    state: text("state", {
      enum: ["fenced", "external_cleanup", "leased", "completed"] as const,
    }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(sql.raw("0")),
    leaseID: text("lease_id"),
    leaseExpiresAt: integer("lease_expires_at"),
    availableAt: integer("available_at").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    index("account_deletion_jobs_ready").on(table.state, table.availableAt),
    unique().on(table.userID),
    check(
      "account_deletion_jobs_check_1",
      sql.raw("length(payload_hash) = 64"),
    ),
    check(
      "account_deletion_jobs_check_2",
      sql.raw("length(original_subject_hash) = 64"),
    ),
    check(
      "account_deletion_jobs_check_3",
      sql.raw("original_auth_version > 0"),
    ),
    check(
      "account_deletion_jobs_check_4",
      sql.raw("json_valid(plan_ids_json)"),
    ),
    check(
      "account_deletion_jobs_check_5",
      sql.raw("state IN ('fenced', 'external_cleanup', 'leased', 'completed')"),
    ),
    check("account_deletion_jobs_check_6", sql.raw("attempt_count >= 0")),
  ],
);

export const appleAuthRequests = sqliteTable(
  "apple_auth_requests",
  {
    requestID: text("request_id").primaryKey(),
    payloadHash: text("payload_hash").notNull(),
    grantHash: text("grant_hash").notNull(),
    nonceHash: text("nonce_hash").notNull(),
    authorizationCodeHash: text("authorization_code_hash").notNull(),
    state: text("state", {
      enum: ["exchanging", "staged", "indeterminate", "completed"] as const,
    }).notNull(),
    appleSubject: text("apple_subject").notNull(),
    appleSubjectDigest: text("apple_subject_digest").notNull(),
    proofIssuedAt: integer("proof_issued_at"),
    clientID: text("client_id").notNull(),
    observedUserID: integer("observed_user_id"),
    observedAuthVersion: integer("observed_auth_version"),
    providerEmail: text("provider_email"),
    displayName: text("display_name"),
    stageNonce: text("stage_nonce"),
    stageCiphertext: text("stage_ciphertext"),
    cleanupLeaseID: text("cleanup_lease_id"),
    cleanupLeaseExpiresAt: integer("cleanup_lease_expires_at"),
    cleanupAttemptCount: integer("cleanup_attempt_count")
      .notNull()
      .default(sql.raw("0")),
    cleanupAvailableAt: integer("cleanup_available_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    unique().on(table.authorizationCodeHash),
    check("apple_auth_requests_check_1", sql.raw("length(payload_hash) = 64")),
    check("apple_auth_requests_check_2", sql.raw("length(nonce_hash) = 64")),
    check(
      "apple_auth_requests_check_3",
      sql.raw("length(authorization_code_hash) = 64"),
    ),
    check(
      "apple_auth_requests_check_4",
      sql.raw(
        "state IN ('exchanging', 'staged', 'indeterminate', 'completed')",
      ),
    ),
    check(
      "apple_auth_requests_check_5",
      sql.raw("length(apple_subject_digest) = 64"),
    ),
  ],
);

export const appleProviderRevocations = sqliteTable(
  "apple_provider_revocations",
  {
    id: text("id").primaryKey(),
    clientID: text("client_id").notNull(),
    aad: text("aad").notNull(),
    nonce: text("nonce").notNull(),
    ciphertext: text("ciphertext").notNull(),
    state: text("state", { enum: ["queued", "leased"] as const }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(sql.raw("0")),
    leaseID: text("lease_id"),
    leaseExpiresAt: integer("lease_expires_at"),
    availableAt: integer("available_at").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("apple_provider_revocations_available").on(
      table.state,
      table.availableAt,
    ),
    check(
      "apple_provider_revocations_check_1",
      sql.raw("state IN ('queued', 'leased')"),
    ),
  ],
);

export const authLogoutReceipts = sqliteTable(
  "auth_logout_receipts",
  {
    requestID: text("request_id").primaryKey(),
    payloadHash: text("payload_hash").notNull(),
    subjectDigest: text("subject_digest").notNull(),
    originalAuthVersion: integer("original_auth_version").notNull(),
    resultAuthVersion: integer("result_auth_version").notNull(),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  () => [
    check("auth_logout_receipts_check_1", sql.raw("length(payload_hash) = 64")),
    check(
      "auth_logout_receipts_check_2",
      sql.raw("length(subject_digest) = 64"),
    ),
    check("auth_logout_receipts_check_3", sql.raw("original_auth_version > 0")),
    check("auth_logout_receipts_check_4", sql.raw("result_auth_version > 1")),
    check(
      "auth_logout_receipts_check_5",
      sql.raw("length(refresh_token_hash) = 64"),
    ),
  ],
);

export const avatarObjectCleanup = sqliteTable(
  "avatar_object_cleanup",
  {
    id: text("id").primaryKey(),
    objectKey: text("object_key").notNull(),
    state: text("state", { enum: ["queued", "leased"] as const })
      .notNull()
      .default(sql.raw("'queued'")),
    attemptCount: integer("attempt_count").notNull().default(sql.raw("0")),
    leaseID: text("lease_id"),
    leaseExpiresAt: integer("lease_expires_at"),
    availableAt: integer("available_at").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("avatar_object_cleanup_ready").on(
      table.state,
      table.availableAt,
      table.createdAt,
    ),
    unique().on(table.objectKey),
    check(
      "avatar_object_cleanup_check_1",
      sql.raw("state IN ('queued', 'leased')"),
    ),
  ],
);

export const catalogEvents = sqliteTable(
  "catalog_events",
  {
    comiketNo: integer("comiket_no").primaryKey(),
    name: text("name").notNull(),
    providerCirclemsEventID: integer("provider_circlems_event_id"),
    activeVersionID: text("active_version_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  () => [
    check("catalog_events_check_1", sql.raw("comiket_no > 0")),
    check(
      "catalog_events_check_2",
      sql.raw("length(trim(name)) BETWEEN 1 AND 100"),
    ),
    check("catalog_events_check_3", sql.raw("provider_circlems_event_id > 0")),
  ],
);

export const catalogInternalCommandReceipts = sqliteTable(
  "catalog_internal_command_receipts",
  {
    idempotencyKey: text("idempotency_key").primaryKey(),
    actionScope: text("action_scope").notNull(),
    payloadHash: text("payload_hash").notNull(),
    resultJSON: text("result_json"),
    createdAt: integer("created_at").notNull(),
  },
  () => [
    check(
      "catalog_internal_command_receipts_check_1",
      sql.raw("length(payload_hash) = 64"),
    ),
    check(
      "catalog_internal_command_receipts_check_2",
      sql.raw("result_json IS NULL OR json_valid(result_json)"),
    ),
  ],
);

export const catalogMultipartUploadReceipts = sqliteTable(
  "catalog_multipart_upload_receipts",
  {
    idempotencyKey: text("idempotency_key").primaryKey(),
    state: text("state", {
      enum: ["creating", "active", "completed"] as const,
    }).notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    byteCount: integer("byte_count").notNull(),
    contentType: text("content_type").notNull(),
    visibility: text("visibility", {
      enum: ["private_source", "authenticated_download"] as const,
    }).notNull(),
    claimID: text("claim_id"),
    leaseID: text("lease_id"),
    sourceMD5Hint: text("source_md5_hint"),
    uploadID: text("upload_id"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.idempotencyKey],
      foreignColumns: [catalogInternalCommandReceipts.idempotencyKey],
    }).onDelete("cascade"),
    check(
      "catalog_multipart_upload_receipts_check_1",
      sql.raw("state IN ('creating', 'active', 'completed')"),
    ),
    check(
      "catalog_multipart_upload_receipts_check_2",
      sql.raw("length(sha256) = 64"),
    ),
    check(
      "catalog_multipart_upload_receipts_check_3",
      sql.raw("byte_count > 0"),
    ),
    check(
      "catalog_multipart_upload_receipts_check_4",
      sql.raw("visibility IN ('private_source', 'authenticated_download')"),
    ),
  ],
);

export const catalogVersions = sqliteTable(
  "catalog_versions",
  {
    id: text("id").primaryKey(),
    comiketNo: integer("comiket_no").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    state: text("state", {
      enum: ["staging", "published", "superseded", "failed"] as const,
    }).notNull(),
    claimID: text("claim_id").notNull(),
    sourceUpdatedAt: integer("source_updated_at"),
    sourceMD5Hint: text("source_md5_hint"),
    sourceMainSHA256: text("source_main_sha256").notNull(),
    sourceImageSHA256: text("source_image_sha256").notNull(),
    derivedSHA256: text("derived_sha256"),
    derivedBytes: integer("derived_bytes"),
    dateCount: integer("date_count").notNull().default(sql.raw("0")),
    mapCount: integer("map_count").notNull().default(sql.raw("0")),
    areaCount: integer("area_count").notNull().default(sql.raw("0")),
    blockCount: integer("block_count").notNull().default(sql.raw("0")),
    floorCount: integer("floor_count").notNull().default(sql.raw("0")),
    mappingCount: integer("mapping_count").notNull().default(sql.raw("0")),
    genreCount: integer("genre_count").notNull().default(sql.raw("0")),
    circleCount: integer("circle_count").notNull().default(sql.raw("0")),
    layoutCount: integer("layout_count").notNull().default(sql.raw("0")),
    imageCount: integer("image_count").notNull().default(sql.raw("0")),
    createdAt: integer("created_at").notNull(),
    publishedAt: integer("published_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.comiketNo],
      foreignColumns: [catalogEvents.comiketNo],
    }),
    index("catalog_versions_event_state").on(
      table.comiketNo,
      table.state,
      table.publishedAt,
    ),
    unique().on(
      table.comiketNo,
      table.sourceMainSHA256,
      table.sourceImageSHA256,
    ),
    check("catalog_versions_check_1", sql.raw("schema_version = 1")),
    check(
      "catalog_versions_check_2",
      sql.raw("state IN ('staging', 'published', 'superseded', 'failed')"),
    ),
    check(
      "catalog_versions_check_3",
      sql.raw("source_md5_hint IS NULL OR length(source_md5_hint) = 65"),
    ),
    check(
      "catalog_versions_check_4",
      sql.raw("length(source_main_sha256) = 64"),
    ),
    check(
      "catalog_versions_check_5",
      sql.raw("length(source_image_sha256) = 64"),
    ),
    check(
      "catalog_versions_check_6",
      sql.raw("derived_sha256 IS NULL OR length(derived_sha256) = 64"),
    ),
    check(
      "catalog_versions_check_7",
      sql.raw("derived_bytes IS NULL OR derived_bytes > 0"),
    ),
    check("catalog_versions_check_8", sql.raw("date_count >= 0")),
    check("catalog_versions_check_9", sql.raw("map_count >= 0")),
    check("catalog_versions_check_10", sql.raw("area_count >= 0")),
    check("catalog_versions_check_11", sql.raw("block_count >= 0")),
    check("catalog_versions_check_12", sql.raw("floor_count >= 0")),
    check("catalog_versions_check_13", sql.raw("mapping_count >= 0")),
    check("catalog_versions_check_14", sql.raw("genre_count >= 0")),
    check("catalog_versions_check_15", sql.raw("circle_count >= 0")),
    check("catalog_versions_check_16", sql.raw("layout_count >= 0")),
    check("catalog_versions_check_17", sql.raw("image_count >= 0")),
  ],
);

export const circleTagOverlayObjectCleanup = sqliteTable(
  "circle_tag_overlay_object_cleanup",
  {
    objectKey: text("object_key").primaryKey(),
    eventNumber: integer("event_number").notNull(),
    revision: text("revision").notNull(),
    objectSHA256: text("object_sha256").notNull(),
    state: text("state", { enum: ["queued", "leased"] as const })
      .notNull()
      .default(sql.raw("'queued'")),
    attemptCount: integer("attempt_count").notNull().default(sql.raw("0")),
    leaseID: text("lease_id"),
    leaseExpiresAt: integer("lease_expires_at"),
    availableAt: integer("available_at").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("circle_tag_overlay_object_cleanup_ready").on(
      table.state,
      table.availableAt,
      table.createdAt,
    ),
    check(
      "circle_tag_overlay_object_cleanup_check_1",
      sql.raw("state IN ('queued', 'leased')"),
    ),
    check(
      "circle_tag_overlay_object_cleanup_check_2",
      sql.raw("event_number > 0 AND event_number <= 10000"),
    ),
    check(
      "circle_tag_overlay_object_cleanup_check_3",
      sql.raw("length(revision) = 64 AND revision NOT GLOB '*[^0-9a-f]*'"),
    ),
    check(
      "circle_tag_overlay_object_cleanup_check_4",
      sql.raw(
        "length(object_sha256) = 64 AND object_sha256 NOT GLOB '*[^0-9a-f]*'",
      ),
    ),
  ],
);

export const circleTagOverlayVersions = sqliteTable(
  "circle_tag_overlay_versions",
  {
    eventNumber: integer("event_number").notNull(),
    revision: text("revision").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    catalogVersionID: text("catalog_version_id").notNull(),
    catalogPayloadSHA256: text("catalog_payload_sha256").notNull(),
    taxonomyRevision: text("taxonomy_revision").notNull(),
    matchingPolicyRevision: text("matching_policy_revision").notNull(),
    evaluatedCircleCount: integer("evaluated_circle_count").notNull(),
    taggedCircleCount: integer("tagged_circle_count").notNull(),
    termCount: integer("term_count").notNull(),
    objectKey: text("object_key").notNull(),
    objectSHA256: text("object_sha256").notNull(),
    byteCount: integer("byte_count").notNull(),
    publishedAt: integer("published_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventNumber, table.revision] }),
    foreignKey({
      columns: [table.catalogVersionID],
      foreignColumns: [catalogVersions.id],
    }),
    unique().on(table.objectKey),
    check(
      "circle_tag_overlay_versions_check_1",
      sql.raw("event_number > 0 AND event_number <= 10000"),
    ),
    check("circle_tag_overlay_versions_check_2", sql.raw("schema_version = 1")),
    check(
      "circle_tag_overlay_versions_check_3",
      sql.raw("length(revision) = 64 AND revision NOT GLOB '*[^0-9a-f]*'"),
    ),
    check(
      "circle_tag_overlay_versions_check_4",
      sql.raw(
        "length(catalog_payload_sha256) = 64 AND catalog_payload_sha256 NOT GLOB '*[^0-9a-f]*'",
      ),
    ),
    check(
      "circle_tag_overlay_versions_check_5",
      sql.raw("length(taxonomy_revision) BETWEEN 1 AND 128"),
    ),
    check(
      "circle_tag_overlay_versions_check_6",
      sql.raw("length(matching_policy_revision) BETWEEN 1 AND 128"),
    ),
    check(
      "circle_tag_overlay_versions_check_7",
      sql.raw("evaluated_circle_count >= 0"),
    ),
    check(
      "circle_tag_overlay_versions_check_8",
      sql.raw(
        "tagged_circle_count >= 0 AND tagged_circle_count <= evaluated_circle_count",
      ),
    ),
    check("circle_tag_overlay_versions_check_9", sql.raw("term_count >= 0")),
    check(
      "circle_tag_overlay_versions_check_10",
      sql.raw(
        "length(object_sha256) = 64 AND object_sha256 NOT GLOB '*[^0-9a-f]*'",
      ),
    ),
    check(
      "circle_tag_overlay_versions_check_11",
      sql.raw("byte_count > 0 AND byte_count <= 16777216"),
    ),
  ],
);

export const circleTagOverlayHeads = sqliteTable(
  "circle_tag_overlay_heads",
  {
    eventNumber: integer("event_number").primaryKey(),
    revision: text("revision").notNull(),
    publicationIdempotencyKey: text("publication_idempotency_key").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.eventNumber, table.revision],
      foreignColumns: [
        circleTagOverlayVersions.eventNumber,
        circleTagOverlayVersions.revision,
      ],
    }),
    check(
      "circle_tag_overlay_heads_check_1",
      sql.raw("event_number > 0 AND event_number <= 10000"),
    ),
    check(
      "circle_tag_overlay_heads_check_2",
      sql.raw("length(revision) = 64 AND revision NOT GLOB '*[^0-9a-f]*'"),
    ),
    check(
      "circle_tag_overlay_heads_check_3",
      sql.raw("length(publication_idempotency_key) BETWEEN 16 AND 200"),
    ),
  ],
);

export const circleTagOverlayPublicationReceipts = sqliteTable(
  "circle_tag_overlay_publication_receipts",
  {
    idempotencyKey: text("idempotency_key").primaryKey(),
    payloadSHA256: text("payload_sha256").notNull(),
    eventNumber: integer("event_number").notNull(),
    baseRevision: text("base_revision").notNull(),
    revision: text("revision").notNull(),
    resultJSON: text("result_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.eventNumber, table.revision],
      foreignColumns: [
        circleTagOverlayVersions.eventNumber,
        circleTagOverlayVersions.revision,
      ],
    }),
    check(
      "circle_tag_overlay_publication_receipts_check_1",
      sql.raw(
        "length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'",
      ),
    ),
    check(
      "circle_tag_overlay_publication_receipts_check_2",
      sql.raw("event_number > 0 AND event_number <= 10000"),
    ),
    check(
      "circle_tag_overlay_publication_receipts_check_3",
      sql.raw(
        "base_revision = 'none' OR (length(base_revision) = 64 AND base_revision NOT GLOB '*[^0-9a-f]*')",
      ),
    ),
    check(
      "circle_tag_overlay_publication_receipts_check_4",
      sql.raw("length(revision) = 64 AND revision NOT GLOB '*[^0-9a-f]*'"),
    ),
    check(
      "circle_tag_overlay_publication_receipts_check_5",
      sql.raw("json_valid(result_json)"),
    ),
  ],
);

export const circles = sqliteTable(
  "circles",
  {
    comiketNo: integer("comiket_no").notNull(),
    wcID: integer("wc_id").notNull(),
    circleID: integer("circle_id"),
    circleName: text("circle_name").notNull().default(sql.raw("''")),
    penName: text("pen_name").notNull().default(sql.raw("''")),
    day: integer("day"),
    areaName: text("area_name"),
    blockName: text("block_name"),
    spaceNo: integer("space_no"),
    spaceNoSub: integer("space_no_sub"),
    location: text("location"),
    catalogPayloadSHA256: text("catalog_payload_sha256"),
    catalogRecordJSON: text("catalog_record_json")
      .notNull()
      .default(sql.raw("'{}'")),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.comiketNo, table.wcID] }),
    unique().on(table.comiketNo, table.circleID),
    check("circles_check_1", sql.raw("comiket_no > 0")),
    check("circles_check_2", sql.raw("wc_id > 0")),
    check("circles_check_3", sql.raw("circle_id > 0")),
    check("circles_check_4", sql.raw("json_valid(catalog_record_json)")),
  ],
);

export const deletedProviderIdentityTombstones = sqliteTable(
  "deleted_provider_identity_tombstones",
  {
    provider: text("provider", {
      enum: ["circlems", "google", "apple"] as const,
    }).notNull(),
    providerEnvironment: text("provider_environment").notNull(),
    providerSubjectDigest: text("provider_subject_digest").notNull(),
    deletedAt: integer("deleted_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.provider,
        table.providerEnvironment,
        table.providerSubjectDigest,
      ],
    }),
    check(
      "deleted_provider_identity_tombstones_check_1",
      sql.raw("provider IN ('circlems', 'google', 'apple')"),
    ),
    check(
      "deleted_provider_identity_tombstones_check_2",
      sql.raw("length(provider_subject_digest) = 64"),
    ),
  ],
);

export const deletedSharedPlanTombstones = sqliteTable(
  "deleted_shared_plan_tombstones",
  {
    planID: text("plan_id").primaryKey(),
    comiketNo: integer("comiket_no").notNull(),
    deletedAt: integer("deleted_at").notNull(),
    reason: text("reason", {
      enum: ["owner_account_deleted"] as const,
    }).notNull(),
  },
  () => [
    check(
      "deleted_shared_plan_tombstones_check_1",
      sql.raw("reason = 'owner_account_deleted'"),
    ),
  ],
);

export const followingImports = sqliteTable(
  "following_imports",
  {
    subject: text("subject").primaryKey(),
    twitterUsername: text("twitter_username").notNull(),
    status: text("status", {
      enum: ["fetching", "ready", "failed"] as const,
    }).notNull(),
    leaseID: text("lease_id"),
    attemptedAt: integer("attempted_at").notNull(),
    nextAllowedAt: integer("next_allowed_at").notNull(),
    successfulAt: integer("successful_at"),
    snapshotKey: text("snapshot_key"),
    followingCount: integer("following_count").notNull().default(sql.raw("0")),
    lastError: text("last_error"),
  },
  (table) => [
    index("following_imports_next_allowed_at").on(table.nextAllowedAt),
    check(
      "following_imports_check_1",
      sql.raw("status IN ('fetching', 'ready', 'failed')"),
    ),
  ],
);

export const followingSnapshotCleanup = sqliteTable(
  "following_snapshot_cleanup",
  {
    objectKey: text("object_key").primaryKey(),
    state: text("state", { enum: ["queued", "leased"] as const }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(sql.raw("0")),
    leaseID: text("lease_id"),
    leaseExpiresAt: integer("lease_expires_at"),
    availableAt: integer("available_at").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("following_snapshot_cleanup_available").on(
      table.state,
      table.availableAt,
    ),
    check(
      "following_snapshot_cleanup_check_1",
      sql.raw("state IN ('queued', 'leased')"),
    ),
    check("following_snapshot_cleanup_check_2", sql.raw("attempt_count >= 0")),
  ],
);

export const googleEntryGrants = sqliteTable(
  "google_entry_grants",
  {
    grantHash: text("grant_hash").primaryKey(),
    nonceHash: text("nonce_hash").notNull(),
    audience: text("audience").notNull(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    createdAt: integer("created_at").notNull(),
    consumedRequestID: text("consumed_request_id"),
    consumedPayloadHash: text("consumed_payload_hash"),
  },
  (table) => [
    index("google_entry_grants_expiry").on(table.expiresAt),
    check("google_entry_grants_check_1", sql.raw("length(grant_hash) = 64")),
    check("google_entry_grants_check_2", sql.raw("length(nonce_hash) = 64")),
  ],
);

export const ingestBatches = sqliteTable(
  "ingest_batches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadSHA256: text("payload_sha256").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    observedAt: integer("observed_at").notNull(),
    receivedAt: integer("received_at").notNull(),
    rawPayloadJSON: text("raw_payload_json").notNull(),
  },
  (table) => [
    unique().on(table.source, table.idempotencyKey),
    check("ingest_batches_check_1", sql.raw("length(payload_sha256) = 64")),
    check("ingest_batches_check_2", sql.raw("schema_version > 0")),
    check("ingest_batches_check_3", sql.raw("json_valid(raw_payload_json)")),
  ],
);

export const seedImports = sqliteTable(
  "seed_imports",
  {
    seedKey: text("seed_key").primaryKey(),
    payloadSHA256: text("payload_sha256").notNull(),
    importedAt: integer("imported_at").notNull(),
    circleCount: integer("circle_count").notNull(),
    postCount: integer("post_count").notNull(),
    updateCount: integer("update_count").notNull(),
  },
  () => [check("seed_imports_check_1", sql.raw("length(payload_sha256) = 64"))],
);

export const socialPosts = sqliteTable(
  "social_posts",
  {
    postID: text("post_id").primaryKey(),
    authorXUserID: text("author_x_user_id"),
    authorHandle: text("author_handle").notNull(),
    authorName: text("author_name"),
    authorProfileImageURL: text("author_profile_image_url"),
    postURL: text("post_url"),
    text: text("text").notNull(),
    occurredAt: integer("occurred_at").notNull(),
    latestObservedAt: integer("latest_observed_at").notNull(),
    rawPostJSON: text("raw_post_json").notNull(),
  },
  () => [check("social_posts_check_1", sql.raw("json_valid(raw_post_json)"))],
);

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicID: text("public_id").notNull(),
    displayName: text("display_name").notNull(),
    avatarProviderURL: text("avatar_provider_url"),
    avatarObjectKey: text("avatar_object_key"),
    avatarContentType: text("avatar_content_type", {
      enum: ["image/jpeg", "image/png", "image/webp"] as const,
    }),
    displayNameEdited: integer("display_name_edited")
      .notNull()
      .default(sql.raw("0")),
    avatarEdited: integer("avatar_edited").notNull().default(sql.raw("0")),
    avatarRemoved: integer("avatar_removed").notNull().default(sql.raw("0")),
    profileRevision: integer("profile_revision")
      .notNull()
      .default(sql.raw("1")),
    authVersion: integer("auth_version").notNull().default(sql.raw("1")),
    lastAuthFencedAt: integer("last_auth_fenced_at"),
    lastAuthFenceRequestID: text("last_auth_fence_request_id"),
    lastAuthFencePayloadHash: text("last_auth_fence_payload_hash"),
    lastMutationScope: text("last_mutation_scope"),
    lastMutationRequestID: text("last_mutation_request_id"),
    lastMutationPayloadHash: text("last_mutation_payload_hash"),
    deletionPendingAt: integer("deletion_pending_at"),
    deletionRequestID: text("deletion_request_id"),
    deletionPayloadHash: text("deletion_payload_hash"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastAuthenticatedAt: integer("last_authenticated_at").notNull(),
  },
  (table) => [
    unique().on(table.publicID),
    check("users_check_1", sql.raw("length(public_id) = 32")),
    check(
      "users_check_2",
      sql.raw("length(trim(display_name)) BETWEEN 1 AND 80"),
    ),
    check(
      "users_check_3",
      sql.raw(
        "avatar_provider_url IS NULL OR length(avatar_provider_url) <= 2048",
      ),
    ),
    check(
      "users_check_4",
      sql.raw(
        "avatar_content_type IS NULL OR avatar_content_type IN ('image/jpeg', 'image/png', 'image/webp')",
      ),
    ),
    check("users_check_5", sql.raw("display_name_edited IN (0, 1)")),
    check("users_check_6", sql.raw("avatar_edited IN (0, 1)")),
    check("users_check_7", sql.raw("avatar_removed IN (0, 1)")),
    check("users_check_8", sql.raw("profile_revision > 0")),
    check("users_check_9", sql.raw("auth_version > 0")),
  ],
);

export const accountDeletionAppleRevocations = sqliteTable(
  "account_deletion_apple_revocations",
  {
    deletionRequestID: text("deletion_request_id").notNull(),
    itemID: text("item_id").notNull(),
    clientID: text("client_id").notNull(),
    payloadKind: text("payload_kind", {
      enum: ["credential", "stage"] as const,
    }).notNull(),
    aad: text("aad").notNull(),
    nonce: text("nonce").notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deletionRequestID, table.itemID] }),
    foreignKey({
      columns: [table.deletionRequestID],
      foreignColumns: [accountDeletionJobs.requestID],
    }).onDelete("cascade"),
    check(
      "account_deletion_apple_revocations_check_1",
      sql.raw("payload_kind IN ('credential', 'stage')"),
    ),
  ],
);

export const accountDeletionAtomicAssertions = sqliteTable(
  "account_deletion_atomic_assertions",
  {
    requestID: text("request_id").primaryKey(),
    committed: integer("committed").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.requestID],
      foreignColumns: [accountDeletionJobs.requestID],
    }).onDelete("cascade"),
    check(
      "account_deletion_atomic_assertions_check_1",
      sql.raw("committed = 1"),
    ),
  ],
);

export const accountDeletionFenceAssertions = sqliteTable(
  "account_deletion_fence_assertions",
  {
    requestID: text("request_id").primaryKey(),
    committed: integer("committed").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.requestID],
      foreignColumns: [accountDeletionJobs.requestID],
    }).onDelete("cascade"),
    check(
      "account_deletion_fence_assertions_check_1",
      sql.raw("committed = 1"),
    ),
  ],
);

export const appleAuthRequestAssertions = sqliteTable(
  "apple_auth_request_assertions",
  {
    requestID: text("request_id").primaryKey(),
    committed: integer("committed").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.requestID],
      foreignColumns: [appleAuthRequests.requestID],
    }).onDelete("cascade"),
    check("apple_auth_request_assertions_check_1", sql.raw("committed = 1")),
  ],
);

export const authLogoutAtomicAssertions = sqliteTable(
  "auth_logout_atomic_assertions",
  {
    requestID: text("request_id").primaryKey(),
    committed: integer("committed").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.requestID],
      foreignColumns: [authLogoutReceipts.requestID],
    }).onDelete("cascade"),
    check("auth_logout_atomic_assertions_check_1", sql.raw("committed = 1")),
  ],
);

export const authRefreshTokens = sqliteTable(
  "auth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userID: integer("user_id").notNull(),
    familyID: text("family_id").notNull(),
    authVersion: integer("auth_version").notNull(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    replacedByHash: text("replaced_by_hash"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    index("auth_refresh_tokens_family").on(table.familyID, table.createdAt),
    index("auth_refresh_tokens_user").on(table.userID, table.expiresAt),
    check("auth_refresh_tokens_check_1", sql.raw("length(token_hash) = 64")),
    check("auth_refresh_tokens_check_2", sql.raw("auth_version > 0")),
    check(
      "auth_refresh_tokens_check_3",
      sql.raw("consumed_at IS NULL OR consumed_at >= created_at"),
    ),
  ],
);

export const catalogArtifacts = sqliteTable(
  "catalog_artifacts",
  {
    versionID: text("version_id").notNull(),
    kind: text("kind", {
      enum: ["source_main", "source_image", "derived_catalog"] as const,
    }).notNull(),
    visibility: text("visibility", {
      enum: ["private_source", "authenticated_download"] as const,
    }).notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    sourceMD5Hint: text("source_md5_hint"),
    byteCount: integer("byte_count").notNull(),
    contentType: text("content_type").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.versionID, table.kind] }),
    foreignKey({
      columns: [table.versionID],
      foreignColumns: [catalogVersions.id],
    }).onDelete("cascade"),
    unique().on(table.objectKey),
    check(
      "catalog_artifacts_check_1",
      sql.raw("kind IN ('source_main', 'source_image', 'derived_catalog')"),
    ),
    check(
      "catalog_artifacts_check_2",
      sql.raw("visibility IN ('private_source', 'authenticated_download')"),
    ),
    check("catalog_artifacts_check_3", sql.raw("length(sha256) = 64")),
    check(
      "catalog_artifacts_check_4",
      sql.raw("source_md5_hint IS NULL OR length(source_md5_hint) = 65"),
    ),
    check("catalog_artifacts_check_5", sql.raw("byte_count > 0")),
  ],
);

export const catalogDates = sqliteTable(
  "catalog_dates",
  {
    versionID: text("version_id").notNull(),
    day: integer("day").notNull(),
    dateISO: text("date_iso").notNull(),
    weekday: integer("weekday").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.versionID, table.day] }),
    foreignKey({
      columns: [table.versionID],
      foreignColumns: [catalogVersions.id],
    }).onDelete("cascade"),
    check("catalog_dates_check_1", sql.raw("day > 0")),
    check("catalog_dates_check_2", sql.raw("length(date_iso) = 10")),
    check("catalog_dates_check_3", sql.raw("weekday BETWEEN 1 AND 7")),
  ],
);

export const catalogGenres = sqliteTable(
  "catalog_genres",
  {
    versionID: text("version_id").notNull(),
    genreID: integer("genre_id").notNull(),
    code: integer("code"),
    day: integer("day"),
    name: text("name").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.versionID, table.genreID] }),
    foreignKey({
      columns: [table.versionID, table.day],
      foreignColumns: [catalogDates.versionID, catalogDates.day],
    }),
    foreignKey({
      columns: [table.versionID],
      foreignColumns: [catalogVersions.id],
    }).onDelete("cascade"),
    check("catalog_genres_check_1", sql.raw("day IS NULL OR day > 0")),
  ],
);

export const catalogMaps = sqliteTable(
  "catalog_maps",
  {
    versionID: text("version_id").notNull(),
    mapID: integer("map_id").notNull(),
    name: text("name").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    originX: integer("origin_x").notNull(),
    originY: integer("origin_y").notNull(),
    rotation: integer("rotation").notNull(),
    artworkName: text("artwork_name"),
  },
  (table) => [
    primaryKey({ columns: [table.versionID, table.mapID] }),
    foreignKey({
      columns: [table.versionID],
      foreignColumns: [catalogVersions.id],
    }).onDelete("cascade"),
    check("catalog_maps_check_1", sql.raw("width > 0")),
    check("catalog_maps_check_2", sql.raw("height > 0")),
    check("catalog_maps_check_3", sql.raw("rotation IN (0, 1)")),
  ],
);

export const catalogStableCircles = sqliteTable(
  "catalog_stable_circles",
  {
    comiketNo: integer("comiket_no").notNull(),
    wcID: integer("wc_id").notNull(),
    firstVersionID: text("first_version_id").notNull(),
    lastVersionID: text("last_version_id").notNull(),
    firstPublishedAt: integer("first_published_at").notNull(),
    lastPublishedAt: integer("last_published_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.comiketNo, table.wcID] }),
    foreignKey({
      columns: [table.lastVersionID],
      foreignColumns: [catalogVersions.id],
    }),
    foreignKey({
      columns: [table.firstVersionID],
      foreignColumns: [catalogVersions.id],
    }),
    foreignKey({
      columns: [table.comiketNo],
      foreignColumns: [catalogEvents.comiketNo],
    }),
    check("catalog_stable_circles_check_1", sql.raw("wc_id > 0")),
  ],
);

export const circleUpdateEvents = sqliteTable(
  "circle_update_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventKey: text("event_key").notNull(),
    ingestBatchID: integer("ingest_batch_id").notNull(),
    source: text("source").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    postID: text("post_id").notNull(),
    updateKind: text("update_kind").notNull(),
    stateKind: text("state_kind", {
      enum: [
        "attendance",
        "inventory",
        "presence",
        "shinagaki",
        "cover",
      ] as const,
    }).notNull(),
    stateValue: text("state_value").notNull(),
    confidence: text("confidence", {
      enum: ["high", "medium", "low", "unmatched"] as const,
    }).notNull(),
    occurredAt: integer("occurred_at").notNull(),
    notifiable: integer("notifiable").notNull().default(sql.raw("1")),
    evidenceJSON: text("evidence_json").notNull().default(sql.raw("'{}'")),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.postID],
      foreignColumns: [socialPosts.postID],
    }),
    foreignKey({
      columns: [table.ingestBatchID],
      foreignColumns: [ingestBatches.id],
    }),
    index("circle_update_events_post").on(table.postID, table.id),
    index("circle_update_events_cursor").on(table.id, table.occurredAt),
    unique().on(table.eventKey),
    check("circle_update_events_check_1", sql.raw("source_revision > 0")),
    check(
      "circle_update_events_check_2",
      sql.raw(
        "state_kind IN ('attendance', 'inventory', 'presence', 'shinagaki', 'cover')",
      ),
    ),
    check(
      "circle_update_events_check_3",
      sql.raw("confidence IN ('high', 'medium', 'low', 'unmatched')"),
    ),
    check("circle_update_events_check_4", sql.raw("notifiable IN (0, 1)")),
    check("circle_update_events_check_5", sql.raw("json_valid(evidence_json)")),
  ],
);

export const circleUpdateTargets = sqliteTable(
  "circle_update_targets",
  {
    updateEventID: integer("update_event_id").notNull(),
    comiketNo: integer("comiket_no").notNull(),
    wcID: integer("wc_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.updateEventID, table.comiketNo, table.wcID] }),
    foreignKey({
      columns: [table.comiketNo, table.wcID],
      foreignColumns: [circles.comiketNo, circles.wcID],
    }),
    foreignKey({
      columns: [table.updateEventID],
      foreignColumns: [circleUpdateEvents.id],
    }).onDelete("cascade"),
    index("circle_update_targets_circle").on(
      table.comiketNo,
      table.wcID,
      table.updateEventID,
    ),
  ],
);

export const circlemsOAuthStarts = sqliteTable(
  "circlems_oauth_starts",
  {
    id: text("id").primaryKey(),
    purpose: text("purpose", {
      enum: ["authenticate", "link"] as const,
    }).notNull(),
    requestID: text("request_id").notNull(),
    clientInstanceID: text("client_instance_id").notNull(),
    environment: text("environment", {
      enum: ["production", "sandbox"] as const,
    }).notNull(),
    codeChallenge: text("code_challenge").notNull(),
    payloadHash: text("payload_hash").notNull(),
    stateHash: text("state_hash").notNull(),
    stateNonce: text("state_nonce"),
    stateCiphertext: text("state_ciphertext"),
    linkUserID: integer("link_user_id"),
    linkAuthVersion: integer("link_auth_version"),
    expiresAt: integer("expires_at").notNull(),
    callbackLeaseID: text("callback_lease_id"),
    callbackClaimedAt: integer("callback_claimed_at"),
    completionCodeHash: text("completion_code_hash"),
    completionCodeNonce: text("completion_code_nonce"),
    completionCodeCiphertext: text("completion_code_ciphertext"),
    callbackCompletedAt: integer("callback_completed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.linkUserID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    index("circlems_oauth_starts_expiry").on(table.expiresAt),
    unique().on(table.purpose, table.requestID),
    unique().on(table.stateHash),
    check(
      "circlems_oauth_starts_check_1",
      sql.raw("purpose IN ('authenticate', 'link')"),
    ),
    check(
      "circlems_oauth_starts_check_2",
      sql.raw("environment IN ('production', 'sandbox')"),
    ),
    check(
      "circlems_oauth_starts_check_3",
      sql.raw("length(code_challenge) = 43"),
    ),
    check(
      "circlems_oauth_starts_check_4",
      sql.raw("length(payload_hash) = 64"),
    ),
    check("circlems_oauth_starts_check_5", sql.raw("length(state_hash) = 64")),
    check(
      "circlems_oauth_starts_check_6",
      sql.raw(
        "(purpose = 'authenticate' AND link_user_id IS NULL AND link_auth_version IS NULL) OR (purpose = 'link' AND link_user_id IS NOT NULL AND link_auth_version > 0)",
      ),
    ),
  ],
);

export const favoriteMutationReceipts = sqliteTable(
  "favorite_mutation_receipts",
  {
    userID: integer("user_id").notNull(),
    comiketNo: integer("comiket_no").notNull(),
    mutationID: text("mutation_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    resultRevision: integer("result_revision").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userID, table.comiketNo, table.mutationID] }),
    foreignKey({
      columns: [table.userID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    check(
      "favorite_mutation_receipts_check_1",
      sql.raw("length(payload_hash) = 64"),
    ),
    check("favorite_mutation_receipts_check_2", sql.raw("result_revision > 0")),
  ],
);

export const favoriteSets = sqliteTable(
  "favorite_sets",
  {
    userID: integer("user_id").notNull(),
    comiketNo: integer("comiket_no").notNull(),
    revision: integer("revision").notNull().default(sql.raw("0")),
    lastMutationID: text("last_mutation_id"),
    updatedAt: integer("updated_at").notNull(),
    lastMutationPayloadHash: text("last_mutation_payload_hash"),
  },
  (table) => [
    primaryKey({ columns: [table.userID, table.comiketNo] }),
    foreignKey({
      columns: [table.userID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    check("favorite_sets_check_1", sql.raw("revision >= 0")),
  ],
);

export const postMedia = sqliteTable(
  "post_media",
  {
    postID: text("post_id").notNull(),
    mediaIndex: integer("media_index").notNull(),
    mediaKey: text("media_key").notNull(),
    mediaType: text("media_type").notNull(),
    role: text("role", {
      enum: ["shinagaki", "cover", "post_image"] as const,
    }).notNull(),
    url: text("url").notNull(),
    previewURL: text("preview_url"),
    width: integer("width"),
    height: integer("height"),
    paletteJSON: text("palette_json"),
    payloadSHA256: text("payload_sha256"),
  },
  (table) => [
    primaryKey({ columns: [table.postID, table.mediaKey] }),
    foreignKey({
      columns: [table.postID],
      foreignColumns: [socialPosts.postID],
    }).onDelete("cascade"),
    check("post_media_check_1", sql.raw("media_index >= 0")),
    check(
      "post_media_check_2",
      sql.raw("role IN ('shinagaki', 'cover', 'post_image')"),
    ),
    check("post_media_check_3", sql.raw("width IS NULL OR width > 0")),
    check("post_media_check_4", sql.raw("height IS NULL OR height > 0")),
    check(
      "post_media_check_5",
      sql.raw("palette_json IS NULL OR json_valid(palette_json)"),
    ),
  ],
);

export const pushDevices = sqliteTable(
  "push_devices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userID: integer("user_id").notNull(),
    installationID: text("installation_id").notNull(),
    token: text("token").notNull(),
    tokenSHA256: text("token_sha256").notNull(),
    apnsEnvironment: text("apns_environment", {
      enum: ["sandbox", "production"] as const,
    }).notNull(),
    bundleID: text("bundle_id").notNull(),
    locale: text("locale"),
    timeZone: text("time_zone"),
    enabled: integer("enabled").notNull().default(sql.raw("1")),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastRegisteredAt: integer("last_registered_at").notNull(),
    invalidatedAt: integer("invalidated_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.userID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    index("push_devices_user_enabled").on(table.userID, table.enabled),
    unique().on(table.apnsEnvironment, table.bundleID, table.tokenSHA256),
    unique().on(table.userID, table.installationID),
    check("push_devices_check_1", sql.raw("length(token_sha256) = 64")),
    check(
      "push_devices_check_2",
      sql.raw("apns_environment IN ('sandbox', 'production')"),
    ),
    check("push_devices_check_3", sql.raw("enabled IN (0, 1)")),
  ],
);

export const sharedPlanRequests = sqliteTable(
  "shared_plan_requests",
  {
    userID: integer("user_id").notNull(),
    scope: text("scope").notNull(),
    requestID: text("request_id").notNull(),
    operation: text("operation").notNull(),
    payloadHash: text("payload_hash").notNull(),
    resourceID: text("resource_id").notNull(),
    resultRevision: integer("result_revision"),
    resultStatus: text("result_status", {
      enum: ["active", "archived"] as const,
    }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userID, table.scope, table.requestID] }),
    foreignKey({
      columns: [table.userID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    check("shared_plan_requests_check_1", sql.raw("length(payload_hash) = 64")),
    check(
      "shared_plan_requests_check_2",
      sql.raw("result_revision IS NULL OR result_revision > 0"),
    ),
    check(
      "shared_plan_requests_check_3",
      sql.raw(
        "result_status IS NULL OR result_status IN ('active', 'archived')",
      ),
    ),
  ],
);

export const sharedPlans = sqliteTable(
  "shared_plans",
  {
    id: text("id").primaryKey(),
    comiketNo: integer("comiket_no").notNull(),
    name: text("name").notNull(),
    ownerUserID: integer("owner_user_id").notNull(),
    archivedAt: integer("archived_at"),
    revision: integer("revision").notNull().default(sql.raw("1")),
    lastMutationScope: text("last_mutation_scope"),
    lastMutationRequestID: text("last_mutation_request_id"),
    lastMutationPayloadHash: text("last_mutation_payload_hash"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    notificationEpoch: integer("notification_epoch")
      .notNull()
      .default(sql.raw("1")),
  },
  (table) => [
    foreignKey({ columns: [table.ownerUserID], foreignColumns: [users.id] }),
    index("shared_plans_owner_active").on(
      table.ownerUserID,
      table.comiketNo,
      table.archivedAt,
    ),
    check("shared_plans_check_1", sql.raw("length(id) BETWEEN 20 AND 64")),
    check("shared_plans_check_2", sql.raw("comiket_no > 0")),
    check(
      "shared_plans_check_3",
      sql.raw("length(trim(name)) BETWEEN 1 AND 100"),
    ),
    check("shared_plans_check_4", sql.raw("revision > 0")),
    check("shared_plans_check_5", sql.raw("notification_epoch > 0")),
  ],
);

export const userFavorites = sqliteTable(
  "user_favorites",
  {
    userID: integer("user_id").notNull(),
    comiketNo: integer("comiket_no").notNull(),
    wcID: integer("wc_id").notNull(),
    color: integer("color").notNull().default(sql.raw("1")),
    notificationsEnabled: integer("notifications_enabled")
      .notNull()
      .default(sql.raw("1")),
    active: integer("active").notNull().default(sql.raw("1")),
    snapshotRevision: integer("snapshot_revision").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userID, table.comiketNo, table.wcID] }),
    foreignKey({
      columns: [table.userID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    index("user_favorites_notification_circle")
      .on(table.comiketNo, table.wcID, table.userID)
      .where(sql.raw("active = 1 AND notifications_enabled = 1")),
    check("user_favorites_check_1", sql.raw("color BETWEEN 0 AND 9")),
    check("user_favorites_check_2", sql.raw("notifications_enabled IN (0, 1)")),
    check("user_favorites_check_3", sql.raw("active IN (0, 1)")),
    check("user_favorites_check_4", sql.raw("snapshot_revision > 0")),
  ],
);

export const userIdentities = sqliteTable(
  "user_identities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userID: integer("user_id").notNull(),
    provider: text("provider", {
      enum: ["circlems", "google", "apple"] as const,
    }).notNull(),
    providerEnvironment: text("provider_environment", {
      enum: ["", "production", "sandbox"] as const,
    })
      .notNull()
      .default(sql.raw("''")),
    providerSubject: text("provider_subject").notNull(),
    providerUserID: integer("provider_user_id"),
    providerEmail: text("provider_email"),
    providerDisplayName: text("provider_display_name"),
    providerAvatarURL: text("provider_avatar_url"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastAuthenticatedAt: integer("last_authenticated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    index("user_identities_user").on(table.userID, table.provider),
    unique().on(
      table.provider,
      table.providerEnvironment,
      table.providerUserID,
    ),
    unique().on(
      table.provider,
      table.providerEnvironment,
      table.providerSubject,
    ),
    check(
      "user_identities_check_1",
      sql.raw("provider IN ('circlems', 'google', 'apple')"),
    ),
    check(
      "user_identities_check_2",
      sql.raw(
        "(provider = 'circlems' AND provider_environment IN ('production', 'sandbox')) OR (provider IN ('google', 'apple') AND provider_environment = '')",
      ),
    ),
    check(
      "user_identities_check_3",
      sql.raw(
        "(provider = 'circlems' AND provider_user_id > 0) OR (provider IN ('google', 'apple') AND provider_user_id IS NULL)",
      ),
    ),
  ],
);

export const appleAuthReceipts = sqliteTable(
  "apple_auth_receipts",
  {
    requestID: text("request_id").primaryKey(),
    payloadHash: text("payload_hash").notNull(),
    grantHash: text("grant_hash").notNull(),
    authorizationCodeHash: text("authorization_code_hash").notNull(),
    userID: integer("user_id").notNull(),
    userIdentityID: integer("user_identity_id").notNull(),
    resultAuthVersion: integer("result_auth_version").notNull(),
    resultTokenHash: text("result_token_hash").notNull(),
    resultNonce: text("result_nonce").notNull(),
    resultCiphertext: text("result_ciphertext").notNull(),
    replayExpiresAt: integer("replay_expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userIdentityID],
      foreignColumns: [userIdentities.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    check("apple_auth_receipts_check_1", sql.raw("length(payload_hash) = 64")),
    check(
      "apple_auth_receipts_check_2",
      sql.raw("length(authorization_code_hash) = 64"),
    ),
    check("apple_auth_receipts_check_3", sql.raw("result_auth_version > 0")),
    check(
      "apple_auth_receipts_check_4",
      sql.raw("length(result_token_hash) = 64"),
    ),
  ],
);

export const appleProviderCredentials = sqliteTable(
  "apple_provider_credentials",
  {
    userIdentityID: integer("user_identity_id").primaryKey(),
    clientID: text("client_id").notNull(),
    cipherVersion: integer("cipher_version").notNull(),
    keyVersion: integer("key_version").notNull(),
    nonce: text("nonce").notNull(),
    ciphertext: text("ciphertext").notNull(),
    credentialRevision: integer("credential_revision")
      .notNull()
      .default(sql.raw("1")),
    lastAuthRequestID: text("last_auth_request_id").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userIdentityID],
      foreignColumns: [userIdentities.id],
    }).onDelete("cascade"),
    check("apple_provider_credentials_check_1", sql.raw("cipher_version > 0")),
    check("apple_provider_credentials_check_2", sql.raw("key_version > 0")),
    check(
      "apple_provider_credentials_check_3",
      sql.raw("credential_revision > 0"),
    ),
  ],
);

export const catalogAreas = sqliteTable(
  "catalog_areas",
  {
    versionID: text("version_id").notNull(),
    areaID: integer("area_id").notNull(),
    mapID: integer("map_id").notNull(),
    name: text("name").notNull(),
    simpleName: text("simple_name").notNull(),
    x: integer("x").notNull(),
    y: integer("y").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.versionID, table.areaID] }),
    foreignKey({
      columns: [table.versionID, table.mapID],
      foreignColumns: [catalogMaps.versionID, catalogMaps.mapID],
    }),
    foreignKey({
      columns: [table.versionID],
      foreignColumns: [catalogVersions.id],
    }).onDelete("cascade"),
    check("catalog_areas_check_1", sql.raw("width >= 0")),
    check("catalog_areas_check_2", sql.raw("height >= 0")),
  ],
);

export const catalogBlocks = sqliteTable(
  "catalog_blocks",
  {
    versionID: text("version_id").notNull(),
    blockID: integer("block_id").notNull(),
    areaID: integer("area_id").notNull(),
    name: text("name").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.versionID, table.blockID] }),
    foreignKey({
      columns: [table.versionID, table.areaID],
      foreignColumns: [catalogAreas.versionID, catalogAreas.areaID],
    }),
    foreignKey({
      columns: [table.versionID],
      foreignColumns: [catalogVersions.id],
    }).onDelete("cascade"),
  ],
);

export const catalogCircles = sqliteTable(
  "catalog_circles",
  {
    versionID: text("version_id").notNull(),
    comiketNo: integer("comiket_no").notNull(),
    wcID: integer("wc_id").notNull(),
    day: integer("day").notNull(),
    blockID: integer("block_id"),
    spaceNo: integer("space_no"),
    spaceNoSub: integer("space_no_sub"),
    genreID: integer("genre_id"),
    name: text("name").notNull(),
    kana: text("kana").notNull(),
    penName: text("pen_name").notNull(),
    bookName: text("book_name").notNull(),
    websiteURL: text("website_url"),
    description: text("description").notNull(),
    twitterURL: text("twitter_url"),
    pixivURL: text("pixiv_url"),
    updateID: integer("update_id"),
  },
  (table) => [
    primaryKey({ columns: [table.versionID, table.wcID] }),
    foreignKey({
      columns: [table.versionID, table.genreID],
      foreignColumns: [catalogGenres.versionID, catalogGenres.genreID],
    }),
    foreignKey({
      columns: [table.versionID, table.blockID],
      foreignColumns: [catalogBlocks.versionID, catalogBlocks.blockID],
    }),
    foreignKey({
      columns: [table.versionID, table.day],
      foreignColumns: [catalogDates.versionID, catalogDates.day],
    }),
    foreignKey({
      columns: [table.versionID],
      foreignColumns: [catalogVersions.id],
    }).onDelete("cascade"),
    index("catalog_circles_name").on(table.versionID, table.name, table.kana),
    index("catalog_circles_location").on(
      table.versionID,
      table.day,
      table.blockID,
      table.spaceNo,
      table.spaceNoSub,
    ),
    check("catalog_circles_check_1", sql.raw("wc_id > 0")),
    check(
      "catalog_circles_check_2",
      sql.raw("space_no_sub IS NULL OR space_no_sub IN (0, 1)"),
    ),
  ],
);

export const catalogFloors = sqliteTable(
  "catalog_floors",
  {
    versionID: text("version_id").notNull(),
    floorID: integer("floor_id").notNull(),
    day: integer("day").notNull(),
    mapID: integer("map_id").notNull(),
    name: text("name").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.versionID, table.floorID] }),
    foreignKey({
      columns: [table.versionID, table.mapID],
      foreignColumns: [catalogMaps.versionID, catalogMaps.mapID],
    }),
    foreignKey({
      columns: [table.versionID, table.day],
      foreignColumns: [catalogDates.versionID, catalogDates.day],
    }),
    foreignKey({
      columns: [table.versionID],
      foreignColumns: [catalogVersions.id],
    }).onDelete("cascade"),
  ],
);

export const catalogImageAssets = sqliteTable(
  "catalog_image_assets",
  {
    versionID: text("version_id").notNull(),
    kind: text("kind", { enum: ["circle_cut", "common"] as const }).notNull(),
    assetKey: text("asset_key").notNull(),
    wcID: integer("wc_id"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    contentType: text("content_type", {
      enum: ["image/jpeg", "image/png", "image/webp"] as const,
    }).notNull(),
    byteCount: integer("byte_count").notNull(),
    sha256: text("sha256").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.versionID, table.kind, table.assetKey] }),
    foreignKey({
      columns: [table.versionID, table.wcID],
      foreignColumns: [catalogCircles.versionID, catalogCircles.wcID],
    }),
    foreignKey({
      columns: [table.versionID],
      foreignColumns: [catalogVersions.id],
    }).onDelete("cascade"),
    unique().on(table.versionID, table.kind, table.wcID),
    check(
      "catalog_image_assets_check_1",
      sql.raw("kind IN ('circle_cut', 'common')"),
    ),
    check("catalog_image_assets_check_2", sql.raw("width > 0")),
    check("catalog_image_assets_check_3", sql.raw("height > 0")),
    check(
      "catalog_image_assets_check_4",
      sql.raw("content_type IN ('image/jpeg', 'image/png', 'image/webp')"),
    ),
    check("catalog_image_assets_check_5", sql.raw("byte_count > 0")),
    check("catalog_image_assets_check_6", sql.raw("length(sha256) = 64")),
  ],
);

export const catalogLayouts = sqliteTable(
  "catalog_layouts",
  {
    versionID: text("version_id").notNull(),
    blockID: integer("block_id").notNull(),
    spaceNo: integer("space_no").notNull(),
    mapID: integer("map_id").notNull(),
    hallID: integer("hall_id"),
    x: integer("x").notNull(),
    y: integer("y").notNull(),
    orientation: integer("orientation").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.versionID, table.blockID, table.spaceNo] }),
    foreignKey({
      columns: [table.versionID, table.mapID],
      foreignColumns: [catalogMaps.versionID, catalogMaps.mapID],
    }),
    foreignKey({
      columns: [table.versionID, table.blockID],
      foreignColumns: [catalogBlocks.versionID, catalogBlocks.blockID],
    }),
    foreignKey({
      columns: [table.versionID],
      foreignColumns: [catalogVersions.id],
    }).onDelete("cascade"),
    check("catalog_layouts_check_1", sql.raw("orientation BETWEEN 1 AND 4")),
  ],
);

export const catalogMappings = sqliteTable(
  "catalog_mappings",
  {
    versionID: text("version_id").notNull(),
    day: integer("day").notNull(),
    blockID: integer("block_id").notNull(),
    mapID: integer("map_id").notNull(),
    areaID: integer("area_id").notNull(),
    floorID: integer("floor_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.versionID, table.day, table.blockID] }),
    foreignKey({
      columns: [table.versionID, table.floorID],
      foreignColumns: [catalogFloors.versionID, catalogFloors.floorID],
    }),
    foreignKey({
      columns: [table.versionID, table.areaID],
      foreignColumns: [catalogAreas.versionID, catalogAreas.areaID],
    }),
    foreignKey({
      columns: [table.versionID, table.mapID],
      foreignColumns: [catalogMaps.versionID, catalogMaps.mapID],
    }),
    foreignKey({
      columns: [table.versionID, table.blockID],
      foreignColumns: [catalogBlocks.versionID, catalogBlocks.blockID],
    }),
    foreignKey({
      columns: [table.versionID, table.day],
      foreignColumns: [catalogDates.versionID, catalogDates.day],
    }),
    foreignKey({
      columns: [table.versionID],
      foreignColumns: [catalogVersions.id],
    }).onDelete("cascade"),
  ],
);

export const catalogRefreshFailures = sqliteTable(
  "catalog_refresh_failures",
  {
    userIdentityID: integer("user_identity_id").notNull(),
    comiketNo: integer("comiket_no").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userIdentityID, table.comiketNo] }),
    foreignKey({
      columns: [table.comiketNo],
      foreignColumns: [catalogEvents.comiketNo],
    }),
    foreignKey({
      columns: [table.userIdentityID],
      foreignColumns: [userIdentities.id],
    }).onDelete("cascade"),
    check("catalog_refresh_failures_check_1", sql.raw("attempt_count > 0")),
  ],
);

export const catalogRefreshJobs = sqliteTable(
  "catalog_refresh_jobs",
  {
    id: text("id").primaryKey(),
    userIdentityID: integer("user_identity_id").notNull(),
    comiketNo: integer("comiket_no").notNull(),
    providerCirclemsEventID: integer("provider_circlems_event_id").notNull(),
    sourceMD5Hint: text("source_md5_hint").notNull(),
    sourceUpdatedAt: integer("source_updated_at"),
    state: text("state", {
      enum: ["queued", "leased", "published", "failed"] as const,
    }).notNull(),
    leaseID: text("lease_id"),
    leaseExpiresAt: integer("lease_expires_at"),
    attemptCount: integer("attempt_count").notNull().default(sql.raw("0")),
    publishedVersionID: text("published_version_id"),
    publishedLeaseID: text("published_lease_id"),
    lastError: text("last_error"),
    lastCommandKey: text("last_command_key"),
    lastCommandPayloadHash: text("last_command_payload_hash"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.publishedVersionID],
      foreignColumns: [catalogVersions.id],
    }),
    foreignKey({
      columns: [table.comiketNo],
      foreignColumns: [catalogEvents.comiketNo],
    }),
    foreignKey({
      columns: [table.userIdentityID],
      foreignColumns: [userIdentities.id],
    }).onDelete("cascade"),
    uniqueIndex("catalog_refresh_jobs_live_lease")
      .on(table.leaseID)
      .where(sql.raw("lease_id IS NOT NULL")),
    uniqueIndex("catalog_refresh_jobs_live_event")
      .on(table.comiketNo)
      .where(sql.raw("state IN ('queued', 'leased')")),
    uniqueIndex("catalog_refresh_jobs_live_source")
      .on(table.comiketNo, table.sourceMD5Hint)
      .where(sql.raw("state IN ('queued', 'leased')")),
    index("catalog_refresh_jobs_available").on(
      table.state,
      table.leaseExpiresAt,
      table.createdAt,
    ),
    check(
      "catalog_refresh_jobs_check_1",
      sql.raw("provider_circlems_event_id > 0"),
    ),
    check(
      "catalog_refresh_jobs_check_2",
      sql.raw("length(source_md5_hint) = 65"),
    ),
    check(
      "catalog_refresh_jobs_check_3",
      sql.raw("state IN ('queued', 'leased', 'published', 'failed')"),
    ),
    check("catalog_refresh_jobs_check_4", sql.raw("attempt_count >= 0")),
  ],
);

export const circleStateHeads = sqliteTable(
  "circle_state_heads",
  {
    comiketNo: integer("comiket_no").notNull(),
    wcID: integer("wc_id").notNull(),
    stateKind: text("state_kind").notNull(),
    stateValue: text("state_value").notNull(),
    occurredAt: integer("occurred_at").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    eventKey: text("event_key").notNull(),
    updateEventID: integer("update_event_id").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.comiketNo, table.wcID, table.stateKind] }),
    foreignKey({
      columns: [table.comiketNo, table.wcID],
      foreignColumns: [circles.comiketNo, circles.wcID],
    }),
    foreignKey({
      columns: [table.updateEventID],
      foreignColumns: [circleUpdateEvents.id],
    }),
  ],
);

export const circlemsOAuthAtomicAssertions = sqliteTable(
  "circlems_oauth_atomic_assertions",
  {
    startID: text("start_id").primaryKey(),
    committed: integer("committed").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.startID],
      foreignColumns: [circlemsOAuthStarts.id],
    }).onDelete("cascade"),
    check("circlems_oauth_atomic_assertions_check_1", sql.raw("committed = 1")),
  ],
);

export const circlemsOAuthCompletions = sqliteTable(
  "circlems_oauth_completions",
  {
    codeHash: text("code_hash").primaryKey(),
    startID: text("start_id").notNull(),
    providerSubject: text("provider_subject"),
    providerSubjectDigest: text("provider_subject_digest").notNull(),
    proofIssuedAt: integer("proof_issued_at").notNull(),
    providerUserID: integer("provider_user_id"),
    providerDisplayName: text("provider_display_name"),
    credentialNonce: text("credential_nonce"),
    credentialCiphertext: text("credential_ciphertext"),
    expiresAt: integer("expires_at").notNull(),
    completionRequestID: text("completion_request_id"),
    completionPayloadHash: text("completion_payload_hash"),
    processingLeaseID: text("processing_lease_id"),
    processingStartedAt: integer("processing_started_at"),
    userID: integer("user_id"),
    userIdentityID: integer("user_identity_id"),
    resultAuthVersion: integer("result_auth_version"),
    resultTokenHash: text("result_token_hash"),
    resultNonce: text("result_nonce"),
    resultCiphertext: text("result_ciphertext"),
    credentialRevision: integer("credential_revision"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userIdentityID],
      foreignColumns: [userIdentities.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.startID],
      foreignColumns: [circlemsOAuthStarts.id],
    }).onDelete("cascade"),
    index("circlems_oauth_completions_expiry").on(table.expiresAt),
    unique().on(table.startID),
    check(
      "circlems_oauth_completions_check_1",
      sql.raw("length(code_hash) = 64"),
    ),
    check(
      "circlems_oauth_completions_check_2",
      sql.raw("length(provider_subject_digest) = 64"),
    ),
    check(
      "circlems_oauth_completions_check_3",
      sql.raw("provider_user_id > 0"),
    ),
  ],
);

export const favoriteMutationAtomicAssertions = sqliteTable(
  "favorite_mutation_atomic_assertions",
  {
    userID: integer("user_id").notNull(),
    comiketNo: integer("comiket_no").notNull(),
    mutationID: text("mutation_id").notNull(),
    committed: integer("committed").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userID, table.comiketNo, table.mutationID] }),
    foreignKey({
      columns: [table.userID, table.comiketNo, table.mutationID],
      foreignColumns: [
        favoriteMutationReceipts.userID,
        favoriteMutationReceipts.comiketNo,
        favoriteMutationReceipts.mutationID,
      ],
    }).onDelete("cascade"),
    check(
      "favorite_mutation_atomic_assertions_check_1",
      sql.raw("committed = 1"),
    ),
  ],
);

export const googleAuthReceipts = sqliteTable(
  "google_auth_receipts",
  {
    requestID: text("request_id").primaryKey(),
    payloadHash: text("payload_hash").notNull(),
    grantHash: text("grant_hash").notNull(),
    userID: integer("user_id").notNull(),
    userIdentityID: integer("user_identity_id").notNull(),
    resultAuthVersion: integer("result_auth_version").notNull(),
    resultTokenHash: text("result_token_hash").notNull(),
    resultNonce: text("result_nonce").notNull(),
    resultCiphertext: text("result_ciphertext").notNull(),
    replayExpiresAt: integer("replay_expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userIdentityID],
      foreignColumns: [userIdentities.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    check("google_auth_receipts_check_1", sql.raw("length(payload_hash) = 64")),
    check("google_auth_receipts_check_2", sql.raw("result_auth_version > 0")),
    check(
      "google_auth_receipts_check_3",
      sql.raw("length(result_token_hash) = 64"),
    ),
  ],
);

export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    updateEventID: integer("update_event_id").notNull(),
    userID: integer("user_id").notNull(),
    deviceID: integer("device_id").notNull(),
    status: text("status", {
      enum: [
        "pending",
        "processing",
        "retry",
        "delivered",
        "dead",
        "suppressed",
      ] as const,
    })
      .notNull()
      .default(sql.raw("'pending'")),
    attemptCount: integer("attempt_count").notNull().default(sql.raw("0")),
    availableAt: integer("available_at").notNull(),
    leaseExpiresAt: integer("lease_expires_at"),
    apnsID: text("apns_id"),
    deliveredAt: integer("delivered_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.deviceID],
      foreignColumns: [pushDevices.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.updateEventID],
      foreignColumns: [circleUpdateEvents.id],
    }).onDelete("cascade"),
    index("notification_deliveries_ready").on(
      table.status,
      table.availableAt,
      table.id,
    ),
    unique().on(table.updateEventID, table.deviceID),
    check(
      "notification_deliveries_check_1",
      sql.raw(
        "status IN ('pending', 'processing', 'retry', 'delivered', 'dead', 'suppressed')",
      ),
    ),
    check("notification_deliveries_check_2", sql.raw("attempt_count >= 0")),
  ],
);

export const ownedPlanSlots = sqliteTable(
  "owned_plan_slots",
  {
    ownerUserID: integer("owner_user_id").notNull(),
    comiketNo: integer("comiket_no").notNull(),
    slot: integer("slot").notNull(),
    planID: text("plan_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerUserID, table.comiketNo, table.slot] }),
    foreignKey({
      columns: [table.planID],
      foreignColumns: [sharedPlans.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerUserID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    unique().on(table.planID),
    check("owned_plan_slots_check_1", sql.raw("comiket_no > 0")),
    check("owned_plan_slots_check_2", sql.raw("slot BETWEEN 0 AND 49")),
  ],
);

export const providerAvatarImportJobs = sqliteTable(
  "provider_avatar_import_jobs",
  {
    userIdentityID: integer("user_identity_id").primaryKey(),
    providerAvatarURL: text("provider_avatar_url").notNull(),
    jobRevision: integer("job_revision").notNull().default(sql.raw("1")),
    state: text("state", { enum: ["queued", "leased"] as const }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(sql.raw("0")),
    leaseID: text("lease_id"),
    leaseExpiresAt: integer("lease_expires_at"),
    availableAt: integer("available_at").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userIdentityID],
      foreignColumns: [userIdentities.id],
    }).onDelete("cascade"),
    index("provider_avatar_import_jobs_available").on(
      table.state,
      table.availableAt,
    ),
    check("provider_avatar_import_jobs_check_1", sql.raw("job_revision > 0")),
    check(
      "provider_avatar_import_jobs_check_2",
      sql.raw("state IN ('queued', 'leased')"),
    ),
    check("provider_avatar_import_jobs_check_3", sql.raw("attempt_count >= 0")),
  ],
);

export const providerCredentialHandoffReceipts = sqliteTable(
  "provider_credential_handoff_receipts",
  {
    actionScope: text("action_scope", {
      enum: ["circlems_auth", "circlems_link"] as const,
    }).notNull(),
    requestID: text("request_id").notNull(),
    userIdentityID: integer("user_identity_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    credentialRevision: integer("credential_revision").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.actionScope, table.requestID] }),
    foreignKey({
      columns: [table.userIdentityID],
      foreignColumns: [userIdentities.id],
    }).onDelete("cascade"),
    check(
      "provider_credential_handoff_receipts_check_1",
      sql.raw("action_scope IN ('circlems_auth', 'circlems_link')"),
    ),
    check(
      "provider_credential_handoff_receipts_check_2",
      sql.raw("length(payload_hash) = 64"),
    ),
    check(
      "provider_credential_handoff_receipts_check_3",
      sql.raw("credential_revision > 0"),
    ),
  ],
);

export const providerCredentials = sqliteTable(
  "provider_credentials",
  {
    userIdentityID: integer("user_identity_id").primaryKey(),
    cipherVersion: integer("cipher_version").notNull(),
    keyVersion: integer("key_version").notNull(),
    nonce: text("nonce").notNull(),
    ciphertext: text("ciphertext").notNull(),
    accessExpiresAt: integer("access_expires_at"),
    scopesJSON: text("scopes_json").notNull().default(sql.raw("'[]'")),
    credentialRevision: integer("credential_revision")
      .notNull()
      .default(sql.raw("1")),
    handoffCompletedAt: integer("handoff_completed_at"),
    lastHandoffRequestID: text("last_handoff_request_id"),
    lastHandoffPayloadHash: text("last_handoff_payload_hash"),
    lastOAuthFlowID: text("last_oauth_flow_id"),
    refreshLeaseID: text("refresh_lease_id"),
    refreshLeaseExpiresAt: integer("refresh_lease_expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userIdentityID],
      foreignColumns: [userIdentities.id],
    }).onDelete("cascade"),
    check("provider_credentials_check_1", sql.raw("cipher_version > 0")),
    check("provider_credentials_check_2", sql.raw("key_version > 0")),
    check("provider_credentials_check_3", sql.raw("json_valid(scopes_json)")),
    check("provider_credentials_check_4", sql.raw("credential_revision > 0")),
  ],
);

export const sharedPlanEvents = sqliteTable(
  "shared_plan_events",
  {
    id: text("id").primaryKey(),
    planID: text("plan_id").notNull(),
    actorUserID: integer("actor_user_id"),
    eventType: text("event_type").notNull(),
    i18nKey: text("i18n_key").notNull(),
    payloadVersion: integer("payload_version").notNull(),
    payloadJSON: text("payload_json").notNull(),
    createdAt: integer("created_at").notNull(),
    sourceKind: text("source_kind", {
      enum: ["legacy", "operation", "conflict"] as const,
    })
      .notNull()
      .default(sql.raw("'legacy'")),
    sourceID: text("source_id"),
    membershipEpoch: integer("membership_epoch"),
    planNotificationEpoch: integer("plan_notification_epoch")
      .notNull()
      .default(sql.raw("1")),
  },
  (table) => [
    foreignKey({
      columns: [table.actorUserID],
      foreignColumns: [users.id],
    }).onDelete("set null"),
    foreignKey({
      columns: [table.planID],
      foreignColumns: [sharedPlans.id],
    }).onDelete("cascade"),
    uniqueIndex("shared_plan_events_crdt_source")
      .on(table.planID, table.sourceKind, table.sourceID, table.eventType)
      .where(sql.raw("source_id IS NOT NULL")),
    check("shared_plan_events_check_1", sql.raw("payload_version > 0")),
    check("shared_plan_events_check_2", sql.raw("json_valid(payload_json)")),
    check(
      "shared_plan_events_check_3",
      sql.raw("source_kind IN ('legacy', 'operation', 'conflict')"),
    ),
    check(
      "shared_plan_events_check_4",
      sql.raw("membership_epoch IS NULL OR membership_epoch > 0"),
    ),
    check("shared_plan_events_check_5", sql.raw("plan_notification_epoch > 0")),
  ],
);

export const sharedPlanInvitations = sqliteTable(
  "shared_plan_invitations",
  {
    id: text("id").primaryKey(),
    planID: text("plan_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdByUserID: integer("created_by_user_id").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.createdByUserID],
      foreignColumns: [users.id],
    }),
    foreignKey({
      columns: [table.planID],
      foreignColumns: [sharedPlans.id],
    }).onDelete("cascade"),
    index("shared_plan_invitations_active").on(
      table.tokenHash,
      table.expiresAt,
      table.revokedAt,
    ),
    index("shared_plan_invitations_plan").on(table.planID, table.createdAt),
    unique().on(table.tokenHash),
    check(
      "shared_plan_invitations_check_1",
      sql.raw("length(id) BETWEEN 20 AND 64"),
    ),
    check(
      "shared_plan_invitations_check_2",
      sql.raw("length(token_hash) = 64"),
    ),
  ],
);

export const sharedPlanMembers = sqliteTable(
  "shared_plan_members",
  {
    planID: text("plan_id").notNull(),
    userID: integer("user_id").notNull(),
    role: text("role", { enum: ["owner", "editor"] as const }).notNull(),
    joinedAt: integer("joined_at").notNull(),
    revokedAt: integer("revoked_at"),
    updatedAt: integer("updated_at").notNull(),
    notificationEpoch: integer("notification_epoch")
      .notNull()
      .default(sql.raw("1")),
  },
  (table) => [
    primaryKey({ columns: [table.planID, table.userID] }),
    foreignKey({
      columns: [table.userID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.planID],
      foreignColumns: [sharedPlans.id],
    }).onDelete("cascade"),
    index("shared_plan_members_user_active").on(
      table.userID,
      table.revokedAt,
      table.planID,
    ),
    check(
      "shared_plan_members_check_1",
      sql.raw("role IN ('owner', 'editor')"),
    ),
    check("shared_plan_members_check_2", sql.raw("notification_epoch > 0")),
  ],
);

export const sharedPlanNotificationDeliveries = sqliteTable(
  "shared_plan_notification_deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventID: text("event_id").notNull(),
    userID: integer("user_id").notNull(),
    deviceID: integer("device_id").notNull(),
    urgency: text("urgency", {
      enum: ["routine", "conflict"] as const,
    }).notNull(),
    collapseKey: text("collapse_key"),
    planNotificationEpoch: integer("plan_notification_epoch")
      .notNull()
      .default(sql.raw("1")),
    membershipNotificationEpoch: integer("membership_notification_epoch")
      .notNull()
      .default(sql.raw("1")),
    status: text("status", {
      enum: [
        "pending",
        "processing",
        "retry",
        "delivered",
        "dead",
        "suppressed",
      ] as const,
    })
      .notNull()
      .default(sql.raw("'pending'")),
    attemptCount: integer("attempt_count").notNull().default(sql.raw("0")),
    availableAt: integer("available_at").notNull(),
    leaseExpiresAt: integer("lease_expires_at"),
    apnsID: text("apns_id"),
    deliveredAt: integer("delivered_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.deviceID],
      foreignColumns: [pushDevices.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.eventID],
      foreignColumns: [sharedPlanEvents.id],
    }).onDelete("cascade"),
    index("shared_plan_notification_deliveries_ready").on(
      table.status,
      table.availableAt,
      table.id,
    ),
    unique().on(table.eventID, table.deviceID),
    check(
      "shared_plan_notification_deliveries_check_1",
      sql.raw("urgency IN ('routine', 'conflict')"),
    ),
    check(
      "shared_plan_notification_deliveries_check_2",
      sql.raw("plan_notification_epoch > 0"),
    ),
    check(
      "shared_plan_notification_deliveries_check_3",
      sql.raw("membership_notification_epoch > 0"),
    ),
    check(
      "shared_plan_notification_deliveries_check_4",
      sql.raw(
        "status IN ('pending', 'processing', 'retry', 'delivered', 'dead', 'suppressed')",
      ),
    ),
    check(
      "shared_plan_notification_deliveries_check_5",
      sql.raw("attempt_count >= 0"),
    ),
  ],
);

export const appleAuthAtomicAssertions = sqliteTable(
  "apple_auth_atomic_assertions",
  {
    requestID: text("request_id").primaryKey(),
    committed: integer("committed").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.requestID],
      foreignColumns: [appleAuthReceipts.requestID],
    }).onDelete("cascade"),
    check("apple_auth_atomic_assertions_check_1", sql.raw("committed = 1")),
  ],
);

export const catalogImportClaims = sqliteTable(
  "catalog_import_claims",
  {
    comiketNo: integer("comiket_no").primaryKey(),
    claimID: text("claim_id").notNull(),
    sourceMD5Hint: text("source_md5_hint"),
    refreshJobID: text("refresh_job_id"),
    refreshLeaseID: text("refresh_lease_id"),
    leaseExpiresAt: integer("lease_expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.refreshJobID],
      foreignColumns: [catalogRefreshJobs.id],
    }),
    foreignKey({
      columns: [table.comiketNo],
      foreignColumns: [catalogEvents.comiketNo],
    }),
    unique().on(table.claimID),
    check(
      "catalog_import_claims_check_1",
      sql.raw("source_md5_hint IS NULL OR length(source_md5_hint) = 65"),
    ),
  ],
);

export const catalogRefreshCommandReceipts = sqliteTable(
  "catalog_refresh_command_receipts",
  {
    idempotencyKey: text("idempotency_key").primaryKey(),
    action: text("action", {
      enum: ["lease", "renew", "complete", "release"] as const,
    }).notNull(),
    payloadHash: text("payload_hash").notNull(),
    jobID: text("job_id"),
    resultJSON: text("result_json"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.jobID],
      foreignColumns: [catalogRefreshJobs.id],
    }).onDelete("cascade"),
    check(
      "catalog_refresh_command_receipts_check_1",
      sql.raw("action IN ('lease', 'renew', 'complete', 'release')"),
    ),
    check(
      "catalog_refresh_command_receipts_check_2",
      sql.raw("length(payload_hash) = 64"),
    ),
    check(
      "catalog_refresh_command_receipts_check_3",
      sql.raw("result_json IS NULL OR json_valid(result_json)"),
    ),
  ],
);

export const googleAuthAtomicAssertions = sqliteTable(
  "google_auth_atomic_assertions",
  {
    requestID: text("request_id").primaryKey(),
    committed: integer("committed").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.requestID],
      foreignColumns: [googleAuthReceipts.requestID],
    }).onDelete("cascade"),
    check("google_auth_atomic_assertions_check_1", sql.raw("committed = 1")),
  ],
);

export const sharedPlanEventRecipients = sqliteTable(
  "shared_plan_event_recipients",
  {
    eventID: text("event_id").notNull(),
    userID: integer("user_id").notNull(),
    readAt: integer("read_at"),
    membershipNotificationEpoch: integer("membership_notification_epoch")
      .notNull()
      .default(sql.raw("1")),
    eventCreatedAt: integer("event_created_at").notNull().default(sql.raw("0")),
  },
  (table) => [
    primaryKey({ columns: [table.eventID, table.userID] }),
    foreignKey({
      columns: [table.userID],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.eventID],
      foreignColumns: [sharedPlanEvents.id],
    }).onDelete("cascade"),
    index("shared_plan_event_inbox_v2").on(
      table.userID,
      desc(table.eventCreatedAt),
      desc(table.eventID),
    ),
    index("shared_plan_event_inbox").on(
      table.userID,
      table.readAt,
      table.eventID,
    ),
    check(
      "shared_plan_event_recipients_check_1",
      sql.raw("membership_notification_epoch > 0"),
    ),
    check(
      "shared_plan_event_recipients_check_2",
      sql.raw("event_created_at >= 0"),
    ),
  ],
);

export const migratedTables = {
  account_deletion_apple_revocations: accountDeletionAppleRevocations,
  account_deletion_atomic_assertions: accountDeletionAtomicAssertions,
  account_deletion_fence_assertions: accountDeletionFenceAssertions,
  account_deletion_jobs: accountDeletionJobs,
  apple_auth_atomic_assertions: appleAuthAtomicAssertions,
  apple_auth_receipts: appleAuthReceipts,
  apple_auth_request_assertions: appleAuthRequestAssertions,
  apple_auth_requests: appleAuthRequests,
  apple_provider_credentials: appleProviderCredentials,
  apple_provider_revocations: appleProviderRevocations,
  auth_logout_atomic_assertions: authLogoutAtomicAssertions,
  auth_logout_receipts: authLogoutReceipts,
  auth_refresh_tokens: authRefreshTokens,
  avatar_object_cleanup: avatarObjectCleanup,
  catalog_areas: catalogAreas,
  catalog_artifacts: catalogArtifacts,
  catalog_blocks: catalogBlocks,
  catalog_circles: catalogCircles,
  catalog_dates: catalogDates,
  catalog_events: catalogEvents,
  catalog_floors: catalogFloors,
  catalog_genres: catalogGenres,
  catalog_image_assets: catalogImageAssets,
  catalog_import_claims: catalogImportClaims,
  catalog_internal_command_receipts: catalogInternalCommandReceipts,
  catalog_layouts: catalogLayouts,
  catalog_mappings: catalogMappings,
  catalog_maps: catalogMaps,
  catalog_multipart_upload_receipts: catalogMultipartUploadReceipts,
  catalog_refresh_command_receipts: catalogRefreshCommandReceipts,
  catalog_refresh_failures: catalogRefreshFailures,
  catalog_refresh_jobs: catalogRefreshJobs,
  catalog_stable_circles: catalogStableCircles,
  catalog_versions: catalogVersions,
  circle_tag_overlay_heads: circleTagOverlayHeads,
  circle_tag_overlay_object_cleanup: circleTagOverlayObjectCleanup,
  circle_tag_overlay_publication_receipts: circleTagOverlayPublicationReceipts,
  circle_tag_overlay_versions: circleTagOverlayVersions,
  circle_state_heads: circleStateHeads,
  circle_update_events: circleUpdateEvents,
  circle_update_targets: circleUpdateTargets,
  circlems_oauth_atomic_assertions: circlemsOAuthAtomicAssertions,
  circlems_oauth_completions: circlemsOAuthCompletions,
  circlems_oauth_starts: circlemsOAuthStarts,
  circles: circles,
  deleted_provider_identity_tombstones: deletedProviderIdentityTombstones,
  deleted_shared_plan_tombstones: deletedSharedPlanTombstones,
  favorite_mutation_atomic_assertions: favoriteMutationAtomicAssertions,
  favorite_mutation_receipts: favoriteMutationReceipts,
  favorite_sets: favoriteSets,
  following_imports: followingImports,
  following_snapshot_cleanup: followingSnapshotCleanup,
  google_auth_atomic_assertions: googleAuthAtomicAssertions,
  google_auth_receipts: googleAuthReceipts,
  google_entry_grants: googleEntryGrants,
  ingest_batches: ingestBatches,
  notification_deliveries: notificationDeliveries,
  owned_plan_slots: ownedPlanSlots,
  post_media: postMedia,
  provider_avatar_import_jobs: providerAvatarImportJobs,
  provider_credential_handoff_receipts: providerCredentialHandoffReceipts,
  provider_credentials: providerCredentials,
  push_devices: pushDevices,
  seed_imports: seedImports,
  shared_plan_event_recipients: sharedPlanEventRecipients,
  shared_plan_events: sharedPlanEvents,
  shared_plan_invitations: sharedPlanInvitations,
  shared_plan_members: sharedPlanMembers,
  shared_plan_notification_deliveries: sharedPlanNotificationDeliveries,
  shared_plan_requests: sharedPlanRequests,
  shared_plans: sharedPlans,
  social_posts: socialPosts,
  user_favorites: userFavorites,
  user_identities: userIdentities,
  users: users,
} as const;
