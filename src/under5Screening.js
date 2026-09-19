/**
 * Under-5 malnutrition screening — multi-turn WhatsApp intake flow that
 * calls the Chakudya MCP server's `under5_integrated_screen` tool.
 *
 * DESIGN DECISION (the "Layer 3" AI agent):
 * The original design brief asked for an AI agent that asks questions,
 * decides which tool to call, and explains results in natural/local
 * language. This module splits that into a deterministic half and an
 * optional narrated half, so the actual clinical decision never depends on
 * an LLM behaving correctly:
 *   - Questions are asked by a fixed, deterministic step sequence (below),
 *     not decided by a model each turn.
 *   - The tool call (under5_integrated_screen) always fires with exactly
 *     the fields the health worker actually supplied — nothing is
 *     inferred or guessed by a model.
 *   - formatUnder5ScreeningResult() builds a complete, correct, WhatsApp-
 *     ready message from the tool's own structured JSON with NO model
 *     involved — this is the guaranteed-safe fallback and the source of
 *     truth for what the recommended action actually is.
 *   - explainUnder5ScreeningResult() optionally asks Groq (this repo's
 *     existing LLM provider — see GROQ_API_KEY, already used for barcode
 *     vision and voice transcription elsewhere in index.js) to narrate the
 *     SAME already-computed JSON more warmly / with light Chichewa, for
 *     the explanatory portion only. The recommended action and the
 *     disclaimer are then appended AFTER the model's text, verbatim,
 *     every time — so even if the model paraphrases loosely, drops
 *     something, or the API call fails outright, the actual clinical
 *     bottom line always reaches the health worker unchanged. On any
 *     failure (no API key, timeout, bad response), it falls straight back
 *     to formatUnder5ScreeningResult() with no user-visible error.
 * Net effect: an LLM can make this read better; it can never change what
 * the child was actually classified as or what action was recommended.
 *
 * Extended screening questionnaires: STRONGkids, PNST, PYMS, and STAMP are
 * all available on the MCP server, but asking all four in a WhatsApp
 * conversation (16+ extra yes/no questions) is impractical. This flow
 * offers ONE optional extra step — STRONGkids only (4 questions) — for
 * children 12+ months. PNST/PYMS/STAMP remain reachable by calling the MCP
 * server directly (e.g. from an MCP-connected chat client), just not from
 * this guided WhatsApp flow. Worth revisiting if STRONGkids alone proves
 * insufficient in practice.
 *
 * Session state reuses the existing `last_session_context` table (see
 * migrations/0005_add_session_context.sql) with kind="under5_screening" —
 * no new migration needed. One session per WhatsApp number at a time.
 *
 * REQUIRED SETUP (not done by this file — see wrangler.toml comments):
 *   - A service binding named CHAKUDYA_MCP pointing at the
 *     chakudya-mcp-server-cloudflare Worker.
 *   - A secret CHAKUDYA_MCP_AUTH_TOKEN, set to the SAME value as that
 *     Worker's own MCP_AUTH_TOKEN secret.
 *
 * KNOWN LIMITATION: the MCP server's per-IP rate limiter keys off
 * cf-connecting-ip, which isn't present on Worker-to-Worker service-binding
 * calls — so all screening requests from this bot share one rate-limit
 * bucket server-side (default 60/min) rather than being limited per health
 * worker. Fine at current scale; worth a KV/Durable-Object counter keyed by
 * WhatsApp number here if that ever matters.
 */

const SESSION_KIND = "under5_screening";
const SESSION_TTL_MS = 60 * 60 * 1000; // 60 minutes — same as other multi-turn flows in this repo
const MCP_FETCH_TIMEOUT_MS = 10000;

// ── D1 session helpers (local copies of index.js's saveLastSessionContext /
// getLastSessionContext pattern, plus a delete — kept local rather than
// imported to avoid a circular import between this file and index.js) ──

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
    console.error("Failed to save under5 screening session:", err);
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
    console.error("Failed to load under5 screening session:", err);
    return null;
  }
}

async function clearSession(whatsappId, env) {
  try {
    await env.DB.prepare(`DELETE FROM last_session_context WHERE whatsapp_id = ?1 AND kind = ?2`)
      .bind(whatsappId, SESSION_KIND)
      .run();
  } catch (err) {
    console.error("Failed to clear under5 screening session:", err);
  }
}

// ── Trigger phrase (starts a new session) ──

// English keywords are the primary, tested trigger. The Chichewa word
// "mwana" (child) is included as a light supplementary trigger since this
// bot mixes English/Chichewa — but it hasn't been reviewed for dialectal
// accuracy or false-positive risk against everyday messages, so treat it
// as a starting point to refine, not a finished translation.
const TRIGGER_RE = /\b(screen(?:ing)?|malnutrition|muac)\b.*\b(child|baby|infant|mwana)\b|\b(child|baby|infant|mwana)\b.*\b(screen(?:ing)?|malnutrition)\b/i;

export function detectUnder5ScreeningTrigger(text) {
  return TRIGGER_RE.test(text.trim());
}

// Exported for unit testing (see test/under5Screening.test.js) — these are
// pure functions with no D1/network dependency.
export { parseSex, parseAge, parseNumber, parseMuacMm, parseYesNo, parseMeasurementMethod, parseContext, nextStep, applyReply, formatUnder5ScreeningResult };

// ── Field parsers ──

function parseSex(text) {
  const t = text.trim().toLowerCase();
  if (/\b(boy|male|m)\b/.test(t)) return "male";
  if (/\b(girl|female|f)\b/.test(t)) return "female";
  return null;
}

function parseAge(text) {
  const t = text.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { date_of_birth: t };
  const months = t.match(/(\d+(?:\.\d+)?)\s*(months?|mos?)\b/);
  if (months) return { age_months: parseFloat(months[1]) };
  const years = t.match(/(\d+(?:\.\d+)?)\s*(years?|yrs?|y)\b/);
  if (years) return { age_years: parseFloat(years[1]) };
  return null; // bare/ambiguous number — reprompt rather than guess units
}

function parseNumber(text) {
  const m = text.trim().match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

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

function parseMeasurementMethod(text) {
  const t = text.trim().toLowerCase();
  if (t === "skip") return "skip";
  if (/\b(lying|laying|recumbent|down)\b/.test(t)) return "recumbent_length";
  if (/\b(stand(ing)?)\b/.test(t)) return "standing_height";
  return null;
}

function parseContext(text) {
  const t = text.trim().toLowerCase();
  if (t === "skip" || t === "1" || /community/.test(t)) return "community";
  if (t === "2" || /health.?cent/.test(t)) return "health_centre";
  if (t === "3" || /rehab/.test(t)) return "nutrition_rehabilitation";
  if (t === "4" || /hospital/.test(t)) return "hospital";
  return null;
}

function isCancel(text) {
  return /^(cancel|stop|quit|exit)$/i.test(text.trim());
}

function isDone(text) {
  return /^(done|finish|that's all|thats all)$/i.test(text.trim());
}

function isSkip(text) {
  return /^skip$/i.test(text.trim());
}

// ── Step sequence ──
// Each step: id, ask(data) -> prompt text, and handled inline in advance()
// below (an explicit switch, rather than a generic engine, to keep the
// conditional skips — measurement_method only if height was given,
// extra-screening steps only if age >= 12 months — easy to follow).

function ageIsResolved(data) {
  return data.age_months !== undefined || data.age_years !== undefined || data.date_of_birth !== undefined;
}

function resolvedAgeMonthsEstimate(data) {
  if (data.age_months !== undefined) return data.age_months;
  if (data.age_years !== undefined) return data.age_years * 12;
  if (data.date_of_birth !== undefined) {
    const days = (Date.now() - new Date(`${data.date_of_birth}T00:00:00Z`).getTime()) / 86400000;
    return days / 30.4375;
  }
  return null;
}

function promptFor(step) {
  switch (step) {
    case "sex":
      return "Let's screen a child for malnutrition risk 🩺\n\nIs the child a boy or a girl? (Reply *boy* or *girl*. Reply *cancel* anytime to stop.)";
    case "age":
      return "How old is the child? Reply like *18 months*, *2 years*, or a birth date as *YYYY-MM-DD*.";
    case "weight":
      return "What is the child's weight in kilograms? (e.g. *8.5*). Reply *skip* if not available.";
    case "height":
      return "What is the child's height or length in centimetres? (e.g. *75*). Reply *skip* if not available.";
    case "measurement_method":
      return "Was the child measured lying down or standing up? Reply *lying* or *standing*. Reply *skip* if unsure.";
    case "muac":
      return "What is the child's MUAC (mid-upper arm circumference), if measured? Reply in mm (e.g. *125*) or cm (e.g. *12.5cm*). Reply *skip* if not available.";
    case "edema":
      return "Does the child have bilateral pitting oedema (swelling on both feet)? Reply *yes*, *no*, or *skip* if unsure.";
    case "context":
      return "Where is this screening happening? Reply:\n1) Community\n2) Health centre\n3) Nutrition rehabilitation\n4) Hospital\nOr reply *skip* for community (default).";
    case "extra_gate":
      return "Would you like to also answer a short 4-question risk screen (STRONGkids)? Reply *yes* or *no*. (Or reply *done* to screen with what you've given so far.)";
    case "sk_clinical":
      return "STRONGkids Q1/4: Does the child look thin — reduced fat/muscle mass, or a hollow/sunken face? (yes/no)";
    case "sk_disease":
      return "STRONGkids Q2/4: Does the child have a high-risk underlying illness, or is major surgery planned? (yes/no)";
    case "sk_intake":
      return "STRONGkids Q3/4: In the last few days — 5+ watery stools/day or 3+ vomiting episodes/day, OR reduced food intake, OR pain limiting intake? (yes/no)";
    case "sk_weightloss":
      return "STRONGkids Q4/4: Has the child lost weight or gained poorly over recent weeks/months? (yes/no)";
    default:
      return null;
  }
}

/** Determines the next step id given the current step and data collected so far. */
function nextStep(step, data) {
  switch (step) {
    case "sex":
      return "age";
    case "age":
      return "weight";
    case "weight":
      return "height";
    case "height":
      return data.length_or_height_cm !== undefined ? "measurement_method" : "muac";
    case "measurement_method":
      return "muac";
    case "muac":
      return "edema";
    case "edema":
      return "context";
    case "context":
      return resolvedAgeMonthsEstimate(data) >= 12 ? "extra_gate" : "finish";
    case "extra_gate":
      return data.wantsExtra ? "sk_clinical" : "finish";
    case "sk_clinical":
      return "sk_disease";
    case "sk_disease":
      return "sk_intake";
    case "sk_intake":
      return "sk_weightloss";
    case "sk_weightloss":
      return "finish";
    default:
      return "finish";
  }
}

/**
 * Applies the user's reply to the current step. Returns:
 *   { error: string }               — reprompt with this message
 *   { advance: true }                — move to the next step (data mutated in place)
 *   { finish: true }                 — intake is complete, run the screen
 */
function applyReply(step, text, data) {
  if (isSkip(text) && !["sex", "age"].includes(step)) {
    return { advance: true }; // skip leaves the field unset — never invents a value
  }

  switch (step) {
    case "sex": {
      const v = parseSex(text);
      if (!v) return { error: "Please reply *boy* or *girl*." };
      data.sex = v;
      return { advance: true };
    }
    case "age": {
      const v = parseAge(text);
      if (!v) return { error: "Please reply like *18 months*, *2 years*, or a birth date as *YYYY-MM-DD*." };
      Object.assign(data, v);
      if (v.date_of_birth) data.assessment_date = new Date().toISOString().slice(0, 10);
      return { advance: true };
    }
    case "weight": {
      const v = parseNumber(text);
      if (v === null) return { error: "Please reply with a number in kilograms (e.g. *8.5*), or *skip*." };
      data.weight_kg = v;
      return { advance: true };
    }
    case "height": {
      const v = parseNumber(text);
      if (v === null) return { error: "Please reply with a number in centimetres (e.g. *75*), or *skip*." };
      data.length_or_height_cm = v;
      return { advance: true };
    }
    case "measurement_method": {
      const v = parseMeasurementMethod(text);
      if (!v) return { error: "Please reply *lying* or *standing*, or *skip*." };
      if (v !== "skip") data.measurement_method = v;
      return { advance: true };
    }
    case "muac": {
      const v = parseMuacMm(text);
      if (v === null) return { error: "Please reply with a number in mm or cm (e.g. *125* or *12.5cm*), or *skip*." };
      data.muac_mm = v;
      return { advance: true };
    }
    case "edema": {
      const v = parseYesNo(text);
      if (!v) return { error: "Please reply *yes*, *no*, or *skip*." };
      if (v !== "skip") data.edema = v === "yes";
      return { advance: true };
    }
    case "context": {
      const v = parseContext(text);
      if (!v) return { error: "Please reply 1, 2, 3, 4, or *skip*." };
      data.measurement_context = v;
      return { advance: true };
    }
    case "extra_gate": {
      if (isDone(text)) return { finish: true };
      const v = parseYesNo(text);
      if (!v) return { error: "Please reply *yes* or *no*." };
      data.wantsExtra = v === "yes";
      return { advance: true };
    }
    case "sk_clinical": {
      const v = parseYesNo(text);
      if (!v || v === "skip") return { error: "Please reply *yes* or *no*." };
      data.sk_clinical = v === "yes";
      return { advance: true };
    }
    case "sk_disease": {
      const v = parseYesNo(text);
      if (!v || v === "skip") return { error: "Please reply *yes* or *no*." };
      data.sk_disease = v === "yes";
      return { advance: true };
    }
    case "sk_intake": {
      const v = parseYesNo(text);
      if (!v || v === "skip") return { error: "Please reply *yes* or *no*." };
      data.sk_intake = v === "yes";
      return { advance: true };
    }
    case "sk_weightloss": {
      const v = parseYesNo(text);
      if (!v || v === "skip") return { error: "Please reply *yes* or *no*." };
      data.sk_weightloss = v === "yes";
      return { advance: true };
    }
    default:
      return { finish: true };
  }
}

// ── MCP call ──

function mcpFetchWithTimeout(fetcher, input, init, timeoutMs = MCP_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetcher(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function callUnder5IntegratedScreen(args, env) {
  if (!env.CHAKUDYA_MCP) {
    throw new Error(
      "CHAKUDYA_MCP service binding is not configured (see wrangler.toml comments for setup)."
    );
  }
  if (!env.CHAKUDYA_MCP_AUTH_TOKEN) {
    throw new Error("CHAKUDYA_MCP_AUTH_TOKEN secret is not set.");
  }

  const rpcBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "under5_integrated_screen", arguments: args },
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
    throw new Error(text || "under5_integrated_screen returned an error.");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("under5_integrated_screen returned content that could not be parsed as JSON.");
  }
  return parsed.data ?? parsed; // ok() wraps the real result as { ...meta, data }
}

// ── Result formatting (deterministic — see the design-decision comment at
// the top of this file for why this is a template, not an LLM call) ──

function formatIndicatorLine(label, indicator) {
  if (!indicator.available) return `• ${label}: not available (${indicator.reason_unavailable})`;
  return `• ${label}: z=${indicator.z_score} — ${indicator.classification}`;
}

function formatUnder5ScreeningResult(result) {
  const lines = [];
  lines.push("*Under-5 Malnutrition Screening Result*");
  lines.push(`Child: ${result.child.age_months} months, ${result.child.sex}`);
  lines.push("");

  lines.push("*Anthropometry*");
  const a = result.anthropometry;
  lines.push(formatIndicatorLine("Weight-for-age", a.weight_for_age));
  lines.push(formatIndicatorLine("Height-for-age", a.height_for_age));
  const whLabel = a.weight_for_length_or_height.standard_used === "weight_for_height" ? "Weight-for-height" : "Weight-for-length";
  lines.push(formatIndicatorLine(whLabel, a.weight_for_length_or_height));
  lines.push(formatIndicatorLine("BMI-for-age", a.bmi_for_age));
  lines.push("");

  if (result.nacs_classification) {
    lines.push(`*NACS classification: ${result.nacs_classification.overallAcuteMalnutritionClassification.toUpperCase()}*`);
    for (const ind of result.nacs_classification.indicators) {
      lines.push(`• ${ind.indicator}: ${ind.value} → ${ind.classification}`);
    }
    lines.push("");
  } else if (result.nacs_classification_skipped_reason) {
    lines.push(`NACS classification: not computed (${result.nacs_classification_skipped_reason})`);
    lines.push("");
  }

  const s = result.screening;
  if (s.tools_administered.length > 0) {
    lines.push("*Risk screening*");
    if (s.strongkids) lines.push(`• STRONGkids: ${s.strongkids.total_score}/5 — ${s.strongkids.risk_category}`);
    if (s.pnst) lines.push(`• PNST: ${s.pnst.affirmative_count}/4 — ${s.pnst.risk_category}`);
    if (s.pyms) lines.push(`• PYMS: ${s.pyms.total_score}/8 — ${s.pyms.risk_category}`);
    if (s.stamp) lines.push(`• STAMP: ${s.stamp.total_score}/9 — ${s.stamp.risk_category}`);
    if (s.disagreement_noted) {
      lines.push("⚠️ Screening tools disagreed with each other — see each result above rather than one summary.");
    }
    lines.push("");
  }

  lines.push(recommendedActionBlock(result));

  if (result.clinical_flags.length > 0) {
    lines.splice(lines.length - 1, 0, "*Flags*", ...result.clinical_flags.map((f) => `• ${f.flag}`), "");
  }

  return lines.join("\n");
}

// ── Optional Groq narration layer (see the design-decision comment at the
// top of this file). Uses this repo's existing GROQ_API_KEY / model choice
// — same provider as readBarcodeFromImage/generateMealPlan in index.js —
// so no new secret or dependency is introduced.

const GROQ_EXPLAIN_TIMEOUT_MS = 10000;
const GROQ_EXPLAIN_MODEL = "openai/gpt-oss-120b";

function recommendedActionBlock(result) {
  const urgencyEmoji =
    result.recommended_action.urgency === "urgent" ? "🚨" : result.recommended_action.urgency === "priority" ? "⚠️" : "✅";
  return [
    `${urgencyEmoji} *Recommended action (${result.recommended_action.urgency})*`,
    result.recommended_action.action,
    "",
    "_This is decision support only. A qualified health worker must confirm findings and manage the child. Referral wording is generic — confirm against the current Malawi MoH protocol before acting on it._",
  ].join("\n");
}

/**
 * Narrates an already-computed screening result more warmly (optionally
 * with light Chichewa), via Groq. The recommended action and disclaimer
 * are appended verbatim afterward regardless of what the model produced —
 * see the design-decision comment at the top of this file for why. Falls
 * back to the plain deterministic formatting (still complete and correct)
 * on any failure: no GROQ_API_KEY, a timeout, a non-200 response, or
 * unparseable/empty content.
 */
export async function explainUnder5ScreeningResult(result, env) {
  const deterministic = formatUnder5ScreeningResult(result);
  if (!env.GROQ_API_KEY) return deterministic;

  const systemPrompt =
    "You explain a completed, already-decided child malnutrition screening result to a Malawian " +
    "health worker over WhatsApp. You are NOT deciding anything — every number, classification, and " +
    "recommendation has already been computed by deterministic clinical rules (WHO growth standards, " +
    "NACS, and published paediatric screening tools). Your only job is to explain the anthropometry " +
    "and classification findings warmly and plainly, in 3-6 short sentences, optionally blending in a " +
    "few natural Chichewa words/phrases the way a Malawian health worker might speak. Rules: " +
    "1) Never change, round differently, soften, or omit any number or classification given. " +
    "2) Never add a clinical recommendation, treatment detail, or referral instruction of your own — " +
    "the recommended action will be appended separately after your text, so don't restate or " +
    "pre-empt it. 3) Never claim certainty data doesn't support — if something is marked unavailable " +
    "or not administered, say so plainly rather than guessing why. 4) Use WhatsApp-style formatting " +
    "only (*bold*, plain bullets with •) — no markdown headers, no tables, no code blocks. " +
    "5) Output ONLY the explanation text, nothing else (no preamble like \"Here's an explanation\").";

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
          max_completion_tokens: 500,
          reasoning_effort: "low",
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      console.error("Groq under5-explain error:", res.status, await res.text().catch(() => ""));
      return deterministic;
    }

    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      console.error("Groq under5-explain: empty content");
      return deterministic;
    }

    return [text, "", recommendedActionBlock(result)].join("\n");
  } catch (err) {
    console.error("Groq under5-explain failed:", err);
    return deterministic;
  }
}

// ── Entry point ──

/**
 * Handles one incoming text message as part of (or the start of) an
 * under-5 screening flow.
 * Returns a reply string if this message was handled by the flow, or
 * `null` if it wasn't (caller should fall through to normal dispatch).
 */
export async function handleUnder5ScreeningFlow(userText, from, env) {
  const session = await loadSession(from, env);

  if (!session) {
    if (!detectUnder5ScreeningTrigger(userText)) return null;
    const data = {};
    await saveSession(from, data, "sex", env);
    return promptFor("sex");
  }

  if (isCancel(userText)) {
    await clearSession(from, env);
    return "Screening cancelled. No data was saved beyond this session. Start again anytime by saying \"screen a child\".";
  }

  const { step, data } = session;

  const result = applyReply(step, userText, data);

  if ("error" in result) {
    return `${result.error}\n\n${promptFor(step)}`;
  }

  const isFinishing = result.finish === true || nextStep(step, data) === "finish";

  if (!isFinishing) {
    const next = nextStep(step, data);
    await saveSession(from, data, next, env);
    return promptFor(next);
  }

  // ── Run the screen ──
  await clearSession(from, env); // clear before the call so a crash never leaves a stuck session
  if (!ageIsResolved(data)) {
    return "I don't have the child's age yet, so I can't run the screen. Say \"screen a child\" to start again.";
  }

  const args = {
    sex: data.sex,
    age_months: data.age_months,
    age_years: data.age_years,
    date_of_birth: data.date_of_birth,
    assessment_date: data.assessment_date,
    weight_kg: data.weight_kg,
    length_or_height_cm: data.length_or_height_cm,
    measurement_method: data.measurement_method,
    muac_mm: data.muac_mm,
    edema: data.edema,
    measurement_context: data.measurement_context,
  };
  if (data.wantsExtra && data.sk_clinical !== undefined) {
    args.strongkids = {
      clinical_assessment_poor_nutritional_status: data.sk_clinical,
      high_risk_disease: data.sk_disease,
      reduced_intake_or_losses: data.sk_intake,
      weight_loss_or_poor_gain: data.sk_weightloss,
    };
  }

  try {
    const screenResult = await callUnder5IntegratedScreen(args, env);
    return await explainUnder5ScreeningResult(screenResult, env);
  } catch (err) {
    console.error("under5_integrated_screen call failed:", err);
    return `Sorry, the screening tool couldn't complete: ${err instanceof Error ? err.message : String(err)}. Please try again in a moment.`;
  }
}
