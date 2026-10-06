/**
 * Usage by topic: which parts of the bot people actually use.
 *
 * handleTextMessage (src/index.js) sets a topic key on a small tracker as it routes each message;
 * when the message is done, one row (timestamp + topic, nothing else) is written to topic_events
 * (migrations/0010_add_topic_events.sql). The dashboard's "What people ask about" card and the admin
 * "stats" command read the aggregate counts.
 *
 * Best-effort like the other analytics: no database means nothing is recorded, never an error shown.
 * Pure helpers + D1 calls that never throw; tests in test/topics.test.js.
 */

export const TOPIC_LABELS = Object.freeze({
  qa: "Nutrition Q&A",
  food_lookup: "Food lookup",
  food_compare: "Compare foods",
  substitutes: "Substitutes",
  drug_interactions: "Drug interactions",
  nutrition_label: "Nutrition label",
  dri: "Daily requirements",
  energy: "Energy needs",
  meal_plan: "Meal plans",
  screening: "Malnutrition screening",
  calculator: "Calculators",
  barcode: "Barcode",
  menu: "Menu & help",
  admin: "Admin",
  language: "Language",
  other: "Other",
});

const RETENTION_DAYS = 90;

/** Unknown or missing keys become "other" so the table only ever holds known topics. */
export function normalizeTopic(topic) {
  return Object.prototype.hasOwnProperty.call(TOPIC_LABELS, topic) ? topic : "other";
}

/** Writes one row. Never throws. */
export async function recordTopic(db, topic, nowMs = Date.now()) {
  if (!db) return;
  try {
    await db
      .prepare(`INSERT INTO topic_events (ts, topic) VALUES (?1, ?2)`)
      .bind(new Date(nowMs).toISOString(), normalizeTopic(topic))
      .run();
  } catch (err) {
    console.error("Topic record failed:", err);
  }
}

/** [{ topic, label, n }] over the last `days`, biggest first; [] on any error (e.g. not migrated yet). */
export async function topicCounts(db, days = 30, nowMs = Date.now()) {
  try {
    const since = new Date(nowMs - days * 86400000).toISOString();
    const res = await db
      .prepare(`SELECT topic, COUNT(*) AS n FROM topic_events WHERE ts >= ?1 GROUP BY topic ORDER BY n DESC`)
      .bind(since)
      .all();
    return (res?.results || []).map((r) => ({
      topic: normalizeTopic(r.topic),
      label: TOPIC_LABELS[normalizeTopic(r.topic)],
      n: Number(r.n) || 0,
    }));
  } catch (err) {
    console.error("Topic counts failed:", err);
    return [];
  }
}

/** Deletes rows older than the retention window (daily cron). */
export async function pruneTopics(db, nowMs = Date.now()) {
  try {
    const cutoff = new Date(nowMs - RETENTION_DAYS * 86400000).toISOString();
    await db.prepare(`DELETE FROM topic_events WHERE ts < ?1`).bind(cutoff).run();
  } catch (err) {
    console.error("Topic prune failed:", err);
  }
}
