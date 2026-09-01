-- Per-user "what food were we just talking about" context, keyed by
-- WhatsApp number. Lets a bare follow-up like "Calculate for 50g serving"
-- (see detectServingOnly in src/index.js) recompute against the SAME food
-- and reference amount with real arithmetic, instead of re-asking
-- Chakudya's /rag/ask — whose session-based memory can silently pick a
-- different reference amount for the same food between calls, giving
-- inconsistent answers to what the user experiences as the same request.
CREATE TABLE IF NOT EXISTS last_food_context (
  whatsapp_id TEXT PRIMARY KEY,
  food_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
