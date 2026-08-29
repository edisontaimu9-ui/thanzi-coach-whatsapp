-- Unique-user tracking. whatsapp_id is the sender's WhatsApp number.
CREATE TABLE IF NOT EXISTS users (
  whatsapp_id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);

-- One row per inbound message, for period-based counts ("messages this
-- month") that a single last_seen timestamp per user can't answer.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_whatsapp_id ON events (whatsapp_id);
