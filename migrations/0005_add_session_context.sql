-- Generic "what were we just doing" context for follow-up requests that
-- aren't about a single food's macros (see last_food_context for that
-- narrower, already-existing case). One row per user; `kind` discriminates
-- what's stored:
--   'comparison' — the food names from the last /foods/compare request, so
--                  "compare it with X" can add X to that same list instead
--                  of starting the comparison over from scratch.
--   'meal_plan'  — the meals/items/demographics from the last generated
--                  meal plan, so "swap the egg for beans" can edit it in
--                  place (re-resolving just the changed item against the
--                  Chakudya registry) instead of regenerating the whole
--                  plan via Groq again.
CREATE TABLE IF NOT EXISTS last_session_context (
  whatsapp_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (whatsapp_id, kind)
);
