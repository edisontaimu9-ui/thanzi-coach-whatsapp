/**
 * D1 analytics (activity, errors, dedupe), the daily admin summary, and the /stats endpoints.
 *
 * Split out of src/index.js with no behaviour change.
 */

import { topicCounts } from "./topics.js";
import { feedbackCounts, feedbackSummary, listFeedback } from "./feedback.js";
import { sendWhatsAppReply } from "./whatsapp.js";

// --- Webhook idempotency (D1) ---
// INSERT OR IGNORE on message_id (the WhatsApp wamid): if the row already
// existed, D1 reports 0 changed rows, which is how a redelivery is told
// apart from a first delivery. Fails open — if the D1 write itself errors,
// treat the message as new rather than silently dropping a real reply.
export async function isDuplicateMessage(messageId, env) {
  if (!messageId) return false;
  try {
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO processed_messages (message_id, ts) VALUES (?1, ?2)`
    )
      .bind(messageId, new Date().toISOString())
      .run();
    return (result.meta?.changes ?? 1) === 0;
  } catch (err) {
    console.error("Dedup check failed, treating message as new:", err);
    return false;
  }
}

// --- Analytics (D1) ---
// Records/updates a user row and logs one event per message. Wrapped in
// try/catch so an analytics failure never breaks the actual bot reply —
// this is called via ctx.waitUntil, fire-and-forget.
export async function recordActivity(whatsappId, type, env) {
  try {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (whatsapp_id, first_seen, last_seen, message_count)
         VALUES (?1, ?2, ?2, 1)
         ON CONFLICT(whatsapp_id) DO UPDATE SET
           last_seen = ?2,
           message_count = message_count + 1`
      ).bind(whatsappId, now),
      env.DB.prepare(
        `INSERT INTO events (whatsapp_id, ts, type) VALUES (?1, ?2, ?3)`
      ).bind(whatsappId, now, type),
    ]);
  } catch (err) {
    console.error("Analytics write failed:", err);
  }
}

// Logs a bot-side failure (Chakudya/Groq/WhatsApp-send errors caught in
// handleIncomingMessage) as its own event type, separate from normal
// message events, so /stats can report an error rate — bot *health*, not
// just usage. Doesn't touch the users table; a failed reply shouldn't count
// as a new/returning visit. Fire-and-forget, like recordActivity.
export async function recordError(whatsappId, err, env) {
  try {
    await env.DB.prepare(
      `INSERT INTO events (whatsapp_id, ts, type) VALUES (?1, ?2, 'error')`
    )
      .bind(whatsappId || "unknown", new Date().toISOString())
      .run();
  } catch (dbErr) {
    console.error("Error-event write failed:", dbErr, "(original error:", err, ")");
  }
}

// GET /stats?token=...&days=30 — simple protected JSON dashboard.
// Auth is a query-string token compared to the STATS_TOKEN secret, since
// this is a low-stakes read-only endpoint, not a full auth system.
const STATS_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://edisontaimu9-ui.github.io",
};

// Runs once/day from the `scheduled` handler. Summarizes the last 24h and
// sends it as a normal WhatsApp text via the bot's own send path. Silently
// does nothing if ADMIN_PHONE isn't set yet, so this is a no-op until you
// opt in (see README for setup).
export async function sendDailySummary(env) {
  if (!env.ADMIN_PHONE) {
    console.log("sendDailySummary: ADMIN_PHONE not set, skipping.");
    return;
  }

  const cutoff = new Date(Date.now() - 86400000).toISOString();

  try {
    const [newUsers, activeUsers, messages, errors] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE first_seen >= ?1`)
        .bind(cutoff)
        .first("n"),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE last_seen >= ?1`)
        .bind(cutoff)
        .first("n"),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE ts >= ?1 AND type != 'error'`)
        .bind(cutoff)
        .first("n"),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE ts >= ?1 AND type = 'error'`)
        .bind(cutoff)
        .first("n"),
    ]);

    const lines = [
      "📊 *Thanzi Coach — daily summary*",
      `New users: ${newUsers}`,
      `Active users: ${activeUsers}`,
      `Messages: ${messages}`,
      errors > 0 ? `⚠️ Errors: ${errors}` : `Errors: 0 ✅`,
    ];

    // 👍/👎 from the last 24h, plus the latest 👎 questions so you can see what to improve.
    const fb = await feedbackSummary(env.DB);
    if (fb && fb.up + fb.down > 0) {
      lines.push(`Feedback: 👍 ${fb.up} · 👎 ${fb.down}`);
      for (const q of fb.recentDown) lines.push(`👎 “${q.length > 80 ? q.slice(0, 77) + "…" : q}”`);
    }

    await sendWhatsAppReply(env.ADMIN_PHONE, lines.join("\n"), env);
  } catch (err) {
    console.error("sendDailySummary failed:", err);
  }
}

export async function handleStats(url, env) {
  const token = url.searchParams.get("token");
  if (!env.STATS_TOKEN || token !== env.STATS_TOKEN) {
    return new Response("Forbidden", { status: 403, headers: STATS_CORS_HEADERS });
  }

  const days = Number(url.searchParams.get("days")) || 30;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const [totalUsers, newUsers, activeUsers, periodMessages, allTimeMessages, periodErrors] =
      await Promise.all([
        env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first("n"),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE first_seen >= ?1`)
          .bind(cutoff)
          .first("n"),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE last_seen >= ?1`)
          .bind(cutoff)
          .first("n"),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE ts >= ?1 AND type != 'error'`)
          .bind(cutoff)
          .first("n"),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE type != 'error'`).first("n"),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE ts >= ?1 AND type = 'error'`)
          .bind(cutoff)
          .first("n"),
      ]);

    // Aggregate 👍/👎 only (no question text, so it is safe behind the dashboard's STATS_TOKEN).
    // Own try/catch inside feedbackCounts: /stats must still work before migration 0007 is applied.
    const fb = await feedbackCounts(env.DB, days);

    const stats = {
      // What people ask about (counts only, so safe behind STATS_TOKEN): [{ topic, label, n }].
      topics: await topicCounts(env.DB, days),
      feedback_up: fb.up,
      feedback_down: fb.down,
      feedback_satisfaction: fb.up + fb.down > 0 ? Number((fb.up / (fb.up + fb.down)).toFixed(4)) : null,
      period_days: days,
      total_users: totalUsers,
      new_users: newUsers,
      active_users: activeUsers,
      returning_users: Math.max(activeUsers - newUsers, 0),
      messages_in_period: periodMessages,
      messages_all_time: allTimeMessages,
      errors_in_period: periodErrors,
      error_rate: periodMessages > 0 ? Number((periodErrors / periodMessages).toFixed(4)) : 0,
    };

    return new Response(JSON.stringify(stats, null, 2), {
      headers: { "Content-Type": "application/json", ...STATS_CORS_HEADERS },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err?.message || err) }),
      { status: 500, headers: { "Content-Type": "application/json", ...STATS_CORS_HEADERS } }
    );
  }
}

// GET /stats/timeseries?token=...&days=30 — per-day messages and new-user
// counts, for the dashboard's trend chart. Same token auth as /stats.
// GET /stats/feedback?token=...&days=30&rating=down|up|all&limit=50 — the rated questions
// themselves, for the dashboard's feedback list. Needs FEEDBACK_TOKEN (separate from STATS_TOKEN,
// which is baked into the public dashboard bundle), because these are people's real questions.
export async function handleStatsFeedback(url, env) {
  const token = url.searchParams.get("token");
  if (!env.FEEDBACK_TOKEN || token !== env.FEEDBACK_TOKEN) {
    return new Response("Forbidden", { status: 403, headers: STATS_CORS_HEADERS });
  }
  const days = Math.min(Number(url.searchParams.get("days")) || 30, 90);
  const rating = url.searchParams.get("rating") || "down";
  const items = await listFeedback(env.DB, { days, rating, limit: url.searchParams.get("limit") });
  if (items === null) {
    return new Response(JSON.stringify({ error: "feedback unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...STATS_CORS_HEADERS },
    });
  }
  return new Response(JSON.stringify({ period_days: days, rating, items }, null, 2), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...STATS_CORS_HEADERS },
  });
}

export async function handleStatsTimeseries(url, env) {
  const token = url.searchParams.get("token");
  if (!env.STATS_TOKEN || token !== env.STATS_TOKEN) {
    return new Response("Forbidden", { status: 403, headers: STATS_CORS_HEADERS });
  }

  const days = Math.min(Number(url.searchParams.get("days")) || 30, 90);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const [messagesByDay, newUsersByDay, errorsByDay] = await Promise.all([
      env.DB.prepare(
        `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS n
         FROM events WHERE ts >= ?1 AND type != 'error'
         GROUP BY day ORDER BY day`
      )
        .bind(cutoff)
        .all(),
      env.DB.prepare(
        `SELECT substr(first_seen, 1, 10) AS day, COUNT(*) AS n
         FROM users WHERE first_seen >= ?1
         GROUP BY day ORDER BY day`
      )
        .bind(cutoff)
        .all(),
      env.DB.prepare(
        `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS n
         FROM events WHERE ts >= ?1 AND type = 'error'
         GROUP BY day ORDER BY day`
      )
        .bind(cutoff)
        .all(),
    ]);

    // Merge both series onto a single zero-filled list of every day in range,
    // so the chart doesn't have to reason about missing dates.
    const msgMap = new Map(messagesByDay.results.map((r) => [r.day, r.n]));
    const newUserMap = new Map(newUsersByDay.results.map((r) => [r.day, r.n]));
    const errorMap = new Map(errorsByDay.results.map((r) => [r.day, r.n]));

    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      series.push({
        date: d,
        messages: msgMap.get(d) || 0,
        new_users: newUserMap.get(d) || 0,
        errors: errorMap.get(d) || 0,
      });
    }

    return new Response(JSON.stringify({ period_days: days, series }, null, 2), {
      headers: { "Content-Type": "application/json", ...STATS_CORS_HEADERS },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err?.message || err) }),
      { status: 500, headers: { "Content-Type": "application/json", ...STATS_CORS_HEADERS } }
    );
  }
}
