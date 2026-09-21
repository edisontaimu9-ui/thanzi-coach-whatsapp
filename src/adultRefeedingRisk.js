/**
 * ASPEN refeeding syndrome risk check for adults — a short FOLLOW-UP offered
 * automatically right after an adult NACS screen (./adultScreening.js) comes
 * back "severe" or "moderate", calling the Chakudya MCP server's
 * aspen_refeeding_risk_adult tool (ASPEN Consensus Recommendations for
 * Refeeding Syndrome, Table 3).
 *
 * DELIBERATELY NOT a public quick calculator: it has no free-text trigger
 * phrase and is never listed in ./estimateMenu.js. It only ever starts via
 * beginAdultRefeedingRisk(), called from adultScreening.js's own finishing
 * step. Two of the tool's criteria are auto-filled from what the screen
 * already computed (BMI) or already asked, and the rest need a health
 * worker's own clinical judgement against the ASPEN wording — this is why
 * the flow only exists as a follow-up inside a screening a health worker is
 * already running, not something offered to the public:
 *   - bmi: taken from the just-completed screen's result, not re-asked.
 *   - caloric_intake_level / prefeeding_electrolyte_abnormality_level: the
 *     two criteria the tool's own description says are a "clinician's
 *     qualitative read of a compound description" — asked here as a
 *     3-option choice per Table 3's wording.
 * The tool's other three optional criteria (physical-exam fat/muscle loss,
 * comorbidity severity, weight-loss percent+timeframe) are left out to keep
 * this a two-question follow-up rather than a second mini-assessment; the
 * tool works fine with a partial set of criteria (adult risk only needs 1
 * criterion at "significant" or 2 at "moderate" or higher).
 *
 * Same session machinery as the other flows (screeningShared.js). Session
 * kind: "adult_refeeding_risk".
 */

import { saveSession, loadSession, clearSession, parseYesNo, isCancel, callMcpTool } from "./screeningShared.js";

const SESSION_KIND = "adult_refeeding_risk";

const SEVERITY_LABELS = { severe: "SEVERE", moderate: "MODERATE" };

// ── Prompts ──

export function promptFor(step, data = {}) {
  switch (step) {
    case "gate":
      return (
        `This is a *${SEVERITY_LABELS[data.severity] ?? data.severity}* result. Refeeding too quickly after this level ` +
        "of malnutrition can be dangerous. Would you like to also check ASPEN refeeding syndrome risk before " +
        "feeding starts or increases? This needs your own clinical judgement on the person's recent food/fluid " +
        "intake and their prefeeding electrolytes (potassium, phosphorus, magnesium) — reply *yes* or *no*."
      );
    case "intake":
      return (
        "Caloric intake pattern — which best matches, per ASPEN Table 3?\n" +
        "1) MODERATE: none/negligible intake for 5–6 days, OR <75% of estimated needs for >7 days during acute " +
        "illness/injury, OR <75% of needs for >1 month\n" +
        "2) SIGNIFICANT: none/negligible intake for >7 days, OR <50% of estimated needs for >5 days during acute " +
        "illness/injury, OR <50% of needs for >1 month\n" +
        "3) Neither of the above\n" +
        "Reply 1, 2, or 3."
      );
    case "electrolytes":
      return (
        "Prefeeding electrolytes (potassium, phosphorus, magnesium) — which best matches?\n" +
        "1) MODERATE: minimally low or normal now, but with a recent low level needing only minimal/single-dose " +
        "supplementation\n" +
        "2) SIGNIFICANT: moderately or significantly low now, OR needing significant/multiple-dose " +
        "supplementation\n" +
        "3) Normal, no recent abnormality\n" +
        "Reply 1, 2, or 3.\n\n" +
        "_Electrolytes can look normal despite a real total-body deficiency — use your clinical judgement, not " +
        "just the lab number._"
      );
    default:
      return null;
  }
}

export function nextStep(step, data) {
  if (step === "gate") return data.wantsCheck ? "intake" : "finish";
  if (step === "intake") return "electrolytes";
  return "finish";
}

function parseLevelChoice(text) {
  const t = text.trim();
  if (t === "1") return "moderate";
  if (t === "2") return "significant";
  if (t === "3") return "none";
  return null;
}

/**
 * Applies the user's reply to the current step. Returns { error } | { advance: true } | { finish: true }.
 * A "no" at the gate ends the follow-up with no tool call — this check is always opt-in.
 */
export function applyReply(step, text, data) {
  switch (step) {
    case "gate": {
      const v = parseYesNo(text);
      if (!v || v === "skip") return { error: "Please reply *yes* or *no*." };
      data.wantsCheck = v === "yes";
      return { advance: true };
    }
    case "intake": {
      const v = parseLevelChoice(text);
      if (!v) return { error: "Please reply 1, 2, or 3." };
      data.caloric_intake_level = v;
      return { advance: true };
    }
    case "electrolytes": {
      const v = parseLevelChoice(text);
      if (!v) return { error: "Please reply 1, 2, or 3." };
      data.prefeeding_electrolyte_abnormality_level = v;
      return { advance: true };
    }
    default:
      return { finish: true };
  }
}

// ── Result formatting (deterministic) ──

const CRITERION_LABELS = {
  bmi: "BMI",
  caloric_intake: "Caloric intake pattern",
  prefeeding_electrolyte_abnormality: "Prefeeding electrolyte abnormality",
};

const RISK_LABELS = {
  significant: "⚠️ SIGNIFICANT RISK for refeeding syndrome",
  moderate: "⚠️ MODERATE RISK for refeeding syndrome",
  not_at_risk_by_these_criteria: "Not at risk by these criteria",
};

export function formatRefeedingRiskResult(result) {
  if (!result) return "No refeeding risk could be calculated. Please try again.";
  const lines = ["🩺 *ASPEN refeeding syndrome risk (adult)*", ""];
  for (const c of result.criteria) lines.push(`• ${CRITERION_LABELS[c.criterion] ?? c.criterion}: ${c.level}`);
  lines.push("", `*${RISK_LABELS[result.overallRisk] ?? result.overallRisk}*`, `_${result.rule}_`);
  lines.push(
    "",
    "_Classification only, per ASPEN Consensus Recommendations for Refeeding Syndrome (da Silva et al, Nutr " +
      "Clin Pract. 2020;35(2):178-195) — expert consensus, not randomized-trial evidence. Not a substitute for " +
      "individualized clinical assessment._"
  );
  return lines.join("\n");
}

// ── Entry points ──

/**
 * Starts the follow-up right after an adult screen comes back severe/moderate. `bmi` (may be
 * undefined/null if none was computed) is carried over from that result rather than re-asked.
 * Returns the gate question to append to the screening result message.
 */
export async function beginAdultRefeedingRisk(from, env, { bmi, severity } = {}) {
  const data = { severity };
  if (bmi !== undefined && bmi !== null) data.bmi = bmi;
  await saveSession(SESSION_KIND, from, data, "gate", env);
  return promptFor("gate", data);
}

/**
 * Handles one incoming text message as part of an already-started refeeding-risk follow-up.
 * Returns a reply string if a session is active, or `null` if not (caller should fall through) —
 * there is no free-text trigger to start this cold; it only ever begins via beginAdultRefeedingRisk.
 */
export async function handleAdultRefeedingRiskFlow(userText, from, env) {
  const session = await loadSession(SESSION_KIND, from, env);
  if (!session) return null;

  if (isCancel(userText)) {
    await clearSession(SESSION_KIND, from, env);
    return "Cancelled.";
  }

  const { step, data } = session;
  const stepResult = applyReply(step, userText, data);

  if ("error" in stepResult) return `${stepResult.error}\n\n${promptFor(step, data)}`;

  if (step === "gate" && data.wantsCheck === false) {
    await clearSession(SESSION_KIND, from, env);
    return "No problem — you can always run this later if the situation changes.";
  }

  const isFinishing = stepResult.finish === true || nextStep(step, data) === "finish";

  if (!isFinishing) {
    const next = nextStep(step, data);
    await saveSession(SESSION_KIND, from, data, next, env);
    return promptFor(next, data);
  }

  // ── Run the check ──
  await clearSession(SESSION_KIND, from, env); // clear before the call so a crash never leaves a stuck session
  const args = {};
  if (data.bmi !== undefined) args.bmi = data.bmi;
  if (data.caloric_intake_level) args.caloric_intake_level = data.caloric_intake_level;
  if (data.prefeeding_electrolyte_abnormality_level) args.prefeeding_electrolyte_abnormality_level = data.prefeeding_electrolyte_abnormality_level;

  let toolResult;
  try {
    toolResult = await callMcpTool("aspen_refeeding_risk_adult", args, env);
  } catch (err) {
    console.error("aspen_refeeding_risk_adult call failed:", err);
    return `Sorry, the refeeding risk check couldn't be completed: ${err instanceof Error ? err.message : String(err)}. Please try again in a moment.`;
  }

  return formatRefeedingRiskResult(toolResult);
}
