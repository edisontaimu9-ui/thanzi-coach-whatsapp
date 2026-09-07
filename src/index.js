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
 *   7. Food diary: "log it" / "log 150g" / "log it as dinner" saves the
 *      most recently discussed food to chakudya-api's /log (food_log_entries),
 *      keyed by WhatsApp number as user_id; "today" / "this week" reads it
 *      back via /log/summary. See detectLogCommand/detectLogSummaryCommand.
 *      No new D1 table needed — piggybacks on the existing
 *      last_food_context row already used for gram-based follow-ups.
 *   8. Multi-ingredient meal logging: "log 2 eggs, 1 cup rice and chicken"
 *      -> chakudya-api's /ingredients/parse (free text -> structured
 *      ingredients) -> /meals/analyze (resolves + totals nutrients) -> one
 *      /log entry for the whole meal. See detectMealLogCommand.
 *   9. Nutrient comparison ("compare nsima, rice and potatoes") uses
 *      chakudya-api's /foods/compare directly (2-6 foods, real per-100g
 *      panel + highest/lowest flags + sourced glycaemic data where
 *      available) instead of hand-built side-by-side cards. See
 *      detectFoodComparison/compareFoodsViaChakudya.
 *  10. Food substitutions ("substitute for nsima") -> /foods/substitutes.
 *      See detectSubstituteRequest.
 *  11. Drug-nutrient interactions ("interactions with warfarin", "foods to
 *      avoid while taking metformin") -> /drug-interactions/search, a
 *      structured clinical reference table rather than RAG's general
 *      retrieval. See detectDrugInteractionQuery.
 *  12. Nutrition label ("nutrition label for rice") -> /foods (to resolve
 *      a local food id) then /foods/:id/label for a Codex-style label.
 *      Only works for foods in the local Malawi FCT table (needs a numeric
 *      id) — see detectLabelRequest/getFoodLabel.
 *  13. Dietary Reference Intakes ("how much iron do I need", "RDA for
 *      calcium for a pregnant woman") -> /dri, resolved from an
 *      age/sex/life-stage guess extracted from the message. See
 *      detectDriRequest/lookupDri.
 *  14. Plain multi-food descriptions with no "compare"/"vs" wording
 *      ("Orange fleshed sweet potato and parboiled Usipa porridge") ->
 *      resolved via chakudya-api's POST /batch (one /foods/lookup per named
 *      food, single call/invocation) instead of /rag/ask. Avoids /rag/ask's
 *      internal multi-topic fan-out hitting Cloudflare's per-invocation
 *      subrequest ceiling on compound queries (previously surfaced to the
 *      user as SUBREQUEST_LIMIT_MESSAGE, "couldn't complete your request").
 *      Falls back to /rag/ask if nothing resolves. See
 *      detectMultiFoodList/lookupFoodsViaBatch/formatMultiFoodResults.
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

// Plain numeric text (8-14 digits) is almost always a barcode being typed
// or pasted in, not a nutrition question. Fast-path it to /foods/lookup for
// instant structured data instead of routing through the LLM in /rag/ask.
function looksLikeBarcode(text) {
  return /^\d{8,14}$/.test(text.trim());
}

// A short message with no "?" and no question/verb wording ("Quinoa",
// "Soya pieces") reads as a food-name lookup rather than a question — route
// these to /foods/lookup directly (see handleTextMessage) instead of
// /rag/ask, which has a serving-size metadata gap on cached external
// results. Deliberately conservative: real questions (has "?", or starts
// with a question/imperative word) are left alone and still go to RAG.
const BARE_QUERY_LEADING_WORDS =
  /^(what|how|why|when|where|who|which|is|are|can|does|do|should|will|would|could|tell|explain|describe|list|give|show|compare)\b/i;

function looksLikeBareFoodName(text) {
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
const ENGLISH_GREETINGS = [
  "hi", "hello", "hey", "hiya", "yo",
  "good morning", "good afternoon", "good evening", "good day",
  "how are you", "how are you?", "how're you", "hows it going", "how's it going",
  "what's up", "whats up", "sup",
  "thanks", "thank you",
  "bye", "goodbye", "see you",
];

const CHICHEWA_GREETINGS = [
  "moni", "muli bwanji", "mwauka bwanji", "mwadzuka bwanji", "odi", "zikomo",
];

// Returns "en", "ny", or null (not a recognized greeting at all).
function detectGreetingLanguage(text) {
  const t = text.trim().toLowerCase().replace(/[!?.,]+$/g, "");
  if (ENGLISH_GREETINGS.includes(t)) return "en";
  if (CHICHEWA_GREETINGS.includes(t)) return "ny";
  return null;
}

async function handleTextMessage(userText, from, env, ctx) {
  const greetingLang = detectGreetingLanguage(userText);
  if (greetingLang) {
    await sendPromptList(from, greetingLang, env);
    return;
  }

  // "today" / "this week" — food diary summary. Checked before anything
  // else short-circuits on these exact phrases (see LOG_SUMMARY_*_PHRASES).
  const summaryCmd = detectLogSummaryCommand(userText);
  if (summaryCmd) {
    const summary = await getLogSummary({ whatsappId: from, period: summaryCmd.period, env });
    if (summary) {
      const text = summaryCmd.period === "weekly" ? formatWeeklySummary(summary) : formatDailySummary(summary);
      await sendWhatsAppReply(from, text, env);
      return;
    }
    await sendWhatsAppReply(from, "Sindinathe kupeza zolembedwa zanu pa nthawi ino. Chonde yesaninso. 🙏", env);
    return;
  }

  // "log it" / "log 150g" / "log it as dinner" — save the most recently
  // discussed food (see last_food_context) to the diary. Only fires on a
  // narrow set of phrasings (see detectLogCommand); anything naming a food
  // directly falls through to the normal flow below instead.
  const logCmd = detectLogCommand(userText);
  if (logCmd) {
    const context = await getLastFoodContext(from, env);
    if (!context) {
      await sendWhatsAppReply(
        from,
        "Ndikanakonda kudziwa chakudya choyamba — tumizani dzina la chakudya kaye, kenako muzitha kunena \"log it\". 🙏",
        env
      );
      return;
    }
    const grams = logCmd.grams ?? context.lastShownGrams ?? context.baseGrams;
    const calories = kcalAtGrams(context, grams);
    if (calories == null) {
      await sendWhatsAppReply(from, "Sindinathe kuwerengera ma calories a chakudyachi. Chonde yesaninso. 🙏", env);
      return;
    }
    const mealType = logCmd.mealType || inferMealTypeFromHour(currentHourInMalawi());
    const logged = await logFoodEntry({ whatsappId: from, mealType, calories, foodName: context.name, env });
    if (logged) {
      await sendWhatsAppReply(
        from,
        `Logged: *${context.name}* (${grams} g, ${calories} kcal) under ${MEAL_LABELS[mealType]}. ✅\nSay "today" any time to see your daily total.`,
        env
      );
    } else {
      await sendWhatsAppReply(from, "Sindinathe kulemba izi pa nthawi ino. Chonde yesaninso. 🙏", env);
    }
    return;
  }

  // Multi-ingredient meal logging ("log 2 eggs, 1 cup rice and chicken")
  // — checked right after the single-food log command above since it's the
  // same "log" intent, just with more than one item. detectLogCommand
  // above only matches when nothing but grams/meal-type/filler words
  // remain, so a real ingredient list always falls through to here instead.
  const mealLogCmd = detectMealLogCommand(userText);
  if (mealLogCmd) {
    const analysis = await parseAndAnalyzeMeal(mealLogCmd.text, env);
    if (analysis && (analysis.ingredients?.length || analysis.unresolved_ingredients?.length)) {
      const mealType = mealLogCmd.mealType || inferMealTypeFromHour(currentHourInMalawi());
      await sendWhatsAppReply(from, formatMealAnalysis(analysis, mealType), env);

      const totalKcal = analysis.total_nutrients?.kcal ?? analysis.total_nutrients?.energy_kcal;
      if (totalKcal != null && analysis.ingredients?.length) {
        const logged = await logFoodEntry({
          whatsappId: from,
          mealType,
          calories: Math.round(totalKcal),
          foodName: summarizeMealName(analysis.ingredients),
          env,
        });
        if (logged) {
          await sendWhatsAppReply(
            from,
            `Logged as ${MEAL_LABELS[mealType]}: ${Math.round(totalKcal)} kcal total. ✅`,
            env
          );
        }
      }
      return;
    }
    // Parsing/analysis failed entirely (e.g. Groq unavailable, nothing
    // resolvable) — fall through to the normal flow below rather than
    // leaving the user with no response at all.
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
      return;
    }
  }

  // Plain multi-food descriptions with no "compare"/"vs" wording and no "?"
  // ("Orange fleshed sweet potato and parboiled Usipa porridge") still name
  // 2+ separate foods. Routing these through /rag/ask makes Chakudya's own
  // retrieval fan out per food term (semantic search + Malawi FCT +
  // packaged/OCR + exchange/renal/formula + barcode + USDA/OFF/FatSecret
  // cascade — EACH), which can blow Cloudflare's per-invocation subrequest
  // ceiling even at top_k:12 and leaks as SUBREQUEST_LIMIT_MESSAGE (the
  // generic "couldn't complete your request" reply) instead of an answer.
  // Resolve each named food directly via /foods/lookup instead — no LLM, a
  // fraction of the subrequest cost per item — sent together as one
  // Chakudya /batch call so it's still a single round trip. Falls back to
  // /rag/ask (below) if nothing resolves, so a genuine question that
  // happens to contain "and" (e.g. "iron and folate for pregnancy") just
  // finds no food matches here and continues on to the normal flow.
  if (!foodsToCompare) {
    const foodList = detectMultiFoodList(userText);
    if (foodList) {
      const results = await lookupFoodsViaBatch(foodList, env);
      const formatted = formatMultiFoodResults(results);
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
  if (looksLikeBareFoodName(userText)) {
    const item = await lookupFoodByName(userText.trim(), env);
    const card = formatFoodResult(item);
    if (card) {
      await sendWhatsAppReply(from, card, env);
      const context = toFoodContext(item);
      if (context) ctx.waitUntil(saveLastFoodContext(from, context, env));
      return;
    }
  }

  const answer = await askChakudya(userText, from, env);
  await sendWhatsAppReply(from, answer, env);
}

// Detects a comparison request naming 2-6 foods, in any of these shapes:
//   "compare nsima, rice and potatoes"   (comma/and list after "compare")
//   "100g of X compared with/to Y"
//   "X vs Y" / "X versus Y"
// Returns an array of 2-6 trimmed food-name strings, or null.
function splitFoodList(text) {
  return text
    .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

const stripTrailingVerb = (s) =>
  s.replace(/\s+(provide|providing|have|has|contain|contains)$/i, "").trim();

function detectFoodComparison(query) {
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

async function lookupFoodByName(name, env) {
  const res = await env.CHAKUDYA_API.fetch(
    `https://chakudya-api/foods/lookup?q=${encodeURIComponent(name)}`
  );
  if (!res.ok) return null;
  const body = await res.json();
  return Array.isArray(body?.data) ? body.data[0] : body?.data || null;
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
  const res = await env.CHAKUDYA_API.fetch(
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

  return lines.join("\n");
}

// Plain "X and Y[, and Z]" food descriptions (no "compare"/"vs" wording, no
// "?") — reuses splitFoodList (comma/and/&) but, unlike detectFoodComparison,
// doesn't require an explicit comparison verb. Deliberately conservative:
// bails on anything that reads like a real question (has "?", or starts
// with a question/imperative word — same list looksLikeBareFoodName uses)
// and on any split item longer than 6 words, so an ordinary sentence that
// happens to contain "and" doesn't get misread as a food list.
function detectMultiFoodList(text) {
  const t = text.trim();
  if (!t || t.includes("?")) return null;
  if (BARE_QUERY_LEADING_WORDS.test(t)) return null;
  const items = splitFoodList(t);
  if (items.length < 2 || items.length > 6) return null;
  if (items.some((item) => !item || item.split(/\s+/).length > 6)) return null;
  return items;
}

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
  const res = await env.CHAKUDYA_API.fetch("https://chakudya-api/batch", {
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

// Formats the batch results from lookupFoodsViaBatch into one WhatsApp
// message (each resolved food as its own formatFoodResult card, unresolved
// names called out at the end). Returns null if nothing resolved at all —
// caller falls back to /rag/ask in that case, same as compareFoodsViaChakudya.
function formatMultiFoodResults(results) {
  if (!results?.length) return null;

  const cards = [];
  const unresolved = [];
  for (const { name, item } of results) {
    const card = formatFoodResult(item);
    if (card) cards.push(card);
    else unresolved.push(name);
  }
  if (!cards.length) return null;

  const lines = [cards.join("\n\n")];
  if (unresolved.length) {
    lines.push(`\n⚠️ Couldn't find: ${unresolved.join(", ")}`);
  }
  return lines.join("\n");
}

// Common filler words that end up wrapped around the food name when the
// gram amount trails the food ("find energy and macros for quinoa 200g")
// — stripped iteratively from the front until only the food name is left.
const QUANTITY_LEADING_FILLERS = new Set([
  "find", "energy", "and", "macro", "macros", "for", "of", "nutrition",
  "value", "in", "calculate", "calculation", "please", "me", "give",
  "show", "tell", "the", "a", "an", "what", "is", "are", "how", "much",
  "many", "kcal", "calories",
]);

function stripLeadingFillers(phrase) {
  const words = phrase.trim().split(/\s+/);
  while (words.length > 1 && QUANTITY_LEADING_FILLERS.has(words[0].toLowerCase())) {
    words.shift();
  }
  return words.join(" ");
}

// Detects a food + specific gram amount, in either order:
// "200g of quinoa" / "how many calories in 200g of rice?" (amount first),
// or "quinoa 200g" / "find energy and macros for quinoa 200g" (amount last).
function detectFoodQuantity(query) {
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
const SERVING_ONLY_FILLERS = new Set([
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

function detectServingOnly(query) {
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

// --- Food diary (chakudya-api's /log and /log/summary) ---
//
// "log it" / "log 150g" / "log it as dinner" saves whatever food was most
// recently discussed (see last_food_context) as a diary entry. Deliberately
// narrow in what it accepts: the message must start with an explicit
// log/save/record/add verb, and everything else in it must be either a
// gram amount, a meal-type word, or one of a short list of filler words
// ("it", "this", "to", "my", "diary", ...) — if anything else is left over
// (e.g. "log my rice porridge", naming a food directly rather than
// referring to one already discussed), this returns null and the message
// falls through to the normal flow instead of silently mis-logging or
// swallowing what might actually be a real question.
const LOG_MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];
const LOG_FILLER_WORDS = new Set([
  "log", "save", "record", "add", "it", "this", "that", "to", "my", "the",
  "diary", "food", "as", "please", "now", "in",
]);

function detectLogCommand(text) {
  const t = text.trim();
  if (!/^(log|save|record|add)\b/i.test(t)) return null;

  let grams = null;
  let withoutGrams = t;
  const gramMatch = t.match(/(\d+(?:\.\d+)?)\s*g(?:rams)?\b/i);
  if (gramMatch) {
    grams = Number(gramMatch[1]);
    if (!(grams > 0 && grams < 10000)) return null;
    withoutGrams = t.slice(0, gramMatch.index) + t.slice(gramMatch.index + gramMatch[0].length);
  }

  let mealType = null;
  const words = withoutGrams
    .toLowerCase()
    .replace(/[?.!,]/g, "")
    .split(/\s+/)
    .filter(Boolean);

  const leftover = words.filter((w) => {
    if (LOG_MEAL_TYPES.includes(w)) {
      mealType = w;
      return false;
    }
    return !LOG_FILLER_WORDS.has(w);
  });
  if (leftover.length > 0) return null;

  return { grams, mealType };
}

// "today" / "my log" / "this week" — exact-phrase allowlist (not a
// substring match) so a real question that happens to contain "today"
// ("How many calories should I eat today?") is left alone and still goes
// to /rag/ask instead of being swallowed here.
const LOG_SUMMARY_DAILY_PHRASES = new Set([
  "today", "my log", "food log", "my diary", "diary", "today's log",
  "daily summary", "log summary", "show my log", "show my diary",
  "what did i eat today", "what have i eaten today",
]);
const LOG_SUMMARY_WEEKLY_PHRASES = new Set([
  "this week", "weekly summary", "week summary", "my week",
  "this week's log", "what did i eat this week",
]);

function detectLogSummaryCommand(text) {
  const t = text.trim().toLowerCase().replace(/[?.!]+$/, "");
  if (LOG_SUMMARY_WEEKLY_PHRASES.has(t)) return { period: "weekly" };
  if (LOG_SUMMARY_DAILY_PHRASES.has(t)) return { period: "daily" };
  return null;
}

// Malawi runs on CAT (UTC+2) year-round (no DST) — used only to pick a
// sensible default meal type when the user doesn't say one, so a plain
// "log it" doesn't force an extra round-trip asking which meal this was.
function currentHourInMalawi() {
  return (new Date().getUTCHours() + 2) % 24;
}

function inferMealTypeFromHour(hour) {
  if (hour >= 5 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 15) return "lunch";
  if (hour >= 17 && hour < 21) return "dinner";
  return "snack";
}

// POST /log — see sql/002_add_food_log_entries.sql in chakudya-api.
// user_id is the WhatsApp number, matching the pattern last_food_context
// already uses to key per-user state without a separate account system.
async function logFoodEntry({ whatsappId, mealType, calories, foodName, env }) {
  const res = await env.CHAKUDYA_API.fetch("https://chakudya-api/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: whatsappId,
      meal_type: mealType,
      calories,
      food_name: foodName,
    }),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.data || null;
}

async function getLogSummary({ whatsappId, period, env }) {
  const url = `https://chakudya-api/log/summary?user_id=${encodeURIComponent(whatsappId)}&period=${period}`;
  const res = await env.CHAKUDYA_API.fetch(url);
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.data || null;
}

const MEAL_LABELS = { breakfast: "Breakfast", lunch: "Lunch", snack: "Snack", dinner: "Dinner" };

function formatDailySummary(summary) {
  const lines = [`*Today's log* — ${summary.date}`, `Total: ${Math.round(summary.total_calories)} kcal (${summary.entry_count} item${summary.entry_count === 1 ? "" : "s"})`];
  for (const meal of LOG_MEAL_TYPES) {
    const kcal = summary.by_meal?.[meal];
    if (kcal) lines.push(`${MEAL_LABELS[meal]}: ${Math.round(kcal)} kcal`);
  }
  if (summary.entry_count === 0) lines.push("\nNothing logged yet today — say \"log it\" after I show you a food to start.");
  return lines.join("\n");
}

function formatWeeklySummary(summary) {
  const lines = [
    `*This week's log* — ${summary.start_date} to ${summary.end_date}`,
    `Total: ${Math.round(summary.total_calories)} kcal · Daily average: ${Math.round(summary.average_daily_calories)} kcal`,
  ];
  for (const day of summary.by_date || []) {
    if (day.total_calories) lines.push(`${day.date}: ${Math.round(day.total_calories)} kcal`);
  }
  if (summary.entry_count === 0) lines.push("\nNothing logged yet this week — say \"log it\" after I show you a food to start.");
  return lines.join("\n");
}

// --- Multi-ingredient meal logging (/ingredients/parse + /meals/analyze) ---
//
// "log 2 eggs, 1 cup rice and chicken" / "ate nsima, beans and greens for
// dinner" — anything naming more than one food at once. detectLogCommand
// above only matches a message that's PURELY grams/meal-type/filler words
// after the verb, so a real ingredient list always falls through to this
// detector instead. The comma/" and " check is what distinguishes this from
// a single-food message ("log it as dinner" has neither).
const MEAL_LOG_LEADING_VERB = /^(i ate|ate|log|save|record|add)\b\s*/i;

function detectMealLogCommand(text) {
  const t = text.trim();
  if (!MEAL_LOG_LEADING_VERB.test(t)) return null;
  if (!t.includes(",") && !/\band\b/i.test(t)) return null;

  let rest = t.replace(MEAL_LOG_LEADING_VERB, "");
  let mealType = null;

  const trailingMeal = rest.match(/\bas\s+(breakfast|lunch|dinner|snack)\b\s*$/i);
  if (trailingMeal) {
    mealType = trailingMeal[1].toLowerCase();
    rest = rest.slice(0, trailingMeal.index).trim();
  } else {
    const leadingMeal = rest.match(/\bfor\s+(breakfast|lunch|dinner|snack)[,:]?\s*/i);
    if (leadingMeal) {
      mealType = leadingMeal[1].toLowerCase();
      rest = (rest.slice(0, leadingMeal.index) + rest.slice(leadingMeal.index + leadingMeal[0].length)).trim();
    }
  }

  rest = rest.replace(/[?.!]+$/, "").trim();
  if (!rest) return null;

  return { text: rest, mealType };
}

// Chains /ingredients/parse (free text -> structured ingredients) straight
// into /meals/analyze (resolves each ingredient against local/external food
// data and totals the nutrients) — Chakudya does all the resolution and
// arithmetic; this just passes its own output from one endpoint to the
// next. Returns the /meals/analyze data object, or null on any failure.
async function parseAndAnalyzeMeal(text, env) {
  const parseRes = await env.CHAKUDYA_API.fetch("https://chakudya-api/ingredients/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!parseRes.ok) return null;
  const parseBody = await parseRes.json().catch(() => null);
  const ingredients = parseBody?.data?.ingredients;
  if (!Array.isArray(ingredients) || !ingredients.length) return null;

  const analyzeRes = await env.CHAKUDYA_API.fetch("https://chakudya-api/meals/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ingredients }),
  });
  if (!analyzeRes.ok) return null;
  const analyzeBody = await analyzeRes.json().catch(() => null);
  return analyzeBody?.data || null;
}

function formatMealAnalysis(analysis, mealType) {
  const t = analysis.total_nutrients || {};
  const kcal = t.kcal ?? t.energy_kcal;

  const lines = [`*Meal analysis* (${MEAL_LABELS[mealType] || mealType})`];
  const macros = [];
  if (kcal != null) macros.push(`${Math.round(kcal)} kcal`);
  if (t.protein_g != null) macros.push(`${t.protein_g}g protein`);
  if (t.carbs_g != null) macros.push(`${t.carbs_g}g carbs`);
  if (t.fat_g != null) macros.push(`${t.fat_g}g fat`);
  if (macros.length) lines.push(macros.join(", "));

  if (analysis.ingredients?.length) {
    lines.push("");
    lines.push("Items: " + analysis.ingredients.map((i) => `${i.food_name} (${i.grams}g)`).join(", "));
  }
  if (analysis.unresolved_ingredients?.length) {
    const names = analysis.unresolved_ingredients.map((u) => u.input?.food_name || String(u.input));
    lines.push(`⚠️ Couldn't match: ${names.join(", ")}`);
  }
  return lines.join("\n");
}

function summarizeMealName(ingredients) {
  if (!ingredients?.length) return "Mixed meal";
  const names = ingredients.slice(0, 4).map((i) => i.food_name);
  return names.join(", ") + (ingredients.length > 4 ? ", +more" : "");
}

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
    // requested amount before saving, so "log it" always logs the SAME
    // numbers the user just saw, not silently the base/default amount.
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

// Scales just the kcal figure from a saved context to a target gram amount
// — what logFoodEntry needs; the food diary only stores calories, not a
// full macro/micro breakdown (see food_log_entries schema).
function kcalAtGrams(context, grams) {
  if (!context?.baseGrams || context.kcal == null) return null;
  const factor = grams / context.baseGrams;
  return Math.round(context.kcal * factor * 10) / 10;
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

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
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
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
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

// WhatsApp media is two-step: first ask Graph API for a short-lived URL,
// then fetch the actual bytes from that URL (both calls need the same
// bearer token).
async function downloadWhatsAppMedia(mediaId, env) {
  const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
  });
  if (!metaRes.ok) {
    throw new Error(`Media lookup error: ${metaRes.status} ${await metaRes.text()}`);
  }
  const meta = await metaRes.json();

  const fileRes = await fetch(meta.url, {
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
  const res = await env.CHAKUDYA_API.fetch("https://chakudya-api/packaged/scan", {
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
  const res = await env.CHAKUDYA_API.fetch(
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
// handleFoodSubstitutes). This just formats the result.
function detectSubstituteRequest(text) {
  const t = text.trim();
  let m = t.match(/\b(?:substitutes?|alternatives?|replacements?)\s+(?:for|to)\s+([a-z0-9 '()-]+?)[?.!]?$/i);
  if (m) return m[1].trim();
  m = t.match(/\bwhat can i (?:use|eat|have)\s+instead of\s+([a-z0-9 '()-]+?)[?.!]?$/i);
  if (m) return m[1].trim();
  m = t.match(/^instead of\s+([a-z0-9 '()-]+?),?\s+what can i (?:use|eat|have)\b/i);
  if (m) return m[1].trim();
  return null;
}

async function getFoodSubstitutes(foodName, env) {
  const res = await env.CHAKUDYA_API.fetch(
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
function detectDrugInteractionQuery(text) {
  const t = text.trim();
  let m = t.match(/\b(?:drug[- ]?nutrient )?interactions?\s+(?:with|for|of)\s+([a-z0-9 '()-]+?)[?.!]?$/i);
  if (m) return m[1].trim();
  m = t.match(/\bfoods?\s+to\s+avoid\s+(?:while|when)?\s*(?:taking|on)\s+([a-z0-9 '()-]+?)[?.!]?$/i);
  if (m) return m[1].trim();
  m = t.match(/\bwhat (?:foods|nutrients)\s+(?:should i avoid|interact)\s+with\s+([a-z0-9 '()-]+?)[?.!]?$/i);
  if (m) return m[1].trim();
  return null;
}

async function searchDrugInteractions(query, env) {
  const res = await env.CHAKUDYA_API.fetch(
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
// rows actually in the local `foods` table) then requests the label.
function detectLabelRequest(text) {
  const t = text.trim();
  let m = t.match(/\b(?:nutrition(?:al)? (?:facts )?label|food label)\s+(?:for|of)\s+([a-z0-9 '()-]+?)[?.!]?$/i);
  if (m) return m[1].trim();
  m = t.match(/\bshow (?:me )?(?:the )?label for\s+([a-z0-9 '()-]+?)[?.!]?$/i);
  if (m) return m[1].trim();
  return null;
}

async function getFoodLabel(foodName, env) {
  const searchRes = await env.CHAKUDYA_API.fetch(
    `https://chakudya-api/foods?search=${encodeURIComponent(foodName)}&limit=1`
  );
  if (!searchRes.ok) return null;
  const searchBody = await searchRes.json().catch(() => null);
  const match = Array.isArray(searchBody?.data) ? searchBody.data[0] : null;
  if (!match?.id) return null; // not in the local FCT table — labels aren't available for it

  const labelRes = await env.CHAKUDYA_API.fetch(`https://chakudya-api/foods/${match.id}/label`);
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
// guess extracted from the message text (see detectDriRequest). When no
// age is stated, a representative default is used and flagged in the
// reply rather than silently presented as exact.
const DRI_NUTRIENT_KEYWORDS = {
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
const DRI_NUTRIENT_PHRASES = Object.keys(DRI_NUTRIENT_KEYWORDS).sort((a, b) => b.length - a.length);

function matchDriNutrient(phrase) {
  const p = phrase.toLowerCase().trim();
  for (const key of DRI_NUTRIENT_PHRASES) {
    if (p.includes(key)) return DRI_NUTRIENT_KEYWORDS[key];
  }
  return null;
}

function detectDriRequest(text) {
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

async function lookupDri({ nutrientKey, age, sex, lifeStageType }, env) {
  const params = new URLSearchParams();
  params.set("nutrient", nutrientKey);
  params.set("age", String(age));
  if (sex) params.set("sex", sex);
  if (lifeStageType) params.set("life_stage_type", lifeStageType);

  const res = await env.CHAKUDYA_API.fetch(`https://chakudya-api/dri?${params.toString()}`);
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
  const res = await env.CHAKUDYA_API.fetch("https://chakudya-api/rag/ask", {
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

    const res = await fetch(
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
  { id: "today", title: "My Food Diary" },
];

const PROMPT_EXAMPLES_NY = [
  { id: "Ndi zakudya ziti zomwe zili ndi iron wambiri?", title: "Zakudya za Iron" },
  { id: "Compare nsima, rice and potatoes", title: "Yerekezerani Zakudya" },
  { id: "Substitute for nsima", title: "Zam'malo mwa Nsima" },
  { id: "Exchange list for a diabetic patient", title: "Kudya kwa Shuga" },
  { id: "How much iron do I need?", title: "Iron Yofunika Tsiku" },
  { id: "Quinoa", title: "Funsani Chakudya" },
  { id: "quinoa 200g", title: "Kulemera kwa Chakudya" },
  { id: "today", title: "Zakudya Zanu Lero" },
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
  const res = await fetch(
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
