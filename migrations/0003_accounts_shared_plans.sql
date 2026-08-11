PRAGMA defer_foreign_keys = ON;
PRAGMA legacy_alter_table = ON;

-- D1 applies migrations inside a transaction, where foreign_keys cannot be
-- disabled. SQLite rewrites child FKs to the temporary table name even with
-- legacy_alter_table when enforcement is active; dropping it then cascades.
-- Snapshot every existing child first and restore it after the canonical user
-- table has taken the original name.
CREATE TABLE migration_0003_favorite_sets AS SELECT * FROM favorite_sets;
CREATE TABLE migration_0003_user_favorites AS SELECT * FROM user_favorites;
CREATE TABLE migration_0003_push_devices AS SELECT * FROM push_devices;
CREATE TABLE migration_0003_notification_deliveries AS
  SELECT * FROM notification_deliveries;

DROP TABLE notification_deliveries;
DROP TABLE push_devices;
DROP TABLE user_favorites;
DROP TABLE favorite_sets;

ALTER TABLE users RENAME TO users_legacy;

-- Replace the Circle.ms-shaped user table with a provider-neutral ComiNavi
-- account table while keeping its integer primary keys stable for every
-- existing favorite, device, and delivery foreign key.
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE CHECK (length(public_id) = 32),
  display_name TEXT NOT NULL
    CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  avatar_provider_url TEXT
    CHECK (avatar_provider_url IS NULL OR length(avatar_provider_url) <= 2048),
  avatar_object_key TEXT,
  avatar_content_type TEXT CHECK (
    avatar_content_type IS NULL OR
    avatar_content_type IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  display_name_edited INTEGER NOT NULL DEFAULT 0
    CHECK (display_name_edited IN (0, 1)),
  avatar_edited INTEGER NOT NULL DEFAULT 0
    CHECK (avatar_edited IN (0, 1)),
  avatar_removed INTEGER NOT NULL DEFAULT 0
    CHECK (avatar_removed IN (0, 1)),
  profile_revision INTEGER NOT NULL DEFAULT 1 CHECK (profile_revision > 0),
  auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  last_auth_fenced_at INTEGER,
  last_auth_fence_request_id TEXT,
  last_auth_fence_payload_hash TEXT,
  last_mutation_scope TEXT,
  last_mutation_request_id TEXT,
  last_mutation_payload_hash TEXT,
  deletion_pending_at INTEGER,
  deletion_request_id TEXT,
  deletion_payload_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_authenticated_at INTEGER NOT NULL
) STRICT;

INSERT INTO users (
  id, public_id, display_name, avatar_provider_url, avatar_object_key,
  avatar_content_type, display_name_edited, avatar_edited, avatar_removed, profile_revision,
  auth_version, created_at, updated_at, last_authenticated_at
)
SELECT id, lower(hex(randomblob(16))),
       CASE
         WHEN nickname IS NOT NULL AND length(trim(nickname)) > 0
           THEN substr(trim(nickname), 1, 80)
         ELSE 'ComiNavi User ' || id
       END,
       NULL, NULL, NULL, 0, 0, 0, 1,
       auth_version, created_at, updated_at, last_authenticated_at
FROM users_legacy;

CREATE TABLE user_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('circlems', 'google', 'apple')),
  provider_environment TEXT NOT NULL DEFAULT '' CHECK (
    (provider = 'circlems' AND provider_environment IN ('production', 'sandbox')) OR
    (provider IN ('google', 'apple') AND provider_environment = '')
  ),
  provider_subject TEXT NOT NULL,
  provider_user_id INTEGER CHECK (
    (provider = 'circlems' AND provider_user_id > 0) OR
    (provider IN ('google', 'apple') AND provider_user_id IS NULL)
  ),
  provider_email TEXT,
  provider_display_name TEXT,
  provider_avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_authenticated_at INTEGER NOT NULL,
  UNIQUE (provider, provider_environment, provider_subject),
  UNIQUE (provider, provider_environment, provider_user_id)
) STRICT;

INSERT INTO user_identities (
  user_id, provider, provider_environment, provider_subject,
  provider_user_id, provider_display_name,
  created_at, updated_at, last_authenticated_at
)
SELECT id, 'circlems', circlems_environment,
       CAST(circlems_user_id AS TEXT), circlems_user_id, nickname,
       created_at, updated_at, last_authenticated_at
FROM users_legacy;

DROP TABLE users_legacy;

CREATE TABLE favorite_sets (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comiket_no INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_mutation_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, comiket_no)
) STRICT, WITHOUT ROWID;

CREATE TABLE user_favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comiket_no INTEGER NOT NULL,
  wc_id INTEGER NOT NULL,
  color INTEGER NOT NULL DEFAULT 1 CHECK (color BETWEEN 0 AND 9),
  notifications_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (notifications_enabled IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  snapshot_revision INTEGER NOT NULL CHECK (snapshot_revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Stable WCIDs are validated against the active sanitized catalog at the
  -- mutation boundary. A version-neutral favorite cannot safely FK to either
  -- the legacy realtime projection or one versioned catalog_circles row.
  PRIMARY KEY (user_id, comiket_no, wc_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX user_favorites_notification_circle
  ON user_favorites (comiket_no, wc_id, user_id)
  WHERE active = 1 AND notifications_enabled = 1;

CREATE TABLE push_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  token TEXT NOT NULL,
  token_sha256 TEXT NOT NULL CHECK (length(token_sha256) = 64),
  apns_environment TEXT NOT NULL
    CHECK (apns_environment IN ('sandbox', 'production')),
  bundle_id TEXT NOT NULL,
  locale TEXT,
  time_zone TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_registered_at INTEGER NOT NULL,
  invalidated_at INTEGER,
  UNIQUE (user_id, installation_id),
  UNIQUE (apns_environment, bundle_id, token_sha256)
) STRICT;

CREATE INDEX push_devices_user_enabled
  ON push_devices (user_id, enabled);

CREATE TABLE notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_event_id INTEGER NOT NULL
    REFERENCES circle_update_events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'retry', 'delivered', 'dead', 'suppressed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at INTEGER NOT NULL,
  lease_expires_at INTEGER,
  apns_id TEXT,
  delivered_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (update_event_id, device_id)
) STRICT;

CREATE INDEX notification_deliveries_ready
  ON notification_deliveries (status, available_at, id);

INSERT INTO favorite_sets (
  user_id, comiket_no, revision, last_mutation_id, updated_at
)
SELECT user_id, comiket_no, revision, last_mutation_id, updated_at
FROM migration_0003_favorite_sets;

INSERT INTO user_favorites (
  user_id, comiket_no, wc_id, color, notifications_enabled, active,
  snapshot_revision, created_at, updated_at
)
SELECT user_id, comiket_no, wc_id, color, notifications_enabled, active,
       snapshot_revision, created_at, updated_at
FROM migration_0003_user_favorites;

INSERT INTO push_devices (
  id, user_id, installation_id, token, token_sha256, apns_environment,
  bundle_id, locale, time_zone, enabled, created_at, updated_at,
  last_registered_at, invalidated_at
)
SELECT id, user_id, installation_id, token, token_sha256, apns_environment,
       bundle_id, locale, time_zone, enabled, created_at, updated_at,
       last_registered_at, invalidated_at
FROM migration_0003_push_devices;

INSERT INTO notification_deliveries (
  id, update_event_id, user_id, device_id, status, attempt_count,
  available_at, lease_expires_at, apns_id, delivered_at, last_error,
  created_at, updated_at
)
SELECT id, update_event_id, user_id, device_id, status, attempt_count,
       available_at, lease_expires_at, apns_id, delivered_at, last_error,
       created_at, updated_at
FROM migration_0003_notification_deliveries;

DROP TABLE migration_0003_favorite_sets;
DROP TABLE migration_0003_user_favorites;
DROP TABLE migration_0003_push_devices;
DROP TABLE migration_0003_notification_deliveries;

CREATE INDEX user_identities_user ON user_identities (user_id, provider);

CREATE TABLE auth_refresh_tokens (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  auth_version INTEGER NOT NULL CHECK (auth_version > 0),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  replaced_by_hash TEXT,
  created_at INTEGER NOT NULL,
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
) STRICT, WITHOUT ROWID;

CREATE INDEX auth_refresh_tokens_user
  ON auth_refresh_tokens (user_id, expires_at);
CREATE INDEX auth_refresh_tokens_family
  ON auth_refresh_tokens (family_id, created_at);

CREATE TABLE google_entry_grants (
  grant_hash TEXT PRIMARY KEY CHECK (length(grant_hash) = 64),
  nonce_hash TEXT NOT NULL CHECK (length(nonce_hash) = 64),
  audience TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX google_entry_grants_expiry
  ON google_entry_grants (expires_at);

CREATE TABLE shared_plans (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 20 AND 64),
  comiket_no INTEGER NOT NULL CHECK (comiket_no > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  archived_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_mutation_scope TEXT,
  last_mutation_request_id TEXT,
  last_mutation_payload_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX shared_plans_owner_active
  ON shared_plans (owner_user_id, comiket_no, archived_at);

CREATE TABLE shared_plan_members (
  plan_id TEXT NOT NULL REFERENCES shared_plans(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
  joined_at INTEGER NOT NULL,
  revoked_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plan_id, user_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX shared_plan_members_user_active
  ON shared_plan_members (user_id, revoked_at, plan_id);

-- Slots make the per-Comiket owner limit a uniqueness constraint rather than
-- a race-prone COUNT check. Application writes allocate slot 0...49 in the
-- same D1 batch as the plan mutation.
CREATE TABLE owned_plan_slots (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comiket_no INTEGER NOT NULL CHECK (comiket_no > 0),
  slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 49),
  plan_id TEXT NOT NULL UNIQUE REFERENCES shared_plans(id) ON DELETE CASCADE,
  PRIMARY KEY (owner_user_id, comiket_no, slot)
) STRICT, WITHOUT ROWID;

CREATE TABLE shared_plan_requests (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  resource_id TEXT NOT NULL,
  result_revision INTEGER CHECK (result_revision IS NULL OR result_revision > 0),
  result_status TEXT CHECK (
    result_status IS NULL OR result_status IN ('active', 'archived')
  ),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, scope, request_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE shared_plan_invitations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 20 AND 64),
  plan_id TEXT NOT NULL REFERENCES shared_plans(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX shared_plan_invitations_plan
  ON shared_plan_invitations (plan_id, created_at);
CREATE INDEX shared_plan_invitations_active
  ON shared_plan_invitations (token_hash, expires_at, revoked_at);

-- Typed, versioned plan events are the in-app inbox authority. The actor is a
-- recipient too; APNs delivery can suppress the actor without erasing history.
CREATE TABLE shared_plan_events (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES shared_plans(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  i18n_key TEXT NOT NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE shared_plan_event_recipients (
  event_id TEXT NOT NULL REFERENCES shared_plan_events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at INTEGER,
  PRIMARY KEY (event_id, user_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX shared_plan_event_inbox
  ON shared_plan_event_recipients (user_id, read_at, event_id);

-- R2 writes are immutable and cannot share a transaction with D1. Replaced
-- objects are therefore queued durably and garbage-collected by the Worker.
CREATE TABLE avatar_object_cleanup (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'leased')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_expires_at INTEGER,
  available_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX avatar_object_cleanup_ready
  ON avatar_object_cleanup (state, available_at, created_at);

PRAGMA legacy_alter_table = OFF;
PRAGMA defer_foreign_keys = OFF;
PRAGMA foreign_key_check;
