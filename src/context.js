/**
 * Per-user follow-up context in D1 (last food discussed; last comparison / meal plan).
 *
 * Split out of src/index.js with no behaviour change.
 */



// How long a "last food discussed" context stays usable for a bare
// follow-up like "50g" before we consider the conversation to have moved
// on. Keeps a stale context from a food discussed hours ago from
// hijacking an unrelated later message.
const LAST_FOOD_CONTEXT_TTL_MS = 20 * 60 * 1000;

// 20 minutes

export async function saveLastFoodContext(whatsappId, context, env) {
  if (!context) return;
  try {
    await env.DB.prepare(
      `INSERT INTO last_food_context (whatsapp_id, food_json, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(whatsapp_id) DO UPDATE SET
         food_json = ?2,
         updated_at = ?3`
    )
      .bind(whatsappId, JSON.stringify(context), new Date().toISOString())
      .run();
  } catch (err) {
    console.error("Failed to save last food context:", err);
  }
}

export async function getLastFoodContext(whatsappId, env) {
  try {
    const row = await env.DB.prepare(
      `SELECT food_json, updated_at FROM last_food_context WHERE whatsapp_id = ?1`
    )
      .bind(whatsappId)
      .first();
    if (!row) return null;
    const age = Date.now() - new Date(row.updated_at).getTime();
    if (age > LAST_FOOD_CONTEXT_TTL_MS) return null;
    return JSON.parse(row.food_json);
  } catch (err) {
    console.error("Failed to load last food context:", err);
    return null;
  }
}

// Generic version of the above for follow-ups that reference something
// richer than one food's macros — a whole comparison, or a whole meal
// plan (see last_session_context in migrations/0005). Keyed by
// (whatsapp_id, kind) so a user can have both a live comparison and a live
// meal-plan context at once without either evicting the other. Longer TTL
// than the bare-gram-followup food context (LAST_FOOD_CONTEXT_TTL_MS,
// 20 min) — refining a meal plan ("swap the egg for beans") is a slower,
// more deliberate flow than a quick gram-amount follow-up, so give it more
// room before treating the conversation as having moved on.
const LAST_SESSION_CONTEXT_TTL_MS = 60 * 60 * 1000;

// 60 minutes

export async function saveLastSessionContext(whatsappId, kind, payload, env) {
  if (!payload) return;
  try {
    await env.DB.prepare(
      `INSERT INTO last_session_context (whatsapp_id, kind, payload_json, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(whatsapp_id, kind) DO UPDATE SET
         payload_json = ?3,
         updated_at = ?4`
    )
      .bind(whatsappId, kind, JSON.stringify(payload), new Date().toISOString())
      .run();
  } catch (err) {
    console.error(`Failed to save last session context (${kind}):`, err);
  }
}

export async function getLastSessionContext(whatsappId, kind, env) {
  try {
    const row = await env.DB.prepare(
      `SELECT payload_json, updated_at FROM last_session_context WHERE whatsapp_id = ?1 AND kind = ?2`
    )
      .bind(whatsappId, kind)
      .first();
    if (!row) return null;
    const age = Date.now() - new Date(row.updated_at).getTime();
    if (age > LAST_SESSION_CONTEXT_TTL_MS) return null;
    return JSON.parse(row.payload_json);
  } catch (err) {
    console.error(`Failed to load last session context (${kind}):`, err);
    return null;
  }
}
