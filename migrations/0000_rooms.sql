CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rooms_expires_at ON rooms (expires_at);
