/**
 * Pure text-parsing detectors used by src/index.js to route an inbound
 * WhatsApp message to the right handler ("compare nsima and rice" vs.
 * "substitute for nsima" vs. a bare food name, etc.).
 *
 * Kept in their own module — with no fetch/env/D1/wasm dependency — so
 * they can be unit tested directly under plain Node (see test/detectors.test.js)
 * without spinning up the Workers runtime. index.js imports everything it
 * needs from here.
 */

// Plain numeric text (8-14 digits) is almost always a barcode being typed
// or pasted in, not a nutrition question. Fast-path it to /foods/lookup for
// instant structured data instead of routing through the LLM in /rag/ask.
export function looksLikeBarcode(text) {
  return /^\d{8,14}$/.test(text.trim());
}

// A short message with no "?" and no question/verb wording ("Quinoa",
// "Soya pieces") reads as a food-name lookup rather than a question — route
// these to /foods/lookup directly (see handleTextMessage) instead of
// /rag/ask, which has a serving-size metadata gap on cached external
// results. Deliberately conservative: real questions (has "?", or starts
// with a question/imperative word) are left alone and still go to RAG.
export const BARE_QUERY_LEADING_WORDS =
  /^(what|how|why|when|where|who|which|is|are|can|does|do|should|will|would|could|tell|explain|describe|list|give|show|compare)\b/i;

export function looksLikeBareFoodName(text) {
  const t = text.trim();
  if (!t || t.includes("?")) return false;
  const words = t.split(/\s+/);
  if (words.length > 5) return false;
  if (BARE_QUERY_LEADING_WORDS.test(t)) return false;
  return true;
}

// Plain small-talk (greetings, "how are you", thanks, bye) doesn't need
// Chakudya's nutrition retrieval at all — routing it through /rag/ask just
// burns a request and comes back with an odd, citation-laden answer to a
// question that was never really about food/health data. Handled with an
// instant tappable prompt list instead (see sendPromptList), matched on the
// whole message (trimmed, punctuation stripped) so it doesn't misfire on a
// real question that merely starts with "hi" or similar. Replies in
// whichever language the greeting itself was in.
export const ENGLISH_GREETINGS = [
  "hi", "hello", "hey", "hiya", "yo",
  "good morning", "good afternoon", "good evening", "good day",
  "how are you", "how are you?", "how're you", "hows it going", "how's it going",
  "what's up", "whats up", "sup",
  "thanks", "thank you",
  "bye", "goodbye", "see you",
];

export const CHICHEWA_GREETINGS = [
  "moni", "muli bwanji", "mwauka bwanji", "mwadzuka bwanji", "odi", "zikomo",
];

// Returns "en", "ny", or null (not a recognized greeting at all).
export function detectGreetingLanguage(text) {
  const t = text.trim().toLowerCase().replace(/[!?.,]+$/g, "");
  if (ENGLISH_GREETINGS.includes(t)) return "en";
  if (CHICHEWA_GREETINGS.includes(t)) return "ny";
  return null;
}

// A single-word item that's just a cooking/preparation state almost never
// names its own separate food — it's describing whatever came right before
// it. "rice, cooked" is ONE food ("rice, cooked" or "rice — cooked"), not
// "rice" + "cooked" as two comparison targets. This matches Chakudya's own
// Malawi FCT naming convention, which uses exactly this comma shape
// ("Rice, soaked", "Oats, cooked", "Maize thick porridge, refined flour").
// Without this, "compare nsima and rice, cooked" splits into THREE items
// (nsima/rice/cooked), and the bare "cooked" then fuzzy-matches onto
// whatever unrelated local food happens to have "cooked" in its name.
const FOOD_PREPARATION_DESCRIPTORS = new Set([
  "cooked", "raw", "boiled", "steamed", "fried", "roasted", "grilled",
  "baked", "soaked", "dried", "mashed", "chopped", "sliced", "ground",
  "whole", "ripe", "unripe", "fresh", "frozen", "canned", "pickled",
  "smoked", "cured", "peeled", "shredded", "blanched", "toasted", "stewed",
]);

// Detects a comparison request naming 2-6 foods, in any of these shapes:
//   "compare nsima, rice and potatoes"   (comma/and list after "compare")
//   "100g of X compared with/to Y"
//   "X vs Y" / "X versus Y"
// Returns an array of 2-6 trimmed food-name strings, or null.
export function splitFoodList(text) {
  const rawItems = text
    .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const merged = [];
  for (const item of rawItems) {
    const isBarePreparationWord =
      merged.length > 0 &&
      !item.includes(" ") &&
      FOOD_PREPARATION_DESCRIPTORS.has(item.toLowerCase());
    if (isBarePreparationWord) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}, ${item}`;
    } else {
      merged.push(item);
    }
  }
  return merged;
}

export const stripTrailingVerb = (s) =>
  s.replace(/\s+(provide|providing|have|has|contain|contains)$/i, "").trim();

export function detectFoodComparison(query) {
  const listMatch = query.match(/\bcompare\b\s+([a-z0-9 ,()'&-]+?)[?.!]?$/i);
  if (listMatch) {
    const items = splitFoodList(listMatch[1]);
    if (items.length >= 2) return items.slice(0, 6);
  }

  const ofCompared = query.match(
    /\bof\s+([a-z0-9 ,()'-]+?)\s+compared\s+(?:with|to)\s+(?:\d+\s*g(?:rams)?\s+of\s+)?([a-z0-9 ,()'-]+?)[?.!]?$/i
  );
  if (ofCompared) return [stripTrailingVerb(ofCompared[1].trim()), ofCompared[2].trim()];

  const vsMatch = query.match(/^([a-z0-9 ,()'-]+?)\s+(?:vs\.?|versus)\s+([a-z0-9 ,()'-]+?)[?.!]?$/i);
  if (vsMatch) return [vsMatch[1].trim(), vsMatch[2].trim()];

  return null;
}

// Plain "X and Y[, and Z]" food descriptions (no "compare"/"vs" wording, no
// "?") — reuses splitFoodList (comma/and/&) but, unlike detectFoodComparison,
// doesn't require an explicit comparison verb. Deliberately conservative:
// bails on anything that reads like a real question (has "?", or starts
// with a question/imperative word — same list looksLikeBareFoodName uses)
// and on any split item longer than 6 words, so an ordinary sentence that
// happens to contain "and" doesn't get misread as a food list.
export function detectMultiFoodList(text) {
  const t = text.trim();
  if (!t || t.includes("?")) return null;
  if (BARE_QUERY_LEADING_WORDS.test(t)) return null;
  const items = splitFoodList(t);
  if (items.length < 2 || items.length > 6) return null;
  if (items.some((item) => !item || item.split(/\s+/).length > 6)) return null;
  return items;
}

// Common filler words that end up wrapped around the food name when the
// gram amount trails the food ("find energy and macros for quinoa 200g")
// — stripped iteratively from the front until only the food name is left.
export const QUANTITY_LEADING_FILLERS = new Set([
  "find", "energy", "and", "macro", "macros", "for", "of", "nutrition",
  "value", "in", "calculate", "calculation", "please", "me", "give",
  "show", "tell", "the", "a", "an", "what", "is", "are", "how", "much",
  "many", "kcal", "calories",
]);

export function stripLeadingFillers(phrase) {
  const words = phrase.trim().split(/\s+/);
  while (words.length > 1 && QUANTITY_LEADING_FILLERS.has(words[0].toLowerCase())) {
    words.shift();
  }
  return words.join(" ");
}

// Detects a food + specific gram amount, in either order:
// "200g of quinoa" / "how many calories in 200g of rice?" (amount first),
// or "quinoa 200g" / "find energy and macros for quinoa 200g" (amount last).
export function detectFoodQuantity(query) {
  const amountFirst = query.match(
    /(\d+(?:\.\d+)?)\s*g(?:rams)?\s+(?:of\s+)?([a-z][a-z '-]*?)[?.!]?$/i
  );
  if (amountFirst) {
    const grams = Number(amountFirst[1]);
    const food = amountFirst[2].trim();
    if (grams > 0 && grams < 10000 && food) return { food, grams };
  }

  const amountLast = query.match(
    /([a-z][a-z '-]*?)\s+(\d+(?:\.\d+)?)\s*g(?:rams)?[?.!]?$/i
  );
  if (amountLast) {
    const grams = Number(amountLast[2]);
    const food = stripLeadingFillers(amountLast[1]);
    if (grams > 0 && grams < 10000 && food) return { food, grams };
  }

  return null;
}

// Filler words allowed in a "no food name, just a quantity" follow-up —
// covers both direct forms ("Calculate for 50g serving", "scale to 200g
// please") AND natural pronoun-referenced questions about whatever was
// just discussed ("How much can it provide in 100g?", "What's in 100g of
// that?", "How much does it have per 100g"). If any OTHER word remains
// after stripping the gram token and these fillers, the message names an
// actual food and isn't a bare follow-up (detectFoodQuantity above
// handles that case) — so it's safe to be generous here: a genuine
// question with a real food name in it ("how much protein does chicken
// have in 100g") still leaves "chicken" behind and correctly falls
// through instead of being swallowed.
export const SERVING_ONLY_FILLERS = new Set([
  "calculate", "calc", "compute", "scale", "convert", "recalculate",
  "show", "shows", "give", "gives", "giving", "make", "for", "to", "a",
  "an", "the", "of", "me", "please", "now", "serving", "portion", "size",
  "sized", "amount", "quantity", "total",
  // pronoun/question forms referring to a food already discussed
  "how", "much", "many", "can", "could", "would", "will", "does", "do",
  "did", "is", "are", "was", "were", "has", "have", "had", "it", "its",
  "that", "this", "there", "in", "per", "out", "provide", "provides",
  "providing", "provided", "contain", "contains", "containing",
  "supply", "supplies", "supplying", "offer", "offers", "deliver",
  "delivers", "what", "whats",
]);

export function detectServingOnly(query) {
  const gramMatch = query.match(/(\d+(?:\.\d+)?)\s*g(?:rams)?\b/i);
  if (!gramMatch) return null;
  const grams = Number(gramMatch[1]);
  if (!(grams > 0 && grams < 10000)) return null;

  const withoutGram = query.slice(0, gramMatch.index) + query.slice(gramMatch.index + gramMatch[0].length);
  const words = withoutGram
    .toLowerCase()
    .replace(/[?.!,']/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const namesAFood = words.some((w) => !SERVING_ONLY_FILLERS.has(w));
  if (namesAFood) return null;

  return { grams };
}

// --- Food substitutions (/foods/substitutes) ---
//
// "substitute for nsima" / "what can I use instead of rice" — Chakudya
// resolves the food, classifies it into a substitution group, and ranks
// candidates by nutritional closeness itself (see chakudya-api's
// handleFoodSubstitutes). This just formats the result.
export function detectSubstituteRequest(text) {
  const t = text.trim();
  let m = t.match(/\b(?:substitutes?|alternatives?|replacements?)\s+(?:for|to)\s+([a-z0-9 '()-]+?)[?.!]?$/i);
  if (m) return m[1].trim();
  m = t.match(/\bwhat can i (?:use|eat|have)\s+instead of\s+([a-z0-9 '()-]+?)[?.!]?$/i);
  if (m) return m[1].trim();
  m = t.match(/^instead of\s+([a-z0-9 '()-]+?),?\s+what can i (?:use|eat|have)\b/i);
  if (m) return m[1].trim();
  return null;
}

// --- Drug-nutrient interactions (/drug-interactions/search) ---
//
// "interactions with warfarin" / "foods to avoid while taking metformin" —
// Chakudya's own migrated clinical reference table (drug, category,
// severity, effects, implications), not a general RAG answer. Structured
// fields come through verbatim so the severity/guidance isn't paraphrased.
export function detectDrugInteractionQuery(text) {
  const t = text.trim();
  let m = t.match(/\b(?:drug[- ]?nutrient )?interactions?\s+(?:with|for|of)\s+([a-z0-9 '()-]+?)[?.!]?$/i);
  if (m) return m[1].trim();
  m = t.match(/\bfoods?\s+to\s+avoid\s+(?:while|when)?\s*(?:taking|on)\s+([a-z0-9 '()-]+?)[?.!]?$/i);
  if (m) return m[1].trim();
  m = t.match(/\bwhat (?:foods|nutrients)\s+(?:should i avoid|interact)\s+with\s+([a-z0-9 '()-]+?)[?.!]?$/i);
  if (m) return m[1].trim();
  return null;
}

// --- Nutrition label (/foods + /foods/:id/label) ---
//
// "nutrition label for rice" — /foods/:id/label needs a numeric local-`foods`
// id, so this first resolves the name via a plain /foods search (not the
// external-cascade /foods/lookup, since /foods/:id/label only works on
// rows actually in the local `foods` table) then requests the label.
export function detectLabelRequest(text) {
  const t = text.trim();
  let m = t.match(/\b(?:nutrition(?:al)? (?:facts )?label|food label)\s+(?:for|of)\s+([a-z0-9 '()-]+?)[?.!]?$/i);
  if (m) return m[1].trim();
  m = t.match(/\bshow (?:me )?(?:the )?label for\s+([a-z0-9 '()-]+?)[?.!]?$/i);
  if (m) return m[1].trim();
  return null;
}

// --- Dietary Reference Intakes (/dri) ---
//
// "how much iron do I need" / "RDA for calcium for a pregnant woman" ->
// resolved from an age/sex/life-stage guess extracted from the message
// text (see detectDriRequest). When no age is stated, a representative
// default is used and flagged in the reply rather than silently presented
// as exact.
export const DRI_NUTRIENT_KEYWORDS = {
  iron: "iron_mg",
  calcium: "calcium_mg",
  zinc: "zinc_mg",
  magnesium: "magnesium_mg",
  potassium: "potassium_mg",
  sodium: "sodium_mg",
  iodine: "iodine_mcg",
  protein: "protein_g",
  fiber: "fiber_g",
  fibre: "fiber_g",
  folate: "folate_mcg",
  "folic acid": "folate_mcg",
  "vitamin a": "vita_rae_mcg",
  "vit a": "vita_rae_mcg",
  "vitamin c": "vitc_mg",
  "vit c": "vitc_mg",
  "vitamin d": "vitd_mcg",
  "vit d": "vitd_mcg",
  "vitamin b12": "vitb12_mcg",
  "vitamin b-12": "vitb12_mcg",
  "vit b12": "vitb12_mcg",
  carbohydrate: "carbs_g",
  carbohydrates: "carbs_g",
  carbs: "carbs_g",
};
// Longest phrase first so "vitamin b12" is tried before any shorter
// substring of it could accidentally match instead.
export const DRI_NUTRIENT_PHRASES = Object.keys(DRI_NUTRIENT_KEYWORDS).sort((a, b) => b.length - a.length);

export function matchDriNutrient(phrase) {
  const p = phrase.toLowerCase().trim();
  for (const key of DRI_NUTRIENT_PHRASES) {
    if (p.includes(key)) return DRI_NUTRIENT_KEYWORDS[key];
  }
  return null;
}

// --- Clinical stress condition (Barak et al 2002 stress factor table) ---
//
// Maps a mentioned condition to the same stress_factor_table keys used by
// chakudya-mcp-server-cloudflare's harrisBenedictStressFactorTools.ts /
// ./energy.js STRESS_FACTOR_TABLE. Ordered most-specific first (e.g.
// "severe sepsis" before plain "sepsis/infection") since only ONE factor
// should ever be applied — per source, never stacked. Returns the first
// matching key, or null if no recognized stress condition is mentioned
// (most outpatient/meal-plan requests won't have one, which is expected —
// calculateEnergyRequirement just skips the stress multiplier in that case).
const STRESS_CONDITION_PATTERNS = [
  ["sepsis_severe", /\b(severe sepsis|septic shock)\b/i],
  ["icu_septic", /\bicu\b.*\bsept/i],
  ["sepsis_mild", /\b(sepsis|infection)\b/i],
  ["multiple_trauma", /\btrauma\b/i],
  ["fracture", /\bfracture(d)?\b/i],
  ["tbi_closed_head_injury", /\b(tbi|traumatic brain injury|head injury|closed head injury)\b/i],
  ["acute_spinal_cord_injury", /\bspinal cord injury\b/i],
  ["organ_transplantation", /\btransplant/i],
  ["active_ibd", /\b(ibd|crohn|ulcerative colitis)\b/i],
  ["peritonitis", /\bperitonitis\b/i],
  ["respiratory_failure_copd", /\b(copd|respiratory failure)\b/i],
  ["active_tb", /\b(active tb|active tuberculosis)\b/i],
  ["acute_pancreatitis", /\bpancreatitis\b/i],
  ["cva", /\b(cva|stroke)\b/i],
  ["leukaemia", /\bleukaemia|leukemia\b/i],
  ["lymphoma", /\blymphoma\b/i],
  ["solid_tumours", /\b(cancer|tumou?r|malignan)/i],
  ["liver_disease", /\b(liver disease|cirrhosis|hepatic)\b/i],
  ["wound_healing", /\b(wound|pressure sore|pressure ulcer)\b/i],
  ["starvation_refeeding", /\b(refeeding|starvation|severe malnutrition)\b/i],
  ["general_surgery", /\bmajor surgery\b/i],
  ["postop_no_complication", /\bpost[- ]?op(erative)?\b/i],
];

export function detectStressCondition(text) {
  for (const [key, pattern] of STRESS_CONDITION_PATTERNS) {
    if (pattern.test(text)) return key;
  }
  return null;
}

// --- Meal plan requests (Groq, direct — see generateMealPlan in index.js) ---
//
// "Create meal plan for 53 years old woman with diabetes she weighs 90kg &
// height is 168cm" — these are compound clinical asks (age + sex + weight +
// height + condition, sometimes several meals/days worth of foods) that
// blow Chakudya's /rag/ask subrequest ceiling (see the big comment in
// index.js above SUBREQUEST_LIMIT_MESSAGE) far more reliably than an
// ordinary multi-food question does, since a meal plan itself fans out
// into many food items internally. Routed instead to a single direct Groq
// call (see generateMealPlan) — one subrequest, no Chakudya fan-out.
// Extracts whatever structured fields the message states (age/sex/weight/
// height/condition) so Groq gets them as clean data rather than having to
// re-parse the raw sentence itself; anything not stated is simply omitted
// rather than guessed.
// --- Shared clinical demographic extraction (age/sex/weight/height/
// conditions/stress condition) — used by both detectMealPlanRequest and
// detectEnergyRequirementRequest below so the two intents parse the same
// fields the same way.
function extractClinicalDemographics(t) {
  let sex = null;
  if (/\b(woman|women|female|girl|lady)\b/i.test(t)) sex = "female";
  if (/\b(man|men|male|boy)\b/i.test(t)) sex = "male";

  let age = null;
  const ageMatch = t.match(/\b(\d{1,3})\s*[- ]?\s*(?:years?|yrs?|yo)\s*(?:old)?\b/i);
  if (ageMatch) age = Number(ageMatch[1]);

  let weightKg = null;
  const weightMatch = t.match(/\b(\d{2,3}(?:\.\d+)?)\s*kg\b/i);
  if (weightMatch) weightKg = Number(weightMatch[1]);

  let heightCm = null;
  const heightCmMatch = t.match(/\b(\d{2,3}(?:\.\d+)?)\s*cm\b/i);
  const heightMMatch = t.match(/\b(\d(?:\.\d+)?)\s*m(?:eters?|etres?)?\b/i);
  if (heightCmMatch) heightCm = Number(heightCmMatch[1]);
  else if (heightMMatch) heightCm = Number(heightMMatch[1]) * 100;

  const conditions = [];
  if (/\bdiabet/i.test(t)) conditions.push("diabetes");
  if (/\bhypertension|high blood pressure\b/i.test(t)) conditions.push("hypertension");
  if (/\b(renal|kidney)\b/i.test(t)) conditions.push("renal disease");
  if (/\bpregnan/i.test(t)) conditions.push("pregnancy");
  if (/\blactat|breastfeed/i.test(t)) conditions.push("lactation");
  if (/\bhiv\b/i.test(t)) conditions.push("HIV");
  if (/\bmalnutrition|underweight|wasting\b/i.test(t)) conditions.push("malnutrition");
  if (/\bobes|overweight\b/i.test(t)) conditions.push("obesity");

  const stressConditionKey = detectStressCondition(t);

  return { age, sex, weightKg, heightCm, conditions, stressConditionKey, rawText: t };
}

// --- Meal plan requests (Groq, direct — see generateMealPlan in index.js) ---
//
// "Create meal plan for 53 years old woman with diabetes she weighs 90kg &
// height is 168cm" — these are compound clinical asks (age + sex + weight +
// height + condition, sometimes several meals/days worth of foods) that
// blow Chakudya's /rag/ask subrequest ceiling (see the big comment in
// index.js above SUBREQUEST_LIMIT_MESSAGE) far more reliably than an
// ordinary multi-food question does, since a meal plan itself fans out
// into many food items internally. Routed instead to a single direct Groq
// call (see generateMealPlan) — one subrequest, no Chakudya fan-out.
// Extracts whatever structured fields the message states (age/sex/weight/
// height/condition) so Groq gets them as clean data rather than having to
// re-parse the raw sentence itself; anything not stated is simply omitted
// rather than guessed.
export function detectMealPlanRequest(text) {
  const t = text.trim();
  if (!/\b(meal|diet|food|menu)\s*plan\b/i.test(t)) return null;
  return extractClinicalDemographics(t);
}

// --- Direct energy-requirement calculation requests (no meal plan wording)
// ---
//
// "calculate energy requirements for a 6 year old boy weighing 20kg",
// "BEE for a 45 year old man, 70kg, 175cm", "how many calories does she
// need" — a standalone ask for the number itself, answered with real
// Harris-Benedict/Schofield/WHO math (see ./energy.js), not routed through
// Groq or /rag/ask at all.
export function detectEnergyRequirementRequest(text) {
  const t = text.trim();
  const isEnergyPhrase =
    /\b(energy|calorie|caloric|nutrition(al)?)\s+(requirement|need|intake)s?\b/i.test(t) ||
    /\b(bee|bmr)\b/i.test(t) ||
    /\bbasal (energy|metabolic) (expenditure|rate)\b/i.test(t) ||
    /\bhow many calories\b/i.test(t);
  if (!isEnergyPhrase) return null;
  return extractClinicalDemographics(t);
}

export function detectDriRequest(text) {
  const t = text.trim();

  let nutrientPhrase = null;
  let m = t.match(/\bhow much\s+([a-z0-9 -]+?)\s+do(?:es)?\s+(?:i|a|an|my|the)\b.*\bneed\b/i);
  if (m) nutrientPhrase = m[1];
  if (!nutrientPhrase) {
    m = t.match(
      /\b(?:rda|recommended (?:daily )?(?:allowance|intake)|dri|daily (?:requirement|need)s?|adequate intake)\s+(?:for|of)\s+([a-z0-9 -]+?)[?.!]?$/i
    );
    if (m) nutrientPhrase = m[1];
  }
  if (!nutrientPhrase) return null;

  const nutrientKey = matchDriNutrient(nutrientPhrase);
  if (!nutrientKey) return null;

  let sex = null;
  if (/\b(woman|women|female|girl)\b/i.test(t)) sex = "female";
  if (/\b(man|men|male|boy)\b/i.test(t)) sex = "male";

  let lifeStageType = "normal";
  if (/\b(pregnant|pregnancy)\b/i.test(t)) {
    lifeStageType = "pregnancy";
    sex = "female";
  } else if (/\b(lactating|breastfeeding|breast-feeding|nursing)\b/i.test(t)) {
    lifeStageType = "lactation";
    sex = "female";
  }

  let age = null;
  let assumedAge = false;
  const ageMatch = t.match(/\b(\d{1,3})\s*[- ]?\s*(?:years?|yrs?|yo)\b/i);
  if (ageMatch) {
    age = Number(ageMatch[1]);
  } else if (lifeStageType !== "normal") {
    age = 25; // representative reproductive-age default for pregnancy/lactation
    assumedAge = true;
  } else if (/\b(child|infant|baby|toddler)\b/i.test(t)) {
    return null; // too many life-stage tiers to guess safely without an age
  } else if (sex) {
    age = 30; // representative adult default when only sex is given
    assumedAge = true;
  } else {
    return null; // not enough info to resolve a life stage safely
  }

  return { nutrientKey, age, sex, lifeStageType, assumedAge };
}
