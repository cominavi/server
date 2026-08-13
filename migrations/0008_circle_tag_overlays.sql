-- Immutable, content-addressed circle tag overlays. The normalized JSON lives
-- in private R2; D1 holds publication metadata, the active CAS head, and exact
-- crawler request receipts.

-- An intent is inserted before every R2 write. The publication transaction
-- consumes it only after the immutable version and CAS head are durable; the
-- scheduled worker removes any object left behind by an interrupted publish.
CREATE TABLE circle_tag_overlay_object_cleanup (
  object_key TEXT PRIMARY KEY,
  event_number INTEGER NOT NULL,
  revision TEXT NOT NULL,
  object_sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'leased')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_expires_at INTEGER,
  available_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (event_number > 0 AND event_number <= 10000),
  CHECK (length(revision) = 64 AND revision NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(object_sha256) = 64 AND object_sha256 NOT GLOB '*[^0-9a-f]*')
) STRICT, WITHOUT ROWID;

CREATE INDEX circle_tag_overlay_object_cleanup_ready
  ON circle_tag_overlay_object_cleanup (state, available_at, created_at);

CREATE TABLE circle_tag_overlay_versions (
  event_number INTEGER NOT NULL,
  revision TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  catalog_version_id TEXT NOT NULL,
  catalog_payload_sha256 TEXT NOT NULL,
  taxonomy_revision TEXT NOT NULL,
  matching_policy_revision TEXT NOT NULL,
  evaluated_circle_count INTEGER NOT NULL,
  tagged_circle_count INTEGER NOT NULL,
  term_count INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  object_sha256 TEXT NOT NULL,
  byte_count INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY (event_number, revision),
  FOREIGN KEY (catalog_version_id)
    REFERENCES catalog_versions(id),
  CHECK (event_number > 0 AND event_number <= 10000),
  CHECK (schema_version = 1),
  CHECK (length(revision) = 64 AND revision NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(catalog_payload_sha256) = 64 AND catalog_payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(taxonomy_revision) BETWEEN 1 AND 128),
  CHECK (length(matching_policy_revision) BETWEEN 1 AND 128),
  CHECK (evaluated_circle_count >= 0),
  CHECK (tagged_circle_count >= 0 AND tagged_circle_count <= evaluated_circle_count),
  CHECK (term_count >= 0),
  CHECK (length(object_sha256) = 64 AND object_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (byte_count > 0 AND byte_count <= 16777216)
) STRICT, WITHOUT ROWID;

CREATE TABLE circle_tag_overlay_heads (
  event_number INTEGER PRIMARY KEY,
  revision TEXT NOT NULL,
  publication_idempotency_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (event_number, revision)
    REFERENCES circle_tag_overlay_versions(event_number, revision),
  CHECK (event_number > 0 AND event_number <= 10000),
  CHECK (length(revision) = 64 AND revision NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(publication_idempotency_key) BETWEEN 16 AND 200)
) STRICT;

CREATE TABLE circle_tag_overlay_publication_receipts (
  idempotency_key TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL,
  event_number INTEGER NOT NULL,
  base_revision TEXT NOT NULL,
  revision TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (event_number, revision)
    REFERENCES circle_tag_overlay_versions(event_number, revision),
  CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (event_number > 0 AND event_number <= 10000),
  CHECK (base_revision = 'none' OR (length(base_revision) = 64 AND base_revision NOT GLOB '*[^0-9a-f]*')),
  CHECK (length(revision) = 64 AND revision NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(result_json))
) STRICT;
