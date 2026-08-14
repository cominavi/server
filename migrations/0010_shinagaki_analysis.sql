PRAGMA foreign_keys = ON;

-- Immutable model-produced Shinagaki analysis datasets. The raw public-source
-- analysis stays queryable, while activation is a separate final step so a
-- partial file import can never become authoritative.
CREATE TABLE shinagaki_analysis_versions (
  event_number INTEGER NOT NULL,
  revision TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  source_archive_sha256 TEXT NOT NULL,
  source_index_sha256 TEXT NOT NULL,
  source_snapshot_revision TEXT NOT NULL,
  source_snapshot_generation INTEGER NOT NULL,
  models_json TEXT NOT NULL,
  model_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  complete_count INTEGER NOT NULL,
  partial_count INTEGER NOT NULL,
  insufficient_count INTEGER NOT NULL,
  product_count INTEGER NOT NULL,
  offer_count INTEGER NOT NULL,
  conflict_record_count INTEGER NOT NULL,
  conflict_count INTEGER NOT NULL,
  result_json_bytes INTEGER NOT NULL,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (event_number, revision),
  UNIQUE (event_number, source_archive_sha256),
  FOREIGN KEY (event_number, source_snapshot_revision)
    REFERENCES crawler_snapshot_versions(event_number, revision),
  CHECK (event_number > 0 AND event_number <= 10000),
  CHECK (schema_version = 1),
  CHECK (length(revision) = 64 AND revision NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(source_archive_sha256) = 64 AND source_archive_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(source_index_sha256) = 64 AND source_index_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(source_snapshot_revision) = 64 AND source_snapshot_revision NOT GLOB '*[^0-9a-f]*'),
  CHECK (source_snapshot_generation > 0),
  CHECK (json_valid(models_json)),
  CHECK (model_count > 0 AND model_count <= 20),
  CHECK (record_count > 0 AND record_count <= 20000),
  CHECK (complete_count >= 0 AND partial_count >= 0 AND insufficient_count >= 0),
  CHECK (complete_count + partial_count + insufficient_count = record_count),
  CHECK (product_count >= 0 AND offer_count >= 0),
  CHECK (conflict_record_count >= 0 AND conflict_record_count <= record_count),
  CHECK (conflict_count >= conflict_record_count),
  CHECK (result_json_bytes > 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE shinagaki_analysis_records (
  event_number INTEGER NOT NULL,
  revision TEXT NOT NULL,
  post_id TEXT NOT NULL,
  wc_id INTEGER NOT NULL,
  author_handle TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  overall_confidence REAL NOT NULL,
  product_count INTEGER NOT NULL,
  offer_count INTEGER NOT NULL,
  conflict_count INTEGER NOT NULL,
  result_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (event_number, revision, post_id),
  FOREIGN KEY (event_number, revision)
    REFERENCES shinagaki_analysis_versions(event_number, revision)
    ON DELETE CASCADE,
  FOREIGN KEY (event_number, wc_id)
    REFERENCES catalog_stable_circles(comiket_no, wc_id),
  CHECK (event_number > 0 AND event_number <= 10000),
  CHECK (length(post_id) BETWEEN 1 AND 24 AND post_id NOT GLOB '*[^0-9]*'),
  CHECK (wc_id > 0),
  CHECK (length(author_handle) BETWEEN 1 AND 15 AND author_handle NOT GLOB '*[^A-Za-z0-9_]*'),
  CHECK (length(trim(model)) BETWEEN 1 AND 100),
  CHECK (status IN ('complete', 'partial', 'insufficient')),
  CHECK (overall_confidence >= 0.0 AND overall_confidence <= 1.0),
  CHECK (product_count >= 0 AND offer_count >= 0 AND conflict_count >= 0),
  CHECK (length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(result_json))
) STRICT, WITHOUT ROWID;

CREATE INDEX shinagaki_analysis_records_circle
  ON shinagaki_analysis_records (event_number, wc_id, revision, post_id);

CREATE TABLE shinagaki_analysis_heads (
  event_number INTEGER PRIMARY KEY,
  revision TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (event_number, revision)
    REFERENCES shinagaki_analysis_versions(event_number, revision),
  CHECK (event_number > 0 AND event_number <= 10000),
  CHECK (length(revision) = 64 AND revision NOT GLOB '*[^0-9a-f]*')
) STRICT;
