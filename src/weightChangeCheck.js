/**
 * Quick percent weight change check — a short calculator (current weight,
 * usual/baseline weight, and an optional time frame) that calls the
 * Chakudya MCP server's percent_weight_change_calculator tool:
 *   % weight change = [(usual weight - current weight) / usual weight] x 100
 * A positive result is weight LOSS. When a time frame is given, the tool
 * also returns the significant/severe weight-loss interpretation
 * (Width & Reinhard) for that time frame in the same call.
 *
 * Same shape as bmiCheck.js / heightEstimate.js: shared session machinery
 * from screeningShared.js, one MCP call, deterministic formatting.
 * Session kind: "weight_change_check".
 */

import { saveSession, loadSession, clearSession, parseNumber, isCancel, isSkip, callMcpTool } from "./screeningShared.js";

const SESSION_KIND = "weight_change_check";

// Rough plausibility bounds only (catch unit/typing mistakes), not clinical thresholds.
const WEIGHT_BOUNDS = { min: 2, max: 300 };

// ── Trigger phrase ──
// Needs "weight change/loss/gain" (or "weight" and a losing/gaining verb within a few words of each
// other, either order — e.g. "how much weight did I lose") plus a computation cue, so an unrelated
// mention of weight loss (e.g. inside a screening flow's own questions) doesn't get swallowed by
// this calculator.
const TOPIC_RE =
  /\bweight\s+(?:change|loss|gain)\b|\bweight\b(?:\W+\w+){0,3}?\W+(?:lost|lose|losing|gained?|gaining)\b|\b(?:lost|lose|losing|gained?|gaining)\b(?:\W+\w+){0,3}?\W+weight\b/i;
const CUE_RE = /\b(check|calculate|compute|get|find|know|quick|my|our|percent(?:age)?|how\s+much)\b/i;

export function detectWeightChangeTrigger(text) {
  const t = text.trim();
  return TOPIC_RE.test(t) && CUE_RE.test(t);
}

/** Sample prompt for the quick-calculators sub-menu row; must (and, per test, does) trigger this flow only. */
export const WEIGHT_CHANGE_SAMPLE_PROMPT = "Check percent weight change";

export function parseTimeFrame(text) {
  const t = text.trim().toLowerCase();
  if (/^(1\s*w(eek)?s?|one\s*week|7\s*days?)$/.test(t)) return "1_week";
  if (/^(1\s*m(onth)?s?|one\s*month|4\s*weeks?|30\s*days?)$/.test(t)) return "1_month";
  if (/^(3\s*m(onth)?s?|three\s*months?|90\s*days?)$/.test(t)) return "3_months";
  if (/^(6\s*m(onth)?s?|six\s*months?|180\s*days?)$/.test(t)) return "6_months";
  return null;
}

// ── Prompts ──

export function promptFor(step) {
  switch (step) {
    case "current":
      return "Let's check percent weight change ⚖️\n\nWhat is the CURRENT weight in kilograms? (e.g. *58*). Reply *cancel* anytime to stop.";
    case "usual":
      return "And the USUAL (baseline) weight before the change, in kilograms? (e.g. *65*).";
    case "timeframe":
      return "Over what time frame did this happen? Reply *1 week*, *1 month*, *3 months*, *6 months*, or *skip* if you're not sure — I can still work out the percent change without it.";
    default:
      return null;
  }
}

export function nextStep(step) {
  if (step === "current") return "usual";
  if (step === "usual") return "timeframe";
  return "finish";
}

/** current/usual weight are required; the time frame is the one optional/skippable field. */
export function applyReply(step, text) {
  switch (step) {
    case "current":
    case "usual": {
      const v = parseNumber(text);
      if (v === null || v < WEIGHT_BOUNDS.min || v > WEIGHT_BOUNDS.max) {
        return { error: "That weight doesn't look right. Please reply in kilograms (e.g. *60*)." };
      }
      return { advance: true, value: v };
    }
    case "timeframe": {
      if (isSkip(text)) return { advance: true, value: undefined };
      const v = parseTimeFrame(text);
      if (!v) return { error: "Please reply *1 week*, *1 month*, *3 months*, *6 months*, or *skip*." };
      return { advance: true, value: v };
    }
    default:
      return { finish: true };
  }
}

// ── Result formatting (deterministic) ──

export function formatWeightChangeResult(result, data = {}) {
  if (!result) return "No percent weight change could be calculated. Please check the two weights and try again.";
  const pct = Math.abs(result.percent_weight_change);
  const directionLabel = result.direction === "loss" ? "weight loss" : result.direction === "gain" ? "weight gain" : "no change";

  const lines = [
    "⚖️ *Percent weight change*",
    `Usual ${data.usual_weight_kg} kg → current ${data.current_weight_kg} kg`,
    "",
    `*${pct}% ${directionLabel}*${result.time_frame ? ` over ${result.time_frame}` : ""}`,
  ];
  if (result.significance) lines.push("", `*${result.significance}*`);
  lines.push(
    "",
    "_Estimate/reference only, from a hospital dietetics anthropometry guideline — not a substitute for individualized clinical assessment._"
  );
  return lines.join("\n");
}

// ── Entry point ──

/**
 * Handles one incoming text message as part of (or the start of) a weight-change-check flow.
 * Returns a reply string if handled, or `null` if not (caller should fall through).
 */
export async function handleWeightChangeFlow(userText, from, env) {
  const session = await loadSession(SESSION_KIND, from, env);

  if (!session) {
    if (!detectWeightChangeTrigger(userText)) return null;
    await saveSession(SESSION_KIND, from, {}, "current", env);
    return promptFor("current");
  }

  if (isCancel(userText)) {
    await clearSession(SESSION_KIND, from, env);
    return 'Cancelled. Start again anytime by saying "check percent weight change".';
  }

  const { step, data } = session;
  const stepResult = applyReply(step, userText);

  if ("error" in stepResult) return `${stepResult.error}\n\n${promptFor(step)}`;

  if (step === "current") data.current_weight_kg = stepResult.value;
  if (step === "usual") data.usual_weight_kg = stepResult.value;
  if (step === "timeframe") data.time_frame = stepResult.value;

  const next = nextStep(step);
  if (next !== "finish") {
    await saveSession(SESSION_KIND, from, data, next, env);
    return promptFor(next);
  }

  // ── Run the calculation ──
  await clearSession(SESSION_KIND, from, env); // clear before the call so a crash never leaves a stuck session
  if (data.current_weight_kg === undefined || data.usual_weight_kg === undefined) {
    return 'I don\'t have enough information to check weight change. Say "check percent weight change" to start again.';
  }

  const args = { current_weight_kg: data.current_weight_kg, usual_weight_kg: data.usual_weight_kg };
  if (data.time_frame) args.time_frame = data.time_frame;

  let toolResult;
  try {
    toolResult = await callMcpTool("percent_weight_change_calculator", args, env);
  } catch (err) {
    console.error("percent_weight_change_calculator call failed:", err);
    return `Sorry, the calculation couldn't be completed: ${err instanceof Error ? err.message : String(err)}. Please try again in a moment.`;
  }

  return formatWeightChangeResult(toolResult, data);
}
