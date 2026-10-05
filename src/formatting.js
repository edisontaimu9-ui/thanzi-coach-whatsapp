/**
 * Pure text/data formatting: markdown -> WhatsApp, nutrient cards, citations, food-name helpers.
 *
 * Split out of src/index.js with no behaviour change.
 */



export function getFoodItemName(item) {
  return item?.product_name || item?.food_name || item?.name || null;
}

// Short human-readable label for a wider-tier match's source tag, shown in
// the disambiguation list so it's clear why this option differs from the
// local Malawi FCT ones (see lookupWiderTierFoodByName).
export function sourceLabel(source) {
  switch (source) {
    case "usda_fdc":
      return "USDA";
    case "off":
    case "open_food_facts":
      return "Open Food Facts";
    case "fatsecret":
      return "FatSecret";
    default:
      return "wider CNR tier";
  }
}

// Case/punctuation/whitespace-insensitive equality check, so "Nsima",
// "nsima." and "  nsima" all still count as a direct match against the
// item name, while a genuine misspelling or partial name doesn't.
export function normalizeFoodName(s) {
  return s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
}

export function isDirectFoodMatch(query, item) {
  const name = getFoodItemName(item);
  if (!name) return false;
  return normalizeFoodName(name) === normalizeFoodName(query);
}

// For food names the batch lookup couldn't resolve (not in the local FCT —
// e.g. "parboiled Usipa porridge"), ask Chakudya about each one
// individually via /rag/ask instead of giving up. Critically, each call is
// its own Worker invocation with its own subrequest budget — this is what
// keeps it safe where a single combined "A and B and C" /rag/ask call
// isn't: that one call's internal fan-out (KB + Malawi FCT + packaged/OCR +
// exchange lists + barcode + USDA/OFF/FatSecret cascade) happens per food
// term but all within the SAME invocation, so it can blow the
// per-invocation subrequest ceiling once you combine enough foods. Asking
// one food per call keeps every call single-topic and within budget. Runs
// in parallel; one name failing doesn't affect the others.
// The bare name alone reads as an open-ended question to Chakudya, which
// can dump every matching recipe/preparation variation it finds (e.g.
// "parboiled Usipa porridge" -> 5 different recipe-book blends) instead of
// a single figure — fine for a real question, bad for what's meant to be a
// quick nutrient lookup. Asking explicitly for one standard estimate keeps
// it in line with the compact card format batch-resolved foods use.
export function buildConciseNutritionQuery(name) {
  return `Nutrition facts per 100g for ${name}. If there are multiple preparations or recipe variations, give one representative estimate only — not a breakdown of each.`;
}

// Formats the combined results: batch-resolved foods as formatFoodResult
// cards, individually-resolved-via-rag foods as their own labeled section,
// and any name neither approach could resolve called out at the end.
// Returns null only if literally nothing resolved either way — caller
// falls back to the normal flow in that case.
export function formatMultiFoodResults(results, ragAnswers) {
  if (!results?.length && !ragAnswers?.length) return null;

  const sections = [];
  const unresolved = [];
  for (const { name, item } of results || []) {
    const card = formatFoodResult(item);
    if (card) sections.push(card);
    else unresolved.push(name);
  }

  const resolvedByRag = new Set();
  for (const { name, answer } of ragAnswers || []) {
    sections.push(`*${name}*\n${answer}`);
    resolvedByRag.add(name);
  }

  const stillUnresolved = unresolved.filter((name) => !resolvedByRag.has(name));
  if (!sections.length) return null;

  const lines = [sections.join("\n\n")];
  if (stillUnresolved.length) {
    lines.push(`\n⚠️ Couldn't find: ${stillUnresolved.join(", ")}`);
  }
  return lines.join("\n");
}

// Detects a food + specific gram amount, in either order — see
// detectFoodQuantity in ./detectors.js.

// Bare "just a quantity" follow-up ("Calculate for 50g serving") — see
// detectServingOnly in ./detectors.js.

// Extracts the durable bits of a food record we need to re-scale it later
// (name, its reference gram amount, and its macros AT that reference
// amount) — this is what gets persisted as "last food discussed" via
// saveLastFoodContext, and re-scaled by scaleFoodToGrams on a bare
// follow-up like "50g". Same base-grams derivation as answerFoodQuantity:
// only a gram-based measure can be linearly scaled, so non-gram units
// (cups, tablespoons) fall back to the 100g default like everywhere else
// in this file.
export function toFoodContext(item) {
  if (!item) return null;
  const name = item.product_name || item.food_name || item.name;
  if (!name) return null;

  const rawMeasure = item.measure || item.raw_data?.quantity;
  const measureGramsMatch = rawMeasure ? rawMeasure.match(/(\d+(?:\.\d+)?)\s*g\b/i) : null;
  const baseGrams = measureGramsMatch ? Number(measureGramsMatch[1]) : 100;
  if (!baseGrams) return null;

  return {
    name,
    baseGrams,
    // What amount was actually shown to the user for this context — starts
    // equal to baseGrams (the default card), but the foodQty and
    // servingOnly branches in handleTextMessage override this to the
    // requested amount before saving, so a later gram-based follow-up
    // scales from the SAME numbers the user just saw.
    lastShownGrams: baseGrams,
    kcal: item.kcal ?? item.energy_kcal,
    protein: item.protein_g,
    carbs: item.carbs_g,
    fat: item.fat_g,
    fiber: item.fiber_g,
    sodium: item.sodium_mg,
    potassium: item.potassium_mg,
    calcium: item.calcium_mg,
    iron: item.iron_mg,
  };
}

// Scales a saved food context (see toFoodContext) to a target gram amount
// with real arithmetic — no LLM, no RAG round-trip, so the SAME food
// always yields the SAME numbers for the SAME requested weight, call after
// call. Mirrors answerFoodQuantity's math exactly.
export function scaleFoodToGrams(context, grams) {
  if (!context?.baseGrams) return null;
  const factor = grams / context.baseGrams;
  const scale = (v) => (v == null ? null : Math.round(v * factor * 10) / 10);

  const kcal = scale(context.kcal);
  const protein = scale(context.protein);
  const carbs = scale(context.carbs);
  const fat = scale(context.fat);
  const fiber = scale(context.fiber);
  const sodium = scale(context.sodium);
  const potassium = scale(context.potassium);
  const calcium = scale(context.calcium);
  const iron = scale(context.iron);

  const macros = [];
  if (kcal != null) macros.push(`${kcal} kcal`);
  if (protein != null) macros.push(`${protein}g protein`);
  if (carbs != null) macros.push(`${carbs}g carbs`);
  if (fat != null) macros.push(`${fat}g fat`);
  if (!macros.length) return null;

  const micros = [];
  if (fiber != null) micros.push(`Fiber ${fiber}g`);
  if (sodium != null) micros.push(`Sodium ${sodium}mg`);
  if (potassium != null) micros.push(`Potassium ${potassium}mg`);
  if (calcium != null) micros.push(`Calcium ${calcium}mg`);
  if (iron != null) micros.push(`Iron ${iron}mg`);

  // Headed as a nutrition-for-this-weight answer (not a plain food card), with the base amount it was
  // scaled from, so it's clear these numbers are for the requested portion.
  const lines = [`⚖️ *Nutrition in ${grams} g of ${context.name}*`, macros.join(", ")];
  if (micros.length) lines.push(micros.join(", "));
  lines.push(`_Scaled from the ${context.baseGrams} g reference values._`);
  return lines.join("\n");
}

// Formats calculateEnergyRequirement's result (see ./energy.js) for a
// standalone "calculate energy requirements" reply — the real math itself,
// with the equation named so it's clear this is a calculated figure, not
// an LLM guess.
export function formatEnergyRequirementResult(result) {
  const lines = [
    `📊 *Estimated energy requirement*`,
    `Equation: ${result.equation}`,
    `Base (${result.population === "adult" ? "BEE" : "BMR"}): ${result.baseKcalPerDay} kcal/day`,
  ];
  if (result.stressFactor) {
    lines.push(`Stress factor: x${result.stressFactor} (${result.stressFactorLabel})`);
    lines.push(`*Adjusted: ${result.adjustedKcalPerDay} kcal/day*`);
  } else {
    lines.push(`*Total: ${result.adjustedKcalPerDay} kcal/day*`);
  }
  lines.push(
    "",
    "Reference/estimate only — not a substitute for individualized clinical/dietitian assessment."
  );
  return lines.join("\n");
}

// Round a nutrient value to at most 2 decimal places for display. Chakudya
// sometimes returns long repeating decimals (e.g. from scaling a label's
// per-serving values to per-100g, like 100/28 = 3.571428571...), which look
// broken in a WhatsApp message. Non-numbers pass through unchanged.
export function roundNutrient(n) {
  if (typeof n !== "number" || !isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

// Formats a Food/PackagedFood/external-lookup result (field names vary by
// source) into a short WhatsApp-friendly card.
export function formatFoodResult(item) {
  if (!item) return null;
  const name = item.product_name || item.food_name || item.name;
  if (!name) return null;

  const brandName = item.brand || item.raw_data?.brands;
  const brand = brandName ? ` (${brandName})` : "";
  // USDA/Malawi FCT nutrient values are reported per 100g by standard
  // convention when no other serving size is given (unlike branded/OFF
  // products, which usually specify their own package quantity) — default
  // to that instead of silently omitting the amount.
  const measure = item.measure || item.raw_data?.quantity || "100 g";
  const measureText = ` — ${measure}`;
  const kcal = roundNutrient(item.kcal ?? item.energy_kcal);
  const protein = roundNutrient(item.protein_g);
  const carbs = roundNutrient(item.carbs_g);
  const fat = roundNutrient(item.fat_g);
  // The "necessary micros" — the full WHO/Malawi-priority micronutrient
  // panel (see sql/001_add_micronutrients_to_foods.sql on the Chakudya
  // side) rather than the raw FCT panel. Each only shows up here if the
  // source actually has a value for it, so a plain FCT food with just
  // fiber/sodium/potassium/calcium/iron stays a short card, while a
  // packaged-food label scan that captured the full panel shows all of it —
  // useful as an on-the-spot confirmation of what got captured/submitted.
  const fiber = roundNutrient(item.fiber_g);
  const sodium = roundNutrient(item.sodium_mg);
  const potassium = roundNutrient(item.potassium_mg);
  const calcium = roundNutrient(item.calcium_mg);
  const iron = roundNutrient(item.iron_mg);
  const zinc = roundNutrient(item.zinc_mg);
  const magnesium = roundNutrient(item.magnesium_mg);
  const folate = roundNutrient(item.folate_mcg);
  const vitaminA = roundNutrient(item.vita_rae_mcg);
  const vitaminC = roundNutrient(item.vitc_mg);
  const vitaminD = roundNutrient(item.vitd_mcg);
  const vitaminB12 = roundNutrient(item.vitb12_mcg);
  const iodine = roundNutrient(item.iodine_mcg);

  const macros = [];
  if (kcal != null) macros.push(`${kcal} kcal`);
  if (protein != null) macros.push(`${protein}g protein`);
  if (carbs != null) macros.push(`${carbs}g carbs`);
  if (fat != null) macros.push(`${fat}g fat`);

  const micros = [];
  if (fiber != null) micros.push(`Fiber ${fiber}g`);
  if (sodium != null) micros.push(`Sodium ${sodium}mg`);
  if (potassium != null) micros.push(`Potassium ${potassium}mg`);
  if (calcium != null) micros.push(`Calcium ${calcium}mg`);
  if (iron != null) micros.push(`Iron ${iron}mg`);
  if (zinc != null) micros.push(`Zinc ${zinc}mg`);
  if (magnesium != null) micros.push(`Magnesium ${magnesium}mg`);
  if (folate != null) micros.push(`Folate ${folate}mcg`);
  if (vitaminA != null) micros.push(`Vitamin A ${vitaminA}mcg`);
  if (vitaminC != null) micros.push(`Vitamin C ${vitaminC}mg`);
  if (vitaminD != null) micros.push(`Vitamin D ${vitaminD}mcg`);
  if (vitaminB12 != null) micros.push(`Vitamin B12 ${vitaminB12}mcg`);
  if (iodine != null) micros.push(`Iodine ${iodine}mcg`);

  const lines = [`*${name}*${brand}${measureText}`];
  if (macros.length) lines.push(macros.join(", "));
  if (micros.length) lines.push(micros.join(", "));
  return lines.join("\n");
}

export function formatSubstitutes(data) {
  if (!data) return null;
  if (!data.substitution_group) {
    return `Couldn't find a known substitution group for *${data.original?.food_name}*. Try asking about a common Malawian staple, protein source, or vegetable instead.`;
  }

  const lines = [`*Substitutes for ${data.original.food_name}* (${data.substitution_group})`];
  for (const s of data.substitutes || []) {
    const p = s.per_100g || {};
    lines.push(`• ${s.food_name} — ${roundNutrient(p.kcal) ?? "?"} kcal, ${roundNutrient(p.protein_g) ?? "?"}g protein per 100g`);
  }
  if (!data.substitutes?.length) lines.push("No close nutritional matches found in the local database.");
  if (data.note) lines.push(`\n_${data.note}_`);
  return lines.join("\n");
}

export function formatDrugInteractions(matches, query) {
  if (!matches.length) {
    return `No drug-nutrient interaction entry found for "${query}" in the clinical database. This doesn't confirm there's no interaction — always check with a pharmacist or clinician. 🙏`;
  }

  const lines = [`*Drug-nutrient interactions: ${query}*`];
  for (const m of matches.slice(0, 3)) {
    lines.push(`\n*${m.drug}*${m.severity ? ` — ${m.severity}` : ""}`);
    if (m.effects?.length) lines.push(`Effects: ${m.effects.slice(0, 3).join("; ")}`);
    if (m.implications?.length) lines.push(`Guidance: ${m.implications.slice(0, 3).join("; ")}`);
  }
  if (matches.length > 3) lines.push(`\n(+${matches.length - 3} more matches — ask more specifically to narrow it down)`);
  lines.push("\n_Clinical reference only — confirm with a pharmacist or clinician before changing medication or diet._");
  return lines.join("\n");
}

export function formatNutritionLabel(label, foodName) {
  if (!label) return null;
  const lines = [
    `*Nutrition Label — ${foodName}*`,
    `Serving: ${label.serving_size} (${label.serving_grams}g)`,
  ];
  if (label.calories != null) lines.push(`Calories: ${roundNutrient(label.calories)} kcal`);
  if (label.total_fat_g != null) lines.push(`Total Fat: ${roundNutrient(label.total_fat_g)}g`);
  if (label.saturated_fat_g != null) lines.push(`  Saturated Fat: ${roundNutrient(label.saturated_fat_g)}g`);
  if (label.carbohydrates_g != null) lines.push(`Carbohydrates: ${roundNutrient(label.carbohydrates_g)}g`);
  if (label.fiber_g != null) lines.push(`  Fiber: ${roundNutrient(label.fiber_g)}g`);
  if (label.sugars_g != null) lines.push(`  Sugars: ${roundNutrient(label.sugars_g)}g`);
  if (label.protein_g != null) lines.push(`Protein: ${roundNutrient(label.protein_g)}g`);
  if (label.sodium_mg != null) lines.push(`Sodium: ${roundNutrient(label.sodium_mg)}mg`);

  const vm = Object.entries(label.vitamins_minerals || {});
  if (vm.length) {
    lines.push("");
    lines.push("Vitamins & Minerals:");
    for (const [name, val] of vm) lines.push(`  ${name}: ${roundNutrient(val)}`);
  }
  if (label.missing_fields?.length) {
    lines.push(`\n_Not on file for this food: ${label.missing_fields.join(", ")}._`);
  }
  return lines.join("\n");
}

export function formatDriAnswer(data, driReq) {
  if (!data?.nutrient) return null;
  const n = data.nutrient;

  const lines = [`*${n.label} — Recommended Intake*`, `Life stage: ${data.life_stage_label}`];
  if (n.rda != null) lines.push(`RDA: ${n.rda} ${n.unit}`);
  else if (n.ai != null) lines.push(`Adequate Intake (AI): ${n.ai} ${n.unit}`);
  else lines.push("No RDA/AI established for this nutrient at this life stage.");
  if (n.ul != null) {
    lines.push(`Upper Limit (UL): ${n.ul} ${n.unit} — avoid exceeding this from food + supplements combined.`);
  }
  if (driReq?.assumedAge) {
    lines.push(`\n_Assumed age ~${driReq.age} since none was given — mention your exact age for a more precise figure._`);
  }
  lines.push("\n_Source: US Food & Nutrition Board (NASEM/IOM) Dietary Reference Intakes, via the Chakudya Nutrition Registry._");
  return lines.join("\n");
}

// We don't control Chakudya's internal prompt/retrieval logic (separate
// repo), but the query text itself IS fed to its LLM — so for
// multi-topic questions (comparisons, or "X and Y" combos like a patient
// with two conditions) we can nudge retrieval/answering toward covering
// everything asked, and give it a bigger top_k so retrieval has room for
// both topics instead of one crowding out the other.
function isMultiTopicQuery(query) {
  return /\b(compare|comparison|vs\.?|versus|and)\b|&/i.test(query);
}

export function normalizeMultiTopicQuery(query) {
  if (!isMultiTopicQuery(query)) return query;
  return `${query} (If this covers multiple foods, conditions, or topics, please address each one using all relevant available information, and use consistent serving sizes when comparing foods.)`;
}

// NOTE: previously tried appending "always state the reference amount" as
// an instruction to the query text sent to Chakudya, to fix answers that
// mentioned nutrient values without saying what serving size they're for.
// Pulled it — it appears to have changed how Chakudya's retrieval routes
// the query, causing single-word food lookups (e.g. "Quinoa") to return
// only the exchange-list match and skip its external cascade (USDA, Malawi
// FCT) entirely, which is a worse regression than the problem it fixed.
// If this needs solving again, it belongs in Chakudya's own answer
// generation/prompt (separate repo), not as extra text bolted onto the
// query here.

// Chakudya's citation markers sometimes come back as fullwidth brackets
// (【1】) instead of standard ASCII ([1]) — visually similar but a different
// character, so every regex here that looks for "[n]" (renumberCitations,
// markdownToWhatsApp's italicizer) would silently miss them entirely,
// leaving raw, unexplained 【n】 markers with no reference list. Normalize to
// ASCII brackets immediately after the answer comes back, before anything
// else touches it.
export function normalizeCitationBrackets(text) {
  if (!text) return text;
  return text.replace(/[【\[]\s*(\d+)\s*[】\]]/g, "[$1]");
}

// Chakudya returns a `sources` array (id, title) separate from the answer
// text, which just has inline "[1]" markers using Chakudya's own internal
// source ids — these are rarely 1, 2, 3, ... in order (could be [3], [7],
// [12], ...) since they're indices into Chakudya's full source list, not
// per-answer citation numbers. This renumbers them to a clean 1, 2, 3, ...
// sequence based on first appearance in the answer, rewrites the inline
// markers to match, and builds the reference list using the same numbers.
// If the same source is cited under two different original ids, the second
// occurrence reuses the first's number instead of taking a new one, so the
// sequence never has a number with no matching reference line.
export function renumberCitations(answerText, sources) {
  if (!sources?.length) return { text: answerText, references: "" };

  const idToNumber = new Map();
  const labelToNumber = new Map();
  const refLines = [];
  let next = 1;

  for (const m of answerText.matchAll(/\[(\d+)\]/g)) {
    const id = Number(m[1]);
    if (idToNumber.has(id)) continue; // already assigned a number

    const src = sources.find((s) => s.id === id);
    const label = prettifySourceLabel(src?.title);

    if (label && labelToNumber.has(label)) {
      idToNumber.set(id, labelToNumber.get(label));
      continue;
    }

    const num = next++;
    idToNumber.set(id, num);
    if (label) {
      labelToNumber.set(label, num);
      refLines.push(`[${num}] ${label}`);
    }
    // else: source id had no matching entry/title — still gets a number so
    // the visible sequence stays consecutive, just no reference line for it.
  }

  if (!idToNumber.size) return { text: answerText, references: "" };

  const renumbered = answerText.replace(/\[(\d+)\]/g, (whole, idStr) => {
    const num = idToNumber.get(Number(idStr));
    return num ? `[${num}]` : whole;
  });

  const references = refLines.length ? `\n\n_References:_\n${refLines.join("\n")}` : "";
  return { text: renumbered, references };
}

// Some source titles are raw internal slugs (e.g. "exchange_lists") rather
// than a real document title — makes for an ugly, meaningless reference
// line. Detect that pattern (all lowercase snake_case, no spaces/
// punctuation — real titles always have those) and turn it into a
// readable label instead. Genuine titles (book/document names, food
// names) pass through unchanged.
function prettifySourceLabel(title) {
  if (!title) return null;
  if (/^[a-z0-9]+(_[a-z0-9]+)*$/.test(title)) {
    const words = title
      .split("_")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
    return `Chakudya ${words} Database`;
  }
  return title;
}

// Chakudya's answers come back in standard Markdown (**bold**, # headers,
// "- " bullets, | table | rows). WhatsApp only understands its own
// lightweight formatting (*bold* with single asterisks, _italic_,
// ~strikethrough~) and has NO concept of headers or tables — anything else
// shows up as literal characters. This converts the common cases so replies
// render properly in the chat.
export function markdownToWhatsApp(text) {
  if (!text) return text;
  return convertMarkdownTables(text)
    // "### Heading" / "## Heading" -> "*Heading*"
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    // "**bold**" or "__bold__" -> "*bold*" (WhatsApp's single-asterisk bold)
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    // "- item" or "* item" bullets -> "• item"
    .replace(/^[-*]\s+/gm, "• ")
    // "[1]" / "[1][2]" citation markers -> italicized with WhatsApp's _..._
    .replace(/(?:\[\d+\])+/g, (m) => `_${m}_`);
}

// Turns a markdown table (| Header | Header |\n|---|---|\n| val | val |)
// into readable lines, since WhatsApp can't render tables at all — pipes
// would otherwise show up as literal "|" characters on a cramped mobile
// screen. Each row becomes: "*first column* — col2: val, col3: val, ..."
function convertMarkdownTables(text) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;

  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSeparator = (l) => isRow(l) && /^[\s|:-]+$/.test(l) && l.includes("-");
  const cells = (l) =>
    l
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  while (i < lines.length) {
    if (isRow(lines[i]) && isSeparator(lines[i + 1] || "")) {
      const headerCells = cells(lines[i]);
      i += 2; // skip header row + separator row
      while (i < lines.length && isRow(lines[i])) {
        const rowCells = cells(lines[i]);
        const label = rowCells[0] || "";
        const rest = headerCells
          .slice(1)
          .map((h, idx) => {
            const val = rowCells[idx + 1];
            return val && val !== "-" ? `${h}: ${val}` : null;
          })
          .filter(Boolean)
          .join(", ");
        out.push(rest ? `*${label}* — ${rest}` : `*${label}*`);
        i++;
      }
      out.push(""); // blank line after the table
      continue;
    }
    out.push(lines[i]);
    i++;
  }

  return out.join("\n");
}

// WhatsApp's Cloud API rejects text messages over 4096 characters outright
// (it doesn't silently truncate) — long Chakudya answers with references
// can exceed that. Rather than ever cut content, split into multiple
// messages sent in order. Prefers breaking at a paragraph boundary, then a
// line break, then a space, so it never splits mid-word/mid-markdown-token
// unless truly forced to.
const WHATSAPP_MAX_LEN = 4000;

// a little under the real 4096 cap, as headroom

export function splitForWhatsApp(text, maxLen = WHATSAPP_MAX_LEN) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen * 0.4) cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.4) cut = remaining.lastIndexOf(" ", maxLen);
    if (cut < maxLen * 0.4) cut = maxLen; // no good boundary — hard split

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);

  return chunks;
}
