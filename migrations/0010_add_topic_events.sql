-- What people ask the bot about (see src/topics.js): one row per handled text message with a coarse,
-- fixed topic key ("qa", "food_lookup", "screening", ...). Deliberately NO phone number and NO
-- message text, so it is safe to aggregate on the dashboard. Pruned after 90 days by the daily cron.
CREATE TABLE IF NOT EXISTS topic_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  topic TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topic_events_ts ON topic_events (ts);
