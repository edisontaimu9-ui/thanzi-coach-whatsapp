-- Voice-reply mode per WhatsApp number (see src/voice.js): 'auto' (voice note in -> voice note out,
-- the default when no row exists), 'on' (always) or 'off' (never). Set by the person sending
-- "voice on" / "voice off" / "voice auto".
CREATE TABLE IF NOT EXISTS user_voice (
  whatsapp_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
