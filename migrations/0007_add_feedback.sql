-- 👍/👎 feedback on answers (see src/feedback.js). A row is created when the "Was this helpful?"
-- buttons are sent (rating NULL) and filled in when the person taps one. The button ids carry the
-- row id, so a tap maps straight back to the question/answer it was about. question/answer are
-- stored truncated, and rows are pruned after 90 days by the daily cron.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  rating TEXT,
  rated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_feedback_whatsapp_ts ON feedback (whatsapp_id, ts);
CREATE INDEX IF NOT EXISTS idx_feedback_ts ON feedback (ts);
