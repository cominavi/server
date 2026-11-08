PRAGMA foreign_keys = ON;

-- Provider-neutral catalog identity, phase P1 (additive only).
-- Approved contract: cominavi/cominavi docs/proposals/catalog-contracts.md §2.9.
-- Nothing reads these tables yet; the legacy comiket_no tables stay
-- authoritative until dual-read (P4). Every statement here is reversible by
-- DROP TABLE / DROP INDEX / ALTER TABLE ... DROP COLUMN.

-- Edition registry. Today's catalog_events stays as the legacy Comiket table
-- during the compatibility window.
CREATE TABLE catalog_editions (
  catalog_event_key TEXT PRIMARY KEY CHECK (
    length(catalog_event_key) BETWEEN 3 AND 64
    AND catalog_event_key GLOB '[a-z]*'
    AND catalog_event_key NOT GLOB '*[^a-z0-9-]*'
    AND catalog_event_key NOT GLOB '*--*'
    AND catalog_event_key NOT GLOB '*-'
    AND NOT (catalog_event_key GLOB 'c[0-9]*' AND substr(catalog_event_key, 2) NOT GLOB '*[^0-9]*')
    AND catalog_event_key NOT GLOB 'event-*'
  ),
  series_key TEXT NOT NULL CHECK (series_key IN ('comiket', 'fixture')),
  legacy_comiket_no INTEGER UNIQUE REFERENCES catalog_events(comiket_no),
  metadata_schema_version INTEGER NOT NULL CHECK (metadata_schema_version = 1),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  metadata_revision INTEGER NOT NULL CHECK (metadata_revision > 0),
  source_provider TEXT NOT NULL CHECK (source_provider IN ('circlems', 'fixture')),
  listing_state TEXT NOT NULL CHECK (listing_state IN ('hidden', 'listed', 'retired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((series_key = 'comiket') = (legacy_comiket_no IS NOT NULL)),
  CHECK (
    series_key = 'comiket'
    OR NOT (catalog_event_key GLOB 'comiket-[0-9]*' AND substr(catalog_event_key, 9) NOT GLOB '*[^0-9]*')
  )
) STRICT;

CREATE TABLE catalog_edition_capabilities (
  catalog_event_key TEXT NOT NULL REFERENCES catalog_editions(catalog_event_key),
  capability TEXT NOT NULL CHECK (capability IN (
    'catalogArtifact', 'circleImages', 'commonImages', 'venueMap',
    'favorites', 'providerFavoriteMirror', 'socialEnrichment',
    'realtimeUpdates', 'attendanceStatus', 'tagOverlay', 'curatedOverlay',
    'structuredShinagaki', 'circleReports', 'reminders', 'sharedPlans'
  )),
  state TEXT NOT NULL CHECK (state IN ('supported', 'unsupported')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (catalog_event_key, capability)
) STRICT, WITHOUT ROWID;

-- Provider identifiers are attributes, never canonical keys. Aliases are
-- retired, never rewritten.
CREATE TABLE catalog_provider_aliases (
  provider TEXT NOT NULL CHECK (provider IN ('circlems')),
  provider_environment TEXT NOT NULL CHECK (provider_environment IN ('production')),
  alias_kind TEXT NOT NULL CHECK (alias_kind IN ('circlems_event_id', 'wcid')),
  -- '' for event aliases; catalog_event_key for circle aliases.
  alias_scope TEXT NOT NULL,
  alias_value TEXT NOT NULL,
  catalog_event_key TEXT NOT NULL REFERENCES catalog_editions(catalog_event_key),
  -- NULL for event aliases.
  circle_key TEXT,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  PRIMARY KEY (provider, provider_environment, alias_kind, alias_scope, alias_value)
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX catalog_provider_aliases_live_target
  ON catalog_provider_aliases (provider, provider_environment, alias_kind, catalog_event_key, ifnull(circle_key, ''))
  WHERE retired_at IS NULL;

-- Neutral stable-circle authority; append-only like catalog_stable_circles.
CREATE TABLE catalog_edition_circles (
  catalog_event_key TEXT NOT NULL REFERENCES catalog_editions(catalog_event_key),
  circle_key TEXT NOT NULL CHECK (
    (circle_key GLOB '[1-9]*' AND circle_key NOT GLOB '*[^0-9]*')
    OR (
      length(circle_key) = 17
      AND circle_key GLOB 'm*'
      AND substr(circle_key, 2) NOT GLOB '*[^0123456789abcdefghjkmnpqrstvwxyz]*'
    )
  ),
  legacy_wc_id INTEGER CHECK (legacy_wc_id > 0),
  key_origin TEXT NOT NULL CHECK (key_origin IN ('provider_durable', 'minted')),
  first_version_id TEXT NOT NULL REFERENCES catalog_versions(id),
  last_version_id TEXT NOT NULL REFERENCES catalog_versions(id),
  first_published_at INTEGER NOT NULL,
  last_published_at INTEGER NOT NULL,
  PRIMARY KEY (catalog_event_key, circle_key),
  UNIQUE (catalog_event_key, legacy_wc_id)
) STRICT, WITHOUT ROWID;

-- Restartable P2 backfill progress (one row per backfill step).
CREATE TABLE catalog_identity_backfill_checkpoints (
  step TEXT PRIMARY KEY,
  last_key TEXT,
  completed_at INTEGER
) STRICT;

-- Nullable columns on the existing version table (dual-written from P3).
ALTER TABLE catalog_versions ADD COLUMN catalog_event_key TEXT REFERENCES catalog_editions(catalog_event_key);
ALTER TABLE catalog_versions ADD COLUMN artifact_format INTEGER CHECK (artifact_format IN (1, 2));
ALTER TABLE catalog_versions ADD COLUMN source_adapter_version INTEGER;
ALTER TABLE catalog_versions ADD COLUMN capability_snapshot_json TEXT;
