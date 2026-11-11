-- Google and Apple sign-in are allowlist-only (cominavi/cominavi AGENTS.md,
-- owner decision 2026-11-11). An entry either waits for a single-use invite
-- code to be redeemed, or is bound to exactly one provider identity
-- (provider + subject). Entries are never matched by email.
CREATE TABLE sign_in_allowlist (
  entry_id TEXT PRIMARY KEY CHECK (
    length(entry_id) = 32 AND entry_id NOT GLOB '*[^0-9a-f]*'
  ),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 200),
  invite_code_hash TEXT UNIQUE CHECK (
    invite_code_hash IS NULL OR length(invite_code_hash) = 64
  ),
  invite_expires_at INTEGER,
  provider TEXT CHECK (provider IS NULL OR provider IN ('google', 'apple')),
  provider_subject TEXT CHECK (
    provider_subject IS NULL OR length(provider_subject) BETWEEN 1 AND 255
  ),
  bound_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((provider IS NULL) = (provider_subject IS NULL)),
  CHECK ((provider IS NULL) = (bound_at IS NULL)),
  CHECK (invite_code_hash IS NOT NULL OR provider IS NOT NULL)
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX sign_in_allowlist_active_identity
  ON sign_in_allowlist (provider, provider_subject)
  WHERE provider IS NOT NULL AND revoked_at IS NULL;

-- The entry page records which unredeemed invite the person typed. The
-- authentication commit binds that entry to the verified identity.
ALTER TABLE google_entry_grants ADD COLUMN allowlist_entry_id TEXT;

-- Grandfather every existing Google or Apple identity so the deploy locks
-- nobody out. The owner can revoke any of these with tools/sign-in-allowlist.ts.
INSERT INTO sign_in_allowlist (
  entry_id, label, invite_code_hash, invite_expires_at, provider,
  provider_subject, bound_at, created_at, revoked_at
)
SELECT lower(hex(randomblob(16))),
       'grandfathered ' || identity.provider || ' user',
       NULL, NULL, identity.provider, identity.provider_subject,
       CAST(strftime('%s', 'now') AS INTEGER),
       CAST(strftime('%s', 'now') AS INTEGER), NULL
FROM user_identities AS identity
JOIN users AS user ON user.id = identity.user_id
WHERE identity.provider IN ('google', 'apple')
  AND identity.provider_environment = ''
  AND user.deletion_pending_at IS NULL;
