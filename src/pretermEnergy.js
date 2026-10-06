/**
 * Preterm infant energy / fluid requirements.
 *
 * "Caloric requirements for preterm babes" used to hit the adult energy calculator (Harris-Benedict /
 * Schofield) and get "I need sex, age, weight, height", which is wrong for a preterm infant. These
 * questions now call the Chakudya MCP tool preterm_fluid_energy_requirements (reference ranges from
 * BND 415 Paediatric Medicine Resources: enteral feeding) and show the per-kg ranges, plus daily
 * totals when a weight is given. If the tool is unavailable the message falls through to the normal
 * nutrition search, never to the adult calculator.
 *
 * Pure detection/formatting plus one MCP call; tests in test/pretermEnergy.test.js.
 */

import { callMcpTool } from "./screeningShared.js";

const PRETERM_RE = /\b(?:pre-?term|premature|prematurity|premies|premie|neonat\w*|newborns?|(?:very |extremely )?low[- ]birth[- ]?weight|[ve]?lbw)\b/i;
const TOPIC_RE = /\b(?:calor\w*|energy|kcal|fluids?|nutrition(?:al)?)\b/i;
const ASK_RE = /\b(?:requirements?|needs?|intake|targets?|how (?:much|many)|recommend\w*|calculate|estimate|per kg|reference)\b/i;

/** True when the message is about preterm / newborn infants (used to keep adult calculators away). */
export function isPretermMention(text) {
  return PRETERM_RE.test(String(text || ""));
}

// Preterm weights: 0.3-6 kg. "1.5kg", "1,5 kg", "1500g", "weighs 1200 grams".
function parseWeightKg(text) {
  const m = /(\d+(?:[.,]\d+)?)\s*(kgs?|kilograms?|kilos?|g|gm|gms|grams?)\b/i.exec(String(text || ""));
  if (!m) return null;
  let v = Number(m[1].replace(",", "."));
  if (!Number.isFinite(v)) return null;
  if (/^(?:g|gm|gms|grams?)$/i.test(m[2])) v /= 1000;
  return v >= 0.3 && v <= 6 ? Math.round(v * 1000) / 1000 : null;
}

/** { weightKg: number|null } for a preterm energy/fluid question, else null. */
export function detectPretermEnergyRequest(text) {
  const t = String(text || "");
  if (!isPretermMention(t) || !TOPIC_RE.test(t)) return null;
  const weightKg = parseWeightKg(t);
  // A stated weight ("calories for premature baby 1.2 kg") counts as asking, same as "requirements".
  if (!ASK_RE.test(t) && weightKg === null) return null;
  return { weightKg };
}

/** Calls the Chakudya MCP tool. weightKg may be null (per-kg ranges only; the tool is asked about 1 kg). */
export async function lookupPretermEnergy(weightKg, env) {
  return callMcpTool("preterm_fluid_energy_requirements", { weight_kg: weightKg ?? 1 }, env);
}

function range(est) {
  return est && Number.isFinite(est.low) && Number.isFinite(est.high) ? `${est.low}–${est.high}` : null;
}

/** WhatsApp text for a tool result. Throws if the result is missing the reference ranges. */
export function formatPretermEnergy(result, weightKg) {
  const energy = result?.energy_kcal_per_kg_per_day;
  const fluid = result?.fluid_ml_per_kg_per_day;
  if (!energy || !fluid) throw new Error("preterm result missing ranges");
  const lines = [
    "*Preterm infant — enteral requirements*",
    `• Energy: ${energy}`,
    `• Fluid: ${fluid}`,
  ];
  const kcal = range(result.energy_kcal_per_day_estimate);
  const ml = range(result.fluid_ml_per_day_estimate);
  if (weightKg && kcal && ml) {
    lines.push("", `For ${weightKg} kg: ≈${kcal} kcal/day · ≈${ml} mL/day`);
  } else {
    lines.push("", "Send the baby's weight for daily totals, e.g. “energy needs for a preterm baby 1.5kg”.");
  }
  lines.push("", `_Source: ${result.source || "BND 415 Paediatric Medicine Resources"}. Reference only — not a substitute for individual clinical assessment._`);
  return lines.join("\n");
}
