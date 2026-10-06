/**
 * 👍/👎 "Was this helpful?" buttons after nutrition-search answers.
 *
 * Flow: after a real answer, a short follow-up message with two reply buttons is sent. A D1 row
 * (migrations/0007_add_feedback.sql) is created first and its id is carried in the button ids
 * ("fb:up:42" / "fb:down:42"), so a tap maps back to the exact question and answer. The admin
 * daily summary shows the counts and the latest 👎 questions, so you can see what to fix.
 *
 * Optional feature, so everything here is best-effort: any database problem means "don't ask" or
 * "don't record", never an error shown to the person. Every answer gets the buttons; an optional
 * per-person cooldown (createFeedbackPrompt's cooldownMs) can thin them out.
 *
 * No fetch/env here (the WhatsApp send lives in src/index.js); unit-tested with a fake DB in
 * test/feedback.test.js.
 */

export const FEEDBACK_COOLDOWN_MS = 3 * 60 * 1000;
export const FEEDBACK_RETENTION_DAYS = 30;
const MIN_ANSWER_CHARS = 40; // skip trivial one-liners; everything else gets the action buttons
const MAX_QUESTION_CHARS = 200;
const MAX_SOURCES_CHARS = 800;
const MAX_ANSWER_CHARS = 1500; // enough for the 📤 Share excerpt (see buildShareText)

const ACTIONS = ["up", "down", "share", "details"];

/** Button id for an action ("up" | "down" | "share" | "details") on feedback row `id`. */
export function buildFeedbackId(action, id) {
  return `fb:${ACTIONS.includes(action) ? action : "down"}:${id}`;
}

/** Parses "fb:up:42" -> { rating: "up", id: 42 } ("rating" may also be "share" or "details"); else null. */
export function parseFeedbackId(raw) {
  const m = /^fb:(up|down|share|details):(\d{1,12})$/.exec(String(raw || ""));
  return m ? { rating: m[1], id: Number(m[2]) } : null;
}

/**
 * Splits an answer into the readable body and its hidden "References" block.
 * askChakudya appends "\n\n_References:_\n[1] ..." (see renumberCitations in src/index.js).
 * Returns { main, references }; references is "" when there is none.
 */
export function splitReferences(answer) {
  const text = String(answer || "");
  const m = /\n+[ \t]*_*\*?references?:?\*?_*[ \t]*\n([\s\S]+)$/i.exec(text);
  if (!m) return { main: text.trim(), references: "" };
  return { main: text.slice(0, m.index).trim(), references: m[1].trim() };
}

/** Only substantive answers are worth asking about. */
export function shouldAskFeedback(answer) {
  return typeof answer === "string" && answer.trim().length >= MIN_ANSWER_CHARS;
}

/**
 * { body, buttons: [{id, title}, ...] } for the follow-up message (titles are <= 20 chars, max 3).
 * With hidden sources the first button is 📚 See details; otherwise the third is 📤 Share.
 */
export function buildFeedbackPrompt(feedbackId, isChichewa = false, hasDetails = false) {
  const up = { id: buildFeedbackId("up", feedbackId), title: isChichewa ? "👍 Zandithandiza" : "👍 Helpful" };
  const down = { id: buildFeedbackId("down", feedbackId), title: isChichewa ? "👎 Sizandithandiza" : "👎 Not helpful" };
  const body = isChichewa ? "Kodi yankho ili linakuthandizani?" : "Was this answer helpful?";
  if (hasDetails) {
    const details = { id: buildFeedbackId("details", feedbackId), title: isChichewa ? "📚 Onani zambiri" : "📚 See details" };
    return { body, buttons: [details, up, down] };
  }
  const share = { id: buildFeedbackId("share", feedbackId), title: isChichewa ? "📤 Gawirani" : "📤 Share" };
  return { body, buttons: [up, down, share] };
}

// ── 📤 Share ──
// WhatsApp gives bots no native "share" icon, so the third button replies with a link button that
// opens WhatsApp's own chat picker (wa.me/?text=...) with the answer already written in.
const MAX_SHARE_CHARS = 1200;
const SHARE_SIZES = [MAX_SHARE_CHARS, 1000, 800, 650, 500, 400, 300];
const MAX_SHARE_URL_CHARS = 1900; // WhatsApp caps CTA URLs at 2000

// A short line with no closing punctuation and no bullet ("Typical Malawi DASH servings") is a heading.
function isHeadingLine(line) {
  const l = line.trim();
  return l.length > 0 && l.length < 70 && !/^[•\-*\d]/.test(l) && !/[.!?:)”"]$/.test(l);
}

/**
 * Clean, forwardable excerpt of an answer: no [1] citations or References block. Short answers are
 * shared whole. Longer ones are cut at the last paragraph break (else the last line / sentence / word)
 * that fits `maxChars`, never leaving a heading hanging at the end, and marked as an excerpt.
 */
export function buildShareText(answer, botNumber, maxChars = MAX_SHARE_CHARS) {
  let t = String(answer || "")
    .split(/\n\s*references?\s*:/i)[0]
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  let truncated = false;
  if (t.length > maxChars) {
    truncated = true;
    const cut = t.slice(0, maxChars);
    const floor = maxChars * 0.4;
    const para = cut.lastIndexOf("\n\n");
    const line = cut.lastIndexOf("\n");
    const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (para > floor) t = cut.slice(0, para);
    else if (line > floor) t = cut.slice(0, line);
    else if (sentence > floor) t = cut.slice(0, sentence + 1);
    else t = cut.slice(0, Math.max(cut.lastIndexOf(" "), 1));
    t = t.trim();
    // Never end on a dangling heading: drop trailing heading lines (keep at least the first paragraph).
    let lines = t.split("\n");
    while (lines.length > 1 && (lines[lines.length - 1].trim() === "" || isHeadingLine(lines[lines.length - 1]))) lines.pop();
    t = lines.join("\n").trim();
  }
  const digits = String(botNumber || "").replace(/\D/g, "");
  const link = digits ? ` (https://wa.me/${digits})` : "";
  const signature = truncated ? `\n\n…\n— More in Thanzi Coach${link}` : `\n\n— Thanzi Coach${link}`;
  return t + signature;
}

/** https://wa.me/?text=... guaranteed under the CTA URL limit (shrinks the text if needed). */
export function buildShareUrl(text) {
  let t = String(text || "");
  let url = `https://wa.me/?text=${encodeURIComponent(t)}`;
  while (url.length > MAX_SHARE_URL_CHARS && t.length > 20) {
    t = t.slice(0, Math.floor(t.length * 0.85)).trimEnd() + "…";
    url = `https://wa.me/?text=${encodeURIComponent(t)}`;
  }
  return url;
}

/**
 * The share link for an answer: the longest excerpt (down to 300 chars) whose encoded URL fits the
 * limit, always cut cleanly by buildShareText. Use this instead of buildShareUrl(buildShareText(..)).
 */
export function buildShareLink(answer, botNumber) {
  for (const size of SHARE_SIZES) {
    const url = `https://wa.me/?text=${encodeURIComponent(buildShareText(answer, botNumber, size))}`;
    if (url.length <= MAX_SHARE_URL_CHARS) return url;
  }
  return buildShareUrl(buildShareText(answer, botNumber, SHARE_SIZES[SHARE_SIZES.length - 1]));
}

/** { body, displayText } for the link-button message sent when 📤 Share is tapped. */
export function buildShareMessage(isChichewa = false) {
  return isChichewa
    ? { body: "Dinani pansipa kuti musankhe munthu woti mum'gawire yankho ili.", displayText: "📤 Gawirani yankho" }
    : { body: "Tap below to pick a chat and share this answer.", displayText: "📤 Share answer" };
}

/** { body, displayText } for the 📚 See details reply: the sources, plus a 📤 Share link button. */
export function buildDetailsMessage(sources, isChichewa = false) {
  const head = isChichewa ? "📚 *Magwero*" : "📚 *Sources*";
  const hint = isChichewa ? "Dinani pansipa kuti mugawire yankho ili." : "Tap below to share this answer.";
  const room = 1024 - head.length - hint.length - 6;
  const src = String(sources || "").slice(0, Math.max(0, room)).trim();
  return {
    body: `${head}\n${src}\n\n${hint}`,
    displayText: isChichewa ? "📤 Gawirani yankho" : "📤 Share answer",
  };
}

/** The stored answer text for feedback row `id`, only if it belongs to `whatsappId`; else null. */
export async function getAnswerForShare(db, { id, whatsappId }) {
  if (!db || !whatsappId || !Number.isFinite(id)) return null;
  try {
    const row = await db
      .prepare(`SELECT answer, question, sources FROM feedback WHERE id = ?1 AND whatsapp_id = ?2`)
      .bind(id, whatsappId)
      .first();
    return row?.answer
      ? { answer: String(row.answer), question: String(row.question || ""), sources: String(row.sources || "") }
      : null;
  } catch (err) {
    console.error("Feedback share lookup failed:", err);
    return null;
  }
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
 * Creates the feedback row and returns its id, or null on any error. `cooldownMs` (default 0 = every
 * answer gets buttons) can rate-limit prompts per person; `sources` is the hidden References text
 * for the 📚 See details button.
 */
export async function createFeedbackPrompt(db, { whatsappId, question, answer, sources = "", nowMs = Date.now(), cooldownMs = 0 }) {
  if (!db || !whatsappId) return null;
  try {
    if (cooldownMs > 0) {
      const since = new Date(nowMs - cooldownMs).toISOString();
      const recent = await db
        .prepare(`SELECT COUNT(*) AS n FROM feedback WHERE whatsapp_id = ?1 AND ts >= ?2`)
        .bind(whatsappId, since)
        .first("n");
      if (Number(recent) > 0) return null;
    }
    const res = await db
      .prepare(`INSERT INTO feedback (whatsapp_id, ts, question, answer, sources) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(
        whatsappId,
        new Date(nowMs).toISOString(),
        String(question || "").slice(0, MAX_QUESTION_CHARS),
        String(answer || "").slice(0, MAX_ANSWER_CHARS),
        String(sources || "").slice(0, MAX_SOURCES_CHARS)
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

/** { up, down } rated counts over the last `days` (zeros on any error, e.g. table not migrated yet). */
export async function feedbackCounts(db, days = 30, nowMs = Date.now()) {
  try {
    const since = new Date(nowMs - days * 86400 * 1000).toISOString();
    const counts = await db
      .prepare(`SELECT rating, COUNT(*) AS n FROM feedback WHERE rating IS NOT NULL AND rated_at >= ?1 GROUP BY rating`)
      .bind(since)
      .all();
    const by = Object.fromEntries((counts?.results || []).map((r) => [r.rating, Number(r.n)]));
    return { up: by.up || 0, down: by.down || 0 };
  } catch (err) {
    console.error("Feedback counts failed:", err);
    return { up: 0, down: 0 };
  }
}

/**
 * Recent rated feedback for the dashboard: [{ id, rated_at, rating, question, answer }], newest
 * first. `rating` is "down" (default), "up", or "all". No phone numbers are ever included.
 * Returns null on error.
 */
export async function listFeedback(db, { days = 30, rating = "down", limit = 50, nowMs = Date.now() } = {}) {
  try {
    const since = new Date(nowMs - days * 86400 * 1000).toISOString();
    const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const filtered = rating === "up" || rating === "down";
    const stmt = filtered
      ? db
          .prepare(
            `SELECT id, rated_at, rating, question, answer FROM feedback
             WHERE rating IS NOT NULL AND rated_at >= ?1 AND rating = ?2
             ORDER BY rated_at DESC LIMIT ?3`
          )
          .bind(since, rating, max)
      : db
          .prepare(
            `SELECT id, rated_at, rating, question, answer FROM feedback
             WHERE rating IS NOT NULL AND rated_at >= ?1
             ORDER BY rated_at DESC LIMIT ?2`
          )
          .bind(since, max);
    const res = await stmt.all();
    return (res?.results || []).map((r) => ({
      id: Number(r.id),
      rated_at: String(r.rated_at),
      rating: String(r.rating),
      question: String(r.question || ""),
      answer: String(r.answer || "").slice(0, 300),
    }));
  } catch (err) {
    console.error("Feedback list failed:", err);
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
