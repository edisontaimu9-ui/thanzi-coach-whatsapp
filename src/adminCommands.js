/**
 * Admin commands over WhatsApp, for the number in ADMIN_PHONE only (checked in src/index.js; the
 * webhook signature check means that sender can't be spoofed):
 *
 *   stats            last 24 hours          stats 7 / stats week     last 7 days
 *   stats today      last 24 hours          stats 30 / stats month   last 30 days (max 90)
 *   feedback         latest 👎 questions, last 7 days   (feedback 30 for a longer window)
 *   admin            lists these commands
 *
 * Same numbers as the dashboard's /stats endpoint plus the message mix, replied to the admin as one
 * WhatsApp message. Pure parsing/formatting plus D1 reads that never throw; tests in
 * test/adminCommands.test.js.
 */

import { feedbackCounts, listFeedback } from "./feedback.js";

const MAX_DAYS = 90;

function clampDays(n, fallback) {
  const d = Number.parseInt(n, 10);
  return Number.isFinite(d) && d >= 1 ? Math.min(d, MAX_DAYS) : fallback;
}

/** { type: "stats"|"feedback"|"help", days? } or null when the message isn't an admin command. */
export function parseAdminCommand(text) {
  const t = String(text || "").trim().toLowerCase().replace(/[!?.,;:]+$/g, "").replace(/\s+/g, " ");
  if (/^(?:admin|admin help|commands)$/.test(t)) return { type: "help" };
  let m = /^stats(?:\s+(today|day|week|month|\d{1,3})\s*d?(?:ays?)?)?$/.exec(t);
  if (m) {
    const arg = m[1];
    const days = !arg || arg === "today" || arg === "day" ? 1 : arg === "week" ? 7 : arg === "month" ? 30 : clampDays(arg, 1);
    return { type: "stats", days };
  }
  m = /^feedback(?:\s+(week|month|\d{1,3})\s*d?(?:ays?)?)?$/.exec(t);
  if (m) {
    const arg = m[1];
    const days = !arg || arg === "week" ? 7 : arg === "month" ? 30 : clampDays(arg, 7);
    return { type: "feedback", days };
  }
  return null;
}

export const ADMIN_HELP_TEXT =
  "🛠 *Admin commands*\n" +
  "• *stats* — last 24 hours\n" +
  "• *stats 7* / *stats week* — last 7 days\n" +
  "• *stats 30* / *stats month* — last 30 days\n" +
  "• *feedback* — latest 👎 questions (7 days)\n" +
  "• *feedback 30* — longer window";

function label(days) {
  return days === 1 ? "last 24 hours" : `last ${days} days`;
}

/** The stats message. `s` is the object from getAdminStats. */
export function buildStatsText(days, s) {
  const lines = [`📊 *Thanzi Coach — ${label(days)}*`];
  lines.push(`Users: ${s.totalUsers} total · ${s.newUsers} new · ${s.activeUsers} active`);
  const rate = s.messages > 0 ? ` (${((s.errors / s.messages) * 100).toFixed(1)}%)` : "";
  lines.push(`Messages: ${s.messages}`);
  lines.push(s.errors > 0 ? `⚠️ Errors: ${s.errors}${rate}` : "Errors: 0 ✅");
  if (s.byType.length) lines.push("Mix: " + s.byType.map((t) => `${t.type} ${t.n}`).join(" · "));
  const total = s.up + s.down;
  if (total > 0) lines.push(`Feedback: 👍 ${s.up} · 👎 ${s.down} (${Math.round((s.up / total) * 100)}% helpful)`);
  return lines.join("\n");
}

/** The latest 👎 questions as a message. `items` from listFeedback (or null on error). */
export function buildFeedbackText(days, items) {
  if (items === null) return "Couldn't read feedback right now. Try again in a moment.";
  if (items.length === 0) return `No 👎 in the ${label(days)}. 🎉`;
  const lines = [`👎 *Latest not-helpful — ${label(days)}*`];
  for (const it of items) {
    const q = it.question.replace(/\s+/g, " ").trim();
    lines.push(`• “${q.length > 100 ? q.slice(0, 97) + "…" : q}”`);
  }
  return lines.join("\n");
}

/** Reads the numbers for a stats message. Returns null on any database error. */
export async function getAdminStats(db, days, nowMs = Date.now()) {
  try {
    const cutoff = new Date(nowMs - days * 86400000).toISOString();
    const [totalUsers, newUsers, activeUsers, messages, errors, byType] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n FROM users`).first("n"),
      db.prepare(`SELECT COUNT(*) AS n FROM users WHERE first_seen >= ?1`).bind(cutoff).first("n"),
      db.prepare(`SELECT COUNT(*) AS n FROM users WHERE last_seen >= ?1`).bind(cutoff).first("n"),
      db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ts >= ?1 AND type != 'error'`).bind(cutoff).first("n"),
      db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ts >= ?1 AND type = 'error'`).bind(cutoff).first("n"),
      db
        .prepare(`SELECT type, COUNT(*) AS n FROM events WHERE ts >= ?1 AND type != 'error' GROUP BY type ORDER BY n DESC LIMIT 5`)
        .bind(cutoff)
        .all(),
    ]);
    const fb = await feedbackCounts(db, days, nowMs);
    return {
      totalUsers: Number(totalUsers) || 0,
      newUsers: Number(newUsers) || 0,
      activeUsers: Number(activeUsers) || 0,
      messages: Number(messages) || 0,
      errors: Number(errors) || 0,
      byType: (byType?.results || []).map((r) => ({ type: String(r.type), n: Number(r.n) })),
      up: fb.up,
      down: fb.down,
    };
  } catch (err) {
    console.error("Admin stats failed:", err);
    return null;
  }
}

/** Runs a parsed command and returns the reply text. */
export async function runAdminCommand(cmd, db) {
  if (cmd.type === "help") return ADMIN_HELP_TEXT;
  if (cmd.type === "feedback") {
    return buildFeedbackText(cmd.days, await listFeedback(db, { days: cmd.days, rating: "down", limit: 5 }));
  }
  const stats = await getAdminStats(db, cmd.days);
  return stats ? buildStatsText(cmd.days, stats) : "Couldn't read stats right now. Try again in a moment.";
}
