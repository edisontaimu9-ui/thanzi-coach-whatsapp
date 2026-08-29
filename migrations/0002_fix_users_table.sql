-- A prior partial/stale state left `users` without the expected columns
-- (CREATE TABLE IF NOT EXISTS in 0001 silently no-op'd against it). No
-- analytics writes have succeeded yet, so it's safe to drop and recreate.
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS events;

CREATE TABLE users (
  whatsapp_id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_whatsapp_id ON events (whatsapp_id);
