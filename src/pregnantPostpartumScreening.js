/**
 * Pregnant/postpartum malnutrition screening — multi-turn WhatsApp intake
 * flow that calls the Chakudya MCP server's
 * `pregnant_postpartum_integrated_screen` tool.
 *
 * Same architecture as under5Screening.js — see that file's top comment
 * for the full design rationale (deterministic questions, deterministic
 * tool call, deterministic base formatting, optional Groq narration with
 * the recommended action + disclaimer always appended verbatim, English
 * only). Reuses the same CHAKUDYA_MCP service binding and
 * CHAKUDYA_MCP_AUTH_TOKEN secret — no new setup required.
 *
 * Session state reuses `last_session_context` with kind=
 * "pregnant_postpartum_screening" — a different kind than under-5's
 * "under5_screening", so the two flows can never collide for the same
 * WhatsApp number.
 */

const SESSION_KIND = "pregnant_postpartum_screening";
const SESSION_TTL_MS = 60 * 60 * 1000;
const MCP_FETCH_TIMEOUT_MS = 10000;
const GROQ_EXPLAIN_TIMEOUT_MS = 10000;
const GROQ_EXPLAIN_MODEL = "openai/gpt-oss-120b";

// ── D1 session helpers (same pattern as under5Screening.js — kept local
// rather than shared, to avoid a cross-module import for a few lines of
// D1 CRUD; see that file's comment for the same tradeoff) ──

async function saveSession(whatsappId, data, step, env) {
  const payload = { step, data };
  try {
    await env.DB.prepare(
      `INSERT INTO last_session_context (whatsapp_id, kind, payload_json, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(whatsapp_id, kind) DO UPDATE SET
         payload_json = ?3,
         updated_at = ?4`
    )
      .bind(whatsappId, SESSION_KIND, JSON.stringify(payload), new Date().toISOString())
      .run();
  } catch (err) {
    console.error("Failed to save pregnant/postpartum screening session:", err);
  }
}

async function loadSession(whatsappId, env) {
  try {
    const row = await env.DB.prepare(
      `SELECT payload_json, updated_at FROM last_session_context WHERE whatsapp_id = ?1 AND kind = ?2`
    )
      .bind(whatsappId, SESSION_KIND)
      .first();
    if (!row) return null;
    const age = Date.now() - new Date(row.updated_at).getTime();
    if (age > SESSION_TTL_MS) return null;
    return JSON.parse(row.payload_json);
  } catch (err) {
    console.error("Failed to load pregnant/postpartum screening session:", err);
    return null;
  }
}

async function clearSession(whatsappId, env) {
  try {
    await env.DB.prepare(`DELETE FROM last_session_context WHERE whatsapp_id = ?1 AND kind = ?2`)
      .bind(whatsappId, SESSION_KIND)
      .run();
  } catch (err) {
    console.error("Failed to clear pregnant/postpartum screening session:", err);
  }
}

// ── Trigger phrase ──
// Requires a pregnancy/postpartum-specific word alongside screen/malnutrition/
// muac, so it never collides with the under-5 trigger (which requires
// child/baby/infant/mwana instead).
const TRIGGER_RE = /\b(screen(?:ing)?|malnutrition|muac)\b.*\b(pregnant|pregnancy|postpartum|antenatal|mayi|amayi)\b|\b(pregnant|pregnancy|postpartum|antenatal)\b.*\b(screen(?:ing)?|malnutrition)\b/i;

export function detectPregnantPostpartumScreeningTrigger(text) {
  return TRIGGER_RE.test(text.trim());
}

// ── Field parsers ──

function parseMuacMm(text) {
  const t = text.trim().toLowerCase();
  const m = t.match(/(\d+(?:\.\d+)?)\s*(mm|cm)?/);
  if (!m) return null;
  const value = parseFloat(m[1]);
  return m[2] === "cm" ? Math.round(value * 10) : Math.round(value);
}

function parseYesNo(text) {
  const t = text.trim().toLowerCase();
  if (["skip", "unsure", "don't know", "dont know", "idk", "not sure"].includes(t)) return "skip";
  if (/^y(es)?$/.test(t)) return "yes";
  if (/^n(o)?$/.test(t)) return "no";
  return null;
}

function parseMuacUpperCutoff(text) {
  const t = text.trim().toLowerCase();
  if (t === "skip" || t === "220") return 220;
  if (t === "230") return 230;
  return null;
}

function isCancel(text) {
  return /^(cancel|stop|quit|exit)$/i.test(text.trim());
}

function isSkip(text) {
  return /^skip$/i.test(text.trim());
}

// ── Step sequence ──

function promptFor(step) {
  switch (step) {
    case "muac":
      return "Let's screen a pregnant or postpartum woman for malnutrition risk 🩺\n\nWhat is her MUAC (mid-upper arm circumference), if measured? Reply in mm (e.g. *240*) or cm (e.g. *24cm*). Reply *skip* if not available. (Reply *cancel* anytime to stop.)";
    case "muac_cutoff":
      return "Does your program use a 220mm or 230mm MUAC cutoff for moderate malnutrition? Reply *220*, *230*, or *skip* for the default (220).";
    case "edema":
      return "Does she have bilateral pitting oedema (swelling on both feet)? Reply *yes*, *no*, or *skip* if unsure.";
    case "weight_loss":
      return "Has she had confirmed unintentional weight loss of more than 10% since her last visit? Reply *yes*, *no*, or *skip* if unsure.";
    default:
      return null;
  }
}

function nextStep(step) {
  switch (step) {
    case "muac":
      return "muac_cutoff";
    case "muac_cutoff":
      return "edema";
    case "edema":
      return "weight_loss";
    case "weight_loss":
      return "finish";
    default:
      return "finish";
  }
}

/**
 * Applies the user's reply to the current step. Returns:
 *   { error: string }  — reprompt with this message
 *   { advance: true }  — move to the next step (data mutated in place)
 */
function applyReply(step, text, data) {
  if (isSkip(text) && step !== "muac_cutoff") {
    return { advance: true }; // skip leaves the field unset — never invents a value
  }

  switch (step) {
    case "muac": {
      const v = parseMuacMm(text);
      if (v === null) return { error: "Please reply with a number in mm or cm (e.g. *240* or *24cm*), or *skip*." };
      data.muac_mm = v;
      return { advance: true };
    }
    case "muac_cutoff": {
      const v = parseMuacUpperCutoff(text);
      if (v === null) return { error: "Please reply *220*, *230*, or *skip*." };
      data.moderate_muac_upper_mm = v;
      return { advance: true };
    }
    case "edema": {
      const v = parseYesNo(text);
      if (!v) return { error: "Please reply *yes*, *no*, or *skip*." };
      if (v !== "skip") data.edema = v === "yes";
      return { advance: true };
    }
    case "weight_loss": {
      const v = parseYesNo(text);
      if (!v) return { error: "Please reply *yes*, *no*, or *skip*." };
      if (v !== "skip") data.confirmed_weight_loss_over_10_percent = v === "yes";
      return { advance: true };
    }
    default:
      return { advance: true };
  }
}

// ── MCP call ──

function mcpFetchWithTimeout(fetcher, input, init, timeoutMs = MCP_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetcher(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function callPregnantPostpartumIntegratedScreen(args, env) {
  if (!env.CHAKUDYA_MCP) {
    throw new Error("CHAKUDYA_MCP service binding is not configured.");
  }
  if (!env.CHAKUDYA_MCP_AUTH_TOKEN) {
    throw new Error("CHAKUDYA_MCP_AUTH_TOKEN secret is not set.");
  }

  const rpcBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "pregnant_postpartum_integrated_screen", arguments: args },
  };

  const res = await mcpFetchWithTimeout(env.CHAKUDYA_MCP.fetch.bind(env.CHAKUDYA_MCP), "https://chakudya-mcp/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.CHAKUDYA_MCP_AUTH_TOKEN}`,
    },
    body: JSON.stringify(rpcBody),
  });

  if (!res.ok) {
    throw new Error(`MCP server returned HTTP ${res.status}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`MCP error: ${json.error.message || JSON.stringify(json.error)}`);
  }

  const result = json.result;
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) {
    throw new Error(text || "pregnant_postpartum_integrated_screen returned an error.");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("pregnant_postpartum_integrated_screen returned content that could not be parsed as JSON.");
  }
  return parsed.data ?? parsed;
}

// ── Result formatting (deterministic) ──

function recommendedActionBlock(result) {
  const urgencyEmoji =
    result.recommended_action.urgency === "urgent" ? "🚨" : result.recommended_action.urgency === "priority" ? "⚠️" : "✅";
  return [
    `${urgencyEmoji} *Recommended action (${result.recommended_action.urgency})*`,
    result.recommended_action.action,
    "",
    "_This is decision support only. A qualified health worker must confirm findings and manage the patient. Referral wording is generic — confirm against the current Malawi MoH protocol before acting on it._",
  ].join("\n");
}

function formatPregnantPostpartumScreeningResult(result) {
  const lines = [];
  lines.push("*Pregnant/Postpartum Malnutrition Screening Result*");
  lines.push("");

  lines.push(`*NACS classification: ${result.classification.overallMalnutritionClassification.toUpperCase()}*`);
  for (const ind of result.classification.indicators) {
    lines.push(`• ${ind.indicator}: ${ind.value} → ${ind.classification}`);
  }
  lines.push("");

  lines.push(recommendedActionBlock(result));

  if (result.clinical_flags.length > 0) {
    lines.splice(lines.length - 1, 0, "*Flags*", ...result.clinical_flags.map((f) => `• ${f.flag}`), "");
  }

  return lines.join("\n");
}

function toWhatsAppFormatting(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^#{1,6}\s*/gm, "");
}

/**
 * Narrates an already-computed screening result more warmly, via Groq
 * (English only). The recommended action and disclaimer are appended
 * verbatim afterward regardless of what the model produced. Falls back to
 * the plain deterministic formatting on any failure.
 */
export async function explainPregnantPostpartumScreeningResult(result, env) {
  const deterministic = formatPregnantPostpartumScreeningResult(result);
  if (!env.GROQ_API_KEY) return deterministic;

  const systemPrompt =
    "You explain a completed, already-decided maternal malnutrition screening result to a Malawian " +
    "health worker over WhatsApp. You are NOT deciding anything — every classification has already " +
    "been computed by deterministic NACS clinical rules. Your only job is to explain the findings " +
    "warmly and plainly, in 2-4 short sentences, in English only. Rules: " +
    "1) Never change, round differently, soften, or omit any number or classification given. " +
    "2) Never add a clinical recommendation, treatment detail, or referral instruction of your own — " +
    "the recommended action will be appended separately after your text. " +
    "3) Never claim certainty data doesn't support — if something is marked unavailable, say so " +
    "plainly rather than guessing why. 4) Use WhatsApp-style formatting only (*bold*, plain bullets " +
    "with •) — no markdown headers, no tables, no code blocks. " +
    "5) Write in English only — do not use Chichewa or any other language, even a single word. " +
    "6) Output ONLY the explanation text, nothing else (no preamble like \"Here's an explanation\").";

  const userPrompt = `Screening result JSON:\n${JSON.stringify(result)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROQ_EXPLAIN_TIMEOUT_MS);
    let res;
    try {
      res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: GROQ_EXPLAIN_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
          max_completion_tokens: 400,
          reasoning_effort: "low",
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      console.error("Groq pregnant-postpartum-explain error:", res.status, await res.text().catch(() => ""));
      return deterministic;
    }

    const body = await res.json();
    const rawText = body?.choices?.[0]?.message?.content?.trim();
    if (!rawText) {
      console.error("Groq pregnant-postpartum-explain: empty content");
      return deterministic;
    }
    const text = toWhatsAppFormatting(rawText);

    return [text, "", recommendedActionBlock(result)].join("\n");
  } catch (err) {
    console.error("Groq pregnant-postpartum-explain failed:", err);
    return deterministic;
  }
}

// ── Entry point ──

/**
 * Starts a pregnant/postpartum session and returns the first prompt. Used by
 * the school-age and adult flows when the person turns out to be pregnant or
 * recently postpartum, so they can be handed over without retyping a trigger.
 */
export async function beginPregnantPostpartumScreening(from, env) {
  await saveSession(from, {}, "muac", env);
  return promptFor("muac");
}

/**
 * Handles one incoming text message as part of (or the start of) a
 * pregnant/postpartum screening flow. Returns a reply string if handled,
 * or `null` if not (caller should fall through to normal dispatch).
 */
export async function handlePregnantPostpartumScreeningFlow(userText, from, env) {
  const session = await loadSession(from, env);

  if (!session) {
    if (!detectPregnantPostpartumScreeningTrigger(userText)) return null;
    const data = {};
    await saveSession(from, data, "muac", env);
    return promptFor("muac");
  }

  if (isCancel(userText)) {
    await clearSession(from, env);
    return "Screening cancelled. No data was saved beyond this session. Start again anytime by saying \"screen a pregnant woman\".";
  }

  const { step, data } = session;
  const result = applyReply(step, userText, data);

  if ("error" in result) {
    return `${result.error}\n\n${promptFor(step)}`;
  }

  const next = nextStep(step);
  if (next !== "finish") {
    await saveSession(from, data, next, env);
    return promptFor(next);
  }

  // ── Run the screen ──
  await clearSession(from, env); // clear before the call so a crash never leaves a stuck session
  if (data.edema === undefined && data.muac_mm === undefined && data.confirmed_weight_loss_over_10_percent === undefined) {
    return "I don't have enough information to run the screen (no MUAC, oedema, or weight-loss answer). Say \"screen a pregnant woman\" to start again.";
  }

  try {
    const screenResult = await callPregnantPostpartumIntegratedScreen(data, env);
    return await explainPregnantPostpartumScreeningResult(screenResult, env);
  } catch (err) {
    console.error("pregnant_postpartum_integrated_screen call failed:", err);
    return `Sorry, the screening tool couldn't complete: ${err instanceof Error ? err.message : String(err)}. Please try again in a moment.`;
  }
}
