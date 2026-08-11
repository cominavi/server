-- Circle.ms encodes event-wide genres with day 0. Normalize those rows to
-- NULL so they retain their meaning without inventing a catalog date.

PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE catalog_genres_v2 (
  version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL,
  code INTEGER,
  day INTEGER,
  name TEXT NOT NULL,
  PRIMARY KEY (version_id, genre_id),
  CHECK (day IS NULL OR day > 0),
  FOREIGN KEY (version_id, day)
    REFERENCES catalog_dates(version_id, day)
) STRICT, WITHOUT ROWID;

INSERT INTO catalog_genres_v2 (version_id, genre_id, code, day, name)
SELECT version_id, genre_id, code, NULLIF(day, 0), name
FROM catalog_genres;

DROP TABLE catalog_genres;
ALTER TABLE catalog_genres_v2 RENAME TO catalog_genres;

PRAGMA foreign_key_check;
