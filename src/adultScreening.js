/**
 * Adult (18+, not pregnant / not recently postpartum) malnutrition screening
 * — multi-turn WhatsApp intake flow that calls the Chakudya MCP server's
 * `adult_integrated_screen` tool. Covers adult men and non-pregnant women,
 * including older adults.
 *
 * Same architecture as the other screening flows (deterministic questions,
 * deterministic tool call with only what the health worker supplied,
 * deterministic formatting, optional Groq narration with the recommended
 * action + disclaimer appended verbatim, English only). Shared plumbing lives
 * in ./screeningShared.js. Reuses the CHAKUDYA_MCP service binding and
 * CHAKUDYA_MCP_AUTH_TOKEN secret — no new setup.
 *
 * NACS classification (oedema, MUAC, BMI, confirmed >10% weight loss) is the
 * primary result. An OPTIONAL 2-question MUST (BAPEN Malnutrition Universal
 * Screening Tool) risk check is offered when weight and height were given
 * (MUST needs a BMI); it is reported on a separate axis.
 *
 * HEIGHT ESTIMATE: if weight was given but standing height was skipped (bedridden,
 * frail, contractures), the flow offers ONE extra question — ULNA length — and
 * sends it as ulna_length_cm; the MCP tool estimates the height and labels every
 * BMI-based finding as an estimate. Knee height is not offered here: its
 * equations need the person's race, which this flow does not ask. It stays
 * available by calling adult_integrated_screen directly. Weight is never
 * estimated (the published equations are too coarse for a BMI).
 *
 * WEIGHT ESTIMATE: if weight is skipped (person can't be weighed) and MUAC was given, the
 * flow offers — as an explicit yes/no — to ESTIMATE weight, reusing the step machine in
 * ./weightEstimate.js (arm + calf for 65+; knee height + race, which is asked, for ages up
 * to 80). The raw measurements go to the MCP tool with estimate_weight_if_missing = true;
 * the MCP tool does the estimating and returns BMI as a labelled estimate with a range and
 * an "uncertain" flag when the error straddles a NACS cut-off. The standard errors are large
 * (about 4-5 kg for 65+, 7-14.5 kg for the race-specific set), so the reply says so and the
 * estimate only ever affects BMI (and MUST) — never the MUAC, oedema or weight-loss findings.
 * If height is also missing after that, the ulna question is asked at the end of this block.
 *
 * ROUTING: a woman under 50 is asked whether she is pregnant or recently
 * gave birth — "yes" hands over to the maternal flow. Under-18 ages are
 * turned away with a pointer to "screen a school child" / "screen a child".
 * (This file must not import schoolAgeScreening.js — that file imports this
 * one, and the import graph is kept one-directional.)
 *
 * Session kind: "adult_screening".
 */

import {
  saveSession,
  loadSession,
  clearSession,
  parseSex,
  parseAgeFlexible,
  parseNumber,
  parseMuacMm,
  parseYesNo,
  parseContext,
  isCancel,
  isDone,
  isSkip,
  estimateAgeMonths,
  ageArgs,
  looksLikeScreeningRequest,
  callMcpTool,
  recommendedActionBlock,
  withFlags,
  narrateWithGroq,
  NARRATION_RULES,
} from "./screeningShared.js";
import { beginPregnantPostpartumScreening } from "./pregnantPostpartumScreening.js";
import {
  applyReply as applyWeightEstimateReply,
  nextStep as nextWeightEstimateStep,
  promptFor as weightEstimatePrompt,
  plannedTools as weightEstimatePlannedTools,
  estimationPossibleForAge,
} from "./weightEstimate.js";

const SESSION_KIND = "adult_screening";
const ADULT_AGE_MONTHS = 216; // 18 years
const PREGNANCY_QUESTION_MAX_AGE_MONTHS = 50 * 12; // ask women under 50 whether they are pregnant / recently gave birth

// ── Trigger phrase ──
const POPULATION_RE =
  /\b(adults?|men|man|women|woman|patients?|clients?|elderly|older (?:adult|person|people)|grand(?:mother|father|ma|pa)|(?:[2-9]\d|1[0-2]\d)[\s-]*(?:year|yr)s?[\s-]*old)\b/i;

export function detectAdultScreeningTrigger(text) {
  return looksLikeScreeningRequest(text, POPULATION_RE);
}

// ── Prompts ──

export function promptFor(step) {
  if (step.startsWith("we_") && step !== "we_gate") return weightEstimatePrompt(step.slice(3));
  switch (step) {
    case "sex":
      return "Let's screen an adult for malnutrition risk 🩺\n\nIs the person a man or a woman? (Reply *man* or *woman*. Reply *cancel* anytime to stop.)";
    case "age":
      return "How old is the person? Reply like *45 years* or a birth date as *YYYY-MM-DD*.";
    case "pregnant":
      return "Is she pregnant, or has she recently given birth? Reply *yes* or *no*.";
    case "weight":
      return "What is the person's weight in kilograms? (e.g. *58.5*). Reply *skip* if it can't be measured — I can then offer to estimate it.";
    case "height":
      return "What is the person's standing height in centimetres? (e.g. *165*). Reply *skip* if not available.";
    case "we_gate":
      return "You skipped weight. If the person can't be weighed I can *estimate* it from body measurements (arm and calf, or knee height). It is only an estimate — the typical error is several kg, more for younger adults — so BMI will be shown as a range and flagged as uncertain. Estimate weight? Reply *yes* or *no*.";
    case "ulna":
    case "ulna_late":
      return "Can't stand for a height measurement? You can estimate it from ULNA length instead: with the arm bent and the palm across the chest, measure the LEFT forearm from the point of the elbow to the midpoint of the bony bump of the wrist. Reply in cm (e.g. *26.5*, between 18.5 and 32), or *skip*.";
    case "muac":
      return "What is the person's MUAC (mid-upper arm circumference), if measured? Reply in mm (e.g. *230*) or cm (e.g. *23cm*). Reply *skip* if not available.";
    case "edema":
      return "Does the person have bilateral pitting oedema (swelling on both feet)? Reply *yes*, *no*, or *skip* if unsure.";
    case "weight_loss":
      return "Has the person had CONFIRMED unintentional weight loss of more than 10% since their last visit? Reply *yes*, *no*, or *skip* if unknown.";
    case "context":
      return "Where is this screening happening? Reply:\n1) Community\n2) Health centre\n3) Nutrition rehabilitation\n4) Hospital\nOr reply *skip* for community (default).";
    case "must_gate":
      return "Would you like to also answer 2 quick questions for the MUST malnutrition-risk score? Reply *yes* or *no*. (Or reply *done* to screen with what you've given so far.)";
    case "must_wl":
      return "MUST Q1/2: Unplanned weight loss over the last 3–6 months? Reply:\n1) Less than 5%\n2) 5–10%\n3) More than 10%";
    case "must_acute":
      return "MUST Q2/2: Is the person acutely ill AND has had, or is likely to have, no food intake for more than 5 days? (yes/no)";
    default:
      return null;
  }
}

/** Next step id given the current step and the data collected so far. */
export function nextStep(step, data) {
  switch (step) {
    case "sex":
      return "age";
    case "age":
      return data.sex === "female" && estimateAgeMonths(data) < PREGNANCY_QUESTION_MAX_AGE_MONTHS ? "pregnant" : "weight";
    case "pregnant":
      return "weight";
    case "weight":
      return "height";
    case "height":
      // Weight but no standing height: offer the ulna-length estimate (it is only useful when a BMI can result)
      return data.weight_kg !== undefined && data.height_cm === undefined ? "ulna" : "muac";
    case "ulna":
      return "muac";
    case "muac":
      // Weight was skipped but arm circumference given: offer to estimate weight (only where an equation can apply at this age)
      return data.weight_kg === undefined && data.muac_mm !== undefined && estimationPossibleForAge(estimateAgeMonths(data) / 12) ? "we_gate" : "edema";
    case "we_gate":
      return data.estimateWeight ? `we_${nextWeightEstimateStep("muac", data)}` : "edema";
    case "ulna_late":
      return "edema";
    case "edema":
      return "weight_loss";
    case "weight_loss":
      return "context";
    case "context":
      // MUST needs a BMI, so only offer it when a weight (measured or estimated) AND a height (measured or estimated) can be had
      return bmiPossible(data) ? "must_gate" : "finish";
    case "must_gate":
      return data.wantsMust ? "must_wl" : "finish";
    case "must_wl":
      return "must_acute";
    default:
      if (step.startsWith("we_")) {
        const inner = nextWeightEstimateStep(step.slice(3), data);
        return inner === "finish" ? afterWeightEstimate(data) : `we_${inner}`;
      }
      return "finish";
  }
}

/** Once the weight-estimate questions are done: ask the ulna question if a BMI still lacks any way to get a height. */
function afterWeightEstimate(data) {
  const canEstimate = weightEstimatePlannedTools(data).length > 0;
  const heightDerivable = data.height_cm !== undefined || data.ulna_length_cm !== undefined || (data.kh_cm !== undefined && data.race !== undefined);
  return canEstimate && !heightDerivable ? "ulna_late" : "edema";
}

/** True when the collected answers can yield a BMI (measured or estimated weight, and a measured or estimable height). */
function bmiPossible(data) {
  const weightOk = data.weight_kg !== undefined || (data.estimateWeight === true && weightEstimatePlannedTools(data).length > 0);
  const heightOk = data.height_cm !== undefined || data.ulna_length_cm !== undefined || (data.kh_cm !== undefined && data.race !== undefined);
  return weightOk && heightOk;
}

function parseWeightLossBand(text) {
  const t = text.trim().toLowerCase();
  if (t === "1" || /less than 5|under 5|<\s*5/.test(t)) return "lt_5_percent";
  if (t === "2" || /5\s*(?:-|–|to)\s*10/.test(t)) return "5_to_10_percent";
  if (t === "3" || /more than 10|over 10|>\s*10/.test(t)) return "gt_10_percent";
  return null;
}

/**
 * Applies the user's reply to the current step. Returns:
 *   { error } | { advance: true } | { finish: true } | { handoff: "pregnant" | "underage" }
 */
export function applyReply(step, text, data) {
  // Weight-estimate questions are answered by the shared step machine. Its "done" (finish estimating) must not end the whole intake.
  if (step.startsWith("we_") && step !== "we_gate") {
    const r = applyWeightEstimateReply(step.slice(3), text, data);
    if ("finish" in r) {
      data.wantsSkinfold = false;
      return { advance: true };
    }
    return r;
  }

  if (isSkip(text) && !["sex", "age", "pregnant", "must_wl", "must_acute"].includes(step)) {
    return { advance: true }; // skip leaves the field unset — never invents a value
  }

  switch (step) {
    case "sex": {
      const v = parseSex(text);
      if (!v) return { error: "Please reply *man* or *woman*." };
      data.sex = v;
      return { advance: true };
    }
    case "age": {
      const v = parseAgeFlexible(text, { bareAsYears: true });
      if (!v) return { error: "Please reply like *45 years* or a birth date as *YYYY-MM-DD*." };
      Object.assign(data, v);
      if (v.date_of_birth) data.assessment_date = new Date().toISOString().slice(0, 10);
      const months = estimateAgeMonths(data);
      if (months === null || months < 0) return { error: "That age doesn't look right. Please try again." };
      if (months < ADULT_AGE_MONTHS) return { handoff: "underage" };
      return { advance: true };
    }
    case "pregnant": {
      const v = parseYesNo(text);
      if (!v || v === "skip") return { error: "Please reply *yes* or *no*." };
      if (v === "yes") return { handoff: "pregnant" };
      return { advance: true };
    }
    case "weight": {
      const v = parseNumber(text);
      if (v === null) return { error: "Please reply with a number in kilograms (e.g. *58.5*), or *skip*." };
      if (v < 20 || v > 300) return { error: "That weight looks off. Please reply in kilograms (e.g. *58.5*), or *skip*." };
      data.weight_kg = v;
      return { advance: true };
    }
    case "height": {
      const v = parseNumber(text);
      if (v === null) return { error: "Please reply with a number in centimetres (e.g. *165*), or *skip*." };
      if (v < 100 || v > 230) return { error: "That height looks off. Please reply in centimetres (e.g. *165*), not metres, or *skip*." };
      data.height_cm = v;
      return { advance: true };
    }
    case "we_gate": {
      const v = parseYesNo(text);
      if (!v) return { error: "Please reply *yes* or *no*." };
      data.estimateWeight = v === "yes";
      if (data.estimateWeight) data.muac_cm = data.muac_mm / 10; // the estimation equations take cm
      return { advance: true };
    }
    case "ulna":
    case "ulna_late": {
      const v = parseNumber(text);
      if (v === null) return { error: "Please reply with the ulna length in cm (e.g. *26.5*), or *skip*." };
      if (v < 18.5 || v > 32) {
        return { error: "The ulna length table covers 18.5 to 32 cm. Please re-measure and reply in cm (e.g. *26.5*), or *skip*." };
      }
      data.ulna_length_cm = v;
      return { advance: true };
    }
    case "muac": {
      const v = parseMuacMm(text);
      if (v === null) return { error: "Please reply with a number in mm or cm (e.g. *230* or *23cm*), or *skip*." };
      data.muac_mm = v;
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
    case "context": {
      const v = parseContext(text);
      if (!v) return { error: "Please reply 1, 2, 3, 4, or *skip*." };
      data.measurement_context = v;
      return { advance: true };
    }
    case "must_gate": {
      if (isDone(text)) return { finish: true };
      const v = parseYesNo(text);
      if (!v) return { error: "Please reply *yes* or *no*." };
      data.wantsMust = v === "yes";
      return { advance: true };
    }
    case "must_wl": {
      const v = parseWeightLossBand(text);
      if (!v) return { error: "Please reply 1, 2, or 3." };
      data.must_weight_loss_band = v;
      return { advance: true };
    }
    case "must_acute": {
      const v = parseYesNo(text);
      if (!v || v === "skip") return { error: "Please reply *yes* or *no*." };
      data.must_acute = v === "yes";
      return { advance: true };
    }
    default:
      return { finish: true };
  }
}

// ── Building the MCP call ──

export function buildScreenArgs(data) {
  const args = {
    sex: data.sex,
    ...ageArgs(data),
    weight_kg: data.weight_kg,
    height_cm: data.height_cm,
    ulna_length_cm: data.ulna_length_cm,
    muac_mm: data.muac_mm,
    edema: data.edema,
    confirmed_weight_loss_over_10_percent: data.confirmed_weight_loss_over_10_percent,
    measurement_context: data.measurement_context,
  };
  if (data.estimateWeight) {
    args.estimate_weight_if_missing = true;
    args.calf_circumference_cm = data.calf_cm;
    args.subscapular_skinfold_mm = data.ssf_mm;
    args.knee_height_cm = data.kh_cm;
    args.race = data.race;
  }
  if (data.wantsMust && data.must_weight_loss_band !== undefined && data.must_acute !== undefined) {
    args.must = {
      weight_loss_band: data.must_weight_loss_band,
      acute_disease_no_intake_over_5_days: data.must_acute,
    };
  }
  return args;
}

// ── Result formatting (deterministic — no model involved) ──

export function formatAdultScreeningResult(result) {
  const lines = [];
  lines.push("*Adult Malnutrition Screening Result*");
  const range = result.measurements.bmi_range_from_estimate_error;
  const bmi =
    result.measurements.bmi !== null
      ? `, BMI ${result.measurements.bmi}${range ? ` (could be ${range.low}–${range.high})` : ""}`
      : "";
  lines.push(`Adult: ${result.person.age_years} years, ${result.person.sex === "female" ? "woman" : "man"}${bmi}`);
  const heightSource = result.measurements.height_source;
  if (heightSource === "ulna_length" || heightSource === "knee_height") {
    const from = heightSource === "ulna_length" ? "ulna length" : "knee height";
    lines.push(`Height: ${result.measurements.height_cm} cm — _estimated from ${from}, not measured_`);
  }
  const weightEstimated = result.measurements.weight_source === "estimated_65plus" || result.measurements.weight_source === "estimated_knee_height_mac";
  if (weightEstimated) {
    lines.push(`Weight: ${result.measurements.weight_kg} kg — _estimated (standard error ±${result.measurements.weight_error_kg} kg), not measured_`);
  }
  lines.push("");

  if (result.nacs_classification && result.nacs_classification.indicators.length > 0) {
    lines.push(`*Acute malnutrition (NACS): ${result.nacs_classification.overallMalnutritionClassification.toUpperCase()}*`);
    for (const ind of result.nacs_classification.indicators) lines.push(`• ${ind.indicator}: ${ind.value} → ${ind.classification}`);
    lines.push("");
  } else {
    lines.push("NACS classification: not computed (no classifiable measurement was given)");
    lines.push("");
  }

  if (result.screening.must) {
    const m = result.screening.must;
    lines.push("*Risk screening*");
    lines.push(`• MUST: score ${m.total_score} — ${m.risk_category} risk`);
    lines.push("");
  }

  const heightEstimated = heightSource === "ulna_length" || heightSource === "knee_height";
  if (heightEstimated || weightEstimated) {
    const what = heightEstimated && weightEstimated ? "weight and height" : weightEstimated ? "weight" : "height";
    lines.push(`_BMI is based on an estimated ${what}, so BMI-based findings are estimates. MUAC, oedema and weight loss do not depend on it._`);
    if (weightEstimated && result.measurements.weight_error_kg >= 7) {
      lines.push(`⚠️ _The error of this weight equation is large (±${result.measurements.weight_error_kg} kg) — treat BMI as a rough guide and weigh the person when you can._`);
    }
    lines.push("");
  }

  if (result.person.older_adult) {
    lines.push("_Age 65+: adult BMI/MUAC cut-offs are not age-adjusted and can under-detect malnutrition in older adults._");
    lines.push("");
  }

  lines.push(recommendedActionBlock(result, "person"));
  return withFlags(lines, result).join("\n");
}

/**
 * Narrates an already-computed result via Groq. The recommended action and
 * disclaimer are appended verbatim afterward regardless. Falls back to the
 * plain deterministic message on any failure.
 */
export async function explainAdultScreeningResult(result, env) {
  const deterministic = formatAdultScreeningResult(result);
  const systemPrompt =
    "You explain a completed, already-decided adult malnutrition screening result to a Malawian health worker " +
    "over WhatsApp. You are NOT deciding anything — every number, classification, and recommendation has " +
    "already been computed by deterministic clinical rules (NACS oedema/MUAC/BMI/weight-loss cut-offs and, if " +
    "present, the BAPEN MUST score). The NACS result and the MUST score are separate axes and may differ; " +
    "explain each without merging them. If the result says height was estimated (from ulna length or knee " +
    "height), say plainly that BMI rests on an estimate. Overweight or obesity is not acute malnutrition; state it plainly if " +
    "present. Your only job is to explain the findings warmly and plainly, in 3-6 short sentences, in English only. " +
    NARRATION_RULES;
  const text = await narrateWithGroq(systemPrompt, result, env, 500);
  if (!text) return deterministic;
  return [text, "", recommendedActionBlock(result, "person")].join("\n");
}

// ── Entry points ──

/**
 * Starts (or resumes at the right step) an adult session from answers
 * another flow already collected (e.g. the school-age flow found the person
 * is 20). `preset` may hold sex and any age field. Returns the next prompt.
 */
export async function beginAdultScreening(from, env, preset = {}) {
  const data = {};
  for (const k of ["sex", "age_months", "age_years", "date_of_birth", "assessment_date"]) {
    if (preset[k] !== undefined) data[k] = preset[k];
  }
  if (data.sex === undefined) {
    await saveSession(SESSION_KIND, from, data, "sex", env);
    return promptFor("sex");
  }
  if (estimateAgeMonths(data) === null) {
    await saveSession(SESSION_KIND, from, data, "age", env);
    return promptFor("age");
  }
  const step = nextStep("age", data);
  await saveSession(SESSION_KIND, from, data, step, env);
  return `Since the person is 18 or older, I'll use the adult screen (NACS: oedema, MUAC, BMI, weight loss).\n\n${promptFor(step)}`;
}

/**
 * Handles one incoming text message as part of (or the start of) an adult
 * screening flow. Returns a reply string if handled, or `null` if not.
 */
export async function handleAdultScreeningFlow(userText, from, env) {
  const session = await loadSession(SESSION_KIND, from, env);

  if (!session) {
    if (!detectAdultScreeningTrigger(userText)) return null;
    await saveSession(SESSION_KIND, from, {}, "sex", env);
    return promptFor("sex");
  }

  if (isCancel(userText)) {
    await clearSession(SESSION_KIND, from, env);
    return 'Screening cancelled. No data was saved beyond this session. Start again anytime by saying "screen an adult".';
  }

  const { step, data } = session;
  const result = applyReply(step, userText, data);

  if ("error" in result) return `${result.error}\n\n${promptFor(step)}`;

  if ("handoff" in result) {
    await clearSession(SESSION_KIND, from, env);
    if (result.handoff === "underage") {
      return 'That person is under 18. For ages 5–17 say *"screen a school child"*; for children under 5 say *"screen a child"*.';
    }
    return `Thanks — for a pregnant or recently postpartum woman I'll switch to the maternal screen.\n\n${await beginPregnantPostpartumScreening(from, env)}`;
  }

  const isFinishing = result.finish === true || nextStep(step, data) === "finish";

  if (!isFinishing) {
    const next = nextStep(step, data);
    await saveSession(SESSION_KIND, from, data, next, env);
    return promptFor(next);
  }

  // ── Run the screen ──
  await clearSession(SESSION_KIND, from, env); // clear before the call so a crash never leaves a stuck session
  if (estimateAgeMonths(data) === null) {
    return 'I don\'t have the person\'s age yet, so I can\'t run the screen. Say "screen an adult" to start again.';
  }

  try {
    const screenResult = await callMcpTool("adult_integrated_screen", buildScreenArgs(data), env);
    return await explainAdultScreeningResult(screenResult, env);
  } catch (err) {
    console.error("adult_integrated_screen call failed:", err);
    return `Sorry, the screening tool couldn't complete: ${err instanceof Error ? err.message : String(err)}. Please try again in a moment.`;
  }
}
