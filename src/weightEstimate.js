/**
 * Body-weight ESTIMATE for a patient who cannot be weighed — multi-turn
 * WhatsApp intake flow that calls the Chakudya MCP server's weight tools
 * (Lee & Nieman equations):
 *   - weight_estimate_persons_65_and_older  — arm + calf circumference, optional
 *     subscapular skinfold and knee height; no race needed; ages 65+.
 *   - weight_from_knee_height_and_mac       — knee height + arm circumference,
 *     RACE-specific (black / white), ages 6-80 (bands 6-18, 19-59, 60-80).
 *
 * Which tool(s) run depends on age and what was measured:
 *   under 65 (6-64) -> knee height + arm + race (the only equation there);
 *   65-80           -> calf route and/or knee-height route, whichever was given;
 *   81+             -> calf route only.
 * Every applicable equation is computed and the most precise (lowest standard
 * error) is the headline. THE ERRORS ARE LARGE — about 4-5 kg for the 65+ set
 * and roughly 7-14.5 kg for the race-specific set (10.6-12 kg for adults
 * 19-59) — so the reply always shows the standard error, and warns when it is
 * large. Race is asked only when knee height was given, because those
 * equations are race-specific; it is held for this session only.
 *
 * This file also exports its step machine (promptFor / nextStep / applyReply /
 * plannedTools) so the adult screening flow (adultScreening.js) can ask the
 * same questions when a person can't be weighed. There the estimate is passed
 * to the MCP tool as raw measurements and used for BMI only — the result is
 * labelled as estimated, shows a BMI range, and never affects MUAC, oedema or
 * weight-loss findings.
 *
 * Same architecture as the other flows (deterministic questions, deterministic
 * MCP calls with only what the health worker supplied, deterministic
 * formatting — no LLM narration here). Shared plumbing is in
 * ./screeningShared.js; the same CHAKUDYA_MCP binding and
 * CHAKUDYA_MCP_AUTH_TOKEN secret are reused.
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
const ELDERLY_MIN_AGE_YEARS = 65; // the calf-circumference equations start here
const MIN_AGE_YEARS = 6; // the race-specific knee-height equations start here
// Age bands the race-specific knee-height equations cover (same as the MCP tool). Ages in the gaps (18-19, 59-60) have no equation.
const RACE_TOOL_BANDS = [
  [6, 18],
  [19, 59],
  [60, 80],
];

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

/** Sample prompt for the greeting list's weight-estimate row; must (and, per test, does) trigger this flow only. */
export const WEIGHT_ESTIMATE_SAMPLE_PROMPT = "Estimate weight for a patient";

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

// ── Age helpers (the step machine is shared with the adult screening flow, whose data holds the same age fields) ──

function ageYearsOf(data) {
  const months = estimateAgeMonths(data);
  return months === null ? null : months / 12;
}

/** True when the race-specific knee-height equations have a band for this age. */
export function raceToolCovers(ageYears) {
  return RACE_TOOL_BANDS.some(([lo, hi]) => ageYears >= lo && ageYears <= hi);
}

/** True when at least one equation set can ever apply at this age (65+ always can; younger needs a race-tool band). */
export function estimationPossibleForAge(ageYears) {
  return ageYears >= ELDERLY_MIN_AGE_YEARS || raceToolCovers(ageYears);
}

export function parseRace(text) {
  const t = text.trim().toLowerCase();
  if (/^(black|b)$/.test(t)) return "black";
  if (/^(white|w)$/.test(t)) return "white";
  return null;
}

/** Which MCP tools the collected measurements support: "elderly" (65+ calf route) and/or "race" (knee height + race). */
export function plannedTools(data) {
  const age = ageYearsOf(data);
  const tools = [];
  if (age === null || data.muac_cm === undefined) return tools;
  if (age >= ELDERLY_MIN_AGE_YEARS && data.calf_cm !== undefined) tools.push("elderly");
  if (data.kh_cm !== undefined && data.race !== undefined && raceToolCovers(age)) tools.push("race");
  return tools;
}

// ── Prompts ──

export function promptFor(step) {
  switch (step) {
    case "sex":
      return "Let's estimate body weight for a patient who can't be weighed ⚖️\n\nIs the patient male or female? (Reply *male* or *female*. Reply *cancel* anytime to stop.)";
    case "age":
      return "How old is the patient? Reply like *72 years*. (Estimates cover ages 6 and up.)";
    case "muac":
      return "Mid-upper arm circumference (MUAC): with the arm relaxed, measure around the midpoint between the tip of the shoulder and the elbow. Reply in cm (e.g. *27.5*) — mm also works (e.g. *275*).";
    case "calf":
      return "Calf circumference: with the knee bent to a right angle (sitting, or lying with the knee raised), measure around the widest part of the calf. Reply in cm (e.g. *31.5*), or *skip* if you have knee height instead.";
    case "kh":
      return "Knee height in cm (e.g. *50*): with the knee and ankle each bent to a right angle, measure from the heel to the top of the knee. Reply *skip* if not available.";
    case "race":
      return "The knee-height equations are race-specific — they exist for *black* and *white* only. Which applies to the patient? Reply *black* or *white*.";
    case "extra_gate":
      return "Do you also have a subscapular skinfold measurement (needs a skinfold caliper)? It makes the estimate more precise. Reply *yes* or *no*.";
    case "ssf":
      return "Subscapular skinfold in mm (e.g. *12*). Reply *skip* to estimate without it.";
    default:
      return null;
  }
}

export function nextStep(step, data) {
  const age = ageYearsOf(data) ?? 0;
  const calfRoute = age >= ELDERLY_MIN_AGE_YEARS && data.calf_cm !== undefined; // skinfold only helps the 65+ calf equations
  switch (step) {
    case "sex":
      return "age";
    case "age":
      return "muac";
    case "muac":
      return age >= ELDERLY_MIN_AGE_YEARS ? "calf" : "kh";
    case "calf":
      return "kh";
    case "kh":
      if (data.kh_cm !== undefined && raceToolCovers(age)) return "race";
      return calfRoute ? "extra_gate" : "finish";
    case "race":
      return calfRoute ? "extra_gate" : "finish";
    case "extra_gate":
      return data.wantsSkinfold ? "ssf" : "finish";
    default:
      return "finish";
  }
}

/**
 * Applies the user's reply to the current step. Returns:
 *   { error } | { advance: true } | { finish: true } | { outOfRange: "under6" | "gap" }
 * Required measurements cannot be skipped: MUAC always; calf only when there is no knee-height route (81+);
 * knee height and race whenever there is no calf route (under 65).
 */
export function applyReply(step, text, data) {
  const age = ageYearsOf(data) ?? 0;
  const hasCalf = data.calf_cm !== undefined;

  if (isSkip(text)) {
    if (step === "ssf") return { advance: true };
    if (step === "calf") {
      if (raceToolCovers(age)) return { advance: true }; // a knee-height route exists for 65-80
      return { error: "For a patient over 80 I need the calf circumference — there is no knee-height equation for that age." };
    }
    if (step === "kh" || step === "race") {
      if (age >= ELDERLY_MIN_AGE_YEARS && hasCalf) return { advance: true };
      return { error: step === "kh" ? "I need the knee height — it is the only equation available at this age (or send the calf circumference for 65+)." : "I need to know which applies — the knee-height equations are race-specific." };
    }
  }

  switch (step) {
    case "sex": {
      const v = parseSex(text);
      if (!v) return { error: "Please reply *male* or *female*." };
      data.sex = v;
      return { advance: true };
    }
    case "age": {
      const v = parseAgeFlexible(text, { bareAsYears: true });
      if (!v) return { error: "Please reply like *72 years*." };
      Object.assign(data, v);
      if (v.date_of_birth) data.assessment_date = new Date().toISOString().slice(0, 10);
      const years = ageYearsOf(data);
      if (years === null || years < 0) return { error: "That age doesn't look right. Please try again." };
      if (years < MIN_AGE_YEARS) return { outOfRange: "under6" };
      if (!estimationPossibleForAge(years)) return { outOfRange: "gap" };
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
      if (v === null) return { error: "Please reply with the calf circumference in cm (e.g. *31.5*)." };
      if (v < BOUNDS.calf_cm.min || v > BOUNDS.calf_cm.max) {
        return { error: "That calf circumference looks off. Please re-measure and reply in cm (e.g. *31.5*)." };
      }
      data.calf_cm = v;
      return { advance: true };
    }
    case "kh": {
      const v = parseNumber(text);
      if (v === null) return { error: "Please reply with the knee height in cm (e.g. *50*), or *skip*." };
      if (v < BOUNDS.kh_cm.min || v > BOUNDS.kh_cm.max) {
        return { error: "That knee height looks off. Please re-measure and reply in cm (e.g. *50*), or *skip*." };
      }
      data.kh_cm = v;
      return { advance: true };
    }
    case "race": {
      const v = parseRace(text);
      if (!v) return { error: "Please reply *black* or *white*." };
      data.race = v;
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
    default:
      return { finish: true };
  }
}

// ── MCP calls ──

/** The MCP calls the collected measurements support, each as { tool, args } — only ever with what was supplied. */
export function buildEstimateCalls(data) {
  const age = ageYearsOf(data);
  const calls = [];
  for (const which of plannedTools(data)) {
    if (which === "elderly") {
      const args = { sex: data.sex, mid_arm_circumference_cm: data.muac_cm, calf_circumference_cm: data.calf_cm };
      if (data.ssf_mm !== undefined) {
        args.subscapular_skinfold_mm = data.ssf_mm;
        if (data.kh_cm !== undefined) args.knee_height_cm = data.kh_cm; // knee height only ever goes with the skinfold here
      }
      calls.push({ tool: "weight_estimate_persons_65_and_older", args });
    } else {
      calls.push({
        tool: "weight_from_knee_height_and_mac",
        args: {
          sex: data.sex,
          race: data.race,
          age_years: Math.round(age * 100) / 100,
          knee_height_cm: data.kh_cm,
          mid_arm_circumference_cm: data.muac_cm,
        },
      });
    }
  }
  return calls;
}

/** Normalises either tool's response to a list of { estimated_weight_kg, see_kg, using }. */
export function normaliseEstimates(tool, result) {
  if (tool === "weight_from_knee_height_and_mac") {
    return [
      {
        estimated_weight_kg: result.estimated_weight_kg,
        see_kg: result.see_kg,
        using: "arm circumference + knee height, race-specific equation",
      },
    ];
  }
  return (result.estimates ?? []).map((e) => ({
    estimated_weight_kg: e.estimated_weight_kg,
    see_kg: e.see_kg,
    using: e.inputs_used.map((k) => INPUT_LABELS[k] ?? k).join(" + "),
  }));
}

// ── Result formatting (deterministic) ──

const INPUT_LABELS = { muac: "arm circumference", cc: "calf circumference", ssf: "skinfold", kh: "knee height" };
const LARGE_ERROR_KG = 7; // above this, say plainly that the number is only a rough guide

export function formatWeightEstimateResult(estimates, data = {}, notes = []) {
  if (!estimates || estimates.length === 0) return "No estimate could be calculated. Please check the measurements and try again.";
  const sorted = [...estimates].sort((a, b) => a.see_kg - b.see_kg);
  const best = sorted[0];
  const r1 = (n) => Math.round(n * 10) / 10;

  const used = [`arm ${data.muac_cm ?? "?"} cm`];
  if (data.calf_cm !== undefined) used.push(`calf ${data.calf_cm} cm`);
  if (data.ssf_mm !== undefined) used.push(`skinfold ${data.ssf_mm} mm`);
  if (data.kh_cm !== undefined) used.push(`knee height ${data.kh_cm} cm`);

  const who = `${data.sex === "female" ? "Female" : "Male"}${data.age_years !== undefined ? `, ${data.age_years} years` : ""}`;
  const lines = [
    "⚖️ *Estimated body weight*",
    who,
    `Measurements: ${used.join(", ")}`,
    "",
    `*≈ ${r1(best.estimated_weight_kg)} kg* — most precise equation (standard error ±${best.see_kg} kg)`,
  ];

  const others = sorted.slice(1);
  if (others.length > 0) {
    lines.push(`Less precise: ${others.map((e) => `${r1(e.estimated_weight_kg)} kg (±${e.see_kg}, ${e.using})`).join("; ")}`);
  }
  if (best.see_kg >= LARGE_ERROR_KG) {
    lines.push("", `⚠️ The error of this equation is large (±${best.see_kg} kg) — treat the number as a rough guide only.`);
  }
  for (const n of notes) lines.push("", `_${n}_`);
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

  if ("outOfRange" in result) {
    await clearSession(SESSION_KIND, from, env);
    return result.outOfRange === "under6"
      ? "The weight equations only cover ages 6 and up. For a younger child please weigh them directly (a hanging or baby scale works)."
      : "There is no published equation for this exact age (roughly 18–19 or 59–60 years). Please weigh the patient directly if you can — a chair or bed scale works if they can't stand.";
  }

  const isFinishing = result.finish === true || nextStep(step, data) === "finish";

  if (!isFinishing) {
    const next = nextStep(step, data);
    await saveSession(SESSION_KIND, from, data, next, env);
    return promptFor(next);
  }

  // ── Run the estimate ──
  await clearSession(SESSION_KIND, from, env); // clear before the calls so a crash never leaves a stuck session
  const calls = buildEstimateCalls(data);
  if (data.sex === undefined || data.muac_cm === undefined || calls.length === 0) {
    return 'I don\'t have enough measurements to estimate weight. Say "estimate weight for a patient" to start again.';
  }

  const estimates = [];
  const notes = [];
  const failures = [];
  for (const { tool, args } of calls) {
    try {
      const out = await callMcpTool(tool, args, env);
      estimates.push(...normaliseEstimates(tool, out));
    } catch (err) {
      console.error(`${tool} call failed:`, err);
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (estimates.length === 0) {
    return `Sorry, the estimate couldn't be completed: ${failures.join("; ") || "no result"}. Please try again in a moment.`;
  }
  if (failures.length > 0) notes.push(`One equation could not be calculated (${failures.join("; ")}); the result above uses the others.`);

  const ageYears = data.age_years !== undefined ? data.age_years : Math.floor(ageYearsOf(data));
  return formatWeightEstimateResult(estimates, { ...data, age_years: ageYears }, notes);
}
