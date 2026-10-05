/**
 * Meal plan generation, rendering and in-place edits.
 *
 * Split out of src/index.js with no behaviour change.
 */

import { getFoodLabel } from "./chakudyaClient.js";
import { chakudyaFetch, fetchWithRetry } from "./http.js";
import { LLM_BUSY_MESSAGE } from "./errors.js";

// Meal-plan generation, in two passes:
//
// Pass 1 (Groq, one call): propose which Malawian/common foods go in each
// meal slot, given the person's demographics/condition/energy target — but
// NOT quantities or calories. That's deliberately left to pass 2, since an
// LLM's calorie/portion numbers are a guess, not a fact.
//
// Pass 2 (Chakudya, per unique food — see resolveFoodItem): look each
// proposed food up in the actual Chakudya Nutrition Registry. For anything
// in the local Malawi FCT table, this reuses getFoodLabel (the same
// function nutrition-label requests use), which returns Chakudya's own
// Serving-Size Intelligence default — a real Malawian household unit
// (1 chipande of nsima, 1 dzankho of groundnuts, etc. — see
// SERVING_SIZE_KEYWORDS in chakudya-api) with a grounded gram weight and
// kcal, not an invented one. Anything not in the local table falls back to
// the registry's wider USDA/OFF/FatSecret tier, shown as a flat 100g
// reference since local serving-size intelligence doesn't apply there.
// Items the registry can't resolve at all are still shown (Groq's
// suggestion), just without a grounded kcal figure.
//
// The final message is assembled here in code from that real data — Groq's
// job ends at proposing food names, it does not touch the final formatting
// or numbers.
//
// This bypasses /rag/ask (whose internal per-food fan-out reliably blows
// the subrequest ceiling on a request shaped like a meal plan — see
// SUBREQUEST_LIMIT_MESSAGE) while still grounding every number in the same
// registry /rag/ask itself draws from. Item count is capped (see
// MAX_MEAL_PLAN_ITEMS) to keep the resulting Chakudya lookups (up to 2 per
// item: local search + label, or 1 for the wider-tier fallback) well
// inside that ceiling.
const MAX_MEAL_PLAN_ITEMS = 14;

const MEAL_EMOJI = {
  breakfast: "🍳",
  "morning snack": "🥜",
  snack: "🥜",
  lunch: "🍲",
  "afternoon snack": "🍎",
  supper: "🍽️",
  dinner: "🍽️",
};

function emojiForMeal(mealName) {
  return MEAL_EMOJI[(mealName || "").trim().toLowerCase()] || "🍽️";
}

// Resolves one proposed food name against the Chakudya Nutrition Registry.
// Local FCT hit -> real Malawian household-unit serving (via getFoodLabel).
// Otherwise -> the wider CNR tier (USDA/OFF/FatSecret), flat 100g reference
// since Serving-Size Intelligence is local-table-only. Null if the
// registry has nothing at all for this name.
async function resolveFoodItem(foodName, env) {
  const local = await getFoodLabel(foodName, env);
  if (local?.label) {
    return {
      name: local.foodName || foodName,
      servingLabel: local.label.serving_size,
      kcal: local.label.calories,
      source: "local_fct",
    };
  }

  try {
    const res = await chakudyaFetch(env, `https://chakudya-api/foods/lookup?q=${encodeURIComponent(foodName)}`);
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const data = Array.isArray(body?.data) ? body.data[0] : body?.data;
    const kcal = data?.energy_kcal ?? data?.kcal;
    if (kcal == null) return null;
    return {
      name: data.food_name || foodName,
      servingLabel: "100g",
      kcal: Math.round(kcal),
      source: data.source || "cnr_wider_tier",
    };
  } catch (e) {
    return null;
  }
}

// Sends the meal plan progressively instead of building one big message —
// WhatsApp has no way to "stream" a single message as it's written (no
// edit-after-send API for outbound messages), so the only real way to make
// the answer visibly unfold is to send it as several messages, each as
// soon as that part is actually ready, rather than waiting for the whole
// plan to finish and sending it in one block at the end. Concretely:
// energy target (pure local math — sent before Groq is even called) ->
// each meal section (sent the moment its foods are resolved against
// Chakudya, one meal at a time rather than all of them in parallel) ->
// closing day-total/disclaimer. Returns { meals, resolvedByName } for
// session-context saving (see the caller in handleTextMessage), or
// { meals: null, resolvedByName: null } on failure — LLM_BUSY_MESSAGE is
// sent directly in that case since there's no caller-side text to send.
export async function generateMealPlan(req, energyResult, env) {
  const facts = [];
  if (req.age) facts.push(`Age: ${req.age} years`);
  if (req.sex) facts.push(`Sex: ${req.sex}`);
  if (req.weightKg) facts.push(`Weight: ${req.weightKg} kg`);
  if (req.heightCm) facts.push(`Height: ${req.heightCm} cm`);
  if (req.conditions.length) facts.push(`Condition(s): ${req.conditions.join(", ")}`);
  if (energyResult) {
    facts.push(`Daily energy target: ${energyResult.adjustedKcalPerDay} kcal/day`);
  }

  const systemPrompt =
    "You are a clinical nutrition assistant for Malawi. Propose which foods go in a one-day meal " +
    "plan — Breakfast, Morning Snack, Lunch, Afternoon Snack, Supper — favouring everyday Malawian " +
    "foods (nsima, beans, pumpkin leaves/nkhwani, groundnuts, usipa, chambo, soya pieces, local " +
    "fruit, etc.) wherever they fit the person's condition, alongside other suitable foods. If a " +
    "condition like diabetes, hypertension, renal disease, or pregnancy is given, favour foods " +
    "that suit it (e.g. for diabetes: lower-GI starches, more vegetables, no sugary items). List " +
    "1-3 plain food items per meal (simple names only, e.g. 'nsima', 'groundnuts', 'boiled egg', " +
    "'pumpkin leaves' — NOT full dish descriptions, NOT quantities, NOT calorie numbers; those are " +
    "resolved separately from real nutrition data). Respond with ONLY a JSON object, no other text, " +
    'exactly in this shape: {"meals":[{"name":"Breakfast","items":["food name","food name"]}, ...]}.';

  const userPrompt = facts.length
    ? `Propose a one-day meal plan's foods for a person with these details:\n${facts.join("\n")}`
    : `Propose a general one-day healthy meal plan's foods. Original request: "${req.rawText}"`;

  const res = await fetchWithRetry(fetch, "https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_completion_tokens: 1200,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    console.error("Groq meal plan error:", res.status, await res.text());
    return { text: LLM_BUSY_MESSAGE, meals: null, resolvedByName: null };
  }

  const planBody = await res.json();
  const rawContent = planBody?.choices?.[0]?.message?.content?.trim();
  if (!rawContent) {
    console.error("Groq meal plan empty content:", JSON.stringify(planBody).slice(0, 800));
    return { text: LLM_BUSY_MESSAGE, meals: null, resolvedByName: null };
  }

  let meals;
  try {
    // Strip ```json fences on the off chance the model adds them despite
    // response_format: json_object.
    const cleaned = rawContent.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    meals = JSON.parse(cleaned)?.meals;
  } catch (e) {
    console.error("Groq meal plan JSON parse error:", e.message, rawContent.slice(0, 500));
    return { text: LLM_BUSY_MESSAGE, meals: null, resolvedByName: null };
  }
  if (!Array.isArray(meals) || !meals.length) {
    console.error("Groq meal plan: no meals array in", rawContent.slice(0, 500));
    return { text: LLM_BUSY_MESSAGE, meals: null, resolvedByName: null };
  }

  // Resolve every unique proposed food against the Chakudya Nutrition
  // Registry, capped and run concurrently to keep this fast and bounded.
  const allNames = meals.flatMap((m) => (Array.isArray(m.items) ? m.items : []));
  const uniqueNames = [...new Set(allNames)].slice(0, MAX_MEAL_PLAN_ITEMS);
  const resolvedList = await Promise.all(uniqueNames.map((name) => resolveFoodItem(name, env)));
  const resolvedByName = new Map(uniqueNames.map((name, i) => [name, resolvedList[i]]));

  return {
    text: renderMealPlanText(meals, resolvedByName, energyResult),
    meals,
    resolvedByName,
  };
}

// Pure formatting step, shared between a freshly-generated plan
// (generateMealPlan) and an edited one (applyMealPlanEdit) — takes the
// meals structure and a Map of resolved Chakudya data (name -> {name,
// servingLabel, kcal, source} | null) and renders the same WhatsApp text
// either way, so an edit reply looks identical in shape to the original.
function renderMealPlanText(meals, resolvedByName, energyResult) {
  const lines = [];
  if (energyResult) {
    lines.push(`📊 Calculated energy target: ${energyResult.adjustedKcalPerDay} kcal/day (${energyResult.equation})`);
  }

  let totalKcal = 0;
  let anyGrounded = false;
  for (const meal of meals) {
    if (!meal?.name || !Array.isArray(meal.items) || !meal.items.length) continue;
    lines.push(`\n${emojiForMeal(meal.name)} *${meal.name}*`);
    for (const itemName of meal.items) {
      const item = resolvedByName.get(itemName);
      if (item?.kcal != null) {
        anyGrounded = true;
        totalKcal += item.kcal;
        lines.push(`• ${item.name} — ${item.servingLabel} (${item.kcal} kcal)`);
      } else {
        lines.push(`• ${itemName}`);
      }
    }
  }

  if (anyGrounded) {
    const vsTarget = energyResult ? ` (target ${energyResult.adjustedKcalPerDay} kcal)` : "";
    lines.push(`\n*Estimated day total: ~${totalKcal} kcal*${vsTarget}`);
  }

  lines.push(
    "",
    anyGrounded
      ? "Food data from the Chakudya Nutrition Registry where available; any item shown without a " +
          "kcal figure wasn't found in the registry. General sample plan, not a substitute for an " +
          "in-person clinical/dietitian assessment."
      : "Couldn't match these foods against the Chakudya Nutrition Registry this time — general " +
          "sample plan only, not a substitute for an in-person clinical/dietitian assessment."
  );

  return lines.join("\n");
}

// Applies a swap/remove edit (see detectMealPlanEdit in ./detectors.js) to
// a stored meal-plan context in place — no new Groq call, since only the
// one changed item needs resolving against Chakudya (or none at all for a
// removal). `target` is matched loosely (case-insensitive substring)
// against the plan's actual item names, since the user's wording won't
// match Groq's exact phrasing character-for-character. Returns
// { text, meals, resolvedByName } like generateMealPlan, or null if
// `target` isn't found anywhere in the plan.
export async function applyMealPlanEdit(edit, storedContext, env) {
  const meals = storedContext.meals.map((m) => ({ ...m, items: [...m.items] }));
  const resolvedByName = new Map(Object.entries(storedContext.resolved || {}));

  let matchedMeal = null;
  let matchedIndex = -1;
  let matchedName = null;
  const targetNorm = edit.target.toLowerCase();
  for (const meal of meals) {
    const idx = meal.items.findIndex((name) => name.toLowerCase().includes(targetNorm));
    if (idx !== -1) {
      matchedMeal = meal;
      matchedIndex = idx;
      matchedName = meal.items[idx];
      break;
    }
  }
  if (!matchedMeal) return null;

  if (edit.action === "remove") {
    matchedMeal.items.splice(matchedIndex, 1);
  } else {
    // swap
    const replacementItem = await resolveFoodItem(edit.replacement, env);
    matchedMeal.items[matchedIndex] = edit.replacement;
    resolvedByName.set(edit.replacement, replacementItem);
  }

  const nonEmptyMeals = meals.filter((m) => m.items.length > 0);
  const energyResult = storedContext.energyResult || null;
  return {
    text: renderMealPlanText(nonEmptyMeals, resolvedByName, energyResult),
    meals: nonEmptyMeals,
    resolvedByName,
    matchedName,
  };
}
