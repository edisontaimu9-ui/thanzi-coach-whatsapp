/**
 * Shared plumbing for the school-age (schoolAgeScreening.js) and adult
 * (adultScreening.js) malnutrition screening flows.
 *
 * The two ORIGINAL flows (under5Screening.js, pregnantPostpartumScreening.js)
 * keep their own private copies of this code and are deliberately left
 * untouched. The two newer flows share this one file instead of adding two
 * more copies of the same ~150 lines.
 *
 * Same architecture as the original flows (see under5Screening.js's top
 * comment for the full rationale): deterministic questions, a deterministic
 * MCP tool call with only what the health worker actually supplied,
 * deterministic base formatting, and optional Groq narration that can never
 * change a classification or the recommended action (that block is always
 * appended verbatim afterwards).
 *
 * Session state reuses `last_session_context` (migration 0005) — one row per
 * (whatsapp_id, kind), so no new migration is needed.
 */

export const SESSION_TTL_MS = 60 * 60 * 1000; // 60 minutes — same as the other multi-turn flows
export const MCP_FETCH_TIMEOUT_MS = 10000;
export const GROQ_EXPLAIN_TIMEOUT_MS = 10000;
export const GROQ_EXPLAIN_MODEL = "openai/gpt-oss-120b";

/** Every guided flow's session kind. Used to let a fresh trigger phrase cleanly replace a stale half-finished flow. */
export const ALL_SCREENING_SESSION_KINDS = [
  "under5_screening",
  "pregnant_postpartum_screening",
  "school_age_screening",
  "adult_screening",
  "weight_estimate", // not a screening flow, but a fresh trigger for any flow should also discard a stale weight-estimate session
  "height_estimate", // not a screening flow, but a fresh trigger for any flow should also discard a stale height-estimate session
];

// ── D1 session helpers ──

export async function saveSession(kind, whatsappId, data, step, env) {
  const payload = { step, data };
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
    console.error(`Failed to save ${kind} session:`, err);
  }
}

export async function loadSession(kind, whatsappId, env) {
  try {
    const row = await env.DB.prepare(
      `SELECT payload_json, updated_at FROM last_session_context WHERE whatsapp_id = ?1 AND kind = ?2`
    )
      .bind(whatsappId, kind)
      .first();
    if (!row) return null;
    const age = Date.now() - new Date(row.updated_at).getTime();
    if (age > SESSION_TTL_MS) return null;
    return JSON.parse(row.payload_json);
  } catch (err) {
    console.error(`Failed to load ${kind} session:`, err);
    return null;
  }
}

export async function clearSession(kind, whatsappId, env) {
  try {
    await env.DB.prepare(`DELETE FROM last_session_context WHERE whatsapp_id = ?1 AND kind = ?2`)
      .bind(whatsappId, kind)
      .run();
  } catch (err) {
    console.error(`Failed to clear ${kind} session:`, err);
  }
}

/** Clears every screening flow's session for this number. */
export async function clearAllScreeningSessions(whatsappId, env) {
  for (const kind of ALL_SCREENING_SESSION_KINDS) {
    await clearSession(kind, whatsappId, env);
  }
}

// ── Field parsers (pure) ──

export function parseSex(text) {
  const t = text.trim().toLowerCase();
  if (/\b(boy|male|man|m)\b/.test(t)) return "male";
  if (/\b(girl|female|woman|f)\b/.test(t)) return "female";
  return null;
}

/**
 * Parses an age reply. Accepts:
 *   "YYYY-MM-DD"            -> { date_of_birth }
 *   "8 years 3 months"      -> { age_months: 99 }   (also "8y 3m")
 *   "96 months" / "96 mo"   -> { age_months: 96 }
 *   "8 years" / "8y"        -> { age_years: 8 }
 *   "8" (bare number)       -> { age_years: 8 }     ONLY when opts.bareAsYears (these flows are for
 *                                                    5+ year olds, where a bare number is years)
 * Returns null when it can't tell, so the caller re-prompts instead of guessing.
 */
export function parseAgeFlexible(text, opts = {}) {
  const t = text.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { date_of_birth: t };

  const years = t.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|yr|y)\b/);
  const months = t.match(/(\d+(?:\.\d+)?)\s*(?:months?|mos?|mo|m)\b/);
  if (years && months) return { age_months: Math.round(parseFloat(years[1]) * 12 + parseFloat(months[1])) };
  if (months) return { age_months: parseFloat(months[1]) };
  if (years) return { age_years: parseFloat(years[1]) };
  if (opts.bareAsYears && /^\d{1,3}(?:\.\d+)?$/.test(t)) return { age_years: parseFloat(t) };
  return null;
}

export function parseNumber(text) {
  const m = text.trim().match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

export function parseMuacMm(text) {
  const t = text.trim().toLowerCase();
  const m = t.match(/(\d+(?:\.\d+)?)\s*(mm|cm)?/);
  if (!m) return null;
  const value = parseFloat(m[1]);
  return m[2] === "cm" ? Math.round(value * 10) : Math.round(value);
}

export function parseYesNo(text) {
  const t = text.trim().toLowerCase();
  if (["skip", "unsure", "don't know", "dont know", "idk", "not sure"].includes(t)) return "skip";
  if (/^y(es)?$/.test(t)) return "yes";
  if (/^n(o)?$/.test(t)) return "no";
  return null;
}

export function parseContext(text) {
  const t = text.trim().toLowerCase();
  if (t === "skip" || t === "1" || /community/.test(t)) return "community";
  if (t === "2" || /health.?cent/.test(t)) return "health_centre";
  if (t === "3" || /rehab/.test(t)) return "nutrition_rehabilitation";
  if (t === "4" || /hospital/.test(t)) return "hospital";
  return null;
}

export function isCancel(text) {
  return /^(cancel|stop|quit|exit)$/i.test(text.trim());
}

export function isDone(text) {
  return /^(done|finish|that's all|thats all)$/i.test(text.trim());
}

export function isSkip(text) {
  return /^skip$/i.test(text.trim());
}

/** Best-effort age in months from whichever age field the flow collected (null if none). */
export function estimateAgeMonths(data) {
  if (data.age_months !== undefined) return data.age_months;
  if (data.age_years !== undefined) return data.age_years * 12;
  if (data.date_of_birth !== undefined) {
    const days = (Date.now() - new Date(`${data.date_of_birth}T00:00:00Z`).getTime()) / 86400000;
    return days / 30.4375;
  }
  return null;
}

/** Copies the age fields the MCP tools accept, dropping anything unset. */
export function ageArgs(data) {
  const out = {};
  for (const k of ["age_months", "age_years", "date_of_birth", "assessment_date"]) {
    if (data[k] !== undefined) out[k] = data[k];
  }
  return out;
}

// ── Trigger helpers ──
// A screening request needs three ingredients so ordinary questions don't start a flow:
//   an action word (screen / assess / check ...), a topic word (malnutrition / muac / bmi ...), and a population word.
const ACTION_RE = /\b(screen(?:ing)?|assess(?:ment)?|check)\b/i;
const TOPIC_RE = /\b(malnutrition|malnourished|muac|bmi|nutrition(?:al)? status|underweight)\b/i;

export function looksLikeScreeningRequest(text, populationRe) {
  const t = text.trim();
  return ACTION_RE.test(t) && TOPIC_RE.test(t) && populationRe.test(t);
}

// ── MCP call ──

function withTimeout(fetcher, input, init, timeoutMs = MCP_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetcher(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * Calls one tool on the Chakudya MCP server through the CHAKUDYA_MCP service
 * binding (same binding + CHAKUDYA_MCP_AUTH_TOKEN secret as the original
 * screening flows). Returns the tool's structured result (the `data` part).
 */
export async function callMcpTool(toolName, args, env) {
  if (!env.CHAKUDYA_MCP) {
    throw new Error("CHAKUDYA_MCP service binding is not configured (see wrangler.toml comments for setup).");
  }
  if (!env.CHAKUDYA_MCP_AUTH_TOKEN) {
    throw new Error("CHAKUDYA_MCP_AUTH_TOKEN secret is not set.");
  }

  const rpcBody = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } };

  const res = await withTimeout(env.CHAKUDYA_MCP.fetch.bind(env.CHAKUDYA_MCP), "https://chakudya-mcp/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.CHAKUDYA_MCP_AUTH_TOKEN}` },
    body: JSON.stringify(rpcBody),
  });

  if (!res.ok) throw new Error(`MCP server returned HTTP ${res.status}`);

  const json = await res.json();
  if (json.error) throw new Error(`MCP error: ${json.error.message || JSON.stringify(json.error)}`);

  const result = json.result;
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(text || `${toolName} returned an error.`);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${toolName} returned content that could not be parsed as JSON.`);
  }
  return parsed.data ?? parsed; // ok() wraps the real result as { ...meta, data }
}

// ── Formatting ──

/** Normalizes markdown-ish model output to WhatsApp syntax. Applied ONLY to model text, never to the deterministic parts. */
export function toWhatsAppFormatting(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*") // **bold** -> *bold*
    .replace(/__(.+?)__/g, "_$1_") // __italic__ -> _italic_
    .replace(/^#{1,6}\s*/gm, ""); // strip stray markdown headers
}

export function urgencyEmoji(urgency) {
  return urgency === "urgent" ? "🚨" : urgency === "priority" ? "⚠️" : "✅";
}

/** The recommended action + disclaimer — always appended verbatim, whatever the narration did. */
export function recommendedActionBlock(result, subject) {
  return [
    `${urgencyEmoji(result.recommended_action.urgency)} *Recommended action (${result.recommended_action.urgency})*`,
    result.recommended_action.action,
    "",
    `_This is decision support only. A qualified health worker must confirm findings and manage the ${subject}. Referral wording is generic — confirm against the current Malawi MoH protocol before acting on it._`,
  ].join("\n");
}

/** Inserts a "*Flags*" section just before the final block (the recommended action). */
export function withFlags(lines, result) {
  if (result.clinical_flags && result.clinical_flags.length > 0) {
    lines.splice(lines.length - 1, 0, "*Flags*", ...result.clinical_flags.map((f) => `• ${f.flag}`), "");
  }
  return lines;
}

/**
 * Asks Groq to narrate an already-computed result. Returns the model's
 * WhatsApp-formatted text, or null on ANY failure (no key, timeout, non-200,
 * empty). Callers fall back to their deterministic formatting when null.
 */
export async function narrateWithGroq(systemPrompt, result, env, maxTokens = 500) {
  if (!env.GROQ_API_KEY) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROQ_EXPLAIN_TIMEOUT_MS);
    let res;
    try {
      res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: GROQ_EXPLAIN_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Screening result JSON:\n${JSON.stringify(result)}` },
          ],
          temperature: 0.2,
          max_completion_tokens: maxTokens,
          reasoning_effort: "low",
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      console.error("Groq screening-explain error:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const body = await res.json();
    const rawText = body?.choices?.[0]?.message?.content?.trim();
    if (!rawText) {
      console.error("Groq screening-explain: empty content");
      return null;
    }
    return toWhatsAppFormatting(rawText);
  } catch (err) {
    console.error("Groq screening-explain failed:", err);
    return null;
  }
}

/** Common rules for every narration prompt. */
export const NARRATION_RULES =
  "Rules: " +
  "1) Never change, round differently, soften, or omit any number or classification given. " +
  "2) Never add a clinical recommendation, treatment detail, or referral instruction of your own — " +
  "the recommended action will be appended separately after your text, so don't restate or pre-empt it. " +
  "3) Never claim certainty data doesn't support — if something is marked unavailable or not administered, " +
  "say so plainly rather than guessing why. 4) Use WhatsApp-style formatting only (*bold*, plain bullets with •) " +
  "— no markdown headers, no tables, no code blocks. 5) Write in English only — do not use Chichewa or any " +
  "other language, even a single word. 6) Output ONLY the explanation text, nothing else (no preamble like " +
  "\"Here's an explanation\").";
