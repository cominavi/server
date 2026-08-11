PRAGMA foreign_keys = ON;

CREATE TABLE catalog_internal_command_receipts (
  idempotency_key TEXT PRIMARY KEY,
  action_scope TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE catalog_multipart_upload_receipts (
  idempotency_key TEXT PRIMARY KEY
    REFERENCES catalog_internal_command_receipts(idempotency_key) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('creating', 'active', 'completed')),
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_count INTEGER NOT NULL CHECK (byte_count > 0),
  content_type TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (
    visibility IN ('private_source', 'authenticated_download')
  ),
  claim_id TEXT,
  lease_id TEXT,
  source_md5_hint TEXT,
  upload_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- Provider credentials never participate in the public catalog contract.
-- Ciphertext is owner-bound through the identity FK and can only be decrypted
-- by server code holding the configured versioned encryption key.
CREATE TABLE provider_credentials (
  user_identity_id INTEGER PRIMARY KEY
    REFERENCES user_identities(id) ON DELETE CASCADE,
  cipher_version INTEGER NOT NULL CHECK (cipher_version > 0),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  access_expires_at INTEGER,
  scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes_json)),
  credential_revision INTEGER NOT NULL DEFAULT 1 CHECK (credential_revision > 0),
  handoff_completed_at INTEGER,
  last_handoff_request_id TEXT,
  last_handoff_payload_hash TEXT,
  last_oauth_flow_id TEXT,
  refresh_lease_id TEXT,
  refresh_lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE provider_credential_handoff_receipts (
  action_scope TEXT NOT NULL CHECK (
    action_scope IN ('circlems_auth', 'circlems_link')
  ),
  request_id TEXT NOT NULL,
  user_identity_id INTEGER NOT NULL
    REFERENCES user_identities(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  credential_revision INTEGER NOT NULL CHECK (credential_revision > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (action_scope, request_id)
) STRICT, WITHOUT ROWID;

-- Circle.ms production OAuth is backend-owned. Provider state never reaches
-- the app, and provider tokens are staged only as encrypted ciphertext until
-- the short-lived PKCE completion is consumed.
CREATE TABLE circlems_oauth_starts (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('authenticate', 'link')),
  request_id TEXT NOT NULL,
  client_instance_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  code_challenge TEXT NOT NULL CHECK (length(code_challenge) = 43),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  state_hash TEXT NOT NULL UNIQUE CHECK (length(state_hash) = 64),
  state_nonce TEXT,
  state_ciphertext TEXT,
  link_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  link_auth_version INTEGER,
  expires_at INTEGER NOT NULL,
  callback_lease_id TEXT,
  callback_claimed_at INTEGER,
  completion_code_hash TEXT,
  completion_code_nonce TEXT,
  completion_code_ciphertext TEXT,
  callback_completed_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (purpose, request_id),
  CHECK (
    (purpose = 'authenticate' AND link_user_id IS NULL AND link_auth_version IS NULL) OR
    (purpose = 'link' AND link_user_id IS NOT NULL AND link_auth_version > 0)
  )
) STRICT, WITHOUT ROWID;

CREATE INDEX circlems_oauth_starts_expiry
  ON circlems_oauth_starts (expires_at);

CREATE TABLE circlems_oauth_completions (
  code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  start_id TEXT NOT NULL UNIQUE
    REFERENCES circlems_oauth_starts(id) ON DELETE CASCADE,
  provider_subject TEXT,
  provider_subject_digest TEXT NOT NULL CHECK (length(provider_subject_digest) = 64),
  proof_issued_at INTEGER NOT NULL,
  provider_user_id INTEGER CHECK (provider_user_id > 0),
  provider_display_name TEXT,
  credential_nonce TEXT,
  credential_ciphertext TEXT,
  expires_at INTEGER NOT NULL,
  completion_request_id TEXT,
  completion_payload_hash TEXT,
  processing_lease_id TEXT,
  processing_started_at INTEGER,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  user_identity_id INTEGER REFERENCES user_identities(id) ON DELETE CASCADE,
  result_auth_version INTEGER,
  result_token_hash TEXT,
  result_nonce TEXT,
  result_ciphertext TEXT,
  credential_revision INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX circlems_oauth_completions_expiry
  ON circlems_oauth_completions (expires_at);

-- The final statement of the completion D1 batch inserts this row. Its CHECK
-- deliberately aborts and rolls back the whole batch when the claimant/fence
-- CAS did not persist the encrypted result.
CREATE TABLE circlems_oauth_atomic_assertions (
  start_id TEXT PRIMARY KEY
    REFERENCES circlems_oauth_starts(id) ON DELETE CASCADE,
  committed INTEGER NOT NULL CHECK (committed = 1),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

ALTER TABLE google_entry_grants ADD COLUMN consumed_request_id TEXT;
ALTER TABLE google_entry_grants ADD COLUMN consumed_payload_hash TEXT;

CREATE TABLE google_auth_receipts (
  request_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  grant_hash TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_identity_id INTEGER NOT NULL REFERENCES user_identities(id) ON DELETE CASCADE,
  result_auth_version INTEGER NOT NULL CHECK (result_auth_version > 0),
  result_token_hash TEXT NOT NULL CHECK (length(result_token_hash) = 64),
  result_nonce TEXT NOT NULL,
  result_ciphertext TEXT NOT NULL,
  replay_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE google_auth_atomic_assertions (
  request_id TEXT PRIMARY KEY
    REFERENCES google_auth_receipts(request_id) ON DELETE CASCADE,
  committed INTEGER NOT NULL CHECK (committed = 1),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE auth_logout_receipts (
  request_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  subject_digest TEXT NOT NULL CHECK (length(subject_digest) = 64),
  original_auth_version INTEGER NOT NULL CHECK (original_auth_version > 0),
  result_auth_version INTEGER NOT NULL CHECK (result_auth_version > 1),
  refresh_token_hash TEXT NOT NULL CHECK (length(refresh_token_hash) = 64),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE auth_logout_atomic_assertions (
  request_id TEXT PRIMARY KEY
    REFERENCES auth_logout_receipts(request_id) ON DELETE CASCADE,
  committed INTEGER NOT NULL CHECK (committed = 1),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE apple_provider_credentials (
  user_identity_id INTEGER PRIMARY KEY
    REFERENCES user_identities(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  cipher_version INTEGER NOT NULL CHECK (cipher_version > 0),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  credential_revision INTEGER NOT NULL DEFAULT 1 CHECK (credential_revision > 0),
  last_auth_request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- The Apple authorization code is single-use.  Claiming the request and entry
-- grant happens before the external exchange, and a successful exchange is
-- encrypted here before any account/session mutation.  A process crash while
-- `exchanging` is deliberately indeterminate: an exact retry never sends the
-- same code to Apple a second time.
CREATE TABLE apple_auth_requests (
  request_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  grant_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL CHECK (length(nonce_hash) = 64),
  authorization_code_hash TEXT NOT NULL UNIQUE
    CHECK (length(authorization_code_hash) = 64),
  state TEXT NOT NULL CHECK (
    state IN ('exchanging', 'staged', 'indeterminate', 'completed')
  ),
  apple_subject TEXT NOT NULL,
  apple_subject_digest TEXT NOT NULL CHECK (length(apple_subject_digest) = 64),
  proof_issued_at INTEGER,
  client_id TEXT NOT NULL,
  observed_user_id INTEGER,
  observed_auth_version INTEGER,
  provider_email TEXT,
  display_name TEXT,
  stage_nonce TEXT,
  stage_ciphertext TEXT,
  cleanup_lease_id TEXT,
  cleanup_lease_expires_at INTEGER,
  cleanup_attempt_count INTEGER NOT NULL DEFAULT 0,
  cleanup_available_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT, WITHOUT ROWID;

CREATE TABLE apple_auth_request_assertions (
  request_id TEXT PRIMARY KEY
    REFERENCES apple_auth_requests(request_id) ON DELETE CASCADE,
  committed INTEGER NOT NULL CHECK (committed = 1),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE apple_auth_receipts (
  request_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  grant_hash TEXT NOT NULL,
  authorization_code_hash TEXT NOT NULL CHECK (length(authorization_code_hash) = 64),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_identity_id INTEGER NOT NULL REFERENCES user_identities(id) ON DELETE CASCADE,
  result_auth_version INTEGER NOT NULL CHECK (result_auth_version > 0),
  result_token_hash TEXT NOT NULL CHECK (length(result_token_hash) = 64),
  result_nonce TEXT NOT NULL,
  result_ciphertext TEXT NOT NULL,
  replay_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE apple_auth_atomic_assertions (
  request_id TEXT PRIMARY KEY
    REFERENCES apple_auth_receipts(request_id) ON DELETE CASCADE,
  committed INTEGER NOT NULL CHECK (committed = 1),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE apple_provider_revocations (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  aad TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_expires_at INTEGER,
  available_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX apple_provider_revocations_available
  ON apple_provider_revocations (state, available_at);

CREATE TABLE provider_avatar_import_jobs (
  user_identity_id INTEGER PRIMARY KEY
    REFERENCES user_identities(id) ON DELETE CASCADE,
  provider_avatar_url TEXT NOT NULL,
  job_revision INTEGER NOT NULL DEFAULT 1 CHECK (job_revision > 0),
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_id TEXT,
  lease_expires_at INTEGER,
  available_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX provider_avatar_import_jobs_available
  ON provider_avatar_import_jobs (state, available_at);

ALTER TABLE favorite_sets ADD COLUMN last_mutation_payload_hash TEXT;

CREATE TABLE favorite_mutation_receipts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comiket_no INTEGER NOT NULL,
  mutation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  result_revision INTEGER NOT NULL CHECK (result_revision > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, comiket_no, mutation_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE favorite_mutation_atomic_assertions (
  user_id INTEGER NOT NULL,
  comiket_no INTEGER NOT NULL,
  mutation_id TEXT NOT NULL,
  committed INTEGER NOT NULL CHECK (committed = 1),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, comiket_no, mutation_id),
  FOREIGN KEY (user_id, comiket_no, mutation_id)
    REFERENCES favorite_mutation_receipts(user_id, comiket_no, mutation_id)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE deleted_shared_plan_tombstones (
  plan_id TEXT PRIMARY KEY,
  comiket_no INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'owner_account_deleted')
) STRICT, WITHOUT ROWID;

CREATE TABLE deleted_provider_identity_tombstones (
  provider TEXT NOT NULL CHECK (provider IN ('circlems', 'google', 'apple')),
  provider_environment TEXT NOT NULL,
  provider_subject_digest TEXT NOT NULL
    CHECK (length(provider_subject_digest) = 64),
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_environment, provider_subject_digest)
) STRICT, WITHOUT ROWID;

CREATE TABLE account_deletion_jobs (
  request_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  original_subject_hash TEXT NOT NULL CHECK (length(original_subject_hash) = 64),
  original_auth_version INTEGER NOT NULL CHECK (original_auth_version > 0),
  user_id INTEGER UNIQUE,
  plan_ids_json TEXT NOT NULL CHECK (json_valid(plan_ids_json)),
  following_snapshot_key TEXT,
  avatar_object_key TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('fenced', 'external_cleanup', 'leased', 'completed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_id TEXT,
  lease_expires_at INTEGER,
  available_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT, WITHOUT ROWID;

CREATE TABLE account_deletion_apple_revocations (
  deletion_request_id TEXT NOT NULL
    REFERENCES account_deletion_jobs(request_id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  payload_kind TEXT NOT NULL CHECK (payload_kind IN ('credential', 'stage')),
  aad TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (deletion_request_id, item_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX account_deletion_jobs_ready
  ON account_deletion_jobs (state, available_at);

CREATE TABLE following_snapshot_cleanup (
  object_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_id TEXT,
  lease_expires_at INTEGER,
  available_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX following_snapshot_cleanup_available
  ON following_snapshot_cleanup (state, available_at);

CREATE TABLE account_deletion_fence_assertions (
  request_id TEXT PRIMARY KEY
    REFERENCES account_deletion_jobs(request_id) ON DELETE CASCADE,
  committed INTEGER NOT NULL CHECK (committed = 1),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE account_deletion_atomic_assertions (
  request_id TEXT PRIMARY KEY
    REFERENCES account_deletion_jobs(request_id) ON DELETE CASCADE,
  committed INTEGER NOT NULL CHECK (committed = 1),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE catalog_events (
  comiket_no INTEGER PRIMARY KEY CHECK (comiket_no > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  provider_circlems_event_id INTEGER CHECK (provider_circlems_event_id > 0),
  active_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- A claim is the single-flight authority. Expired claims may be replaced by a
-- new worker; a source MD5 is only a cheap change hint and never validation.
CREATE TABLE catalog_import_claims (
  comiket_no INTEGER PRIMARY KEY REFERENCES catalog_events(comiket_no),
  claim_id TEXT NOT NULL UNIQUE,
  source_md5_hint TEXT CHECK (
    source_md5_hint IS NULL OR length(source_md5_hint) = 65
  ),
  refresh_job_id TEXT REFERENCES catalog_refresh_jobs(id),
  refresh_lease_id TEXT,
  lease_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE catalog_versions (
  id TEXT PRIMARY KEY,
  comiket_no INTEGER NOT NULL REFERENCES catalog_events(comiket_no),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  state TEXT NOT NULL CHECK (
    state IN ('staging', 'published', 'superseded', 'failed')
  ),
  claim_id TEXT NOT NULL,
  source_updated_at INTEGER,
  source_md5_hint TEXT CHECK (
    source_md5_hint IS NULL OR length(source_md5_hint) = 65
  ),
  source_main_sha256 TEXT NOT NULL CHECK (length(source_main_sha256) = 64),
  source_image_sha256 TEXT NOT NULL CHECK (length(source_image_sha256) = 64),
  derived_sha256 TEXT CHECK (derived_sha256 IS NULL OR length(derived_sha256) = 64),
  derived_bytes INTEGER CHECK (derived_bytes IS NULL OR derived_bytes > 0),
  date_count INTEGER NOT NULL DEFAULT 0 CHECK (date_count >= 0),
  map_count INTEGER NOT NULL DEFAULT 0 CHECK (map_count >= 0),
  area_count INTEGER NOT NULL DEFAULT 0 CHECK (area_count >= 0),
  block_count INTEGER NOT NULL DEFAULT 0 CHECK (block_count >= 0),
  floor_count INTEGER NOT NULL DEFAULT 0 CHECK (floor_count >= 0),
  mapping_count INTEGER NOT NULL DEFAULT 0 CHECK (mapping_count >= 0),
  genre_count INTEGER NOT NULL DEFAULT 0 CHECK (genre_count >= 0),
  circle_count INTEGER NOT NULL DEFAULT 0 CHECK (circle_count >= 0),
  layout_count INTEGER NOT NULL DEFAULT 0 CHECK (layout_count >= 0),
  image_count INTEGER NOT NULL DEFAULT 0 CHECK (image_count >= 0),
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (comiket_no, source_main_sha256, source_image_sha256)
) STRICT, WITHOUT ROWID;

CREATE INDEX catalog_versions_event_state
  ON catalog_versions (comiket_no, state, published_at);

CREATE TABLE catalog_artifacts (
  version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('source_main', 'source_image', 'derived_catalog')
  ),
  visibility TEXT NOT NULL CHECK (
    visibility IN ('private_source', 'authenticated_download')
  ),
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  source_md5_hint TEXT CHECK (
    source_md5_hint IS NULL OR length(source_md5_hint) = 65
  ),
  byte_count INTEGER NOT NULL CHECK (byte_count > 0),
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (version_id, kind)
) STRICT, WITHOUT ROWID;

CREATE TABLE catalog_dates (
  version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  day INTEGER NOT NULL CHECK (day > 0),
  date_iso TEXT NOT NULL CHECK (length(date_iso) = 10),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  PRIMARY KEY (version_id, day)
) STRICT, WITHOUT ROWID;

CREATE TABLE catalog_maps (
  version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  map_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  origin_x INTEGER NOT NULL,
  origin_y INTEGER NOT NULL,
  rotation INTEGER NOT NULL CHECK (rotation IN (0, 1)),
  artwork_name TEXT,
  PRIMARY KEY (version_id, map_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE catalog_areas (
  version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  area_id INTEGER NOT NULL,
  map_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  simple_name TEXT NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  width INTEGER NOT NULL CHECK (width >= 0),
  height INTEGER NOT NULL CHECK (height >= 0),
  PRIMARY KEY (version_id, area_id),
  FOREIGN KEY (version_id, map_id)
    REFERENCES catalog_maps(version_id, map_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE catalog_blocks (
  version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  block_id INTEGER NOT NULL,
  area_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (version_id, block_id),
  FOREIGN KEY (version_id, area_id)
    REFERENCES catalog_areas(version_id, area_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE catalog_floors (
  version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  floor_id INTEGER NOT NULL,
  day INTEGER NOT NULL,
  map_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (version_id, floor_id),
  FOREIGN KEY (version_id, day)
    REFERENCES catalog_dates(version_id, day),
  FOREIGN KEY (version_id, map_id)
    REFERENCES catalog_maps(version_id, map_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE catalog_mappings (
  version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  block_id INTEGER NOT NULL,
  map_id INTEGER NOT NULL,
  area_id INTEGER NOT NULL,
  floor_id INTEGER NOT NULL,
  PRIMARY KEY (version_id, day, block_id),
  FOREIGN KEY (version_id, day)
    REFERENCES catalog_dates(version_id, day),
  FOREIGN KEY (version_id, block_id)
    REFERENCES catalog_blocks(version_id, block_id),
  FOREIGN KEY (version_id, map_id)
    REFERENCES catalog_maps(version_id, map_id),
  FOREIGN KEY (version_id, area_id)
    REFERENCES catalog_areas(version_id, area_id),
  FOREIGN KEY (version_id, floor_id)
    REFERENCES catalog_floors(version_id, floor_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE catalog_genres (
  version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL,
  code INTEGER,
  -- Circle.ms uses day 0 for genres that apply to the whole event.
  day INTEGER,
  name TEXT NOT NULL,
  PRIMARY KEY (version_id, genre_id),
  CHECK (day IS NULL OR day > 0),
  FOREIGN KEY (version_id, day)
    REFERENCES catalog_dates(version_id, day)
) STRICT, WITHOUT ROWID;

CREATE TABLE catalog_layouts (
  version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  block_id INTEGER NOT NULL,
  space_no INTEGER NOT NULL,
  map_id INTEGER NOT NULL,
  hall_id INTEGER,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  orientation INTEGER NOT NULL CHECK (orientation BETWEEN 1 AND 4),
  PRIMARY KEY (version_id, block_id, space_no),
  FOREIGN KEY (version_id, block_id)
    REFERENCES catalog_blocks(version_id, block_id),
  FOREIGN KEY (version_id, map_id)
    REFERENCES catalog_maps(version_id, map_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE catalog_circles (
  version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  comiket_no INTEGER NOT NULL,
  wc_id INTEGER NOT NULL CHECK (wc_id > 0),
  day INTEGER NOT NULL,
  block_id INTEGER,
  space_no INTEGER,
  space_no_sub INTEGER CHECK (space_no_sub IS NULL OR space_no_sub IN (0, 1)),
  genre_id INTEGER,
  name TEXT NOT NULL,
  kana TEXT NOT NULL,
  pen_name TEXT NOT NULL,
  book_name TEXT NOT NULL,
  website_url TEXT,
  description TEXT NOT NULL,
  twitter_url TEXT,
  pixiv_url TEXT,
  update_id INTEGER,
  PRIMARY KEY (version_id, wc_id),
  FOREIGN KEY (version_id, day)
    REFERENCES catalog_dates(version_id, day),
  FOREIGN KEY (version_id, block_id)
    REFERENCES catalog_blocks(version_id, block_id),
  FOREIGN KEY (version_id, genre_id)
    REFERENCES catalog_genres(version_id, genre_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX catalog_circles_location
  ON catalog_circles (version_id, day, block_id, space_no, space_no_sub);
CREATE INDEX catalog_circles_name
  ON catalog_circles (version_id, name, kana);

-- Version-neutral stable identity authority. Successful publication only ever
-- extends this set; superseding a catalog never invalidates an existing user
-- favorite merely because the latest provider snapshot omitted the circle.
CREATE TABLE catalog_stable_circles (
  comiket_no INTEGER NOT NULL REFERENCES catalog_events(comiket_no),
  wc_id INTEGER NOT NULL CHECK (wc_id > 0),
  first_version_id TEXT NOT NULL REFERENCES catalog_versions(id),
  last_version_id TEXT NOT NULL REFERENCES catalog_versions(id),
  first_published_at INTEGER NOT NULL,
  last_published_at INTEGER NOT NULL,
  PRIMARY KEY (comiket_no, wc_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE catalog_image_assets (
  version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('circle_cut', 'common')),
  asset_key TEXT NOT NULL,
  wc_id INTEGER,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  content_type TEXT NOT NULL CHECK (
    content_type IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  byte_count INTEGER NOT NULL CHECK (byte_count > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (version_id, kind, asset_key),
  UNIQUE (version_id, kind, wc_id),
  FOREIGN KEY (version_id, wc_id)
    REFERENCES catalog_circles(version_id, wc_id)
) STRICT, WITHOUT ROWID;

-- Provider URLs expire quickly and are therefore minted only after a trusted
-- publisher leases a job. Durable rows retain authority and source identity,
-- never transient provider capabilities.
CREATE TABLE catalog_refresh_jobs (
  id TEXT PRIMARY KEY,
  user_identity_id INTEGER NOT NULL
    REFERENCES user_identities(id) ON DELETE CASCADE,
  comiket_no INTEGER NOT NULL REFERENCES catalog_events(comiket_no),
  provider_circlems_event_id INTEGER NOT NULL CHECK (provider_circlems_event_id > 0),
  source_md5_hint TEXT NOT NULL CHECK (length(source_md5_hint) = 65),
  source_updated_at INTEGER,
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'published', 'failed')),
  lease_id TEXT,
  lease_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  published_version_id TEXT REFERENCES catalog_versions(id),
  published_lease_id TEXT,
  last_error TEXT,
  last_command_key TEXT,
  last_command_payload_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX catalog_refresh_jobs_available
  ON catalog_refresh_jobs (state, lease_expires_at, created_at);

CREATE UNIQUE INDEX catalog_refresh_jobs_live_source
  ON catalog_refresh_jobs (comiket_no, source_md5_hint)
  WHERE state IN ('queued', 'leased');

-- One public Comiket can have only one runnable publication, even if two
-- credentials observe different upstream pairs during the same discovery.
CREATE UNIQUE INDEX catalog_refresh_jobs_live_event
  ON catalog_refresh_jobs (comiket_no)
  WHERE state IN ('queued', 'leased');

CREATE UNIQUE INDEX catalog_refresh_jobs_live_lease
  ON catalog_refresh_jobs (lease_id) WHERE lease_id IS NOT NULL;

CREATE TABLE catalog_refresh_command_receipts (
  idempotency_key TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (
    action IN ('lease', 'renew', 'complete', 'release')
  ),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  job_id TEXT REFERENCES catalog_refresh_jobs(id) ON DELETE CASCADE,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE catalog_refresh_failures (
  user_identity_id INTEGER NOT NULL
    REFERENCES user_identities(id) ON DELETE CASCADE,
  comiket_no INTEGER NOT NULL REFERENCES catalog_events(comiket_no),
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  next_attempt_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_identity_id, comiket_no)
) STRICT, WITHOUT ROWID;
