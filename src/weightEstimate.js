/**
 * Body-weight ESTIMATE for a patient aged 65+ who cannot be weighed —
 * multi-turn WhatsApp intake flow that calls the Chakudya MCP server's
 * `weight_estimate_persons_65_and_older` tool (Lee & Nieman equations).
 *
 * This is a standalone calculator, NOT part of malnutrition screening:
 * the estimate is never fed into BMI or any classification. The published
 * equations have standard errors of roughly 4-5 kg for this age group, far
 * too coarse to classify anyone on; the screening flows therefore still ask
 * for a real weight. Every reply says so.
 *
 * Inputs: sex, age (must be 65+), mid-upper arm circumference and calf
 * circumference (both required), then OPTIONALLY a subscapular skinfold
 * (needs a caliper) and — only if a skinfold was given — knee height. Knee
 * height on its own is never sent: the source has no equation that uses it
 * without the skinfold, so the tool would silently ignore it.
 *
 * Same architecture as the other flows (deterministic questions, one
 * deterministic MCP call with only what the health worker supplied,
 * deterministic formatting — no LLM narration at all here). Shared plumbing is
 * in ./screeningShared.js; the same CHAKUDYA_MCP binding and
 * CHAKUDYA_MCP_AUTH_TOKEN secret are reused.
 *
 * The 6-80 year, race-specific knee-height + arm-circumference tool
 * (weight_from_knee_height_and_mac) is not offered: it needs the person's
 * race, which this bot does not ask. It stays available by calling the MCP
 * server directly.
 *
 * Session kind: "weight_estimate".
 */

import {
  saveSession,
  loadSession,
  clearSession,
  parseSex,
  parseAgeFlexible,
  parseNumber,
  parseYesNo,
  isCancel,
  isDone,
  isSkip,
  estimateAgeMonths,
  callMcpTool,
} from "./screeningShared.js";

const SESSION_KIND = "weight_estimate";
const MIN_AGE_MONTHS = 65 * 12;

// ── Trigger phrase ──
// Needs an "estimate/predict" word, the word "weight", and a person-ish word — or an explicit "can't weigh".
// Weight-loss, ideal-weight and energy/meal-plan requests that happen to mention weight are excluded.
const ESTIMATE_RE = /\b(estimat(?:e|es|ing|ion)|predict(?:ing|ion)?)\b/i;
const WEIGHT_RE = /\b(?:body\s+)?weight\b/i;
const PERSON_RE =
  /\b(patients?|clients?|elderly|older (?:adult|person|people|man|woman)|seniors?|bedridden|bed-bound|grand(?:mother|father|ma|pa)|man|men|woman|women|person)\b/i;
const CANNOT_WEIGH_RE = /\b(can'?t|cannot|can not|unable to|not able to|couldn'?t)\s+(?:be\s+)?weigh(?:ed)?\b/i;
const NOT_THIS_RE =
  /\bweight\s+(?:loss|gain|change|management)\b|\b(?:ideal|usual|target|healthy|goal|dry)\s+(?:body\s+)?weight\b|\d\s*kg\b|\b(?:energy|calorie|calories|kcal|requirements?|bee|meal\s*plan|diet)\b/i;

export function detectWeightEstimateTrigger(text) {
  const t = text.trim();
  if (NOT_THIS_RE.test(t)) return false;
  if (CANNOT_WEIGH_RE.test(t)) return true;
  return ESTIMATE_RE.test(t) && WEIGHT_RE.test(t) && PERSON_RE.test(t);
}

// ── Parsing ──

/**
 * Circumference in cm. Accepts "27.5", "27.5cm", "275mm", or a bare "275" (>= 100 is read as mm, matching the
 * mm convention the screening flows use for MUAC). Returns null when there is no number.
 */
export function parseCircumferenceCm(text) {
  const m = text.trim().toLowerCase().match(/(\d+(?:\.\d+)?)\s*(mm|cm)?/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (m[2] === "mm") return Math.round(v) / 10;
  if (m[2] === "cm") return v;
  return v >= 100 ? Math.round(v) / 10 : v;
}

// Gross plausibility bounds only (catch unit/typing mistakes), not clinical thresholds.
const BOUNDS = {
  muac_cm: { min: 10, max: 50 },
  calf_cm: { min: 15, max: 60 },
  ssf_mm: { min: 2, max: 60 },
  kh_cm: { min: 35, max: 70 },
};

// ── Prompts ──

export function promptFor(step) {
  switch (step) {
    case "sex":
      return "Let's estimate body weight for a patient aged 65 or older who can't be weighed ⚖️\n\nIs the patient a man or a woman? (Reply *man* or *woman*. Reply *cancel* anytime to stop.)";
    case "age":
      return "How old is the patient? This estimate is for people 65 and older. Reply like *72 years*.";
    case "muac":
      return "Mid-upper arm circumference (MUAC): with the arm relaxed, measure around the midpoint between the tip of the shoulder and the elbow. Reply in cm (e.g. *27.5*) — mm also works (e.g. *275*).";
    case "calf":
      return "Calf circumference: with the knee bent to a right angle (sitting, or lying with the knee raised), measure around the widest part of the calf. Reply in cm (e.g. *31.5*).";
    case "extra_gate":
      return "Do you also have a subscapular skinfold measurement (needs a skinfold caliper)? It makes the estimate more precise. Reply *yes* or *no*.";
    case "ssf":
      return "Subscapular skinfold in mm (e.g. *12*). Reply *skip* to estimate without it.";
    case "kh":
      return "Knee height in cm (e.g. *50*) improves precision a little further. Reply *skip* if not available.";
    default:
      return null;
  }
}

export function nextStep(step, data) {
  switch (step) {
    case "sex":
      return "age";
    case "age":
      return "muac";
    case "muac":
      return "calf";
    case "calf":
      return "extra_gate";
    case "extra_gate":
      return data.wantsSkinfold ? "ssf" : "finish";
    case "ssf":
      // knee height is only usable together with the skinfold (no equation uses it without one)
      return data.ssf_mm !== undefined ? "kh" : "finish";
    default:
      return "finish";
  }
}

/**
 * Applies the user's reply to the current step. Returns:
 *   { error } | { advance: true } | { finish: true } | { tooYoung: true }
 */
export function applyReply(step, text, data) {
  // muac and calf are required, so they cannot be skipped; everything else may be.
  if (isSkip(text) && ["ssf", "kh"].includes(step)) return { advance: true };

  switch (step) {
    case "sex": {
      const v = parseSex(text);
      if (!v) return { error: "Please reply *man* or *woman*." };
      data.sex = v;
      return { advance: true };
    }
    case "age": {
      const v = parseAgeFlexible(text, { bareAsYears: true });
      if (!v) return { error: "Please reply like *72 years*." };
      Object.assign(data, v);
      if (v.date_of_birth) data.assessment_date = new Date().toISOString().slice(0, 10);
      const months = estimateAgeMonths(data);
      if (months === null || months < 0) return { error: "That age doesn't look right. Please try again." };
      if (months < MIN_AGE_MONTHS) return { tooYoung: true };
      return { advance: true };
    }
    case "muac": {
      const v = parseCircumferenceCm(text);
      if (v === null) return { error: "Please reply with the arm circumference in cm (e.g. *27.5*). I need it to estimate weight." };
      if (v < BOUNDS.muac_cm.min || v > BOUNDS.muac_cm.max) {
        return { error: "That arm circumference looks off. Please re-measure and reply in cm (e.g. *27.5*)." };
      }
      data.muac_cm = v;
      return { advance: true };
    }
    case "calf": {
      const v = parseCircumferenceCm(text);
      if (v === null) return { error: "Please reply with the calf circumference in cm (e.g. *31.5*). I need it to estimate weight." };
      if (v < BOUNDS.calf_cm.min || v > BOUNDS.calf_cm.max) {
        return { error: "That calf circumference looks off. Please re-measure and reply in cm (e.g. *31.5*)." };
      }
      data.calf_cm = v;
      return { advance: true };
    }
    case "extra_gate": {
      if (isDone(text)) return { finish: true };
      const v = parseYesNo(text);
      if (!v || v === "skip") return { error: "Please reply *yes* or *no*." };
      data.wantsSkinfold = v === "yes";
      return { advance: true };
    }
    case "ssf": {
      const raw = text.trim().toLowerCase();
      let v = parseNumber(raw);
      if (v === null) return { error: "Please reply with the skinfold in mm (e.g. *12*), or *skip*." };
      if (/cm\b/.test(raw)) v *= 10;
      if (v < BOUNDS.ssf_mm.min || v > BOUNDS.ssf_mm.max) {
        return { error: "That skinfold looks off. Please reply in mm (e.g. *12*), or *skip*." };
      }
      data.ssf_mm = v;
      return { advance: true };
    }
    case "kh": {
      const v = parseNumber(text);
      if (v === null) return { error: "Please reply with the knee height in cm (e.g. *50*), or *skip*." };
      if (v < BOUNDS.kh_cm.min || v > BOUNDS.kh_cm.max) {
        return { error: "That knee height looks off. Please reply in cm (e.g. *50*), or *skip*." };
      }
      data.kh_cm = v;
      return { advance: true };
    }
    default:
      return { finish: true };
  }
}

// ── MCP call arguments ──

export function buildEstimateArgs(data) {
  const args = {
    sex: data.sex,
    mid_arm_circumference_cm: data.muac_cm,
    calf_circumference_cm: data.calf_cm,
  };
  if (data.ssf_mm !== undefined) {
    args.subscapular_skinfold_mm = data.ssf_mm;
    if (data.kh_cm !== undefined) args.knee_height_cm = data.kh_cm; // only ever sent together with the skinfold
  }
  return args;
}

// ── Result formatting (deterministic) ──

const INPUT_LABELS = { muac: "arm circumference", cc: "calf circumference", ssf: "skinfold", kh: "knee height" };

export function formatWeightEstimateResult(result, data = {}) {
  const estimates = result.estimates ?? [];
  if (estimates.length === 0) return "The tool returned no estimate. Please check the measurements and try again.";
  const best = estimates[0]; // the tool sorts by lowest standard error first

  const used = [`arm ${data.muac_cm ?? "?"} cm`, `calf ${data.calf_cm ?? "?"} cm`];
  if (data.ssf_mm !== undefined) used.push(`skinfold ${data.ssf_mm} mm`);
  if (data.kh_cm !== undefined && data.ssf_mm !== undefined) used.push(`knee height ${data.kh_cm} cm`);

  const lines = [
    "⚖️ *Estimated body weight (65+)*",
    `${result.sex === "female" ? "Woman" : "Man"}${data.age_years !== undefined ? `, ${data.age_years} years` : ""}`,
    `Measurements: ${used.join(", ")}`,
    "",
    `*≈ ${Math.round(best.estimated_weight_kg * 10) / 10} kg* — most precise equation (standard error ±${best.see_kg} kg)`,
  ];

  const others = estimates.slice(1);
  if (others.length > 0) {
    lines.push(
      `Less precise: ${others
        .map((e) => `${Math.round(e.estimated_weight_kg * 10) / 10} kg (±${e.see_kg}, using ${e.inputs_used.map((k) => INPUT_LABELS[k] ?? k).join(" + ")})`)
        .join("; ")}`
    );
  }

  lines.push(
    "",
    `_An estimate, not a measurement: the typical error is about ±${best.see_kg} kg and an individual can be further out. It is not used to classify malnutrition (BMI, MUST or NACS) — weigh the patient as soon as a scale is available._`
  );
  return lines.join("\n");
}

// ── Entry point ──

/**
 * Handles one incoming text message as part of (or the start of) a weight-estimate flow.
 * Returns a reply string if handled, or `null` if not (caller should fall through).
 */
export async function handleWeightEstimateFlow(userText, from, env) {
  const session = await loadSession(SESSION_KIND, from, env);

  if (!session) {
    if (!detectWeightEstimateTrigger(userText)) return null;
    await saveSession(SESSION_KIND, from, {}, "sex", env);
    return promptFor("sex");
  }

  if (isCancel(userText)) {
    await clearSession(SESSION_KIND, from, env);
    return 'Cancelled. Start again anytime by saying "estimate weight for a patient".';
  }

  const { step, data } = session;
  const result = applyReply(step, userText, data);

  if ("error" in result) return `${result.error}\n\n${promptFor(step)}`;

  if ("tooYoung" in result) {
    await clearSession(SESSION_KIND, from, env);
    return (
      "This estimate is only for people aged 65 and older — the equations behind it were built for that age group. " +
      "For a younger adult please weigh them directly (a chair or bed scale works if they can't stand)."
    );
  }

  const isFinishing = result.finish === true || nextStep(step, data) === "finish";

  if (!isFinishing) {
    const next = nextStep(step, data);
    await saveSession(SESSION_KIND, from, data, next, env);
    return promptFor(next);
  }

  // ── Run the estimate ──
  await clearSession(SESSION_KIND, from, env); // clear before the call so a crash never leaves a stuck session
  if (data.sex === undefined || data.muac_cm === undefined || data.calf_cm === undefined) {
    return 'I\'m missing a measurement, so I can\'t estimate. Say "estimate weight for a patient" to start again.';
  }

  try {
    const estimate = await callMcpTool("weight_estimate_persons_65_and_older", buildEstimateArgs(data), env);
    const ageYears = data.age_years !== undefined ? data.age_years : Math.floor(estimateAgeMonths(data) / 12);
    return formatWeightEstimateResult(estimate, { ...data, age_years: ageYears });
  } catch (err) {
    console.error("weight_estimate_persons_65_and_older call failed:", err);
    return `Sorry, the estimate couldn't be completed: ${err instanceof Error ? err.message : String(err)}. Please try again in a moment.`;
  }
}
