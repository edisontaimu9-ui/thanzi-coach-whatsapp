/**
 * Quick BMI check — a short, two-question calculator that calls the Chakudya
 * MCP server's bmi_classification tool (WHO 2000 bands with comorbidity
 * risk, and the Malawi NCST Guidelines 2015 bands, both for the same BMI
 * value since they use different cut-offs).
 *
 * This exists because none of the screening flows answer a bare "BMI for
 * 70 kg 170 cm" — BMI only ever appears there bundled inside a full
 * malnutrition screen (age, MUAC, oedema, weight loss, ...). This is the
 * two-question version for someone who just wants the number and its
 * classification, no screening attached.
 *
 * Same session machinery as the other standalone flows (screeningShared.js);
 * same "one MCP call, deterministic formatting" shape as heightEstimate.js.
 * Session kind: "bmi_check".
 */

import { saveSession, loadSession, clearSession, parseNumber, isCancel, callMcpTool } from "./screeningShared.js";

const SESSION_KIND = "bmi_check";

// Rough plausibility bounds only (catch unit/typing mistakes), not clinical thresholds.
const BOUNDS = {
  weight_kg: { min: 2, max: 300 },
  height_cm: { min: 40, max: 250 },
};

// A child this short almost certainly isn't who these adult-oriented bands are meant for
// (WHO 2000 and Malawi NCST 2015 BMI bands are both adult classifications) — see the note
// added in formatBmiResult below. ~140cm is a rough proxy for "likely under about 12".
const CHILD_HEIGHT_HINT_CM = 140;

// ── Trigger phrase ──
// Needs the word "bmi" plus a computation cue (check/calculate/my/for/quick), so a genuine
// question like "what is bmi" or "how is bmi calculated" (no cue) falls through to general Q&A
// instead of starting this calculator.
const BMI_CALC_RE =
  /\b(?:check|calculate|compute|get|find|know|quick)\s+(?:my\s+|our\s+|the\s+|a\s+|)?bmi\b|\bbmi\s+check\b|\bmy\s+bmi\b|\bwhat'?s\s+my\s+bmi\b|\bwhat\s+is\s+my\s+bmi\b|\bbmi\s+for\b|\bbmi\s+of\s+\d/i;

export function detectBmiCheckTrigger(text) {
  return BMI_CALC_RE.test(text.trim());
}

/** Sample prompt for the quick-calculators sub-menu row; must (and, per test, does) trigger this flow only. */
export const BMI_CHECK_SAMPLE_PROMPT = "Check my BMI";

// ── Prompts ──

export function promptFor(step) {
  switch (step) {
    case "weight":
      return "Let's do a quick BMI check ⚖️\n\nWhat is the weight in kilograms? (e.g. *62*). Reply *cancel* anytime to stop.";
    case "height":
      return "And the height in centimetres? (e.g. *165*).";
    default:
      return null;
  }
}

export function nextStep(step) {
  if (step === "weight") return "height";
  return "finish";
}

/** Every field is required — a BMI needs both weight and height, so there is no "skip" here. */
export function applyReply(step, text) {
  switch (step) {
    case "weight": {
      const v = parseNumber(text);
      if (v === null || v < BOUNDS.weight_kg.min || v > BOUNDS.weight_kg.max) {
        return { error: "That weight doesn't look right. Please reply in kilograms (e.g. *62*)." };
      }
      return { advance: true, value: v };
    }
    case "height": {
      const v = parseNumber(text);
      if (v === null || v < BOUNDS.height_cm.min || v > BOUNDS.height_cm.max) {
        return { error: "That height doesn't look right. Please reply in centimetres (e.g. *165*)." };
      }
      return { advance: true, value: v };
    }
    default:
      return { finish: true };
  }
}

// ── Result formatting (deterministic) ──

export function formatBmiResult(result, data = {}) {
  if (!result) return "No BMI could be calculated. Please check the weight and height and try again.";
  const lines = [
    "⚖️ *BMI check*",
    `Weight ${data.weight_kg} kg, height ${data.height_cm} cm`,
    "",
    `*BMI ${result.bmi}*`,
    `WHO 2000: ${result.who_2000.classification} (${result.who_2000.risk_of_comorbidities.toLowerCase()})`,
    `Malawi NCST 2015: ${result.ncst_2015.classification}`,
  ];
  if (data.height_cm !== undefined && data.height_cm < CHILD_HEIGHT_HINT_CM) {
    lines.push(
      "",
      '⚠️ _These are adult BMI bands and may not apply to a child this height — for a child, try "screen a child for malnutrition" instead._'
    );
  }
  lines.push("", "_Classification/reference only, per the cited source tables — not a substitute for a full clinical nutrition assessment._");
  return lines.join("\n");
}

// ── Entry point ──

/**
 * Handles one incoming text message as part of (or the start of) a BMI-check flow.
 * Returns a reply string if handled, or `null` if not (caller should fall through).
 */
export async function handleBmiCheckFlow(userText, from, env) {
  const session = await loadSession(SESSION_KIND, from, env);

  if (!session) {
    if (!detectBmiCheckTrigger(userText)) return null;
    await saveSession(SESSION_KIND, from, {}, "weight", env);
    return promptFor("weight");
  }

  if (isCancel(userText)) {
    await clearSession(SESSION_KIND, from, env);
    return 'Cancelled. Start again anytime by saying "check my BMI".';
  }

  const { step, data } = session;
  const stepResult = applyReply(step, userText);

  if ("error" in stepResult) return `${stepResult.error}\n\n${promptFor(step)}`;

  if (step === "weight") data.weight_kg = stepResult.value;
  if (step === "height") data.height_cm = stepResult.value;

  const next = nextStep(step);
  if (next !== "finish") {
    await saveSession(SESSION_KIND, from, data, next, env);
    return promptFor(next);
  }

  // ── Run the check ──
  await clearSession(SESSION_KIND, from, env); // clear before the call so a crash never leaves a stuck session
  if (data.weight_kg === undefined || data.height_cm === undefined) {
    return 'I don\'t have enough information to check BMI. Say "check my BMI" to start again.';
  }

  let toolResult;
  try {
    toolResult = await callMcpTool("bmi_classification", { weight_kg: data.weight_kg, height_cm: data.height_cm }, env);
  } catch (err) {
    console.error("bmi_classification call failed:", err);
    return `Sorry, the BMI check couldn't be completed: ${err instanceof Error ? err.message : String(err)}. Please try again in a moment.`;
  }

  return formatBmiResult(toolResult, data);
}
