PRAGMA foreign_keys = ON;

-- Test identity provider (data-layering proposal §7, phase N1).
-- Maps an agent-chosen label to one ComiNavi user on staging and local dev.
-- Additive only. `user_identities.provider` keeps its production CHECK
-- ('circlems', 'google', 'apple'): widening it would rebuild that table, so
-- test identities live here instead. Production never writes this table:
-- the route is compiled out of production builds and refused at runtime when
-- ENVIRONMENT is not an explicit non-production value. Reversible by
-- DROP TABLE while empty.

CREATE TABLE test_identities (
  label TEXT PRIMARY KEY CHECK (
    length(label) BETWEEN 1 AND 64 AND label NOT GLOB '*[^a-z0-9-]*'
    AND substr(label, 1, 1) GLOB '[a-z0-9]'
  ),
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_authenticated_at INTEGER NOT NULL
) STRICT;
