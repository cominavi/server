PRAGMA foreign_keys = ON;

-- Curated-decision authority ledger (#49).
-- Approved contract: cominavi/cominavi docs/proposals/catalog-contracts.md §3.4.
-- Decisions and request receipts are append-only: the triggers below abort
-- every UPDATE and DELETE. Additive only; reversible by DROP TRIGGER /
-- DROP INDEX / DROP TABLE while the tables are empty.

CREATE TABLE curated_decisions (
  decision_id TEXT PRIMARY KEY,
  catalog_event_key TEXT NOT NULL REFERENCES catalog_editions(catalog_event_key),
  circle_key TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (length(slot) BETWEEN 1 AND 200),
  slot_revision INTEGER NOT NULL CHECK (slot_revision > 0),
  operation TEXT NOT NULL CHECK (operation IN ('assert', 'reverse')),
  decision_type TEXT NOT NULL CHECK (decision_type IN (
    'x_account_attach', 'x_account_suppress', 'attendance_assert',
    'attendance_claim_suppress', 'circle_identity_link')),
  payload_schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('operator', 'system', 'legacy_import')),
  actor_subject TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'report_confirmed', 'operator_observed', 'provider_data_error',
    'false_match', 'impersonation_or_unofficial', 'circle_request',
    'identity_resolution', 'legacy_label_import', 'other')),
  reason_text TEXT NOT NULL,
  -- FK to the #52 report table once it exists.
  report_id TEXT,
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  request_id TEXT NOT NULL UNIQUE,
  request_sha256 TEXT NOT NULL,
  -- Per-edition monotonic sequence for publication.
  ledger_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (catalog_event_key, circle_key, slot, slot_revision),
  UNIQUE (catalog_event_key, ledger_seq),
  FOREIGN KEY (catalog_event_key, circle_key)
    REFERENCES catalog_edition_circles(catalog_event_key, circle_key)
) STRICT;

CREATE INDEX curated_decisions_subject
  ON curated_decisions (catalog_event_key, circle_key, created_at);

-- Current state per slot; the optimistic CAS target. NULL after reverse.
CREATE TABLE curated_decision_heads (
  catalog_event_key TEXT NOT NULL,
  circle_key TEXT NOT NULL,
  slot TEXT NOT NULL,
  slot_revision INTEGER NOT NULL,
  active_decision_id TEXT REFERENCES curated_decisions(decision_id),
  PRIMARY KEY (catalog_event_key, circle_key, slot)
) STRICT, WITHOUT ROWID;

-- Per-edition sequence allocator and publication fence.
CREATE TABLE curated_edition_ledger_heads (
  catalog_event_key TEXT PRIMARY KEY REFERENCES catalog_editions(catalog_event_key),
  ledger_seq INTEGER NOT NULL,
  published_through_seq INTEGER NOT NULL,
  CHECK (published_through_seq <= ledger_seq)
) STRICT;

CREATE TABLE curated_decision_request_receipts (
  request_id TEXT PRIMARY KEY,
  request_sha256 TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES curated_decisions(decision_id),
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TRIGGER curated_decisions_append_only_update
BEFORE UPDATE ON curated_decisions
BEGIN
  SELECT RAISE(ABORT, 'curated_decisions is append-only');
END;

CREATE TRIGGER curated_decisions_append_only_delete
BEFORE DELETE ON curated_decisions
BEGIN
  SELECT RAISE(ABORT, 'curated_decisions is append-only');
END;

CREATE TRIGGER curated_decision_request_receipts_append_only_update
BEFORE UPDATE ON curated_decision_request_receipts
BEGIN
  SELECT RAISE(ABORT, 'curated_decision_request_receipts is append-only');
END;

CREATE TRIGGER curated_decision_request_receipts_append_only_delete
BEFORE DELETE ON curated_decision_request_receipts
BEGIN
  SELECT RAISE(ABORT, 'curated_decision_request_receipts is append-only');
END;
