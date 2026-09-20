/**
 * Standing HEIGHT (stature) ESTIMATE for a patient who cannot be measured
 * directly — multi-turn WhatsApp intake flow that calls the Chakudya MCP
 * server's stature tools:
 *   - stature_from_knee_height  (Lee & Nieman) — race/sex/age-specific,
 *     needs knee height in cm plus race (black/white); ages ~6 and up.
 *   - stature_from_demi_span    (Gibson) — sex/age-specific, needs demi
 *     span in cm (sternal notch to the middle/ring finger web, arm
 *     outstretched); ages 16 and up.
 *   - stature_from_ulna_length  (reference table) — sex/age-band lookup
 *     from ulna (forearm) length in cm; table covers 18.5-32.0 cm.
 *
 * Unlike the weight-estimate flow (weightEstimate.js), which combines every
 * measurement it's given into several equations and headlines the most
 * precise, height here is ONE equation at a time: a health worker normally
 * has exactly one of these measurements available for a given patient (the
 * other two need body positions or a caliper-style stretch a bedridden or
 * contracted patient often can't do), so the flow asks which measurement is
 * on hand, then only the questions that method needs. Methods that don't
 * apply at the patient's age (demi span under 16, knee height under 6) are
 * left off the menu rather than offered and then rejected.
 *
 * Same architecture as the other flows (deterministic questions,
 * deterministic MCP call with only what the health worker supplied,
 * deterministic formatting — no LLM narration here). Shared plumbing is in
 * ./screeningShared.js; the same CHAKUDYA_MCP binding and
 * CHAKUDYA_MCP_AUTH_TOKEN secret are reused. parseRace (black/white) is
 * shared with ./weightEstimate.js, whose race-specific knee-height weight
 * equation uses the same two categories.
 *
 * This is a standalone calculator: its result is never used for
 * malnutrition classification (unlike the adult screening flow's own,
 * narrower ulna-only height estimate — see ./adultScreening.js — which
 * feeds a BMI).
 *
 * Session kind: "height_estimate".
 */

import {
  saveSession,
  loadSession,
  clearSession,
  parseSex,
  parseAgeFlexible,
  parseNumber,
  isCancel,
  estimateAgeMonths,
  callMcpTool,
} from "./screeningShared.js";
import { parseRace } from "./weightEstimate.js";

const SESSION_KIND = "height_estimate";
const KNEE_HEIGHT_MIN_AGE = 6; // youngest age the Lee & Nieman knee-height equations cover
const DEMI_SPAN_MIN_AGE = 16; // youngest age the Gibson demi-span equations cover

// ── Trigger phrase ──
// Needs an "estimate/predict" word, a height/stature word, and a person-ish word — or an explicit
// "can't stand"/"can't be measured". Growth/stunting screening language (height-for-age) is excluded,
// since that belongs to the under-5 / school-age screening flows, not this standalone calculator.
const ESTIMATE_RE = /\b(estimat(?:e|es|ing|ion)|predict(?:ing|ion)?)\b/i;
const HEIGHT_RE = /\b(height|stature|(?:how\s+)?tall)\b/i;
const PERSON_RE =
  /\b(patients?|clients?|elderly|older (?:adult|person|people|man|woman)|seniors?|bedridden|bed-bound|contracture[sd]?|amputee[sd]?|grand(?:mother|father|ma|pa)|man|men|woman|women|person)\b/i;
const CANNOT_STAND_RE = /\b(can'?t|cannot|can not|unable to|not able to|couldn'?t)\s+(?:be\s+)?(?:stand(?:ing)?|measur(?:e|ed))\b/i;
const NOT_THIS_RE = /\bheight[- ]for[- ]age\b|\bstunt(?:ing|ed)?\b|\bz[- ]?score\b/i;

export function detectHeightEstimateTrigger(text) {
  const t = text.trim();
  if (NOT_THIS_RE.test(t)) return false;
  if (CANNOT_STAND_RE.test(t)) return true;
  return ESTIMATE_RE.test(t) && HEIGHT_RE.test(t) && PERSON_RE.test(t);
}

/** Sample prompt for the greeting list's height-estimate row; must (and, per test, does) trigger this flow only. */
export const HEIGHT_ESTIMATE_SAMPLE_PROMPT = "Estimate height for a patient";

// ── Age helper ──

function ageYearsOf(data) {
  const months = estimateAgeMonths(data);
  return months === null ? null : months / 12;
}

/** Which measurement methods have a published equation/table at this age, in menu order. Ulna always applies (no age restriction in the source table beyond the forearm-length range itself). */
export function availableMethods(ageYears) {
  const methods = [];
  if (ageYears >= KNEE_HEIGHT_MIN_AGE) methods.push("knee_height");
  if (ageYears >= DEMI_SPAN_MIN_AGE) methods.push("demi_span");
  methods.push("ulna");
  return methods;
}

const METHOD_LABELS = {
  knee_height: "Knee height (needs race — black/white)",
  demi_span: "Demi span (arm span)",
  ulna: "Ulna (forearm) length",
};

export function parseMethod(text, available) {
  const t = text.trim().toLowerCase();
  if (/^\d+$/.test(t)) {
    const v = available[parseInt(t, 10) - 1];
    return v ?? null;
  }
  if (/knee/.test(t)) return available.includes("knee_height") ? "knee_height" : null;
  if (/demi|span/.test(t)) return available.includes("demi_span") ? "demi_span" : null;
  if (/ulna|forearm/.test(t)) return available.includes("ulna") ? "ulna" : null;
  return null;
}

// Gross plausibility bounds only (catch unit/typing mistakes), not clinical thresholds. The ulna
// bound matches the MCP tool's own table range (18.5-32.0cm) exactly, so a value it will reject
// is caught here with a clearer message instead of round-tripping to the tool first.
const BOUNDS = {
  kh_cm: { min: 30, max: 70 },
  ds_cm: { min: 20, max: 60 },
  ulna_cm: { min: 18.5, max: 32 },
};

// ── Prompts ──

export function promptFor(step, data = {}) {
  switch (step) {
    case "sex":
      return "Let's estimate standing height for a patient who can't be measured directly 📏\n\nIs the patient male or female? (Reply *male* or *female*. Reply *cancel* anytime to stop.)";
    case "age":
      return "How old is the patient? Reply like *72 years*.";
    case "method": {
      const methods = availableMethods(ageYearsOf(data) ?? 0);
      const lines = ["Which measurement do you have for this patient?"];
      methods.forEach((m, i) => lines.push(`${i + 1}. ${METHOD_LABELS[m]}`));
      lines.push("Reply with a number, or the method name.");
      return lines.join("\n");
    }
    case "race":
      return "The knee-height equations are race-specific — they exist for *black* and *white* only. Which applies to the patient? Reply *black* or *white*.";
    case "kh":
      return "Knee height in cm (e.g. *50*): with the knee and ankle each bent to a right angle, measure from the heel to the top of the knee.";
    case "ds":
      return "Demi span in cm (e.g. *35*): with the arm stretched out horizontally to the side, measure from the sternal notch (the dip at the base of the neck) to the web between the middle and ring finger.";
    case "ulna":
      return "Ulna (forearm) length in cm (e.g. *26.5*, between 18.5 and 32): with the arm bent and the palm across the chest, measure the LEFT forearm from the point of the elbow to the midpoint of the bony bump of the wrist.";
    default:
      return null;
  }
}

export function nextStep(step, data) {
  switch (step) {
    case "sex":
      return "age";
    case "age":
      return "method";
    case "method":
      if (data.method === "knee_height") return "race";
      if (data.method === "demi_span") return "ds";
      return "ulna";
    case "race":
      return "kh";
    case "kh":
    case "ds":
    case "ulna":
      return "finish";
    default:
      return "finish";
  }
}

/**
 * Applies the user's reply to the current step. Returns { error } | { advance: true } | { finish: true }.
 * Every field asked is required — there is no "skip" here, because each question is asked only when it
 * is the one measurement the chosen method needs; skipping it would leave nothing to estimate from.
 */
export function applyReply(step, text, data) {
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
      if (years === null || years < 0 || years > 120) return { error: "That age doesn't look right. Please try again." };
      return { advance: true };
    }
    case "method": {
      const methods = availableMethods(ageYearsOf(data) ?? 0);
      const v = parseMethod(text, methods);
      if (!v) return { error: `Please reply with a number 1-${methods.length}, or the method name.` };
      data.method = v;
      return { advance: true };
    }
    case "race": {
      const v = parseRace(text);
      if (!v) return { error: "Please reply *black* or *white*." };
      data.race = v;
      return { advance: true };
    }
    case "kh": {
      const v = parseNumber(text);
      if (v === null) return { error: "Please reply with the knee height in cm (e.g. *50*)." };
      if (v < BOUNDS.kh_cm.min || v > BOUNDS.kh_cm.max) {
        return { error: "That knee height looks off. Please re-measure and reply in cm (e.g. *50*)." };
      }
      data.kh_cm = v;
      return { advance: true };
    }
    case "ds": {
      const v = parseNumber(text);
      if (v === null) return { error: "Please reply with the demi span in cm (e.g. *35*)." };
      if (v < BOUNDS.ds_cm.min || v > BOUNDS.ds_cm.max) {
        return { error: "That demi span looks off. Please re-measure and reply in cm (e.g. *35*)." };
      }
      data.ds_cm = v;
      return { advance: true };
    }
    case "ulna": {
      const v = parseNumber(text);
      if (v === null) return { error: "Please reply with the ulna length in cm (e.g. *26.5*)." };
      if (v < BOUNDS.ulna_cm.min || v > BOUNDS.ulna_cm.max) {
        return { error: "The ulna length table covers 18.5 to 32 cm. Please re-measure and reply in cm (e.g. *26.5*)." };
      }
      data.ulna_cm = v;
      return { advance: true };
    }
    default:
      return { finish: true };
  }
}

// ── MCP call ──

/** The single MCP call the chosen method needs, as { tool, args }. */
export function buildEstimateCall(data) {
  const age = ageYearsOf(data);
  const ageYears = Math.round(age * 100) / 100;
  if (data.method === "knee_height") {
    return { tool: "stature_from_knee_height", args: { race: data.race, sex: data.sex, age_years: ageYears, knee_height_cm: data.kh_cm } };
  }
  if (data.method === "demi_span") {
    return { tool: "stature_from_demi_span", args: { sex: data.sex, age_years: ageYears, demi_span_cm: data.ds_cm } };
  }
  return { tool: "stature_from_ulna_length", args: { sex: data.sex, age_years: ageYears, ulna_length_cm: data.ulna_cm } };
}

// ── Result formatting (deterministic) ──

export function formatHeightEstimateResult(tool, result, data = {}) {
  if (!result) return "No estimate could be calculated. Please check the measurement and try again.";
  const r1 = (n) => Math.round(n * 10) / 10;
  const who = `${data.sex === "female" ? "Female" : "Male"}${data.age_years !== undefined ? `, ${data.age_years} years` : ""}`;

  let heightCm, methodLabel, measurementLine, errorCm, warnLine;
  if (tool === "stature_from_knee_height") {
    heightCm = result.estimated_stature_cm;
    methodLabel = "knee height, race-specific equation (Lee & Nieman)";
    measurementLine = `knee height ${data.kh_cm} cm, race: ${data.race}`;
    errorCm = result.error_cm;
  } else if (tool === "stature_from_demi_span") {
    heightCm = result.estimated_height_cm;
    methodLabel = "demi span equation (Gibson)";
    measurementLine = `demi span ${data.ds_cm} cm`;
  } else {
    heightCm = result.estimated_height_cm;
    methodLabel = "ulna (forearm) length reference table";
    measurementLine = `ulna length ${data.ulna_cm} cm`;
    warnLine = result.note; // only ever set for the one known doubtful table cell — see statureEstimationTools.ts
  }

  const lines = [
    "📏 *Estimated height*",
    who,
    `Measurement: ${measurementLine}`,
    "",
    `*≈ ${r1(heightCm)} cm* — ${methodLabel}${errorCm !== undefined ? ` (standard error ±${errorCm} cm)` : ""}`,
  ];
  if (warnLine) lines.push("", `⚠️ ${warnLine}`);
  lines.push(
    "",
    `_An estimate, not a measurement${errorCm !== undefined ? ` — the typical error is about ±${errorCm} cm and an individual can be further out` : ""}. Measure the patient directly (standing, or supine length) as soon as it is possible to do so._`
  );
  return lines.join("\n");
}

// ── Entry point ──

/**
 * Handles one incoming text message as part of (or the start of) a height-estimate flow.
 * Returns a reply string if handled, or `null` if not (caller should fall through).
 */
export async function handleHeightEstimateFlow(userText, from, env) {
  const session = await loadSession(SESSION_KIND, from, env);

  if (!session) {
    if (!detectHeightEstimateTrigger(userText)) return null;
    await saveSession(SESSION_KIND, from, {}, "sex", env);
    return promptFor("sex");
  }

  if (isCancel(userText)) {
    await clearSession(SESSION_KIND, from, env);
    return 'Cancelled. Start again anytime by saying "estimate height for a patient".';
  }

  const { step, data } = session;
  const stepResult = applyReply(step, userText, data);

  if ("error" in stepResult) return `${stepResult.error}\n\n${promptFor(step, data)}`;

  const isFinishing = stepResult.finish === true || nextStep(step, data) === "finish";

  if (!isFinishing) {
    const next = nextStep(step, data);
    await saveSession(SESSION_KIND, from, data, next, env);
    return promptFor(next, data);
  }

  // ── Run the estimate ──
  await clearSession(SESSION_KIND, from, env); // clear before the call so a crash never leaves a stuck session
  if (data.sex === undefined || data.method === undefined) {
    return 'I don\'t have enough information to estimate height. Say "estimate height for a patient" to start again.';
  }

  const { tool, args } = buildEstimateCall(data);
  let toolResult;
  try {
    toolResult = await callMcpTool(tool, args, env);
  } catch (err) {
    console.error(`${tool} call failed:`, err);
    return `Sorry, the estimate couldn't be completed: ${err instanceof Error ? err.message : String(err)}. Please try again in a moment.`;
  }

  const ageYears = data.age_years !== undefined ? data.age_years : Math.floor(ageYearsOf(data));
  return formatHeightEstimateResult(tool, toolResult, { ...data, age_years: ageYears });
}
