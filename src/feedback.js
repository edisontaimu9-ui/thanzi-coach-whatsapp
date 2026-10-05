/**
 * 👍/👎 "Was this helpful?" buttons after nutrition-search answers.
 *
 * Flow: after a real answer, a short follow-up message with two reply buttons is sent. A D1 row
 * (migrations/0007_add_feedback.sql) is created first and its id is carried in the button ids
 * ("fb:up:42" / "fb:down:42"), so a tap maps back to the exact question and answer. The admin
 * daily summary shows the counts and the latest 👎 questions, so you can see what to fix.
 *
 * Optional feature, so everything here is best-effort: any database problem means "don't ask" or
 * "don't record", never an error shown to the person. A per-person cooldown keeps it from nagging
 * during a rapid-fire Q&A.
 *
 * No fetch/env here (the WhatsApp send lives in src/index.js); unit-tested with a fake DB in
 * test/feedback.test.js.
 */

export const FEEDBACK_COOLDOWN_MS = 3 * 60 * 1000;
export const FEEDBACK_RETENTION_DAYS = 90;
const MIN_ANSWER_CHARS = 120; // don't ask about one-liners
const MAX_QUESTION_CHARS = 200;
const MAX_ANSWER_CHARS = 300;

/** Button id for a rating on feedback row `id`. */
export function buildFeedbackId(rating, id) {
  return `fb:${rating === "up" ? "up" : "down"}:${id}`;
}

/** Parses "fb:up:42" -> { rating: "up", id: 42 }; anything else -> null. */
export function parseFeedbackId(raw) {
  const m = /^fb:(up|down):(\d{1,12})$/.exec(String(raw || ""));
  return m ? { rating: m[1], id: Number(m[2]) } : null;
}

/** Only substantive answers are worth asking about. */
export function shouldAskFeedback(answer) {
  return typeof answer === "string" && answer.trim().length >= MIN_ANSWER_CHARS;
}

/** { body, buttons: [{id, title}, ...] } for the follow-up message (titles are <= 20 chars). */
export function buildFeedbackPrompt(feedbackId, isChichewa = false) {
  return isChichewa
    ? {
        body: "Kodi yankho ili linakuthandizani?",
        buttons: [
          { id: buildFeedbackId("up", feedbackId), title: "👍 Zandithandiza" },
          { id: buildFeedbackId("down", feedbackId), title: "👎 Sizandithandiza" },
        ],
      }
    : {
        body: "Was this answer helpful?",
        buttons: [
          { id: buildFeedbackId("up", feedbackId), title: "👍 Helpful" },
          { id: buildFeedbackId("down", feedbackId), title: "👎 Not helpful" },
        ],
      };
}

/** The reply after a tap. */
export function buildFeedbackThanks(rating, isChichewa = false) {
  if (rating === "up") {
    return isChichewa ? "Zikomo! 🙏 Ndikusangalala kuti zakuthandizani." : "Thanks for the feedback! 🙏 Glad it helped.";
  }
  return isChichewa
    ? "Zikomo, pepani kuti sizinakuthandizeni. Yesaninso kufunsa m'njira ina, kapena lembani *menu*. 🙏"
    : "Thanks, and sorry that wasn't helpful. Try asking it another way, or type *menu* for options. 🙏";
}

/**
 * Creates the feedback row and returns its id, or null when we should not ask (cooldown active,
 * no database, or any error).
 */
export async function createFeedbackPrompt(db, { whatsappId, question, answer, nowMs = Date.now() }) {
  if (!db || !whatsappId) return null;
  try {
    const since = new Date(nowMs - FEEDBACK_COOLDOWN_MS).toISOString();
    const recent = await db
      .prepare(`SELECT COUNT(*) AS n FROM feedback WHERE whatsapp_id = ?1 AND ts >= ?2`)
      .bind(whatsappId, since)
      .first("n");
    if (Number(recent) > 0) return null;
    const res = await db
      .prepare(`INSERT INTO feedback (whatsapp_id, ts, question, answer) VALUES (?1, ?2, ?3, ?4)`)
      .bind(
        whatsappId,
        new Date(nowMs).toISOString(),
        String(question || "").slice(0, MAX_QUESTION_CHARS),
        String(answer || "").slice(0, MAX_ANSWER_CHARS)
      )
      .run();
    const id = Number(res?.meta?.last_row_id);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch (err) {
    console.error("Feedback prompt create failed:", err);
    return null;
  }
}

/**
 * Records a tap. True only if it was this person's own, still-unrated row, so a repeated tap or a
 * forged id for someone else's row changes nothing.
 */
export async function recordFeedback(db, { id, whatsappId, rating, nowMs = Date.now() }) {
  if (!db || !whatsappId || !Number.isFinite(id)) return false;
  try {
    const res = await db
      .prepare(`UPDATE feedback SET rating = ?1, rated_at = ?2 WHERE id = ?3 AND whatsapp_id = ?4 AND rating IS NULL`)
      .bind(rating, new Date(nowMs).toISOString(), id, whatsappId)
      .run();
    return Number(res?.meta?.changes) > 0;
  } catch (err) {
    console.error("Feedback record failed:", err);
    return false;
  }
}

/** { up, down, recentDown: [question, ...] } for the last 24h, or null on error. */
export async function feedbackSummary(db, nowMs = Date.now()) {
  try {
    const since = new Date(nowMs - 24 * 3600 * 1000).toISOString();
    const counts = await db
      .prepare(`SELECT rating, COUNT(*) AS n FROM feedback WHERE rating IS NOT NULL AND rated_at >= ?1 GROUP BY rating`)
      .bind(since)
      .all();
    const downs = await db
      .prepare(`SELECT question FROM feedback WHERE rating = 'down' AND rated_at >= ?1 ORDER BY rated_at DESC LIMIT 3`)
      .bind(since)
      .all();
    const byRating = Object.fromEntries((counts?.results || []).map((r) => [r.rating, Number(r.n)]));
    return {
      up: byRating.up || 0,
      down: byRating.down || 0,
      recentDown: (downs?.results || []).map((r) => String(r.question)),
    };
  } catch (err) {
    console.error("Feedback summary failed:", err);
    return null;
  }
}

/** Deletes feedback older than the retention window (daily cron). */
export async function pruneFeedback(db, nowMs = Date.now()) {
  try {
    const cutoff = new Date(nowMs - FEEDBACK_RETENTION_DAYS * 86400 * 1000).toISOString();
    await db.prepare(`DELETE FROM feedback WHERE ts < ?1`).bind(cutoff).run();
  } catch (err) {
    console.error("Feedback prune failed:", err);
  }
}
