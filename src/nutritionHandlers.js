/**
 * Text routing, part 2: reference lookups, meal plans, comparisons and multi-food lists.
 *
 * Split out of handleTextMessage in src/index.js with no behaviour change: each handler gets the
 * shared routing context `c` ({ userText, from, env, ctx, opts, topic, langState, lang,
 * repliesInChichewa }) and returns true when it handled (replied to) the message.
 */

import { askChakudya, compareFoodsViaChakudya, getFoodLabel, getFoodSubstitutes, lookupBarcode, lookupDri, lookupFoodByName, lookupFoodsViaBatch, resolveUnknownFoodsViaRag, searchDrugInteractions } from "./chakudyaClient.js";
import { getLastSessionContext, saveLastFoodContext, saveLastSessionContext } from "./context.js";
import { detectPretermEnergyRequest, formatPretermEnergy, isPretermMention, lookupPretermEnergy } from "./pretermEnergy.js";
import { detectComparisonFollowUp, detectDriRequest, detectDrugInteractionQuery, detectEnergyRequirementRequest, detectFoodComparison, detectLabelRequest, detectMealPlanEdit, detectMealPlanRequest, detectMultiFoodList, detectSubstituteRequest, looksLikeBarcode } from "./detectors.js";
import { calculateEnergyRequirement } from "./energy.js";
import { SUBREQUEST_LIMIT_MESSAGE } from "./errors.js";
import { buildConciseNutritionQuery, formatDriAnswer, formatDrugInteractions, formatEnergyRequirementResult, formatFoodResult, formatMultiFoodResults, formatNutritionLabel, formatSubstitutes, isDirectFoodMatch, toFoodContext } from "./formatting.js";
import { applyMealPlanEdit, generateMealPlan } from "./mealPlan.js";
import { sendWhatsAppReply } from "./whatsapp.js";

/** Barcode, substitutes, drug interactions, nutrition label, DRI and energy-requirement requests. Returns true when handled. */
export async function handleReferenceQueries(c) {
  const { userText, from, env, ctx, topic } = c;

if (looksLikeBarcode(userText)) {
    topic.name = "barcode";
    const barcode = userText.trim();
    const found = await lookupBarcode(barcode, env);
    if (found) {
      await sendWhatsAppReply(from, found.text, env);
      ctx.waitUntil(saveLastFoodContext(from, toFoodContext(found.item), env));
      return true;
    }
    // No product found for that barcode — fall through to rag/ask, which
    // can still respond helpfully (e.g. "I couldn't find that product").
  }

  // Food substitutions ("substitute for nsima", "what can I use instead of
  // rice") — Chakudya's own substitution-group ranking (/foods/substitutes),
  // not a guess from the LLM.
  const substituteFor = detectSubstituteRequest(userText);
  if (substituteFor) {
    topic.name = "substitutes";
    const data = await getFoodSubstitutes(substituteFor, env);
    const formatted = formatSubstitutes(data);
    if (formatted) {
      await sendWhatsAppReply(from, formatted, env);
      return true;
    }
    // Not found at all (no matching food) — fall through to /rag/ask.
  }

  // Drug-nutrient interactions ("interactions with warfarin", "foods to
  // avoid while taking metformin") — Chakudya's structured clinical
  // reference table (/drug-interactions/search), not RAG's general
  // retrieval, so severity/effects/implications come through verbatim.
  const drugQuery = detectDrugInteractionQuery(userText);
  if (drugQuery) {
    topic.name = "drug_interactions";
    const matches = await searchDrugInteractions(drugQuery, env);
    if (matches) {
      await sendWhatsAppReply(from, formatDrugInteractions(matches, drugQuery), env);
      return true;
    }
  }

  // Nutrition label ("nutrition label for rice") — Codex-style label via
  // /foods/:id/label. Only works for foods with a local Malawi FCT id, so a
  // miss falls through to /rag/ask rather than dead-ending.
  const labelFor = detectLabelRequest(userText);
  if (labelFor) {
    topic.name = "nutrition_label";
    const labelResult = await getFoodLabel(labelFor, env);
    if (labelResult) {
      await sendWhatsAppReply(from, formatNutritionLabel(labelResult.label, labelResult.foodName), env);
      return true;
    }
  }

  // Dietary Reference Intakes ("how much iron do I need", "RDA for calcium
  // for a pregnant woman") — Chakudya's own NASEM/IOM DRI tables (/dri),
  // resolved from whatever age/sex/life-stage hints are in the message.
  const driReq = detectDriRequest(userText);
  if (driReq) {
    topic.name = "dri";
    const data = await lookupDri(driReq, env);
    const answer = formatDriAnswer(data, driReq);
    if (answer) {
      await sendWhatsAppReply(from, answer, env);
      return true;
    }
  }

  // Direct energy-requirement calculation requests ("calculate energy
  // requirements for a 6 year old boy weighing 20kg", "BEE for a 45 year
  // old man, 70kg, 175cm") — answered with real Harris-Benedict (adult) /
  // Schofield-or-WHO (pediatric) math (see ./energy.js), no Groq or
  // /rag/ask call at all. Checked before the meal-plan branch since these
  // two intents can otherwise overlap (both parse the same demographic
  // fields) and a bare calculation request should never fall through to
  // meal-plan generation.
  // Preterm infants have their own reference ranges (Chakudya MCP tool, see ./pretermEnergy.js); the
  // adult calculator below can't answer them. If the lookup fails, the message falls through to the
  // normal nutrition search instead of the adult "I need sex, age, height" prompt.
  const pretermReq = detectPretermEnergyRequest(userText);
  if (pretermReq) {
    topic.name = "energy";
    try {
      const result = await lookupPretermEnergy(pretermReq.weightKg, env);
      await sendWhatsAppReply(from, formatPretermEnergy(result, pretermReq.weightKg), env);
      return true;
    } catch (err) {
      console.error("Preterm energy lookup failed, falling back to search:", err?.message || err);
    }
  }

  const energyReq = detectEnergyRequirementRequest(userText);
  if (energyReq && !isPretermMention(userText)) {
    topic.name = "energy";
    const result = calculateEnergyRequirement({
      sex: energyReq.sex,
      ageYears: energyReq.age,
      weightKg: energyReq.weightKg,
      heightCm: energyReq.heightCm,
      stressFactorKey: energyReq.stressConditionKey,
    });
    if (result) {
      await sendWhatsAppReply(from, formatEnergyRequirementResult(result), env);
      return true;
    }
    await sendWhatsAppReply(
      from,
      "I need a bit more to calculate that: sex, age, weight (kg), and — for adults or when height is known — " +
        "height (cm). E.g. \"calculate energy requirements for a 45 year old man, 70kg, 175cm\".",
      env
    );
    return true;
  }

  return false;
}

/** Meal plan requests and meal-plan edit follow-ups. Returns true when handled. */
export async function handleMealPlans(c) {
  const { userText, from, env, ctx, topic } = c;

  // Meal plan requests ("create a meal plan for a 53 year old woman with
  // diabetes...") — a single direct Groq call instead of /rag/ask. A meal
  // plan itself names many foods, so routing it through Chakudya's RAG as
  // one query reliably blows the subrequest ceiling (see the comment above
  // SUBREQUEST_LIMIT_MESSAGE) far more than an ordinary compound question
  // does. See detectMealPlanRequest in ./detectors.js and generateMealPlan
  // below. When enough demographic data is given, the plan is grounded on
  // a real calculated energy target (Harris-Benedict/Schofield/WHO, same as
  // the standalone energy-requirement branch above) rather than a number
  // Groq would otherwise have to guess.
  const mealPlanReq = detectMealPlanRequest(userText);
  if (mealPlanReq) {
    topic.name = "meal_plan";
    const energyResult = calculateEnergyRequirement({
      sex: mealPlanReq.sex,
      ageYears: mealPlanReq.age,
      weightKg: mealPlanReq.weightKg,
      heightCm: mealPlanReq.heightCm,
      stressFactorKey: mealPlanReq.stressConditionKey,
    });
    const plan = await generateMealPlan(mealPlanReq, energyResult, env);
    await sendWhatsAppReply(from, plan.text, env);
    if (plan.meals) {
      ctx.waitUntil(
        saveLastSessionContext(
          from,
          "meal_plan",
          { meals: plan.meals, resolved: Object.fromEntries(plan.resolvedByName), energyResult },
          env
        )
      );
    }
    return true;
  }

  // Meal-plan edit follow-ups ("swap the egg for beans", "remove the
  // groundnuts") — applied in place against the stored plan (one Chakudya
  // lookup for a swap's replacement, none at all for a removal), not a
  // fresh Groq call. See detectMealPlanEdit in ./detectors.js and
  // applyMealPlanEdit above.
  const mealPlanEdit = detectMealPlanEdit(userText);
  if (mealPlanEdit) {
    topic.name = "meal_plan";
    const prevPlan = await getLastSessionContext(from, "meal_plan", env);
    if (prevPlan?.meals?.length) {
      const edited = await applyMealPlanEdit(mealPlanEdit, prevPlan, env);
      if (edited) {
        await sendWhatsAppReply(from, edited.text, env);
        ctx.waitUntil(
          saveLastSessionContext(
            from,
            "meal_plan",
            {
              meals: edited.meals,
              resolved: Object.fromEntries(edited.resolvedByName),
              energyResult: prevPlan.energyResult,
            },
            env
          )
        );
        return true;
      }
      await sendWhatsAppReply(
        from,
        `I couldn't find "${mealPlanEdit.target}" in your meal plan to ${mealPlanEdit.action === "remove" ? "remove" : "swap"}. ` +
          "Check the exact item name from the plan and try again.",
        env
      );
      return true;
    }
    await sendWhatsAppReply(
      from,
      "I don't have an earlier meal plan to edit — ask me to create one first.",
      env
    );
    return true;
  }

  return false;
}

/** Comparison follow-ups, food comparisons, and plain multi-food lists. Returns true when handled. */
export async function handleComparisonsAndMultiFood(c) {
  const { userText, from, env, ctx, topic } = c;

  // Comparison follow-ups ("compare it with quinoa", "also compare beans")
  // — refers back to the previous comparison's food list rather than
  // naming everything fresh. Checked before the fresh-comparison branch
  // since its phrasing ("compare it with X") wouldn't match
  // detectFoodComparison's own patterns anyway, but ordering it first
  // keeps the intent clear. See detectComparisonFollowUp in ./detectors.js
  // and last_session_context (migrations/0005) for the stored context.
  const comparisonFollowUp = detectComparisonFollowUp(userText);
  if (comparisonFollowUp) {
    topic.name = "food_compare";
    const prevContext = await getLastSessionContext(from, "comparison", env);
    if (prevContext?.foods?.length) {
      const merged = [...new Set([...prevContext.foods, ...comparisonFollowUp])].slice(0, 6);
      const comparison = await compareFoodsViaChakudya(merged, env);
      if (comparison) {
        await sendWhatsAppReply(from, comparison, env);
        ctx.waitUntil(saveLastSessionContext(from, "comparison", { foods: merged }, env));
        return true;
      }
    } else {
      await sendWhatsAppReply(
        from,
        "I don't have an earlier comparison to add that to — try \"compare X and Y\" to start one.",
        env
      );
      return true;
    }
  }

  // Nutrient comparisons ("compare nsima, rice and potatoes", "X vs Y") —
  // resolved and computed entirely by Chakudya's /foods/compare (2-6 foods,
  // real per-100g panel, highest/lowest flags, sourced glycaemic data where
  // it exists) rather than hand-built side-by-side lookups here. If fewer
  // than 2 of the named foods resolve, fall through to /rag/ask.
  const foodsToCompare = detectFoodComparison(userText);
  if (foodsToCompare) {
    topic.name = "food_compare";
    const comparison = await compareFoodsViaChakudya(foodsToCompare, env);
    if (comparison) {
      await sendWhatsAppReply(from, comparison, env);
      ctx.waitUntil(saveLastSessionContext(from, "comparison", { foods: foodsToCompare }, env));
      return true;
    }
  }

  // Plain multi-food descriptions with no "compare"/"vs" wording and no "?"
  // ("Orange fleshed sweet potato and parboiled Usipa porridge") still name
  // 2+ separate foods. Routing these through /rag/ask as ONE combined query
  // makes Chakudya's own retrieval fan out per food term (semantic search +
  // Malawi FCT + packaged/OCR + exchange/renal/formula + barcode +
  // USDA/OFF/FatSecret cascade — EACH) all within a single invocation,
  // which can blow Cloudflare's per-invocation subrequest ceiling even at
  // top_k:12 and leaks as SUBREQUEST_LIMIT_MESSAGE (the generic "couldn't
  // complete your request" reply) instead of an answer. Resolve each named
  // food directly via /foods/lookup instead — no LLM, a fraction of the
  // subrequest cost per item — sent together as one Chakudya /batch call so
  // it's still a single round trip. Anything the batch can't find (not in
  // the local FCT) gets its own individual /rag/ask call instead of being
  // dropped — still single-topic per call, so still safe. Only falls back
  // to the normal flow (below) if NEITHER approach resolves anything, so a
  // genuine question that happens to contain "and" (e.g. "iron and folate
  // for pregnancy") just finds no food matches here and continues on.
  //
  // IMPORTANT: "and" isn't always a separator — some dish names legitimately
  // contain it as part of the name itself, not as a list conjunction (e.g.
  // "Orange fleshed sweet potato and parboiled Usipa porridge" is a single
  // named recipe in Chakudya's recipe-book source, not two foods). Naively
  // splitting on every "and" would break those. So before treating the
  // message as a list at all: 1) try the whole phrase as a single
  // structured food-table entry, 2) if that's not found, try it as a single
  // concise question to Chakudya (composite dishes often live only in
  // Chakudya's RAG-indexed sources, not the structured food table) — a
  // single call, still one invocation, so still safe UNLESS Chakudya's own
  // retrieval treats it as multiple topics internally and trips the same
  // subrequest ceiling this whole feature exists to avoid; if it does, that
  // comes back as SUBREQUEST_LIMIT_MESSAGE and we fall through to 3) the
  // per-food split/batch approach as the safety net, same as before.
  if (!foodsToCompare) {
    topic.name = "food_lookup";
    const wholePhraseMatch = await lookupFoodByName(userText.trim(), env);
    // lookupFoodByName's local->fuzzy(pg_trgm)->external cascade always
    // picks SOME "best guess" internally, even when nothing genuinely
    // matches (e.g. "Yams"/"Yam plant" with no yam entry in the local FCT
    // can fuzzy-match onto an unrelated item like "Beef, raw" or
    // "Plantain and beef casserole" via loose trigram overlap). Sending
    // that straight to the user as a confident card — as this branch used
    // to — reports the wrong food's nutrients with no indication it's a
    // guess. Require the same exact-name check used for bare food names
    // below (isDirectFoodMatch) before trusting it; anything looser falls
    // through to the per-food / bare-name flow further down, which already
    // offers a proper "did you mean" candidate list instead of guessing.
    const wholePhraseCard =
      isDirectFoodMatch(userText.trim(), wholePhraseMatch) && formatFoodResult(wholePhraseMatch);
    if (wholePhraseCard) {
      await sendWhatsAppReply(from, wholePhraseCard, env);
      const context = toFoodContext(wholePhraseMatch);
      if (context) ctx.waitUntil(saveLastFoodContext(from, context, env));
      return true;
    }

    const foodList = detectMultiFoodList(userText);
    if (foodList) {
      const wholePhraseAnswer = await askChakudya(
        buildConciseNutritionQuery(userText.trim()),
        from,
        env
      );
      if (wholePhraseAnswer && wholePhraseAnswer !== SUBREQUEST_LIMIT_MESSAGE) {
        await sendWhatsAppReply(from, wholePhraseAnswer, env);
        return true;
      }
    }

    if (foodList) {
      const results = await lookupFoodsViaBatch(foodList, env);
      const unresolvedNames = results
        ? results.filter((r) => !r.item).map((r) => r.name)
        : foodList; // batch call itself failed — try every name individually
      const ragAnswers = unresolvedNames.length
        ? await resolveUnknownFoodsViaRag(unresolvedNames, from, env)
        : [];
      const formatted = formatMultiFoodResults(results, ragAnswers);
      if (formatted) {
        await sendWhatsAppReply(from, formatted, env);
        return true;
      }
    }
  }

  return false;
}
