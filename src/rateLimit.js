/**
 * Per-phone-number rate limiting, so one number can't burn the Groq/Chakudya quota.
 *
 * Fixed-window counters in D1 (migrations/0006_add_rate_limits.sql): every inbound message upserts
 * +1 into the sender's current per-minute and per-hour window and reads the new counts back in one
 * batch. Over a limit -> the message is dropped before any expensive work; the person gets ONE
 * polite notice per window (not a reply to every excess message, which would just be more spam).
 *
 * Fails OPEN: if D1 errors, the message is allowed through (a limiter outage must never silence the
 * bot). Defaults 10/minute and 100/hour; override with the RATE_LIMIT_PER_MINUTE /
 * RATE_LIMIT_PER_HOUR Worker variables (0 disables that window). ADMIN_PHONE is exempt.
 *
 * Pure of fetch/env, so it is unit-tested with a fake DB in test/rateLimit.test.js.
 */

export const DEFAULT_PER_MINUTE = 10;
export const DEFAULT_PER_HOUR = 100;
const MINUTE = 60;
const HOUR = 3600;

function intOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** { perMinute, perHour } from env; 0 means "no limit" for that window. */
export function getLimits(env = {}) {
  return {
    perMinute: intOr(env.RATE_LIMIT_PER_MINUTE, DEFAULT_PER_MINUTE),
    perHour: intOr(env.RATE_LIMIT_PER_HOUR, DEFAULT_PER_HOUR),
  };
}

/** Decides from the post-increment counts. notify is true only on the first message over the limit. */
export function evaluateCounts({ minuteCount, hourCount }, { perMinute, perHour }) {
  if (perMinute > 0 && minuteCount > perMinute) {
    return { limited: true, notify: minuteCount === perMinute + 1, scope: "minute" };
  }
  if (perHour > 0 && hourCount > perHour) {
    return { limited: true, notify: hourCount === perHour + 1, scope: "hour" };
  }
  return { limited: false, notify: false, scope: null };
}

const UPSERT_SQL =
  `INSERT INTO rate_limits (whatsapp_id, window_sec, window_start, count) VALUES (?1, ?2, ?3, 1)
   ON CONFLICT(whatsapp_id, window_sec, window_start) DO UPDATE SET count = count + 1
   RETURNING count`;

/**
 * Records one message from `whatsappId` and says whether it is over the limit.
 * Returns { limited, notify, scope }. Never throws (fails open).
 */
export async function checkRateLimit(db, whatsappId, limits, nowMs = Date.now()) {
  const open = { limited: false, notify: false, scope: null };
  if (!db || !whatsappId) return open;
  if (!(limits.perMinute > 0) && !(limits.perHour > 0)) return open;
  try {
    const nowSec = Math.floor(nowMs / 1000);
    const minuteStart = nowSec - (nowSec % MINUTE);
    const hourStart = nowSec - (nowSec % HOUR);
    const results = await db.batch([
      db.prepare(UPSERT_SQL).bind(whatsappId, MINUTE, minuteStart),
      db.prepare(UPSERT_SQL).bind(whatsappId, HOUR, hourStart),
    ]);
    const minuteCount = Number(results?.[0]?.results?.[0]?.count ?? 0);
    const hourCount = Number(results?.[1]?.results?.[0]?.count ?? 0);
    return evaluateCounts({ minuteCount, hourCount }, limits);
  } catch (err) {
    console.error("Rate limit check failed, allowing message:", err);
    return open;
  }
}

/** Deletes counters older than two hours (called from the daily cron). */
export async function pruneRateLimits(db, nowMs = Date.now()) {
  try {
    const cutoff = Math.floor(nowMs / 1000) - 2 * HOUR;
    await db.prepare(`DELETE FROM rate_limits WHERE window_start < ?1`).bind(cutoff).run();
  } catch (err) {
    console.error("Rate limit prune failed:", err);
  }
}

/** The one-time notice. `isChichewa` picks the language (see looksChichewa in ./fallbackReplies.js). */
export function buildRateLimitNotice(scope, isChichewa = false) {
  if (isChichewa) {
    return scope === "hour"
      ? "Mwafika pa malire a mauthenga pa ola limodzi. Chonde yesaninso patapita kanthawi. 🙏"
      : "Mukutumiza mauthenga mofulumira kwambiri 🙏 Chonde dikirani mphindi imodzi, kenako yesaninso.";
  }
  return scope === "hour"
    ? "You've reached the hourly message limit. Please try again in a little while. 🙏"
    : "You're sending messages very quickly 🙏 Please wait a minute, then try again.";
}
