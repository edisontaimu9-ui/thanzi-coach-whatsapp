/**
 * Thanzi Coach — WhatsApp Cloud API bridge
 *
 * Flow:
 *   1. Meta sends webhook verification (GET) once when you register the webhook URL.
 *   2. Meta POSTs incoming messages here whenever someone messages +265 886 29 53 24.
 *   3. Text messages:
 *        - Pure digits (8-14 chars) are treated as a barcode -> /foods/lookup
 *          for instant structured product data (no LLM).
 *        - Everything else -> /rag/ask for a conversational, cited answer.
 *   4. Image messages (photo of a nutrition label or barcode) -> local
 *      ZXing barcode decode, then Groq vision, then Chakudya OCR (see
 *      handleImageMessage).
 *   5. Voice notes -> downloaded from WhatsApp, transcribed via Groq
 *      Whisper, then routed through the SAME text pipeline as step 3
 *      (see handleAudioMessage) — a spoken food name or question works
 *      exactly like a typed one.
 *   6. Reply sent back via the WhatsApp Cloud API.
 *   7. Nutrient comparison ("compare nsima, rice and potatoes") uses
 *      chakudya-api's /foods/compare directly (2-6 foods, real per-100g
 *      panel + highest/lowest flags + sourced glycaemic data where
 *      available) instead of hand-built side-by-side cards. See
 *      detectFoodComparison/compareFoodsViaChakudya.
 *   8. Food substitutions ("substitute for nsima") -> /foods/substitutes.
 *      See detectSubstituteRequest.
 *   9. Drug-nutrient interactions ("interactions with warfarin", "foods to
 *      avoid while taking metformin") -> /drug-interactions/search, a
 *      structured clinical reference table rather than RAG's general
 *      retrieval. See detectDrugInteractionQuery.
 *  10. Nutrition label ("nutrition label for rice") -> /foods (to resolve
 *      a local food id) then /foods/:id/label for a Codex-style label.
 *      Only works for foods in the local Malawi FCT table (needs a numeric
 *      id) — see detectLabelRequest/getFoodLabel.
 *  11. Dietary Reference Intakes ("how much iron do I need", "RDA for
 *      calcium for a pregnant woman") -> /dri, resolved from an
 *      age/sex/life-stage guess extracted from the message. See
 *      detectDriRequest/lookupDri.
 *  12. Plain multi-food descriptions with no "compare"/"vs" wording
 *      ("Orange fleshed sweet potato and parboiled Usipa porridge") ->
 *      resolved via chakudya-api's POST /batch (one /foods/lookup per named
 *      food, single call/invocation) instead of one combined /rag/ask.
 *      Avoids /rag/ask's internal multi-topic fan-out hitting Cloudflare's
 *      per-invocation subrequest ceiling on compound queries (previously
 *      surfaced to the user as SUBREQUEST_LIMIT_MESSAGE, "couldn't complete
 *      your request"). Any name the batch can't find gets its own
 *      individual /rag/ask call (still single-topic, still safe) instead of
 *      being dropped. See detectMultiFoodList/lookupFoodsViaBatch/
 *      resolveUnknownFoodsViaRag/formatMultiFoodResults.
 *
 * Required secrets (set with `wrangler secret put <NAME>` — never hardcode these):
 *   WHATSAPP_TOKEN         - Meta permanent/system-user access token
 *   VERIFY_TOKEN           - a string you invent; must match what you enter in
 *                            Meta App Dashboard > WhatsApp > Configuration > Webhook
 *   GROQ_API_KEY            - console.groq.com API key, for direct barcode-from-photo
 *                            reads AND voice-note transcription (Whisper)
 *   STATS_TOKEN             - a string you invent; required as ?token= on GET /stats
 *   ADMIN_PHONE             - optional; your own WhatsApp number for the daily
 *                            summary cron job (see wrangler.toml [triggers]).
 *                            No-ops if unset.
 *
 * DB is a D1 binding (see wrangler.toml [[d1_databases]]) tracking unique
 * WhatsApp users and message events for analytics. GET /stats?token=...
 * returns aggregate metrics (total/new/active/returning users, message
 * counts) as JSON.
 *
 * Required vars (set in wrangler.toml [vars], not secret since not sensitive):
 *   PHONE_NUMBER_ID        - the WhatsApp Business phone number ID (from Meta dashboard,
 *                            NOT the phone number itself)
 *
 * CHAKUDYA_API is a Service Binding (see wrangler.toml [[services]]), not a
 * public URL — Worker-to-Worker calls within the same account use this
 * instead of fetch() to a *.workers.dev URL, which triggers Cloudflare
 * error 1042 ("request attempting to route to itself").
 *
 * /rag/ask is public + rate-limited (no auth needed). Contract, per openapi.json:
 *   POST /rag/ask  { query, context: "clinical"|"general"|"both", top_k, session_id }
 *   -> 200 { status: "success", data: { answer, intent, barcode_detected, sources[] } }
 *   -> 429 rate limited, with Retry-After header
 */

import zxingReaderWasmModule from "zxing-wasm/dist/reader/zxing_reader.wasm";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import {
  looksLikeBarcode,
  looksLikeBareFoodName,
  detectGreetingLanguage,
  detectFoodComparison,
  detectMultiFoodList,
  detectFoodQuantity,
  detectServingOnly,
  detectSubstituteRequest,
  detectDrugInteractionQuery,
  detectLabelRequest,
  detectDriRequest,
  detectMealPlanRequest,
  detectEnergyRequirementRequest,
  detectComparisonFollowUp,
  detectMealPlanEdit,
} from "./detectors.js";
import { calculateEnergyRequirement } from "./energy.js";

// Default per-request timeout for outbound HTTP calls (Chakudya, Groq,
// WhatsApp Cloud API). Without this, a hung upstream stalls the request
// until the Worker's own wall-clock limit kills it with no clean error;
// with it, callers get a normal rejected promise at a predictable point,
// which the existing try/catch in handleIncomingMessage already turns
// into a friendly reply instead of a silent timeout.
const FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(fetcher, input, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One retry (2 attempts total) after a short backoff, for a transient 5xx
// response or the request itself throwing (network blip, or the
// FETCH_TIMEOUT_MS abort above). Never retries a 4xx — that's a real
// client-side result (bad query, not found) and retrying would just waste
// a subrequest and return the same thing. Kept to a single retry to stay
// well inside Cloudflare's per-invocation subrequest ceiling, which is
// already tight on some multi-topic queries (see SUBREQUEST_LIMIT_MESSAGE).
// Used for Chakudya and Groq — read/analyze calls, safe to repeat when the
// first attempt didn't succeed. NOT used for WhatsApp Cloud API sends:
// retrying a send that actually went through server-side would double-
// message the user, which is worse than the occasional failed send.
const RETRY_BACKOFF_MS = 300;

async function fetchWithRetry(fetcher, input, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    const res = await fetchWithTimeout(fetcher, input, init, timeoutMs);
    if (res.status >= 500 && res.status < 600) {
      await sleep(RETRY_BACKOFF_MS);
      return fetchWithTimeout(fetcher, input, init, timeoutMs);
    }
    return res;
  } catch (err) {
    await sleep(RETRY_BACKOFF_MS);
    return fetchWithTimeout(fetcher, input, init, timeoutMs);
  }
}

// Thin wrapper for CHAKUDYA_API service-binding calls (see wrangler.toml
// for why this is a binding, not a public fetch URL). Every Chakudya call
// site below uses this instead of env.CHAKUDYA_API.fetch directly so none
// of them can hang past FETCH_TIMEOUT_MS, and a transient 5xx gets one
// retry instead of surfacing straight to the user.
function chakudyaFetch(env, path, init) {
  return fetchWithRetry(env.CHAKUDYA_API.fetch.bind(env.CHAKUDYA_API), path, init);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/webhook") {
      return handleVerification(url, env);
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleIncomingMessage(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      return handleStats(url, env);
    }

    if (request.method === "GET" && url.pathname === "/stats/timeseries") {
      return handleStatsTimeseries(url, env);
    }

    return new Response("Thanzi Coach webhook is running.", { status: 200 });
  },

  // Cloudflare Cron Trigger (see wrangler.toml [triggers]). Sends a daily
  // usage summary to ADMIN_PHONE over WhatsApp, using the bot's own send
  // path — no separate notification channel to build or maintain.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailySummary(env));
  },
};

// --- Step 1: Meta's one-time webhook verification handshake ---
function handleVerification(url, env) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// --- Step 2-4: incoming message -> Chakudya RAG -> reply ---
async function handleIncomingMessage(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // WhatsApp Cloud API also sends delivery/read status callbacks with no
  // message content — ignore those and only act on real inbound text messages.
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];

  if (!message) {
    return new Response("OK", { status: 200 }); // status callback, nothing to do
  }

  // Meta redelivers a webhook on any non-200 response or slow reply (see
  // the comment at the bottom of this function), so the same message.id
  // can arrive more than once for one real user action. Record it first
  // and bail out silently on a repeat so a slow upstream never produces a
  // doubled reply.
  if (await isDuplicateMessage(message.id, env)) {
    return new Response("OK", { status: 200 });
  }

  const from = message.from; // sender's WhatsApp number

  // Fire-and-forget analytics write — ctx.waitUntil lets it finish after the
  // response is sent, without slowing down or risking the actual reply.
  if (message.type === "text" || message.type === "image" || message.type === "audio" || message.type === "interactive") {
    ctx.waitUntil(recordActivity(from, message.type, env));
  }

  try {
    if (message.type === "text") {
      await handleTextMessage(message.text.body, from, env, ctx);
    } else if (message.type === "image") {
      await handleImageMessage(message.image, from, env, ctx);
    } else if (message.type === "audio") {
      await handleAudioMessage(message.audio, from, env, ctx);
    } else if (message.type === "interactive") {
      // A tapped list row/button — its id carries the full prompt text (see
      // sendPromptList), so route it through the exact same pipeline as if
      // the user had typed it (barcode/comparison/quantity detection all
      // still apply).
      const tapped =
        message.interactive?.list_reply?.id || message.interactive?.button_reply?.id;
      if (tapped) {
        await handleTextMessage(tapped, from, env, ctx);
      } else {
        return new Response("OK", { status: 200 });
      }
    } else {
      return new Response("OK", { status: 200 }); // unsupported type, ack silently
    }
  } catch (err) {
    console.error("Thanzi Coach error:", err);
    ctx.waitUntil(recordError(from, err, env));
    const reply = isSubrequestLimitError(err)
      ? SUBREQUEST_LIMIT_MESSAGE
      : "Pepani, pali vuto pakadali pano. Yesaninso pambuyo pa mphindi zochepa. 🙏";
    await sendWhatsAppReply(from, reply, env).catch(() => {}); // best-effort; don't crash the webhook ack
  }

  // Always 200 quickly — Meta retries aggressively on non-200/timeout
  return new Response("OK", { status: 200 });
}

// Plain small-talk (greetings, "how are you", thanks, bye) doesn't need
// Chakudya's nutrition retrieval at all — routing it through /rag/ask just
// burns a request and comes back with an odd, citation-laden answer to a
// question that was never really about food/health data. Handled with an
// instant tappable prompt list instead (see sendPromptList), matched on the
// whole message (trimmed, punctuation stripped) so it doesn't misfire on a
// real question that merely starts with "hi" or similar. Replies in
// whichever language the greeting itself was in. See detectGreetingLanguage
// in ./detectors.js.

async function handleTextMessage(userText, from, env, ctx) {
  const greetingLang = detectGreetingLanguage(userText);
  if (greetingLang) {
    await sendPromptList(from, greetingLang, env);
    return;
  }

  if (looksLikeBarcode(userText)) {
    const barcode = userText.trim();
    const found = await lookupBarcode(barcode, env);
    if (found) {
      await sendWhatsAppReply(from, found.text, env);
      ctx.waitUntil(saveLastFoodContext(from, toFoodContext(found.item), env));
      return;
    }
    // No product found for that barcode — fall through to rag/ask, which
    // can still respond helpfully (e.g. "I couldn't find that product").
  }

  // Food substitutions ("substitute for nsima", "what can I use instead of
  // rice") — Chakudya's own substitution-group ranking (/foods/substitutes),
  // not a guess from the LLM.
  const substituteFor = detectSubstituteRequest(userText);
  if (substituteFor) {
    const data = await getFoodSubstitutes(substituteFor, env);
    const formatted = formatSubstitutes(data);
    if (formatted) {
      await sendWhatsAppReply(from, formatted, env);
      return;
    }
    // Not found at all (no matching food) — fall through to /rag/ask.
  }

  // Drug-nutrient interactions ("interactions with warfarin", "foods to
  // avoid while taking metformin") — Chakudya's structured clinical
  // reference table (/drug-interactions/search), not RAG's general
  // retrieval, so severity/effects/implications come through verbatim.
  const drugQuery = detectDrugInteractionQuery(userText);
  if (drugQuery) {
    const matches = await searchDrugInteractions(drugQuery, env);
    if (matches) {
      await sendWhatsAppReply(from, formatDrugInteractions(matches, drugQuery), env);
      return;
    }
  }

  // Nutrition label ("nutrition label for rice") — Codex-style label via
  // /foods/:id/label. Only works for foods with a local Malawi FCT id, so a
  // miss falls through to /rag/ask rather than dead-ending.
  const labelFor = detectLabelRequest(userText);
  if (labelFor) {
    const labelResult = await getFoodLabel(labelFor, env);
    if (labelResult) {
      await sendWhatsAppReply(from, formatNutritionLabel(labelResult.label, labelResult.foodName), env);
      return;
    }
  }

  // Dietary Reference Intakes ("how much iron do I need", "RDA for calcium
  // for a pregnant woman") — Chakudya's own NASEM/IOM DRI tables (/dri),
  // resolved from whatever age/sex/life-stage hints are in the message.
  const driReq = detectDriRequest(userText);
  if (driReq) {
    const data = await lookupDri(driReq, env);
    const answer = formatDriAnswer(data, driReq);
    if (answer) {
      await sendWhatsAppReply(from, answer, env);
      return;
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
  const energyReq = detectEnergyRequirementRequest(userText);
  if (energyReq) {
    const result = calculateEnergyRequirement({
      sex: energyReq.sex,
      ageYears: energyReq.age,
      weightKg: energyReq.weightKg,
      heightCm: energyReq.heightCm,
      stressFactorKey: energyReq.stressConditionKey,
    });
    if (result) {
      await sendWhatsAppReply(from, formatEnergyRequirementResult(result), env);
      return;
    }
    await sendWhatsAppReply(
      from,
      "I need a bit more to calculate that: sex, age, weight (kg), and — for adults or when height is known — " +
        "height (cm). E.g. \"calculate energy requirements for a 45 year old man, 70kg, 175cm\".",
      env
    );
    return;
  }

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
    return;
  }

  // Meal-plan edit follow-ups ("swap the egg for beans", "remove the
  // groundnuts") — applied in place against the stored plan (one Chakudya
  // lookup for a swap's replacement, none at all for a removal), not a
  // fresh Groq call. See detectMealPlanEdit in ./detectors.js and
  // applyMealPlanEdit above.
  const mealPlanEdit = detectMealPlanEdit(userText);
  if (mealPlanEdit) {
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
        return;
      }
      await sendWhatsAppReply(
        from,
        `I couldn't find "${mealPlanEdit.target}" in your meal plan to ${mealPlanEdit.action === "remove" ? "remove" : "swap"}. ` +
          "Check the exact item name from the plan and try again.",
        env
      );
      return;
    }
    await sendWhatsAppReply(
      from,
      "I don't have an earlier meal plan to edit — ask me to create one first.",
      env
    );
    return;
  }

  // Comparison follow-ups ("compare it with quinoa", "also compare beans")
  // — refers back to the previous comparison's food list rather than
  // naming everything fresh. Checked before the fresh-comparison branch
  // since its phrasing ("compare it with X") wouldn't match
  // detectFoodComparison's own patterns anyway, but ordering it first
  // keeps the intent clear. See detectComparisonFollowUp in ./detectors.js
  // and last_session_context (migrations/0005) for the stored context.
  const comparisonFollowUp = detectComparisonFollowUp(userText);
  if (comparisonFollowUp) {
    const prevContext = await getLastSessionContext(from, "comparison", env);
    if (prevContext?.foods?.length) {
      const merged = [...new Set([...prevContext.foods, ...comparisonFollowUp])].slice(0, 6);
      const comparison = await compareFoodsViaChakudya(merged, env);
      if (comparison) {
        await sendWhatsAppReply(from, comparison, env);
        ctx.waitUntil(saveLastSessionContext(from, "comparison", { foods: merged }, env));
        return;
      }
    } else {
      await sendWhatsAppReply(
        from,
        "I don't have an earlier comparison to add that to — try \"compare X and Y\" to start one.",
        env
      );
      return;
    }
  }

  // Nutrient comparisons ("compare nsima, rice and potatoes", "X vs Y") —
  // resolved and computed entirely by Chakudya's /foods/compare (2-6 foods,
  // real per-100g panel, highest/lowest flags, sourced glycaemic data where
  // it exists) rather than hand-built side-by-side lookups here. If fewer
  // than 2 of the named foods resolve, fall through to /rag/ask.
  const foodsToCompare = detectFoodComparison(userText);
  if (foodsToCompare) {
    const comparison = await compareFoodsViaChakudya(foodsToCompare, env);
    if (comparison) {
      await sendWhatsAppReply(from, comparison, env);
      ctx.waitUntil(saveLastSessionContext(from, "comparison", { foods: foodsToCompare }, env));
      return;
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
      return;
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
        return;
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
        return;
      }
    }
  }

  // "quinoa 200g" / "200g of rice" — a specific-weight nutrition request is
  // arithmetic (scale the per-100g figures), not something an LLM should be
  // asked to compute. Doing it as real math here is both more reliable and
  // avoids routing through /rag/ask, which has hit its own subrequest limit
  // on queries shaped like this.
  const foodQty = detectFoodQuantity(userText);
  if (foodQty) {
    const scaled = await answerFoodQuantity(foodQty.food, foodQty.grams, env);
    if (scaled) {
      await sendWhatsAppReply(from, scaled.text, env);
      ctx.waitUntil(
        saveLastFoodContext(from, { ...scaled.context, lastShownGrams: foodQty.grams }, env)
      );
      return;
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
    const context = await getLastFoodContext(from, env);
    if (context) {
      const scaled = scaleFoodToGrams(context, servingOnly.grams);
      if (scaled) {
        await sendWhatsAppReply(from, scaled, env);
        ctx.waitUntil(
          saveLastFoodContext(from, { ...context, lastShownGrams: servingOnly.grams }, env)
        );
        return;
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
    const query = userText.trim();
    const topResult = await lookupFoodByName(query, env);

    if (topResult && isDirectFoodMatch(query, topResult)) {
      const card = formatFoodResult(topResult);
      if (card) {
        await sendWhatsAppReply(from, card, env);
        const context = toFoodContext(topResult);
        if (context) ctx.waitUntil(saveLastFoodContext(from, context, env));
        return;
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
        if (sent) return;
      }
    }
  }


  const answer = await askChakudya(userText, from, env);
  await sendWhatsAppReply(from, answer, env);
}

// Detects a comparison request naming 2-6 foods (see detectFoodComparison
// in ./detectors.js for the shapes it matches).

async function lookupFoodByName(name, env) {
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
async function lookupWiderTierFoodByName(name, env) {
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
async function searchFoodCandidates(name, env, maxResults = 3) {
  const res = await chakudyaFetch(env, 
    `https://chakudya-api/foods/search?q=${encodeURIComponent(name)}&max_results=${maxResults}`
  );
  if (!res.ok) return [];
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.data) ? body.data.slice(0, maxResults) : [];
}

function getFoodItemName(item) {
  return item?.product_name || item?.food_name || item?.name || null;
}

// Short human-readable label for a wider-tier match's source tag, shown in
// the disambiguation list so it's clear why this option differs from the
// local Malawi FCT ones (see lookupWiderTierFoodByName).
function sourceLabel(source) {
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
function normalizeFoodName(s) {
  return s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
}

function isDirectFoodMatch(query, item) {
  const name = getFoodItemName(item);
  if (!name) return false;
  return normalizeFoodName(name) === normalizeFoodName(query);
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
async function compareFoodsViaChakudya(foodNames, env) {
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
    if (p.energy_kcal != null) macros.push(`${p.energy_kcal} kcal`);
    if (p.protein_g != null) macros.push(`${p.protein_g}g protein`);
    if (p.carbs_g != null) macros.push(`${p.carbs_g}g carbs`);
    if (p.fat_g != null) macros.push(`${p.fat_g}g fat`);
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
      const kcal = wider.energy_kcal ?? wider.kcal;
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
async function lookupFoodsViaBatch(foodNames, env) {
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
function buildConciseNutritionQuery(name) {
  return `Nutrition facts per 100g for ${name}. If there are multiple preparations or recipe variations, give one representative estimate only — not a breakdown of each.`;
}

async function resolveUnknownFoodsViaRag(names, fromNumber, env) {
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

// Formats the combined results: batch-resolved foods as formatFoodResult
// cards, individually-resolved-via-rag foods as their own labeled section,
// and any name neither approach could resolve called out at the end.
// Returns null only if literally nothing resolved either way — caller
// falls back to the normal flow in that case.
function formatMultiFoodResults(results, ragAnswers) {
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
function toFoodContext(item) {
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
function scaleFoodToGrams(context, grams) {
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

  const lines = [`*${context.name}* — ${grams} g`, macros.join(", ")];
  if (micros.length) lines.push(micros.join(", "));
  return lines.join("\n");
}

// How long a "last food discussed" context stays usable for a bare
// follow-up like "50g" before we consider the conversation to have moved
// on. Keeps a stale context from a food discussed hours ago from
// hijacking an unrelated later message.
const LAST_FOOD_CONTEXT_TTL_MS = 20 * 60 * 1000; // 20 minutes

async function saveLastFoodContext(whatsappId, context, env) {
  if (!context) return;
  try {
    await env.DB.prepare(
      `INSERT INTO last_food_context (whatsapp_id, food_json, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(whatsapp_id) DO UPDATE SET
         food_json = ?2,
         updated_at = ?3`
    )
      .bind(whatsappId, JSON.stringify(context), new Date().toISOString())
      .run();
  } catch (err) {
    console.error("Failed to save last food context:", err);
  }
}

async function getLastFoodContext(whatsappId, env) {
  try {
    const row = await env.DB.prepare(
      `SELECT food_json, updated_at FROM last_food_context WHERE whatsapp_id = ?1`
    )
      .bind(whatsappId)
      .first();
    if (!row) return null;
    const age = Date.now() - new Date(row.updated_at).getTime();
    if (age > LAST_FOOD_CONTEXT_TTL_MS) return null;
    return JSON.parse(row.food_json);
  } catch (err) {
    console.error("Failed to load last food context:", err);
    return null;
  }
}

// Generic version of the above for follow-ups that reference something
// richer than one food's macros — a whole comparison, or a whole meal
// plan (see last_session_context in migrations/0005). Keyed by
// (whatsapp_id, kind) so a user can have both a live comparison and a live
// meal-plan context at once without either evicting the other. Longer TTL
// than the bare-gram-followup food context (LAST_FOOD_CONTEXT_TTL_MS,
// 20 min) — refining a meal plan ("swap the egg for beans") is a slower,
// more deliberate flow than a quick gram-amount follow-up, so give it more
// room before treating the conversation as having moved on.
const LAST_SESSION_CONTEXT_TTL_MS = 60 * 60 * 1000; // 60 minutes

async function saveLastSessionContext(whatsappId, kind, payload, env) {
  if (!payload) return;
  try {
    await env.DB.prepare(
      `INSERT INTO last_session_context (whatsapp_id, kind, payload_json, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(whatsapp_id, kind) DO UPDATE SET
         payload_json = ?3,
         updated_at = ?4`
    )
      .bind(whatsappId, kind, JSON.stringify(payload), new Date().toISOString())
      .run();
  } catch (err) {
    console.error(`Failed to save last session context (${kind}):`, err);
  }
}

async function getLastSessionContext(whatsappId, kind, env) {
  try {
    const row = await env.DB.prepare(
      `SELECT payload_json, updated_at FROM last_session_context WHERE whatsapp_id = ?1 AND kind = ?2`
    )
      .bind(whatsappId, kind)
      .first();
    if (!row) return null;
    const age = Date.now() - new Date(row.updated_at).getTime();
    if (age > LAST_SESSION_CONTEXT_TTL_MS) return null;
    return JSON.parse(row.payload_json);
  } catch (err) {
    console.error(`Failed to load last session context (${kind}):`, err);
    return null;
  }
}

// Looks up a food's per-100g-equivalent record, then scales its kcal/
// protein/carbs/fat by real arithmetic to the requested gram amount — no
// LLM involved, so it's both exact and avoids Chakudya's RAG pipeline
// (which has hit its own subrequest ceiling on queries shaped like this).
// Only scales against a gram-based measure (our own 100g default, or an
// explicit "<N> g" in the record) — non-gram units (cups, tablespoons)
// can't be linearly scaled without knowing their gram weight, so those
// cases return null and fall back to /rag/ask instead.
async function answerFoodQuantity(food, grams, env) {
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

async function handleImageMessage(image, from, env, ctx) {
  const mediaId = image?.id;
  if (!mediaId) {
    await sendWhatsAppReply(
      from,
      "Ndilandire chithunzi, koma sindinathe kuchiwerenga. Yesaninso. 🙏",
      env
    );
    return;
  }

  await sendWhatsAppReply(
    from,
    "Ndikuwerenga chithunzi... mudikire pang'ono. 📷",
    env
  ).catch(() => {}); // best-effort progress ping; not fatal if it fails

  const { base64, bytes, mimeType } = await downloadWhatsAppMedia(mediaId, env);

  // Try reading it as a barcode first (fast, cheap, precise task). A local
  // ZXing decode runs first — free, instant, no image data leaves
  // Cloudflare — and only if that finds nothing do we fall back to the
  // Groq vision reader, which is slower/costlier but more forgiving of
  // blur, glare, or an off-angle shot. Only if BOTH find no barcode do we
  // fall back further to Chakudya's nutrition-label OCR — this way one
  // photo handles either case (barcode or label) automatically.
  let barcode = await decodeBarcodeLocally(bytes);
  if (!barcode) {
    barcode = await readBarcodeFromImage(base64, mimeType, env);
  }
  if (barcode) {
    const found = await lookupBarcode(barcode, env);
    await sendWhatsAppReply(
      from,
      found?.text ||
        `Ndawerenga barcode ${barcode}, koma sindinapeze mankhwala ake m'databasi. 🙏`,
      env
    );
    if (found) ctx.waitUntil(saveLastFoodContext(from, toFoodContext(found.item), env));
    return;
  }

  const result = await scanPackagedLabel(base64, mimeType, env);
  await sendWhatsAppReply(from, result.text, env);
  if (result.context) ctx.waitUntil(saveLastFoodContext(from, result.context, env));
}

// --- Voice notes ---
//
// A voice message is transcribed via Groq's Whisper API, then handed to
// handleTextMessage exactly as if the person had typed it — every existing
// detector (barcode, bare food name, food+quantity, serving-only follow-up,
// comparison, RAG question) applies unchanged to the transcript.
async function handleAudioMessage(audio, from, env, ctx) {
  const mediaId = audio?.id;
  if (!mediaId) {
    await sendWhatsAppReply(
      from,
      "Ndilandire mawu anu, koma sindinathe kuwatsegula. Yesaninso. 🙏",
      env
    );
    return;
  }

  await sendWhatsAppReply(
    from,
    "Ndikumvetsera mawu anu... mudikire pang'ono. 🎙️",
    env
  ).catch(() => {}); // best-effort progress ping; not fatal if it fails

  const { bytes, mimeType } = await downloadWhatsAppMedia(mediaId, env);
  const transcript = await transcribeAudio(bytes, mimeType, env);

  if (!transcript) {
    await sendWhatsAppReply(
      from,
      "Pepani, sindinamve bwino mawu anuwo. Yesaninso, kapena lembani funso lanu. 🙏",
      env
    );
    return;
  }

  // Echo back what was heard BEFORE acting on it — a cheap trust-builder
  // that lets the person catch a mis-transcription (e.g. a mangled food
  // name) instead of silently getting an answer to the wrong question.
  await sendWhatsAppReply(from, `_Ndamva: "${transcript}"_`, env).catch(() => {});

  await handleTextMessage(transcript, from, env, ctx);
}

// Groq Whisper transcription. whisper-large-v3 (not the -turbo variant) is
// used here rather than the faster/cheaper turbo model because accuracy
// matters more than latency for a single short voice note, and turbo's
// multilingual accuracy is measurably weaker.
//
// `language: "en"` is forced even though callers commonly code-switch into
// Chichewa — Whisper doesn't have solid Chichewa support to begin with, and
// leaving language on auto-detect let a short/ambiguous clip get
// misidentified as an entirely different language, hallucinating
// nonsense in the WRONG SCRIPT (e.g. Cyrillic) rather than failing
// cleanly. Forcing English keeps it constrained to Latin-script output
// even when it mishears a Chichewa word, which mangles that word but
// stays recoverable — vs. a free-associated wrong-language hallucination,
// which isn't. looksLikeTranscriptionGarbage below is a second guard for
// whatever still gets through.
async function transcribeAudio(bytes, mimeType, env) {
  const cleanMimeType = (mimeType || "audio/ogg").split(";")[0].trim();
  const extension = cleanMimeType.includes("mp4") || cleanMimeType.includes("m4a")
    ? "m4a"
    : cleanMimeType.includes("mpeg") || cleanMimeType.includes("mp3")
      ? "mp3"
      : cleanMimeType.includes("wav")
        ? "wav"
        : "ogg"; // WhatsApp voice notes are audio/ogg; codecs=opus by default

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: cleanMimeType }), `voice.${extension}`);
  form.append("model", "whisper-large-v3");
  form.append("response_format", "json");
  form.append("language", "en");
  // Biases transcription toward correct spelling of local food/clinical
  // terms Whisper wouldn't otherwise recognize well.
  form.append(
    "prompt",
    "Malawian food and nutrition terms: nsima, chimanga, phala, mgaiwa, futali, " +
      "chambiko, thobwa, kondowole, mbatata, nyemba, nkhwani, chinangwa, khobwe, " +
      "kcal, protein, carbs, fat, exchange list, renal diet, potassium, sodium."
  );

  const res = await fetchWithRetry(fetch, "https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    console.error("Groq transcription error:", res.status, await res.text());
    return null;
  }

  const body = await res.json();
  const text = body?.text?.trim();
  if (!text || looksLikeTranscriptionGarbage(text)) return null;
  return text;
}

// Catches the specific hallucination failure mode above: a transcript that
// came back in a script no caller of this bot would plausibly be using
// (Cyrillic, CJK, Arabic, etc.), which is a sign Whisper guessed the wrong
// language for the clip rather than an actual utterance to act on.
function looksLikeTranscriptionGarbage(text) {
  return /[\u0400-\u04FF\u0370-\u03FF\u0590-\u08FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(
    text
  );
}

// --- Local barcode decoding (ZXing-C++ compiled to WASM) ---
//
// Runs entirely inside the Worker: no external API call, no per-image cost,
// no round-trip latency, and no image data leaves Cloudflare's network. This
// is tried FIRST on every photo, before the Groq vision fallback below —
// it handles the vast majority of clear, reasonably-framed barcode photos
// deterministically. ZXing-C++'s bundled stb_image decoder reads the raw
// JPEG/PNG bytes directly, so no separate image-decoding step is needed.
//
// The WASM module is instantiated once per Worker isolate (module-level
// state persists across requests handled by the same isolate) and reused.
let zxingModuleReady = false;
function ensureZxingReady() {
  if (zxingModuleReady) return;
  prepareZXingModule({
    overrides: {
      instantiateWasm(imports, successCallback) {
        // `zxingReaderWasmModule` is already a compiled WebAssembly.Module
        // (Workers/wrangler compiles .wasm imports at build time), so
        // WebAssembly.instantiate(module, imports) resolves directly to an
        // Instance — unlike the BufferSource overload, there's no
        // `.instance` to unwrap here.
        WebAssembly.instantiate(zxingReaderWasmModule, imports).then(successCallback);
        return {};
      },
    },
  });
  zxingModuleReady = true;
}

// Barcode symbologies actually used on packaged food products. Restricting
// to these (instead of ZXing's full symbology list, which also covers
// QR/DataMatrix/PDF417/Aztec etc.) keeps decoding fast and avoids false
// matches on an unrelated code that might appear in the same photo.
const RETAIL_BARCODE_FORMATS = ["EAN-13", "EAN-8", "UPC-A", "UPC-E"];

async function decodeBarcodeLocally(imageBytes) {
  ensureZxingReady();
  try {
    const results = await readBarcodes(imageBytes, {
      formats: RETAIL_BARCODE_FORMATS,
      tryHarder: true,
      maxNumberOfSymbols: 1,
    });
    const hit = results.find((r) => r.text && r.isValid !== false);
    return hit ? hit.text : null;
  } catch (err) {
    // No barcode present, a corrupt/unsupported image, etc. — all expected
    // and common. Fall back to the Groq vision reader rather than treating
    // this as a hard failure.
    console.error("Local ZXing decode failed:", err);
    return null;
  }
}

// Direct Groq vision call (independent of Chakudya) specifically to read
// barcode digits from a photo. Returns the digit string, or null if no
// barcode is visible in the image.
async function readBarcodeFromImage(base64, mimeType, env) {
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const res = await fetchWithRetry(fetch, "https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "qwen/qwen3.6-27b",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "If this image shows a barcode, reply with ONLY the numeric digits printed under/beside it (no spaces, no other text). If there is no barcode visible in the image, reply with exactly: NONE",
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0,
      max_completion_tokens: 30,
    }),
  });

  if (!res.ok) {
    console.error("Groq barcode read error:", res.status, await res.text());
    return null; // fail open -> falls back to nutrition-label OCR
  }

  const body = await res.json();
  const raw = body?.choices?.[0]?.message?.content?.trim() || "";
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

// Formats calculateEnergyRequirement's result (see ./energy.js) for a
// standalone "calculate energy requirements" reply — the real math itself,
// with the equation named so it's clear this is a calculated figure, not
// an LLM guess.
function formatEnergyRequirementResult(result) {
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
      servingLabel: "100g (wider CNR tier — no local household-unit serving on file)",
      kcal: Math.round(kcal),
      source: data.source || "cnr_wider_tier",
    };
  } catch (e) {
    return null;
  }
}

async function generateMealPlan(req, energyResult, env) {
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
async function applyMealPlanEdit(edit, storedContext, env) {
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

// WhatsApp media is two-step: first ask Graph API for a short-lived URL,
// then fetch the actual bytes from that URL (both calls need the same
// bearer token).
async function downloadWhatsAppMedia(mediaId, env) {
  const metaRes = await fetchWithTimeout(fetch, `https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
  });
  if (!metaRes.ok) {
    throw new Error(`Media lookup error: ${metaRes.status} ${await metaRes.text()}`);
  }
  const meta = await metaRes.json();

  const fileRes = await fetchWithTimeout(fetch, meta.url, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
  });
  if (!fileRes.ok) {
    throw new Error(`Media download error: ${fileRes.status}`);
  }

  const buf = await fileRes.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  return { base64, bytes: new Uint8Array(buf), mimeType: meta.mime_type || "image/jpeg" };
}

function arrayBufferToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000; // avoid call-stack limits on large images
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Cloudflare throws this (not an HTTP status — a runtime exception) when a
// single Worker invocation makes too many outbound fetch() calls, e.g. a
// query that fans out across several internal Chakudya lookups. Detected by
// message text since Cloudflare doesn't give it a distinct error type.
const SUBREQUEST_LIMIT_MESSAGE =
  "Sorry, we couldn’t complete your request right now. Please try again with a shorter or simpler question.";

function isSubrequestLimitError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("too many subrequests") || msg.includes("too many api requests");
}

// Chakudya can hit its own internal subrequest ceiling mid-retrieval and
// still return 200 OK, with the raw error text baked into `answer` instead
// of thrown as a request failure — so isSubrequestLimitError() (which only
// sees *our* exceptions) never catches this case. Scan the answer text
// itself for Cloudflare's known error strings/URLs before it reaches the
// user.
function looksLikeLeakedProviderError(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("too many subrequests") ||
    t.includes("too many api requests") ||
    t.includes("llm answer unavailable") ||
    t.includes("developers.cloudflare.com") ||
    t.includes("single worker invocation")
  );
}
// otherwise temporarily unavailable, the user gets this exact friendly
// message — never the raw status code, provider/model name, token-limit
// detail, or billing info. Those specifics are logged server-side via
// console.error only, for debugging, never sent to WhatsApp.
const LLM_BUSY_MESSAGE = "Sorry, Thanzi Coach is temporarily busy. Please try again in a moment.";

function isProviderUnavailable(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function scanPackagedLabel(base64, mimeType, env) {
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const res = await chakudyaFetch(env, "https://chakudya-api/packaged/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ images: [dataUrl] }),
  });

  if (res.status === 422) {
    return {
      text: "Sindinathe kuwerenga zambiri pa chithunzichi. Chonde jambulani bwino chizindikiro cha zakudya (nutrition label) ndikutumizanso. 🙏",
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
  return {
    text: result || "Ndawerenga chithunzicho, koma sindinapeze zambiri zokwanira.",
    context: toFoodContext(body?.data),
  };
}

async function lookupBarcode(barcode, env) {
  const res = await chakudyaFetch(env, 
    `https://chakudya-api/foods/lookup?barcode=${encodeURIComponent(barcode)}`
  );
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

// Formats a Food/PackagedFood/external-lookup result (field names vary by
// source) into a short WhatsApp-friendly card.
function formatFoodResult(item) {
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
  const kcal = item.kcal ?? item.energy_kcal;
  const protein = item.protein_g;
  const carbs = item.carbs_g;
  const fat = item.fat_g;
  // The "necessary micros" — the handful of micronutrients most relevant
  // to everyday public-health concerns (blood pressure, bone health,
  // anemia, digestion) — rather than the full FCT panel, to keep the
  // WhatsApp card short. Full panel is available via /foods/:id if needed.
  const fiber = item.fiber_g;
  const sodium = item.sodium_mg;
  const potassium = item.potassium_mg;
  const calcium = item.calcium_mg;
  const iron = item.iron_mg;

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

  const lines = [`*${name}*${brand}${measureText}`];
  if (macros.length) lines.push(macros.join(", "));
  if (micros.length) lines.push(micros.join(", "));
  return lines.join("\n");
}

// --- Food substitutions (/foods/substitutes) ---
//
// "substitute for nsima" / "what can I use instead of rice" — Chakudya
// resolves the food, classifies it into a substitution group, and ranks
// candidates by nutritional closeness itself (see chakudya-api's
// handleFoodSubstitutes). This just formats the result. See
// detectSubstituteRequest in ./detectors.js.


async function getFoodSubstitutes(foodName, env) {
  const res = await chakudyaFetch(env, 
    `https://chakudya-api/foods/substitutes?food_name=${encodeURIComponent(foodName)}`
  );
  if (res.status === 404) return null; // food itself wasn't found — fall back to rag/ask
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.data || null;
}

function formatSubstitutes(data) {
  if (!data) return null;
  if (!data.substitution_group) {
    return `Couldn't find a known substitution group for *${data.original?.food_name}*. Try asking about a common Malawian staple, protein source, or vegetable instead.`;
  }

  const lines = [`*Substitutes for ${data.original.food_name}* (${data.substitution_group})`];
  for (const s of data.substitutes || []) {
    const p = s.per_100g || {};
    lines.push(`• ${s.food_name} — ${p.kcal ?? "?"} kcal, ${p.protein_g ?? "?"}g protein per 100g`);
  }
  if (!data.substitutes?.length) lines.push("No close nutritional matches found in the local database.");
  if (data.note) lines.push(`\n_${data.note}_`);
  return lines.join("\n");
}

// --- Drug-nutrient interactions (/drug-interactions/search) ---
//
// "interactions with warfarin" / "foods to avoid while taking metformin" —
// Chakudya's own migrated clinical reference table (drug, category,
// severity, effects, implications), not a general RAG answer. Structured
// fields come through verbatim so the severity/guidance isn't paraphrased.
// See detectDrugInteractionQuery in ./detectors.js.


async function searchDrugInteractions(query, env) {
  const res = await chakudyaFetch(env, 
    `https://chakudya-api/drug-interactions/search?q=${encodeURIComponent(query)}`
  );
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.data) ? body.data : null;
}

function formatDrugInteractions(matches, query) {
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

// --- Nutrition label (/foods + /foods/:id/label) ---
//
// "nutrition label for rice" — /foods/:id/label needs a numeric local-`foods`
// id, so this first resolves the name via a plain /foods search (not the
// external-cascade /foods/lookup, since /foods/:id/label only works on
// rows actually in the local `foods` table) then requests the label. See
// detectLabelRequest in ./detectors.js.


async function getFoodLabel(foodName, env) {
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

function formatNutritionLabel(label, foodName) {
  if (!label) return null;
  const lines = [
    `*Nutrition Label — ${foodName}*`,
    `Serving: ${label.serving_size} (${label.serving_grams}g)`,
  ];
  if (label.calories != null) lines.push(`Calories: ${label.calories} kcal`);
  if (label.total_fat_g != null) lines.push(`Total Fat: ${label.total_fat_g}g`);
  if (label.saturated_fat_g != null) lines.push(`  Saturated Fat: ${label.saturated_fat_g}g`);
  if (label.carbohydrates_g != null) lines.push(`Carbohydrates: ${label.carbohydrates_g}g`);
  if (label.fiber_g != null) lines.push(`  Fiber: ${label.fiber_g}g`);
  if (label.sugars_g != null) lines.push(`  Sugars: ${label.sugars_g}g`);
  if (label.protein_g != null) lines.push(`Protein: ${label.protein_g}g`);
  if (label.sodium_mg != null) lines.push(`Sodium: ${label.sodium_mg}mg`);

  const vm = Object.entries(label.vitamins_minerals || {});
  if (vm.length) {
    lines.push("");
    lines.push("Vitamins & Minerals:");
    for (const [name, val] of vm) lines.push(`  ${name}: ${val}`);
  }
  if (label.missing_fields?.length) {
    lines.push(`\n_Not on file for this food: ${label.missing_fields.join(", ")}._`);
  }
  return lines.join("\n");
}

// --- Dietary Reference Intakes (/dri) ---
//
// "how much iron do I need" / "RDA for calcium for a pregnant woman" —
// Chakudya's own NASEM/IOM DRI tables, resolved from an age/sex/life-stage
// guess extracted from the message text. See detectDriRequest in
// ./detectors.js.

async function lookupDri({ nutrientKey, age, sex, lifeStageType }, env) {
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

function formatDriAnswer(data, driReq) {
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

function normalizeMultiTopicQuery(query) {
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
function normalizeCitationBrackets(text) {
  if (!text) return text;
  return text.replace(/[【\[]\s*(\d+)\s*[】\]]/g, "[$1]");
}

async function askChakudya(query, fromNumber, env) {
  // Service binding call — internal Worker-to-Worker, not a public fetch.
  // See wrangler.toml for why (avoids Cloudflare error 1042).
  const res = await chakudyaFetch(env, "https://chakudya-api/rag/ask", {
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
  });

  if (isProviderUnavailable(res.status)) {
    console.error("Chakudya provider unavailable:", res.status, await res.text());
    return LLM_BUSY_MESSAGE;
  }

  if (!res.ok) {
    throw new Error(`Chakudya API error: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  const answer = normalizeCitationBrackets(
    body?.data?.answer || "Pepani, sindinapeze yankho pa funso limeneli."
  );

  if (looksLikeLeakedProviderError(answer)) {
    console.error("Chakudya leaked a provider error into the answer text:", answer);
    return SUBREQUEST_LIMIT_MESSAGE;
  }

  const { text: renumberedAnswer, references } = renumberCitations(answer, body?.data?.sources);
  return markdownToWhatsApp(renumberedAnswer) + references;
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
function renumberCitations(answerText, sources) {
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
function markdownToWhatsApp(text) {
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
const WHATSAPP_MAX_LEN = 4000; // a little under the real 4096 cap, as headroom

function splitForWhatsApp(text, maxLen = WHATSAPP_MAX_LEN) {
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

async function sendWhatsAppReply(to, text, env) {
  const parts = splitForWhatsApp(text);
  const multi = parts.length > 1;

  for (let i = 0; i < parts.length; i++) {
    const body = multi ? `${parts[i]}\n\n_(${i + 1}/${parts.length})_` : parts[i];

    const res = await fetchWithTimeout(
      fetch,
      `https://graph.facebook.com/v20.0/${env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body },
        }),
      }
    );

    if (!res.ok) {
      throw new Error(`WhatsApp send error: ${res.status} ${await res.text()}`);
    }
  }
}

// Example prompts shown as a tappable list after a greeting. Each row's id
// carries the FULL query text (sent back to us verbatim when tapped — see
// the interactive-message handling in handleIncomingMessage), while title
// stays short to fit WhatsApp's 24-char row title limit.
const PROMPT_EXAMPLES_EN = [
  { id: "What foods are high in iron?", title: "Iron-Rich Foods" },
  { id: "Compare nsima, rice and potatoes", title: "Compare Foods" },
  { id: "Substitute for nsima", title: "Food Substitutes" },
  { id: "Exchange list for a diabetic patient", title: "Diabetes Food Swaps" },
  { id: "Interactions with warfarin", title: "Drug-Food Interactions" },
  { id: "How much iron do I need?", title: "Daily Nutrient Needs" },
  { id: "Quinoa", title: "Look Up Any Food" },
  { id: "quinoa 200g", title: "Nutrition by Weight" },
];

const PROMPT_EXAMPLES_NY = [
  { id: "Ndi zakudya ziti zomwe zili ndi iron wambiri?", title: "Zakudya za Iron" },
  { id: "Compare nsima, rice and potatoes", title: "Yerekezerani Zakudya" },
  { id: "Substitute for nsima", title: "Zam'malo mwa Nsima" },
  { id: "Exchange list for a diabetic patient", title: "Kudya kwa Shuga" },
  { id: "How much iron do I need?", title: "Iron Yofunika Tsiku" },
  { id: "Quinoa", title: "Funsani Chakudya" },
  { id: "quinoa 200g", title: "Kulemera kwa Chakudya" },
];

async function sendPromptList(to, lang, env) {
  const isEnglish = lang === "en";
  const body = isEnglish
    ? "Hi there! 👋 I'm Thanzi Coach. Tap an example below, or just type your own question anytime. You can also send a barcode number or a photo of a nutrition label."
    : "Muli bwanji! 👋 Ndine Thanzi Coach. Sankhani chitsanzo pansipa, kapena lembani funso lanu nthawi ina iliyonse. Mutha kutumizanso barcode kapena chithunzi cha nutrition label.";
  const buttonText = isEnglish ? "See examples" : "Onani zitsanzo";
  const sectionTitle = isEnglish ? "Try asking" : "Yesani kufunsa";
  const examples = isEnglish ? PROMPT_EXAMPLES_EN : PROMPT_EXAMPLES_NY;

  await sendWhatsAppInteractiveList(
    to,
    {
      body,
      buttonText,
      sections: [{ title: sectionTitle, rows: examples }],
    },
    env
  );
}

async function sendWhatsAppInteractiveList(to, { body, buttonText, sections }, env) {
  const res = await fetchWithTimeout(
    fetch,
    `https://graph.facebook.com/v20.0/${env.PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: body },
          action: { button: buttonText, sections },
        },
      }),
    }
  );

  if (!res.ok) {
    // Fall back to a plain-text reply if the interactive send itself fails
    // (e.g. malformed payload, unsupported client) so the user still gets
    // something useful instead of silence.
    console.error("WhatsApp interactive list send error:", res.status, await res.text());
    await sendWhatsAppReply(to, body, env);
  }
}

// When a bare-food-name search's top /foods/lookup result isn't a direct
// match for what the person typed, this offers up to 3 close candidates
// as a tappable WhatsApp list instead of guessing. Tapping a row re-sends
// its exact name as if the person had typed it (see the "interactive"
// branch in handleIncomingMessage), which then resolves as a direct match
// and returns the normal food card. Returns false (nothing sent) if none
// of the candidates have a usable name, so the caller can fall through to
// /rag/ask same as any other miss.
async function sendFoodOptionsList(to, query, candidates, env) {
  const rows = [];
  const seen = new Set();
  for (const item of candidates) {
    const name = getFoodItemName(item);
    if (!name) continue;
    const key = normalizeFoodName(name);
    if (seen.has(key)) continue;
    seen.add(key);

    // WhatsApp list rows: title max 24 chars, description max 72 chars.
    const title = name.length > 24 ? `${name.slice(0, 23)}…` : name;
    const kcal = item.kcal ?? item.energy_kcal;
    const brand = item.brand || item.raw_data?.brands;
    const descriptionParts = [];
    if (item._widerTier) descriptionParts.push(sourceLabel(item.source));
    if (brand) descriptionParts.push(brand);
    if (kcal != null) descriptionParts.push(`${kcal} kcal/100g`);
    const description = descriptionParts.join(" — ").slice(0, 72) || undefined;

    rows.push({ id: name, title, description });
    if (rows.length === 3) break;
  }
  if (!rows.length) return false;

  await sendWhatsAppInteractiveList(
    to,
    {
      body: `I couldn't find an exact match for "${query}". Did you mean one of these?`,
      buttonText: "Choose a food",
      sections: [{ title: "Closest matches", rows }],
    },
    env
  );
  return true;
}

// --- Webhook idempotency (D1) ---
// INSERT OR IGNORE on message_id (the WhatsApp wamid): if the row already
// existed, D1 reports 0 changed rows, which is how a redelivery is told
// apart from a first delivery. Fails open — if the D1 write itself errors,
// treat the message as new rather than silently dropping a real reply.
async function isDuplicateMessage(messageId, env) {
  if (!messageId) return false;
  try {
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO processed_messages (message_id, ts) VALUES (?1, ?2)`
    )
      .bind(messageId, new Date().toISOString())
      .run();
    return (result.meta?.changes ?? 1) === 0;
  } catch (err) {
    console.error("Dedup check failed, treating message as new:", err);
    return false;
  }
}

// --- Analytics (D1) ---
// Records/updates a user row and logs one event per message. Wrapped in
// try/catch so an analytics failure never breaks the actual bot reply —
// this is called via ctx.waitUntil, fire-and-forget.
async function recordActivity(whatsappId, type, env) {
  try {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (whatsapp_id, first_seen, last_seen, message_count)
         VALUES (?1, ?2, ?2, 1)
         ON CONFLICT(whatsapp_id) DO UPDATE SET
           last_seen = ?2,
           message_count = message_count + 1`
      ).bind(whatsappId, now),
      env.DB.prepare(
        `INSERT INTO events (whatsapp_id, ts, type) VALUES (?1, ?2, ?3)`
      ).bind(whatsappId, now, type),
    ]);
  } catch (err) {
    console.error("Analytics write failed:", err);
  }
}

// Logs a bot-side failure (Chakudya/Groq/WhatsApp-send errors caught in
// handleIncomingMessage) as its own event type, separate from normal
// message events, so /stats can report an error rate — bot *health*, not
// just usage. Doesn't touch the users table; a failed reply shouldn't count
// as a new/returning visit. Fire-and-forget, like recordActivity.
async function recordError(whatsappId, err, env) {
  try {
    await env.DB.prepare(
      `INSERT INTO events (whatsapp_id, ts, type) VALUES (?1, ?2, 'error')`
    )
      .bind(whatsappId || "unknown", new Date().toISOString())
      .run();
  } catch (dbErr) {
    console.error("Error-event write failed:", dbErr, "(original error:", err, ")");
  }
}

// GET /stats?token=...&days=30 — simple protected JSON dashboard.
// Auth is a query-string token compared to the STATS_TOKEN secret, since
// this is a low-stakes read-only endpoint, not a full auth system.
const STATS_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://edisontaimu9-ui.github.io",
};

// Runs once/day from the `scheduled` handler. Summarizes the last 24h and
// sends it as a normal WhatsApp text via the bot's own send path. Silently
// does nothing if ADMIN_PHONE isn't set yet, so this is a no-op until you
// opt in (see README for setup).
async function sendDailySummary(env) {
  if (!env.ADMIN_PHONE) {
    console.log("sendDailySummary: ADMIN_PHONE not set, skipping.");
    return;
  }

  const cutoff = new Date(Date.now() - 86400000).toISOString();

  try {
    const [newUsers, activeUsers, messages, errors] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE first_seen >= ?1`)
        .bind(cutoff)
        .first("n"),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE last_seen >= ?1`)
        .bind(cutoff)
        .first("n"),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE ts >= ?1 AND type != 'error'`)
        .bind(cutoff)
        .first("n"),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE ts >= ?1 AND type = 'error'`)
        .bind(cutoff)
        .first("n"),
    ]);

    const lines = [
      "📊 *Thanzi Coach — daily summary*",
      `New users: ${newUsers}`,
      `Active users: ${activeUsers}`,
      `Messages: ${messages}`,
      errors > 0 ? `⚠️ Errors: ${errors}` : `Errors: 0 ✅`,
    ];

    await sendWhatsAppReply(env.ADMIN_PHONE, lines.join("\n"), env);
  } catch (err) {
    console.error("sendDailySummary failed:", err);
  }
}

async function handleStats(url, env) {
  const token = url.searchParams.get("token");
  if (!env.STATS_TOKEN || token !== env.STATS_TOKEN) {
    return new Response("Forbidden", { status: 403, headers: STATS_CORS_HEADERS });
  }

  const days = Number(url.searchParams.get("days")) || 30;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const [totalUsers, newUsers, activeUsers, periodMessages, allTimeMessages, periodErrors] =
      await Promise.all([
        env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first("n"),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE first_seen >= ?1`)
          .bind(cutoff)
          .first("n"),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE last_seen >= ?1`)
          .bind(cutoff)
          .first("n"),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE ts >= ?1 AND type != 'error'`)
          .bind(cutoff)
          .first("n"),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE type != 'error'`).first("n"),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE ts >= ?1 AND type = 'error'`)
          .bind(cutoff)
          .first("n"),
      ]);

    const stats = {
      period_days: days,
      total_users: totalUsers,
      new_users: newUsers,
      active_users: activeUsers,
      returning_users: Math.max(activeUsers - newUsers, 0),
      messages_in_period: periodMessages,
      messages_all_time: allTimeMessages,
      errors_in_period: periodErrors,
      error_rate: periodMessages > 0 ? Number((periodErrors / periodMessages).toFixed(4)) : 0,
    };

    return new Response(JSON.stringify(stats, null, 2), {
      headers: { "Content-Type": "application/json", ...STATS_CORS_HEADERS },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err?.message || err) }),
      { status: 500, headers: { "Content-Type": "application/json", ...STATS_CORS_HEADERS } }
    );
  }
}

// GET /stats/timeseries?token=...&days=30 — per-day messages and new-user
// counts, for the dashboard's trend chart. Same token auth as /stats.
async function handleStatsTimeseries(url, env) {
  const token = url.searchParams.get("token");
  if (!env.STATS_TOKEN || token !== env.STATS_TOKEN) {
    return new Response("Forbidden", { status: 403, headers: STATS_CORS_HEADERS });
  }

  const days = Math.min(Number(url.searchParams.get("days")) || 30, 90);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const [messagesByDay, newUsersByDay, errorsByDay] = await Promise.all([
      env.DB.prepare(
        `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS n
         FROM events WHERE ts >= ?1 AND type != 'error'
         GROUP BY day ORDER BY day`
      )
        .bind(cutoff)
        .all(),
      env.DB.prepare(
        `SELECT substr(first_seen, 1, 10) AS day, COUNT(*) AS n
         FROM users WHERE first_seen >= ?1
         GROUP BY day ORDER BY day`
      )
        .bind(cutoff)
        .all(),
      env.DB.prepare(
        `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS n
         FROM events WHERE ts >= ?1 AND type = 'error'
         GROUP BY day ORDER BY day`
      )
        .bind(cutoff)
        .all(),
    ]);

    // Merge both series onto a single zero-filled list of every day in range,
    // so the chart doesn't have to reason about missing dates.
    const msgMap = new Map(messagesByDay.results.map((r) => [r.day, r.n]));
    const newUserMap = new Map(newUsersByDay.results.map((r) => [r.day, r.n]));
    const errorMap = new Map(errorsByDay.results.map((r) => [r.day, r.n]));

    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      series.push({
        date: d,
        messages: msgMap.get(d) || 0,
        new_users: newUserMap.get(d) || 0,
        errors: errorMap.get(d) || 0,
      });
    }

    return new Response(JSON.stringify({ period_days: days, series }, null, 2), {
      headers: { "Content-Type": "application/json", ...STATS_CORS_HEADERS },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err?.message || err) }),
      { status: 500, headers: { "Content-Type": "application/json", ...STATS_CORS_HEADERS } }
    );
  }
}
