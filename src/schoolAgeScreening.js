/**
 * School-age children and adolescents (5 to under 18 years) malnutrition
 * screening — multi-turn WhatsApp intake flow that calls the Chakudya MCP
 * server's `school_age_integrated_screen` tool.
 *
 * Same architecture as under5Screening.js / pregnantPostpartumScreening.js
 * (deterministic questions, deterministic tool call with only what the health
 * worker supplied, deterministic formatting, optional Groq narration with the
 * recommended action + disclaimer always appended verbatim, English only).
 * Shared plumbing lives in ./screeningShared.js. Reuses the CHAKUDYA_MCP
 * service binding and CHAKUDYA_MCP_AUTH_TOKEN secret — no new setup.
 *
 * BMI-for-age is classified server-side, from chakudya-api's
 * /bmi-for-age/classify (WHO 2007 table, Malawi MoH "Eat Well to Live Well"
 * 2021 Annex 2) with an in-process WHO 2007 fallback. This flow never
 * classifies anything itself.
 *
 * ROUTING between flows:
 *   - "screen a child" starts the under-5 flow; if the age given there is 5 or
 *     more, under5Screening.js hands the answers already collected over to
 *     beginSchoolAgeScreening() below.
 *   - Here, an age of 18+ hands over to the adult flow; under 5 asks the user
 *     to say "screen a child"; a girl aged 10+ is asked whether she is
 *     pregnant/recently gave birth, and "yes" hands over to the maternal flow.
 *
 * Session kind: "school_age_screening" (own kind, so it can never collide
 * with the other flows for the same WhatsApp number).
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
import { beginAdultScreening } from "./adultScreening.js";
import { beginPregnantPostpartumScreening } from "./pregnantPostpartumScreening.js";

const SESSION_KIND = "school_age_screening";
const MIN_AGE_MONTHS = 60; // under this is the under-5 flow's territory
const ADULT_AGE_MONTHS = 216; // 18 years
const PREGNANCY_QUESTION_MIN_AGE_MONTHS = 120; // ask girls of 10+ whether she is pregnant / recently gave birth

// ── Trigger phrase ──
// School-age wording, or an explicit "N year old" for N = 5-19 (the exact age is checked once it is known;
// 18-19 hands over to the adult flow). A "N year old" that is ALSO called a child/baby/infant is left to
// the under-5 flow, which hands over to this one by age — so "screen a 9 year old child" still lands here.
const SCHOOL_WORD_RE =
  /\b(school\s?child(?:ren)?|school\s?(?:boy|girl)s?|school[- ]?aged?|pupils?|students?|learners?|teen(?:ager)?s?|adolescents?)\b/i;
const YEAR_OLD_5_TO_19_RE = /\b(?:[5-9]|1[0-9])[\s-]*(?:year|yr)s?[\s-]*old\b/i;
const UNDER5_WORDS_RE = /\b(child|baby|infant|mwana)\b/i;

export function detectSchoolAgeScreeningTrigger(text) {
  if (!looksLikeScreeningRequest(text, new RegExp(`${SCHOOL_WORD_RE.source}|${YEAR_OLD_5_TO_19_RE.source}`, "i"))) return false;
  return SCHOOL_WORD_RE.test(text) || !UNDER5_WORDS_RE.test(text);
}

// ── Prompts ──

export function promptFor(step, data = {}) {
  switch (step) {
    case "sex":
      return "Let's screen a school-age child or adolescent for malnutrition risk 🩺\n\nIs the child a boy or a girl? (Reply *boy* or *girl*. Reply *cancel* anytime to stop.)";
    case "age":
      return "How old is the child? Reply like *8 years*, *8 years 3 months*, *99 months*, or a birth date as *YYYY-MM-DD*.";
    case "pregnant":
      return "Is she pregnant, or has she recently given birth? Reply *yes* or *no*.";
    case "weight":
      return "What is the child's weight in kilograms? (e.g. *24.5*). Reply *skip* if not available.";
    case "height":
      return "What is the child's standing height in centimetres? (e.g. *125*). Reply *skip* if not available.";
    case "muac":
      return "What is the child's MUAC (mid-upper arm circumference), if measured? Reply in mm (e.g. *160*) or cm (e.g. *16cm*). Reply *skip* if not available.";
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

/** Next step id given the current step and the data collected so far. */
export function nextStep(step, data) {
  switch (step) {
    case "sex":
      return "age";
    case "age":
      return data.sex === "female" && estimateAgeMonths(data) >= PREGNANCY_QUESTION_MIN_AGE_MONTHS ? "pregnant" : "weight";
    case "pregnant":
      return "weight";
    case "weight":
      return "height";
    case "height":
      return "muac";
    case "muac":
      return "edema";
    case "edema":
      return "context";
    case "context":
      return "extra_gate";
    case "extra_gate":
      return data.wantsExtra ? "sk_clinical" : "finish";
    case "sk_clinical":
      return "sk_disease";
    case "sk_disease":
      return "sk_intake";
    case "sk_intake":
      return "sk_weightloss";
    default:
      return "finish";
  }
}

/**
 * Applies the user's reply to the current step. Returns:
 *   { error }            — reprompt with this message
 *   { advance: true }    — move to the next step (data mutated in place)
 *   { finish: true }     — intake is complete, run the screen
 *   { handoff: "adult" | "pregnant" | "under5" } — this person belongs to another flow
 */
export function applyReply(step, text, data) {
  if (isSkip(text) && !["sex", "age", "pregnant", "sk_clinical", "sk_disease", "sk_intake", "sk_weightloss"].includes(step)) {
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
      const v = parseAgeFlexible(text, { bareAsYears: true });
      if (!v) return { error: "Please reply like *8 years*, *8 years 3 months*, *99 months*, or a birth date as *YYYY-MM-DD*." };
      Object.assign(data, v);
      if (v.date_of_birth) data.assessment_date = new Date().toISOString().slice(0, 10);
      const months = estimateAgeMonths(data);
      if (months === null || months < 0) return { error: "That age doesn't look right. Please try again." };
      if (months < MIN_AGE_MONTHS) return { handoff: "under5" };
      if (months >= ADULT_AGE_MONTHS) return { handoff: "adult" };
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
      if (v === null) return { error: "Please reply with a number in kilograms (e.g. *24.5*), or *skip*." };
      if (v < 5 || v > 250) return { error: "That weight looks off. Please reply in kilograms (e.g. *24.5*), or *skip*." };
      data.weight_kg = v;
      return { advance: true };
    }
    case "height": {
      const v = parseNumber(text);
      if (v === null) return { error: "Please reply with a number in centimetres (e.g. *125*), or *skip*." };
      if (v < 50 || v > 230) return { error: "That height looks off. Please reply in centimetres (e.g. *125*), not metres, or *skip*." };
      data.height_cm = v;
      return { advance: true };
    }
    case "muac": {
      const v = parseMuacMm(text);
      if (v === null) return { error: "Please reply with a number in mm or cm (e.g. *160* or *16cm*), or *skip*." };
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
    case "sk_clinical":
    case "sk_disease":
    case "sk_intake":
    case "sk_weightloss": {
      const v = parseYesNo(text);
      if (!v || v === "skip") return { error: "Please reply *yes* or *no*." };
      data[step] = v === "yes";
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
  return args;
}

// ── Result formatting (deterministic — no model involved) ──

export function formatSchoolAgeScreeningResult(result) {
  const lines = [];
  lines.push("*School-Age / Adolescent Malnutrition Screening Result*");
  lines.push(`Child: ${result.child.age_years} years, ${result.child.sex === "female" ? "girl" : "boy"}`);
  lines.push("");

  lines.push("*BMI-for-age*");
  const b = result.anthropometry.bmi_for_age;
  if (b.available) {
    const z = b.z_score !== undefined ? `, z=${b.z_score}` : "";
    lines.push(`• BMI ${b.bmi} kg/m²${z} — ${b.status}`);
    if (b.source === "local_who2007_lms") {
      lines.push("_(classified with the built-in WHO 2007 reference because the Chakudya table was unreachable)_");
    }
  } else {
    lines.push(`• not available (${b.reason_unavailable})`);
  }
  lines.push("");

  if (result.nacs_classification) {
    const others = result.nacs_classification.indicators.filter((i) => i.indicator !== "bmi_for_age");
    lines.push(`*Acute malnutrition (NACS): ${result.nacs_classification.overallMalnutritionClassification.toUpperCase()}*`);
    for (const ind of others) lines.push(`• ${ind.indicator}: ${ind.value} → ${ind.classification}`);
    lines.push("");
  } else if (result.nacs_classification_skipped_reason) {
    lines.push(`NACS classification: not computed (${result.nacs_classification_skipped_reason})`);
    lines.push("");
  }

  const s = result.screening;
  if (s.tools_administered.length > 0) {
    lines.push("*Risk screening*");
    if (s.strongkids) lines.push(`• STRONGkids: ${s.strongkids.total_score}/5 — ${s.strongkids.risk_category}`);
    lines.push("");
  }

  lines.push(recommendedActionBlock(result, "child"));
  return withFlags(lines, result).join("\n");
}

/**
 * Narrates an already-computed result more warmly via Groq. The recommended
 * action and disclaimer are appended verbatim afterward regardless. Falls
 * back to the plain deterministic message on any failure.
 */
export async function explainSchoolAgeScreeningResult(result, env) {
  const deterministic = formatSchoolAgeScreeningResult(result);
  const systemPrompt =
    "You explain a completed, already-decided school-age child/adolescent malnutrition screening result to a " +
    "Malawian health worker over WhatsApp. You are NOT deciding anything — every number, classification, and " +
    "recommendation has already been computed by deterministic clinical rules (WHO 2007 BMI-for-age, NACS MUAC and " +
    "oedema cut-offs). Overweight or obesity is not acute malnutrition; state it plainly if present. Your only job " +
    "is to explain the findings warmly and plainly, in 3-6 short sentences, in English only. " +
    NARRATION_RULES;
  const text = await narrateWithGroq(systemPrompt, result, env, 500);
  if (!text) return deterministic;
  return [text, "", recommendedActionBlock(result, "child")].join("\n");
}

// ── Entry points ──

/**
 * Starts (or resumes at the right step) a school-age session from answers
 * another flow already collected — e.g. the under-5 flow found the child is
 * 8 years old. `preset` may hold sex and any age field. Returns the next
 * prompt as a reply string.
 */
export async function beginSchoolAgeScreening(from, env, preset = {}) {
  const data = { ...preset };
  if (data.sex === undefined) {
    await saveSession(SESSION_KIND, from, data, "sex", env);
    return promptFor("sex");
  }
  if (estimateAgeMonths(data) === null) {
    await saveSession(SESSION_KIND, from, data, "age", env);
    return promptFor("age");
  }

  const months = estimateAgeMonths(data);
  if (months >= ADULT_AGE_MONTHS) return await beginAdultScreening(from, env, data);

  const step = nextStep("age", data);
  await saveSession(SESSION_KIND, from, data, step, env);
  const years = Math.floor(months / 12);
  return `Since the age is about ${years} years, I'll use the 5–17 year screen (BMI-for-age, MUAC, oedema).\n\n${promptFor(step)}`;
}

/**
 * Handles one incoming text message as part of (or the start of) a
 * school-age screening flow. Returns a reply string if handled, or `null`
 * if not (caller should fall through to normal dispatch).
 */
export async function handleSchoolAgeScreeningFlow(userText, from, env) {
  const session = await loadSession(SESSION_KIND, from, env);

  if (!session) {
    if (!detectSchoolAgeScreeningTrigger(userText)) return null;
    await saveSession(SESSION_KIND, from, {}, "sex", env);
    return promptFor("sex");
  }

  if (isCancel(userText)) {
    await clearSession(SESSION_KIND, from, env);
    return 'Screening cancelled. No data was saved beyond this session. Start again anytime by saying "screen a school child".';
  }

  const { step, data } = session;
  const result = applyReply(step, userText, data);

  if ("error" in result) return `${result.error}\n\n${promptFor(step)}`;

  if ("handoff" in result) {
    await clearSession(SESSION_KIND, from, env);
    if (result.handoff === "under5") {
      return 'That child is under 5 years old — for children 0–59 months, say *"screen a child"* to use the under-5 screen.';
    }
    if (result.handoff === "adult") return await beginAdultScreening(from, env, data);
    // pregnant / recently postpartum girl: BMI-for-age does not apply
    return `Thanks — for a pregnant or recently postpartum girl I'll switch to the maternal screen (BMI-for-age does not apply).\n\n${await beginPregnantPostpartumScreening(from, env)}`;
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
    return 'I don\'t have the child\'s age yet, so I can\'t run the screen. Say "screen a school child" to start again.';
  }

  try {
    const screenResult = await callMcpTool("school_age_integrated_screen", buildScreenArgs(data), env);
    return await explainSchoolAgeScreeningResult(screenResult, env);
  } catch (err) {
    console.error("school_age_integrated_screen call failed:", err);
    return `Sorry, the screening tool couldn't complete: ${err instanceof Error ? err.message : String(err)}. Please try again in a moment.`;
  }
}
