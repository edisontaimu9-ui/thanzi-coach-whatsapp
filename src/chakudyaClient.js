/**
 * Chakudya API client: food lookups, comparisons, barcode/label, DRI, interactions, and the RAG askChakudya.
 *
 * Split out of src/index.js with no behaviour change.
 */

import { chakudyaFetch, retryOnceOnUnavailable } from "./http.js";
import { buildConciseNutritionQuery, formatFoodResult, getFoodItemName, markdownToWhatsApp, normalizeCitationBrackets, normalizeFoodName, normalizeMultiTopicQuery, renumberCitations, roundNutrient, scaleFoodToGrams, sourceLabel, toFoodContext } from "./formatting.js";
import { LLM_BUSY_MESSAGE, SUBREQUEST_LIMIT_MESSAGE, isProviderUnavailable, looksLikeLeakedProviderError } from "./errors.js";

// Detects a comparison request naming 2-6 foods (see detectFoodComparison
// in ./detectors.js for the shapes it matches).

export async function lookupFoodByName(name, env) {
  const res = await chakudyaFetch(env, 
    `https://chakudya-api/foods/lookup?q=${encodeURIComponent(name)}`
  );
  if (!res.ok) return null;
  const body = await res.json();
  return Array.isArray(body?.data) ? body.data[0] : body?.data || null;
}

// Same as lookupFoodByName, but forces chakudya-api's wider USDA/OFF/
// FatSecret tier via ?tier=wider, skipping the local Malawi FCT match
// entirely. Local FCT entries are sometimes a different preparation than
// what a plain name implies (e.g. the local "Rice, soaked" entry vs. a
// generic "rice, cooked" ask) — this gives a second, source-labelled
// option in that case instead of only ever offering the local match.
export async function lookupWiderTierFoodByName(name, env) {
  const res = await chakudyaFetch(
    env,
    `https://chakudya-api/foods/lookup?q=${encodeURIComponent(name)}&tier=wider`
  );
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const data = Array.isArray(body?.data) ? body.data[0] : body?.data;
  return data ? { ...data, _widerTier: true } : null;
}

// GET /foods/search — unlike /foods/lookup (which always collapses to one
// best-guess winner from local->fuzzy->USDA/OFF/FatSecret), this endpoint
// runs Chakudya's pg_trgm typo-tolerant fuzzy search directly over the
// local Malawi FCT table and genuinely returns multiple ranked candidates
// (see sql/008_add_fuzzy_food_search.sql in chakudya-api). Local-data only
// — it won't find a non-Malawian food resolved only via the external
// cascade — so callers should still fall back to /foods/lookup's own
// answer when this comes back empty (see the bare-food-name branch above).
export async function searchFoodCandidates(name, env, maxResults = 3) {
  const res = await chakudyaFetch(env, 
    `https://chakudya-api/foods/search?q=${encodeURIComponent(name)}&max_results=${maxResults}`
  );
  if (!res.ok) return [];
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.data) ? body.data.slice(0, maxResults) : [];
}

// A handful of headline nutrients kept for the "highlights" section — the
// full /foods/compare micronutrient panel is too long for a WhatsApp
// message, so only these get a highest/lowest callout.
const COMPARE_HIGHLIGHT_FIELDS = [
  { field: "energy_kcal", label: "Energy" },
  { field: "protein_g", label: "Protein" },
  { field: "fiber_g", label: "Fiber" },
  { field: "iron_mg", label: "Iron" },
  { field: "calcium_mg", label: "Calcium" },
  { field: "vitc_mg", label: "Vitamin C" },
];

// GET /foods/compare (2-6 foods) — Chakudya resolves each name (local FCT,
// fuzzy match, then USDA/OFF/FatSecret cascade, same as /foods/lookup),
// computes the full per-100g panel, and flags the highest/lowest food per
// nutrient itself. Returns a formatted WhatsApp message, or null if fewer
// than 2 of the named foods could be resolved (caller falls back to
// /rag/ask in that case).
export async function compareFoodsViaChakudya(foodNames, env) {
  const res = await chakudyaFetch(env, 
    `https://chakudya-api/foods/compare?foods=${encodeURIComponent(foodNames.join(","))}`
  );
  if (res.status === 400) return null; // fewer than 2 resolved — let rag/ask try
  if (!res.ok) return null;

  const body = await res.json().catch(() => null);
  const data = body?.data;
  if (!data?.foods?.length) return null;

  const lines = [`*Comparing (per 100g):* ${data.foods.map((f) => f.food_name).join(", ")}`];

  for (const food of data.foods) {
    const p = food.per_100g || {};
    const macros = [];
    if (p.energy_kcal != null) macros.push(`${roundNutrient(p.energy_kcal)} kcal`);
    if (p.protein_g != null) macros.push(`${roundNutrient(p.protein_g)}g protein`);
    if (p.carbs_g != null) macros.push(`${roundNutrient(p.carbs_g)}g carbs`);
    if (p.fat_g != null) macros.push(`${roundNutrient(p.fat_g)}g fat`);
    lines.push(`\n*${food.food_name}* — ${macros.join(", ") || "no macro data"}`);
    if (food.glycaemic?.entries?.length) {
      const gi = food.glycaemic.entries[0];
      if (gi.gi_value != null) lines.push(`GI: ${gi.gi_value} (${gi.source})`);
    }
  }

  const highlights = COMPARE_HIGHLIGHT_FIELDS
    .map(({ field, label }) => {
      const nc = data.nutrient_comparison?.[field];
      if (!nc || nc.highest == null) return null;
      return nc.highest === nc.lowest
        ? `${label}: about the same across all`
        : `${label}: highest in ${nc.highest}, lowest in ${nc.lowest}`;
    })
    .filter(Boolean);

  if (highlights.length) {
    lines.push("\n🏆 *Highlights*");
    lines.push(highlights.join("\n"));
  }

  if (data.unresolved?.length) {
    lines.push(`\n⚠️ Couldn't find: ${data.unresolved.join(", ")}`);
  }

  // Same problem this feature originally had for bare-name lookups ("Rice"
  // resolving to the local "Rice, soaked" with no indication a USDA "Rice,
  // cooked" also exists) applies here too — /foods/compare resolves each
  // name via the same local-first cascade. Rather than changing which food
  // gets compared (that would make the per-100g numbers inconsistent with
  // what was actually requested), surface the wider-tier alternative as a
  // note so the person can ask about it directly if the local match wasn't
  // the preparation they meant.
  const localFoods = data.foods.filter(
    (f) => f.matched_source === "local" || f.matched_source === "local_fuzzy"
  );
  if (localFoods.length) {
    const widerResults = await Promise.all(
      localFoods.map((f) => lookupWiderTierFoodByName(f.requested_as, env))
    );
    const altLines = [];
    localFoods.forEach((f, i) => {
      const wider = widerResults[i];
      const widerName = wider ? getFoodItemName(wider) : null;
      if (!widerName || normalizeFoodName(widerName) === normalizeFoodName(f.food_name)) return;
      const kcal = roundNutrient(wider.energy_kcal ?? wider.kcal);
      altLines.push(
        `• "${f.requested_as}" matched *${f.food_name}* locally — ${sourceLabel(wider.source)} also has ` +
          `*${widerName}*${kcal != null ? ` (${kcal} kcal/100g)` : ""}. Ask about it by name if that's what you meant.`
      );
    });
    if (altLines.length) {
      lines.push("\n💡 *Other matches available*");
      lines.push(altLines.join("\n"));
    }
  }

  return lines.join("\n");
}

// Plain "X and Y[, and Z]" food descriptions with no "compare"/"vs" wording
// — see detectMultiFoodList in ./detectors.js.

// One /foods/lookup per named food, sent together as a single POST /batch
// call (see chakudya-api's /batch) instead of N separate service-binding
// calls — same round-trip either way (service bindings are in-process), but
// bundling keeps this to one call site rather than a Promise.all of raw
// lookupFoodByName() calls, and gives us per-item status/failure handling
// for free via the batch envelope. Returns null on a hard failure (bad
// response, batch malformed) so the caller falls back to /rag/ask; a
// per-item miss just comes back with item: null in that slot instead of
// failing the whole batch.
export async function lookupFoodsViaBatch(foodNames, env) {
  const res = await chakudyaFetch(env, "https://chakudya-api/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: foodNames.map((name, i) => ({
        id: String(i),
        method: "GET",
        path: `/foods/lookup?q=${encodeURIComponent(name)}`,
      })),
    }),
  });
  if (!res.ok) return null;

  const body = await res.json().catch(() => null);
  if (!Array.isArray(body?.data)) return null;

  return foodNames.map((name, i) => {
    const entry = body.data.find((r) => r.id === String(i));
    const item = entry?.status === 200 ? entry.body?.data : null;
    return { name, item: Array.isArray(item) ? item[0] : item };
  });
}

export async function resolveUnknownFoodsViaRag(names, fromNumber, env) {
  const settled = await Promise.all(
    names.map(async (name) => {
      try {
        const answer = await askChakudya(buildConciseNutritionQuery(name), fromNumber, env);
        return { name, answer };
      } catch (err) {
        console.error("resolveUnknownFoodsViaRag failed for", name, err);
        return { name, answer: null };
      }
    })
  );
  return settled.filter((r) => r.answer);
}

// Looks up a food's per-100g-equivalent record, then scales its kcal/
// protein/carbs/fat by real arithmetic to the requested gram amount — no
// LLM involved, so it's both exact and avoids Chakudya's RAG pipeline
// (which has hit its own subrequest ceiling on queries shaped like this).
// Only scales against a gram-based measure (our own 100g default, or an
// explicit "<N> g" in the record) — non-gram units (cups, tablespoons)
// can't be linearly scaled without knowing their gram weight, so those
// cases return null and fall back to /rag/ask instead.
export async function answerFoodQuantity(food, grams, env) {
  const item = await lookupFoodByName(food, env);
  const context = toFoodContext(item);
  if (!context) return null;

  const text = scaleFoodToGrams(context, grams);
  if (!text) return null;

  // Return the context alongside the text so the caller can remember this
  // as "the food we're currently talking about" (see saveLastFoodContext)
  // — a later bare "50g" from the same user re-scales THIS food, exactly.
  return { text, context };
}

export async function scanPackagedLabel(base64, mimeType, env, barcode) {
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const payload = { images: [dataUrl] };
  // Pass along a barcode we already decoded locally/via Groq so
  // /packaged/scan doesn't have to re-derive it from the photo — and so
  // the submitted row is correctly keyed to it even if the barcode itself
  // isn't clearly visible in this particular shot of the label.
  if (barcode) payload.barcode = barcode;
  const res = await chakudyaFetch(env, "https://chakudya-api/packaged/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (res.status === 422) {
    return {
      text: "I couldn't read enough from this image. Please take a clearer photo of the nutrition label and send it again. 🙏",
      context: null,
    };
  }
  if (isProviderUnavailable(res.status)) {
    console.error("Packaged scan provider unavailable:", res.status, await res.text());
    return { text: LLM_BUSY_MESSAGE, context: null };
  }
  if (!res.ok) {
    throw new Error(`Packaged scan error: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  const result = formatFoodResult(body?.data);
  if (result && looksLikeLeakedProviderError(result)) {
    console.error("Packaged scan leaked a provider error:", result);
    return { text: SUBREQUEST_LIMIT_MESSAGE, context: null };
  }
  // A scan always lands as status="pending" (see handlePackagedScan) — it's
  // added to the review queue, not live yet. Say so explicitly so the user
  // doesn't think this barcode is now instantly searchable by anyone.
  const submissionNote = body?.message ? `\n\n📋 ${body.message}` : "";
  return {
    text: result
      ? `${result}${submissionNote}`
      : "I read the image, but couldn't find enough information.",
    context: toFoodContext(body?.data),
  };
}

export async function lookupBarcode(barcode, env) {
  const res = await chakudyaFetch(env, 
    `https://chakudya-api/foods/lookup?barcode=${encodeURIComponent(barcode)}`
  );
  // A 404 here just means "this barcode isn't in Chakudya's database" — an
  // everyday, expected outcome (most packaged Malawian products aren't
  // catalogued yet), not a failure. Treating it as a thrown error was the
  // actual bug: it sent every not-yet-catalogued barcode straight to the
  // generic "something went wrong" reply instead of the friendly
  // "couldn't find it in the database" message the caller already has
  // below — which is exactly what happened scanning the "More!" yoghurt
  // drink barcode. Only a real provider failure should still throw.
  if (res.status === 404) return null;
  if (isProviderUnavailable(res.status)) {
    console.error("Barcode lookup provider unavailable:", res.status, await res.text());
    return null;
  }
  if (!res.ok) {
    throw new Error(`Barcode lookup error: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  // A barcode lookup returns `data` as a single object; a name search
  // (q=...) returns `data` as an array. Handle both.
  const item = Array.isArray(body?.data) ? body.data[0] : body?.data;
  if (!item) return null;
  const text = formatFoodResult(item);
  // Return the raw item too (not just the formatted card) so callers can
  // remember it as "last food discussed" — see toFoodContext/saveLastFoodContext.
  return text ? { item, text } : null;
}

// --- Food substitutions (/foods/substitutes) ---
//
// "substitute for nsima" / "what can I use instead of rice" — Chakudya
// resolves the food, classifies it into a substitution group, and ranks
// candidates by nutritional closeness itself (see chakudya-api's
// handleFoodSubstitutes). This just formats the result. See
// detectSubstituteRequest in ./detectors.js.


export async function getFoodSubstitutes(foodName, env) {
  const res = await chakudyaFetch(env, 
    `https://chakudya-api/foods/substitutes?food_name=${encodeURIComponent(foodName)}`
  );
  if (res.status === 404) return null; // food itself wasn't found — fall back to rag/ask
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.data || null;
}

// --- Drug-nutrient interactions (/drug-interactions/search) ---
//
// "interactions with warfarin" / "foods to avoid while taking metformin" —
// Chakudya's own migrated clinical reference table (drug, category,
// severity, effects, implications), not a general RAG answer. Structured
// fields come through verbatim so the severity/guidance isn't paraphrased.
// See detectDrugInteractionQuery in ./detectors.js.


export async function searchDrugInteractions(query, env) {
  const res = await chakudyaFetch(env, 
    `https://chakudya-api/drug-interactions/search?q=${encodeURIComponent(query)}`
  );
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.data) ? body.data : null;
}

// --- Nutrition label (/foods + /foods/:id/label) ---
//
// "nutrition label for rice" — /foods/:id/label needs a numeric local-`foods`
// id, so this first resolves the name via a plain /foods search (not the
// external-cascade /foods/lookup, since /foods/:id/label only works on
// rows actually in the local `foods` table) then requests the label. See
// detectLabelRequest in ./detectors.js.


export async function getFoodLabel(foodName, env) {
  const searchRes = await chakudyaFetch(env, 
    `https://chakudya-api/foods?search=${encodeURIComponent(foodName)}&limit=1`
  );
  if (!searchRes.ok) return null;
  const searchBody = await searchRes.json().catch(() => null);
  const match = Array.isArray(searchBody?.data) ? searchBody.data[0] : null;
  if (!match?.id) return null; // not in the local FCT table — labels aren't available for it

  const labelRes = await chakudyaFetch(env, `https://chakudya-api/foods/${match.id}/label`);
  if (!labelRes.ok) return null;
  const labelBody = await labelRes.json().catch(() => null);
  if (!labelBody?.data) return null;
  return { label: labelBody.data, foodName: labelBody.food_name || match.food_name };
}

// --- Dietary Reference Intakes (/dri) ---
//
// "how much iron do I need" / "RDA for calcium for a pregnant woman" —
// Chakudya's own NASEM/IOM DRI tables, resolved from an age/sex/life-stage
// guess extracted from the message text. See detectDriRequest in
// ./detectors.js.

export async function lookupDri({ nutrientKey, age, sex, lifeStageType }, env) {
  const params = new URLSearchParams();
  params.set("nutrient", nutrientKey);
  params.set("age", String(age));
  if (sex) params.set("sex", sex);
  if (lifeStageType) params.set("life_stage_type", lifeStageType);

  const res = await chakudyaFetch(env, `https://chakudya-api/dri?${params.toString()}`);
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.data || null;
}

export async function askChakudya(query, fromNumber, env) {
  // Service binding call — internal Worker-to-Worker, not a public fetch.
  // See wrangler.toml for why (avoids Cloudflare error 1042).
  const ragInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: normalizeMultiTopicQuery(query),
      context: "both",
      // top_k: 20 for multi-topic queries pushed Chakudya's internal
      // per-item fan-out (KB + Malawi FCT + exchange lists, etc.) past
      // Cloudflare's per-invocation subrequest ceiling and broke retrieval
      // entirely ("Too many subrequests"). 12 is the safe ceiling that
      // still works — rely on the query-text nudge above (no extra
      // subrequests) to get fuller multi-topic coverage instead.
      top_k: 12,
      // Using the sender's WhatsApp number as session_id gives each user
      // their own Thandizo memory thread across conversations.
      session_id: `whatsapp-${fromNumber}`,
    }),
  };
  // A busy (429/5xx) answer gets one quiet retry after ~2s before the person sees "busy".
  const res = await retryOnceOnUnavailable(() => chakudyaFetch(env, "https://chakudya-api/rag/ask", ragInit));

  if (isProviderUnavailable(res.status)) {
    console.error("Chakudya provider unavailable:", res.status, await res.text());
    return LLM_BUSY_MESSAGE;
  }

  if (!res.ok) {
    throw new Error(`Chakudya API error: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  const answer = normalizeCitationBrackets(
    body?.data?.answer || "Sorry, I couldn't find an answer to that question."
  );

  if (looksLikeLeakedProviderError(answer)) {
    console.error("Chakudya leaked a provider error into the answer text:", answer);
    return SUBREQUEST_LIMIT_MESSAGE;
  }

  const { text: renumberedAnswer, references } = renumberCitations(answer, body?.data?.sources);
  return markdownToWhatsApp(renumberedAnswer) + references;
}
