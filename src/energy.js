/**
 * Deterministic energy-requirement calculations — pure math, no fetch/env
 * dependency, unit tested directly under plain Node (see test/energy.test.js)
 * the same way ./detectors.js is. index.js imports what it needs from here.
 *
 * Adults (age >= 18): classic Harris-Benedict BEE equation, optionally
 * scaled by a Barak et al (2002) clinical stress factor.
 * Children (age < 18): Schofield (1985) weight+height BMR equation
 * (preferred — same two-variable shape as Harris-Benedict, age-banded
 * 0-3y/3-10y/10-18y) when height is available, falling back to WHO (1985)
 * weight-only BMR when it isn't. Either can also be scaled by the same
 * Barak stress factor where a stress condition applies.
 *
 * Source: same reference set as chakudya-mcp-server-cloudflare's
 * harrisBenedictStressFactorTools.ts / pediatricTools.ts (Barak et al 2002;
 * Schofield 1985; WHO 1985) — kept in sync manually since this is a
 * separate Worker with no shared package.
 */

// ── Barak et al (2002) stress factor table (condition -> low/high multiplier
// on BEE/BMR) — same table as harrisBenedictStressFactorTools.ts. Applied
// factor is the midpoint of the range; per source, only the single highest
// applicable factor should ever be used, never stacked.
export const STRESS_FACTOR_TABLE = {
  starvation_refeeding: { label: "Starvation/refeeding risk", low: 0.75, high: 1.0 },
  postop_no_complication: { label: "Post-operatively (no complication)", low: 1.05, high: 1.15 },
  general_surgery: { label: "General surgery (major or with complications)", low: 1.2, high: 1.4 },
  organ_transplantation: { label: "Organ transplantation", low: 1.2, high: 1.2 },
  active_ibd: { label: "Active IBD", low: 1.1, high: 1.1 },
  fracture: { label: "Fracture", low: 1.25, high: 1.3 },
  sepsis_mild: { label: "Sepsis/infection: mild", low: 1.15, high: 1.3 },
  sepsis_severe: { label: "Severe sepsis (systemic)", low: 1.3, high: 1.45 },
  peritonitis: { label: "Peritonitis", low: 1.05, high: 1.4 },
  multiple_trauma: { label: "Multiple trauma", low: 1.3, high: 1.55 },
  respiratory_failure_copd: { label: "Respiratory failure/COPD (non-ventilated)", low: 1.0, high: 1.25 },
  active_tb: { label: "Active TB", low: 1.3, high: 1.7 },
  acute_pancreatitis: { label: "Acute pancreatitis", low: 1.1, high: 1.4 },
  tbi_closed_head_injury: { label: "Traumatic brain injury/closed head injury", low: 1.4, high: 1.4 },
  acute_spinal_cord_injury: { label: "Acute spinal cord injury", low: 0.5, high: 0.85 },
  icu_septic: { label: "ICU: septic", low: 1.2, high: 1.6 },
  cva: { label: "CVA/stroke", low: 1.05, high: 1.05 },
  leukaemia: { label: "Leukaemia", low: 1.3, high: 1.3 },
  lymphoma: { label: "Lymphoma", low: 1.3, high: 1.3 },
  solid_tumours: { label: "Solid tumours/cancer", low: 1.2, high: 1.2 },
  liver_disease: { label: "Liver disease", low: 1.3, high: 1.4 },
  wound_healing: { label: "Wound healing", low: 1.5, high: 1.5 },
};

export function stressFactorMidpoint(key) {
  const row = STRESS_FACTOR_TABLE[key];
  if (!row) return null;
  return { factor: Math.round(((row.low + row.high) / 2) * 100) / 100, label: row.label };
}

// ── Adults (>=18y): Harris-Benedict BEE ──────────────────────────────────
export function harrisBenedictBEE(sex, weightKg, heightCm, ageYears) {
  return sex === "male"
    ? 66.5 + 13.8 * weightKg + 5.0 * heightCm - 6.8 * ageYears
    : 655.1 + 9.6 * weightKg + 1.9 * heightCm - 4.7 * ageYears;
}

// ── Children (<18y): Schofield (1985), weight+height, age-banded ────────
export function schofieldBMR(sex, weightKg, heightCm, ageYears) {
  if (ageYears < 3) {
    return sex === "male"
      ? 0.17 * weightKg + 15.17 * heightCm - 617.6
      : 16.25 * weightKg + 10.232 * heightCm - 413.5;
  }
  if (ageYears < 10) {
    return sex === "male"
      ? 19.6 * weightKg + 1.303 * heightCm + 414.9
      : 16.97 * weightKg + 1.618 * heightCm + 371.2;
  }
  return sex === "male"
    ? 16.25 * weightKg + 1.372 * heightCm + 515.5
    : 8.365 * weightKg + 4.65 * heightCm + 200;
}

// ── Children (<18y): WHO (1985), weight-only fallback when height is
// unavailable — less precise than Schofield, but still usable.
export function whoBMR(sex, weightKg, ageYears) {
  if (ageYears < 3) return sex === "male" ? 60.9 * weightKg - 54 : 61 * weightKg - 51;
  if (ageYears < 10) return sex === "male" ? 22.7 * weightKg + 495 : 22.5 * weightKg + 499;
  return sex === "male" ? 17.5 * weightKg + 651 : 12.2 * weightKg + 746;
}

// Auto-selects adult (Harris-Benedict) vs pediatric (Schofield, or WHO if
// no height) by age, applies a single stress factor if given, and returns
// a structured result — or null if there isn't enough data to calculate
// (always needs sex + weight + age; adults and Schofield also need height).
export function calculateEnergyRequirement({ sex, ageYears, weightKg, heightCm, stressFactorKey }) {
  if (!sex || !weightKg || ageYears === undefined || ageYears === null) return null;

  const stress = stressFactorKey ? stressFactorMidpoint(stressFactorKey) : null;

  let base;
  let equation;
  let population;

  if (ageYears >= 18) {
    if (!heightCm) return null;
    base = harrisBenedictBEE(sex, weightKg, heightCm, ageYears);
    equation = "Harris-Benedict BEE";
    population = "adult";
  } else if (heightCm) {
    base = schofieldBMR(sex, weightKg, heightCm, ageYears);
    equation = "Schofield (1985) BMR";
    population = "pediatric";
  } else {
    base = whoBMR(sex, weightKg, ageYears);
    equation = "WHO (1985) BMR";
    population = "pediatric";
  }

  if (!(base > 0)) return null;

  const adjustedKcal = stress ? base * stress.factor : base;

  return {
    population,
    equation,
    baseKcalPerDay: Math.round(base),
    stressFactor: stress ? stress.factor : null,
    stressFactorLabel: stress ? stress.label : null,
    adjustedKcalPerDay: Math.round(adjustedKcal),
  };
}
