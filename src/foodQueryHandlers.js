/**
 * Text routing, part 3: food quantity, serving-only follow-ups, bare food names.
 *
 * Split out of handleTextMessage in src/index.js with no behaviour change: each handler gets the
 * shared routing context `c` ({ userText, from, env, ctx, opts, topic, langState, lang,
 * repliesInChichewa }) and returns true when it handled (replied to) the message.
 */

import { answerFoodQuantity, lookupFoodByName, lookupWiderTierFoodByName, searchFoodCandidates } from "./chakudyaClient.js";
import { getLastFoodContext, saveLastFoodContext } from "./context.js";
import { detectFoodQuantity, detectServingOnly, looksLikeBareFoodName } from "./detectors.js";
import { formatFoodResult, getFoodItemName, isDirectFoodMatch, normalizeFoodName, scaleFoodToGrams, toFoodContext } from "./formatting.js";
import { sendFoodOptionsList, sendWhatsAppReply } from "./whatsapp.js";

/** Food quantity ("100g nsima"), serving-only follow-ups, and bare food-name lookups. Returns true when handled. */
export async function handleFoodQueries(c) {
  const { userText, from, env, ctx, topic } = c;

  // "quinoa 200g" / "200g of rice" — a specific-weight nutrition request is
  // arithmetic (scale the per-100g figures), not something an LLM should be
  // asked to compute. Doing it as real math here is both more reliable and
  // avoids routing through /rag/ask, which has hit its own subrequest limit
  // on queries shaped like this.
  const foodQty = detectFoodQuantity(userText);
  if (foodQty) {
    topic.name = "food_lookup";
    const scaled = await answerFoodQuantity(foodQty.food, foodQty.grams, env);
    if (scaled) {
      await sendWhatsAppReply(from, scaled.text, env);
      ctx.waitUntil(
        saveLastFoodContext(from, { ...scaled.context, lastShownGrams: foodQty.grams }, env)
      );
      return true;
    }
  }

  // A bare gram amount with no food name at all ("Calculate for 50g
  // serving", "50g", "scale to 200g") is a follow-up on whatever food was
  // just discussed, NOT a new question — but /rag/ask has no reliable
  // memory of which food or reference amount that was (its session-based
  // memory can silently pick a different reference between calls for the
  // same food, giving inconsistent answers for the same request). Recompute
  // it ourselves from the last food we resolved for this user, with real
  // arithmetic against the SAME base measure every time.
  const servingOnly = detectServingOnly(userText);
  if (servingOnly) {
    topic.name = "food_lookup";
    const context = await getLastFoodContext(from, env);
    if (context) {
      const scaled = scaleFoodToGrams(context, servingOnly.grams);
      if (scaled) {
        await sendWhatsAppReply(from, scaled, env);
        ctx.waitUntil(
          saveLastFoodContext(from, { ...context, lastShownGrams: servingOnly.grams }, env)
        );
        return true;
      }
    }
    // No recent food on file (or it's too old/unscalable) — fall through
    // to bare-food-name / rag/ask below, same as any other message.
  }

  // A bare food name ("Quinoa", "Soya pieces") is really a lookup, not a
  // question. Chakudya's /rag/ask retrieval sometimes indexes its cached
  // USDA/external results without a serving-size field, so the LLM has to
  // hedge with "(unspecified typical serving)" — a gap in Chakudya's own
  // knowledge-base indexing we can't patch from here (separate repo).
  // /foods/lookup reliably includes a real measure, so route bare names
  // there directly and only fall back to /rag/ask if nothing is found.
  //
  // /foods/lookup always resolves to a single best guess (its own local ->
  // fuzzy -> USDA/OFF/FatSecret cascade picks one winner internally) — it
  // never hands back alternatives, so it can't itself power a "did you
  // mean" list. Chakudya's separate /foods/search endpoint is the one that
  // actually returns multiple ranked, typo-tolerant candidates (pg_trgm
  // fuzzy match over the local Malawi FCT table) — see searchFoodCandidates.
  // So: use /foods/lookup's answer directly when it's a genuine direct/
  // exact name match; otherwise pull up to 3 candidates from /foods/search
  // and offer them as a tappable list instead of guessing (see
  // sendFoodOptionsList — tapping a row re-sends its exact name through
  // this same pipeline, which then resolves as a direct match). If
  // /foods/lookup's own answer isn't among those local candidates (e.g. a
  // non-Malawian food /foods/search can't see, resolved instead via the
  // external cascade), it's added as an extra option rather than dropped.
  if (looksLikeBareFoodName(userText)) {
    topic.name = "food_lookup";
    const query = userText.trim();
    const topResult = await lookupFoodByName(query, env);

    if (topResult && isDirectFoodMatch(query, topResult)) {
      const card = formatFoodResult(topResult);
      if (card) {
        await sendWhatsAppReply(from, card, env);
        const context = toFoodContext(topResult);
        if (context) ctx.waitUntil(saveLastFoodContext(from, context, env));
        return true;
      }
    } else {
      const [candidates, widerTierResult] = await Promise.all([
        searchFoodCandidates(query, env, 3),
        lookupWiderTierFoodByName(query, env),
      ]);
      const topName = topResult ? getFoodItemName(topResult) : null;
      const alreadyListed =
        topName &&
        candidates.some((c) => normalizeFoodName(getFoodItemName(c) || "") === normalizeFoodName(topName));
      if (topResult && !alreadyListed) candidates.unshift(topResult);

      // Add the wider-tier (USDA/OFF/FatSecret) match too, when it's a
      // genuinely different food than what's already listed — this is
      // what lets someone pick a generic "rice, cooked" (USDA) instead of
      // only ever being offered the local Malawi FCT's "Rice, soaked".
      // Applies to every bare-name lookup, not just rice. Fixed at 3
      // total options either way — if the wider-tier match is new, it
      // takes a reserved slot (bumping the lowest-ranked local candidate)
      // rather than being tacked on as a 4th, so local and external are
      // always competing for the same 3 slots, not local-plus-extra.
      const widerName = widerTierResult ? getFoodItemName(widerTierResult) : null;
      const widerAlreadyListed =
        widerName &&
        candidates.some((c) => normalizeFoodName(getFoodItemName(c) || "") === normalizeFoodName(widerName));
      const finalCandidates =
        widerName && !widerAlreadyListed
          ? [...candidates.slice(0, 2), widerTierResult]
          : candidates;

      if (finalCandidates.length) {
        const sent = await sendFoodOptionsList(from, query, finalCandidates.slice(0, 3), env);
        if (sent) return true;
      }
    }
  }

  return false;
}
