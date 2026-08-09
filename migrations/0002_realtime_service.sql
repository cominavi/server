PRAGMA foreign_keys = ON;

-- Circle.ms identity is verified before a row is created. `subject` remains
-- opaque outside the service and is the JWT subject.
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL UNIQUE,
  circlems_environment TEXT NOT NULL
    CHECK (circlems_environment IN ('production', 'sandbox')),
  circlems_user_id INTEGER NOT NULL CHECK (circlems_user_id > 0),
  nickname TEXT,
  auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_authenticated_at INTEGER NOT NULL,
  UNIQUE (circlems_environment, circlems_user_id)
) STRICT;

-- WCID is the durable public circle identity. Circle IDs are catalog-local and
-- may be renumbered between otherwise equivalent catalog snapshots.
CREATE TABLE circles (
  comiket_no INTEGER NOT NULL CHECK (comiket_no > 0),
  wc_id INTEGER NOT NULL CHECK (wc_id > 0),
  circle_id INTEGER CHECK (circle_id > 0),
  circle_name TEXT NOT NULL DEFAULT '',
  pen_name TEXT NOT NULL DEFAULT '',
  day INTEGER,
  area_name TEXT,
  block_name TEXT,
  space_no INTEGER,
  space_no_sub INTEGER,
  location TEXT,
  catalog_payload_sha256 TEXT,
  catalog_record_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(catalog_record_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (comiket_no, wc_id),
  UNIQUE (comiket_no, circle_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE ingest_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL
    CHECK (length(payload_sha256) = 64),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  raw_payload_json TEXT NOT NULL CHECK (json_valid(raw_payload_json)),
  UNIQUE (source, idempotency_key)
) STRICT;

CREATE TABLE social_posts (
  post_id TEXT PRIMARY KEY,
  author_x_user_id TEXT,
  author_handle TEXT NOT NULL,
  author_name TEXT,
  author_profile_image_url TEXT,
  post_url TEXT,
  text TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  latest_observed_at INTEGER NOT NULL,
  raw_post_json TEXT NOT NULL CHECK (json_valid(raw_post_json))
) STRICT, WITHOUT ROWID;

CREATE TABLE post_media (
  post_id TEXT NOT NULL REFERENCES social_posts(post_id) ON DELETE CASCADE,
  media_index INTEGER NOT NULL CHECK (media_index >= 0),
  media_key TEXT NOT NULL,
  media_type TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('shinagaki', 'cover', 'post_image')),
  url TEXT NOT NULL,
  preview_url TEXT,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  palette_json TEXT CHECK (palette_json IS NULL OR json_valid(palette_json)),
  payload_sha256 TEXT,
  PRIMARY KEY (post_id, media_key)
) STRICT, WITHOUT ROWID;

-- Every classifier result is immutable. A newer policy can emit a distinct
-- event for the same post by increasing source_revision.
CREATE TABLE circle_update_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  ingest_batch_id INTEGER NOT NULL REFERENCES ingest_batches(id),
  source TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision > 0),
  post_id TEXT NOT NULL REFERENCES social_posts(post_id),
  update_kind TEXT NOT NULL,
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('attendance', 'inventory', 'presence', 'shinagaki', 'cover')
  ),
  state_value TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (
    confidence IN ('high', 'medium', 'low', 'unmatched')
  ),
  occurred_at INTEGER NOT NULL,
  notifiable INTEGER NOT NULL DEFAULT 1 CHECK (notifiable IN (0, 1)),
  evidence_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(evidence_json)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX circle_update_events_cursor
  ON circle_update_events (id, occurred_at);
CREATE INDEX circle_update_events_post
  ON circle_update_events (post_id, id);

CREATE TABLE circle_update_targets (
  update_event_id INTEGER NOT NULL
    REFERENCES circle_update_events(id) ON DELETE CASCADE,
  comiket_no INTEGER NOT NULL,
  wc_id INTEGER NOT NULL,
  PRIMARY KEY (update_event_id, comiket_no, wc_id),
  FOREIGN KEY (comiket_no, wc_id)
    REFERENCES circles(comiket_no, wc_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX circle_update_targets_circle
  ON circle_update_targets (comiket_no, wc_id, update_event_id);

-- Ranking is source time, then classifier revision, then stable event key.
-- Webhook arrival order never rewinds the current state.
CREATE TABLE circle_state_heads (
  comiket_no INTEGER NOT NULL,
  wc_id INTEGER NOT NULL,
  state_kind TEXT NOT NULL,
  state_value TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  update_event_id INTEGER NOT NULL
    REFERENCES circle_update_events(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (comiket_no, wc_id, state_kind),
  FOREIGN KEY (comiket_no, wc_id)
    REFERENCES circles(comiket_no, wc_id)
) STRICT, WITHOUT ROWID;

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
  PRIMARY KEY (user_id, comiket_no, wc_id),
  FOREIGN KEY (comiket_no, wc_id)
    REFERENCES circles(comiket_no, wc_id)
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

CREATE TABLE seed_imports (
  seed_key TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  imported_at INTEGER NOT NULL,
  circle_count INTEGER NOT NULL,
  post_count INTEGER NOT NULL,
  update_count INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
