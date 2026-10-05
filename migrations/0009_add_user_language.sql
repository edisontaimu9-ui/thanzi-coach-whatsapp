-- Remembered reply language per WhatsApp number (see src/language.js): 'en' or 'ny' (Chichewa).
-- locked = 1 when the person chose it explicitly ("English" / "Chichewa"); en_streak counts
-- consecutive clearly-English messages from a Chichewa user so one English message doesn't flip it.
CREATE TABLE IF NOT EXISTS user_language (
  whatsapp_id TEXT PRIMARY KEY,
  language TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  en_streak INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
