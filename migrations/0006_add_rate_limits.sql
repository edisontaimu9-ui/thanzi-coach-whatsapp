-- Per-phone-number message counters for rate limiting (see src/rateLimit.js). One row per
-- (sender, window size, window start); each inbound message upserts +1 into its current
-- per-minute and per-hour windows. Old windows are pruned by the daily cron (scheduled()).
CREATE TABLE IF NOT EXISTS rate_limits (
  whatsapp_id TEXT NOT NULL,
  window_sec INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (whatsapp_id, window_sec, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start ON rate_limits (window_start);
