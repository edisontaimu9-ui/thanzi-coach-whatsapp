/**
 * Energy requirements for infants, children, adolescents, pregnancy and lactation.
 *
 * The standalone energy calculator (src/energy.js: Harris-Benedict / Schofield / WHO) gives RESTING
 * energy (BMR/BEE). That is right as the base for clinical stress-factor work, but for a healthy
 * infant, child, pregnant or breastfeeding woman it is not what they need to eat: a 2-year-old's
 * BMR of ~650 kcal is far below the ~1,000 kcal/day they need. These age groups now get the
 * activity-adjusted Estimated Energy Requirement (IOM/DRI) from the Chakudya MCP tool
 * iom_dri_eer_calculator, with the resting value shown alongside.
 *
 * Out of scope here (they keep the existing calculator unchanged): adults without pregnancy or
 * lactation, and anyone with a clinical stress condition (burns, sepsis...). If the tool is
 * unavailable the caller falls back to the existing calculator.
 *
 * planEerLookup / formatEer are pure; runEer makes the MCP calls. Tests: test/eerLookup.test.js.
 */

import { callMcpTool } from "./screeningShared.js";

const ACTIVITY = [
  ["sedentary", "Sedentary"],
  ["low_active", "Low active"],
  ["active", "Active"],
];

const TRIMESTERS = [
  [/\b(?:first|1st)\s+trimester\b|\btrimester\s*1\b/i, "first"],
  [/\b(?:second|2nd)\s+trimester\b|\btrimester\s*2\b/i, "second"],
  [/\b(?:third|3rd)\s+trimester\b|\btrimester\s*3\b/i, "third"],
];

function parseTrimester(text) {
  for (const [re, key] of TRIMESTERS) if (re.test(text)) return key;
  return null;
}

// Baby's age for lactation: "first 6 months", "0-6 months", "6-12 months", or the baby's age in months.
function parsePostpartum(text, ageMonths) {
  if (/\b(?:first|1st)\s*6\s*months?\b|\b0\s*[-–to]+\s*6\s*months?\b|\b(?:under|less than|below)\s*6\s*months?\b/i.test(text)) return "first_6_months";
  if (/\b(?:second|2nd)\s*6\s*months?\b|\b6\s*[-–to]+\s*12\s*months?\b|\b(?:over|more than|above)\s*6\s*months?\b/i.test(text)) return "second_6_months";
  if (Number.isFinite(ageMonths) && ageMonths > 0 && ageMonths <= 6) return "first_6_months";
  if (Number.isFinite(ageMonths) && ageMonths > 6 && ageMonths <= 12) return "second_6_months";
  return null;
}

const BABY_WORD = /\b(baby|babies|babe|babes|infant|toddler|newborn)\b/i;
const CHILD_WORD = /\b(child|children|kid|kids|boy|girl|schoolchild|adolescent|teen(?:ager)?)\b/i;

/** Which people the existing calculator can't serve properly. null = not in scope (use the old path). */
function scopeOf(d) {
  if (d.stressConditionKey) return null; // clinical stress work keeps the existing BMR x stress factor
  const text = d.rawText || "";
  const female = d.sex !== "male";
  const lactating = d.conditions?.includes("lactation");
  const pregnant = d.conditions?.includes("pregnancy");
  if ((pregnant || lactating) && female && (d.age === null || (d.age >= 14 && d.age <= 50))) {
    return pregnant ? "pregnancy" : "lactation";
  }
  // For lactation questions ageMonths is the baby's; otherwise it is the subject's.
  const subjectMonths = d.ageMonths ?? (d.age !== null ? d.age * 12 : null);
  if (subjectMonths !== null && subjectMonths < 36) return "infant";
  if (d.age !== null && d.age >= 3 && d.age < 18) return "child";
  if (d.age === null && BABY_WORD.test(text)) return "infant";
  if (d.age === null && CHILD_WORD.test(text) && !/\b(man|men|woman|women|adult)\b/i.test(text)) return "child";
  return null;
}

/**
 * Plans the lookup. Returns null (out of scope), { scope, missing: [...] } when inputs are missing,
 * or { scope, label, calls: [{ label, args }] } ready for runEer.
 */
export function planEerLookup(d) {
  const scope = scopeOf(d);
  if (!scope) return null;
  const text = d.rawText || "";
  const missing = [];

  if (scope === "infant") {
    const months = d.ageMonths ?? (d.age !== null ? Math.round(d.age * 12) : null);
    if (months === null) missing.push("age (e.g. 7 months)");
    if (d.weightKg === null) missing.push("weight (kg)");
    if (missing.length) return { scope, missing, example: "energy needs of a 7 month old baby, 7kg" };
    return {
      scope,
      label: months < 12 ? `${months}-month-old` : `${Math.floor(months / 12)}-year-old${months % 12 ? ` ${months % 12} mo` : ""}`,
      weightKg: d.weightKg,
      calls: [{ label: "", args: { life_stage: "infant_0_2y", age_months: months, weight_kg: d.weightKg } }],
    };
  }

  if (scope === "child") {
    if (!d.sex) missing.push("sex (boy or girl)");
    if (d.age === null) missing.push("age");
    if (d.weightKg === null) missing.push("weight (kg)");
    if (d.heightCm === null) missing.push("height (cm)");
    if (missing.length) return { scope, missing, example: "energy needs of a 10 year old girl, 30kg, 138cm" };
    const age = Math.floor(d.age);
    const stage = `child_${d.sex === "male" ? "boy" : "girl"}_${age <= 8 ? "3_8" : "9_18"}_normal`;
    return {
      scope,
      label: `${d.sex === "male" ? "boy" : "girl"}, ${age} years`,
      weightKg: d.weightKg,
      calls: ACTIVITY.map(([pal, name]) => ({
        label: name,
        args: { life_stage: stage, age_years: age, weight_kg: d.weightKg, height_cm: d.heightCm, physical_activity_level: pal },
      })),
    };
  }

  // pregnancy / lactation
  const trimester = scope === "pregnancy" ? parseTrimester(text) : null;
  const postpartum = scope === "lactation" ? parsePostpartum(text, d.ageMonths) : null;
  if (d.age === null) missing.push("mother's age");
  if (d.weightKg === null) missing.push("weight (kg)");
  if (d.heightCm === null) missing.push("height (cm)");
  if (scope === "pregnancy" && !trimester) missing.push("trimester (1st, 2nd or 3rd)");
  if (scope === "lactation" && !postpartum) missing.push("baby's age (under or over 6 months)");
  if (missing.length) {
    return {
      scope,
      missing,
      example:
        scope === "pregnancy"
          ? "energy needs for a pregnant woman, 28 years, 65kg, 163cm, 2nd trimester"
          : "energy needs for a breastfeeding mother, 28 years, 62kg, 163cm, baby 3 months",
    };
  }
  const age = Math.floor(d.age);
  const teen = age < 19;
  const stage = `${scope === "pregnancy" ? "pregnant" : "lactating"}_${teen ? "14_18" : "19_50"}`;
  const extra = scope === "pregnancy" ? { trimester } : { months_postpartum: postpartum };
  return {
    scope,
    label: scope === "pregnancy" ? `pregnancy, ${trimester} trimester` : `breastfeeding, ${postpartum === "first_6_months" ? "first 6 months" : "6-12 months"}`,
    weightKg: d.weightKg,
    calls: ACTIVITY.map(([pal, name]) => ({
      label: name,
      args: { life_stage: stage, age_years: age, weight_kg: d.weightKg, height_cm: d.heightCm, physical_activity_level: pal, ...extra },
    })),
  };
}

/** Runs the planned MCP calls in parallel. Throws if any call fails (caller falls back). */
export async function runEer(plan, env) {
  return Promise.all(plan.calls.map((c) => callMcpTool("iom_dri_eer_calculator", c.args, env)));
}

function kcal(n) {
  return Math.round(n).toLocaleString("en-US");
}

/** WhatsApp text. `results` is runEer's output; `resting` is the existing calculator's result or null. */
export function formatEer(plan, results, resting) {
  const values = results.map((r) => Number(r?.eer_kcal_per_day));
  if (!values.length || values.some((v) => !Number.isFinite(v))) throw new Error("EER result missing eer_kcal_per_day");
  const lines = [`📊 *Estimated daily energy needs — ${plan.label}*`];
  if (plan.scope === "infant") {
    const perKg = plan.weightKg > 0 ? Math.round(values[0] / plan.weightKg) : null;
    lines.push(`• *${kcal(values[0])} kcal/day*${perKg ? ` (≈${perKg} kcal/kg/day)` : ""}`);
  } else {
    plan.calls.forEach((c, i) => lines.push(`• ${c.label}: *${kcal(values[i])} kcal/day*`));
    const first = results[0];
    if (plan.scope === "pregnancy" && Number.isFinite(first?.pregnancy_energy_deposition_kcal)) {
      lines.push(`  (includes +${first.pregnancy_energy_deposition_kcal} kcal for pregnancy)`);
    }
    if (plan.scope === "lactation" && Number.isFinite(first?.milk_energy_output_minus_weight_loss_kcal)) {
      lines.push(`  (includes +${first.milk_energy_output_minus_weight_loss_kcal} kcal for milk production)`);
    }
  }
  if (resting && Number.isFinite(resting.baseKcalPerDay)) {
    lines.push("", `Resting energy (${resting.equation}): ${kcal(resting.baseKcalPerDay)} kcal/day`);
  }
  lines.push(
    "",
    plan.scope === "child"
      ? "_Estimate (IOM/DRI) for a healthy-weight child; choose the activity level that fits. Reference only, not a substitute for individual assessment._"
      : "_Estimate (IOM/DRI) for a healthy-weight person. Reference only, not a substitute for individual assessment._"
  );
  return lines.join("\n");
}

/** The "I still need..." message for a plan with missing inputs. */
export function formatEerMissing(plan) {
  return `I still need: ${plan.missing.join(", ")}.\n\nFor example: “${plan.example}”.`;
}
