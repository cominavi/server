CREATE TABLE following_imports (
  subject TEXT PRIMARY KEY NOT NULL,
  twitter_username TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('fetching', 'ready', 'failed')),
  lease_id TEXT,
  attempted_at INTEGER NOT NULL,
  next_allowed_at INTEGER NOT NULL,
  successful_at INTEGER,
  snapshot_key TEXT,
  following_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX following_imports_next_allowed_at
  ON following_imports (next_allowed_at);
