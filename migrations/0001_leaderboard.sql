CREATE TABLE IF NOT EXISTS leaderboard_runs (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leaderboard_runs_expiry ON leaderboard_runs (expires_at);
CREATE TABLE IF NOT EXISTS leaderboard_scores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('solo', 'team')),
  cleared INTEGER NOT NULL CHECK (cleared BETWEEN 1 AND 5),
  elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leaderboard_scores_order ON leaderboard_scores (kind, cleared DESC, elapsed_ms, updated_at);
