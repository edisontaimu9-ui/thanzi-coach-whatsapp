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
 *  13. "screen a child for malnutrition" / "check muac for my baby" ->
 *      a multi-turn under-5 malnutrition screening intake (sex, age,
 *      weight, height, MUAC, oedema, optional STRONGkids), calling the
 *      Chakudya MCP server's under5_integrated_screen tool once complete.
 *      Deterministic questions and deterministic result formatting — no
 *      LLM in this path. See ./under5Screening.js for the full design
 *      rationale and required setup (CHAKUDYA_MCP service binding +
 *      CHAKUDYA_MCP_AUTH_TOKEN secret, listed below too).
 *  14. "screen a pregnant woman for malnutrition" / "postpartum screening" ->
 *      a multi-turn maternal malnutrition screening intake (MUAC, country-
 *      specific MUAC cutoff, oedema, confirmed >10% weight loss), calling
 *      the Chakudya MCP server's pregnant_postpartum_integrated_screen
 *      tool once complete. Same deterministic-question/deterministic-call/
 *      Groq-narrates-only-with-hardcoded-action-appended architecture as
 *      #13 above. See ./pregnantPostpartumScreening.js. No new secret or
 *      binding needed — reuses CHAKUDYA_MCP / CHAKUDYA_MCP_AUTH_TOKEN.
 *  15. "screen a school child for malnutrition" / "check BMI for a 9 year old" ->
 *      a multi-turn 5-17 year screen (BMI-for-age, MUAC, oedema, optional
 *      STRONGkids) calling the MCP server's school_age_integrated_screen tool.
 *      "screen a child" also lands here automatically when the age given is 5+.
 *      See ./schoolAgeScreening.js.
 *  16. "screen an adult for malnutrition" / "check muac for an elderly patient" ->
 *      a multi-turn adult (18+, not pregnant/postpartum) screen (NACS oedema,
 *      MUAC, BMI, weight loss, optional MUST) calling the MCP server's
 *      adult_integrated_screen tool. See ./adultScreening.js. The flows hand
 *      people to each other by age/pregnancy (see each file's header). Both
 *      reuse CHAKUDYA_MCP / CHAKUDYA_MCP_AUTH_TOKEN; shared plumbing is in
 *      ./screeningShared.js. A severe/moderate result also opens the
 *      follow-up in ./adultRefeedingRisk.js — see #16a.
 *
 *  16a. Follow-up only, no trigger of its own: after a severe/moderate #16
 *      result, offers (yes/no) an ASPEN refeeding syndrome risk check for
 *      the same adult (Table 3), calling aspen_refeeding_risk_adult. BMI is
 *      carried over from the #16 result; caloric intake pattern and
 *      prefeeding electrolyte abnormality are asked as a 3-option choice —
 *      the two criteria ASPEN's own tool description calls a "clinician's
 *      qualitative read," which is why this stays a screening follow-up
 *      rather than a public quick calculator. Adult-only by design: for
 *      severe pediatric malnutrition, national protocol should decide, not
 *      this bot. See ./adultRefeedingRisk.js.
 *
 *  17. "estimate weight for a patient" / "patient can't be weighed" ->
 *      a multi-turn body-weight ESTIMATE for a patient who can't be weighed
 *      (ages 6+): arm circumference plus calf circumference (65+) and/or knee
 *      height + race (up to 80), calling weight_estimate_persons_65_and_older
 *      and/or weight_from_knee_height_and_mac on the MCP server. Standard errors
 *      are large and always shown. The adult screening flow reuses the same
 *      questions (as an explicit yes/no) to get a labelled BMI estimate. See
 *      ./weightEstimate.js.
 *
 *  18. "estimate height for a patient" / "patient can't stand" ->
 *      a multi-turn standing HEIGHT (stature) ESTIMATE for a patient who
 *      can't be measured directly: asks which ONE measurement is on hand
 *      (knee height + race, demi span, or ulna length — only the methods
 *      that have a published equation at the patient's age are offered),
 *      then calls the matching MCP tool: stature_from_knee_height,
 *      stature_from_demi_span, or stature_from_ulna_length. Standalone
 *      calculator — its result is never used for malnutrition
 *      classification. See ./heightEstimate.js.
 *
 *  19. "quick calculators" (none of the four below named), or tapping the
 *      greeting list's "Quick Calculators" row ->
 *      a tappable sub-menu offering #17 (weight), #18 (height), #20 (BMI)
 *      or #21 (weight change), the same way the "Malnutrition screening"
 *      row opens a who-to-screen menu. Exists because the greeting list is
 *      already at WhatsApp's 10-row cap, so all four share one row instead
 *      of each needing their own. See ./estimateMenu.js.
 *
 *  20. "check my BMI" / "BMI for a patient" ->
 *      a quick two-question BMI calculator (weight, height) calling
 *      bmi_classification — returns BMI plus BOTH the WHO 2000 band (with
 *      comorbidity risk) and the Malawi NCST 2015 band for the same value.
 *      Not attached to any screening; flags a note when the height suggests
 *      a child, since these bands are adult-oriented. See ./bmiCheck.js.
 *
 *  21. "check percent weight change" / "how much weight did I lose" ->
 *      a quick calculator (current weight, usual/baseline weight, optional
 *      time frame) calling percent_weight_change_calculator. When a time
 *      frame is given, also returns the significant/severe weight-loss
 *      interpretation (Width & Reinhard) for it. See ./weightChangeCheck.js.
 *
 * Required secrets (set with `wrangler secret put <NAME>` — never hardcode these):
 *   WHATSAPP_TOKEN         - Meta permanent/system-user access token
 *   VERIFY_TOKEN           - a string you invent; must match what you enter in
 *                            Meta App Dashboard > WhatsApp > Configuration > Webhook
 *   GROQ_API_KEY            - console.groq.com API key, for direct barcode-from-photo
 *                            reads AND voice-note transcription (Whisper)
 *   STATS_TOKEN             - a string you invent; required as ?token= on GET /stats
 *   FEEDBACK_TOKEN          - optional; a DIFFERENT string you invent, required as ?token= on
 *                            GET /stats/feedback (the 👎/👍 questions). Keep it out of the
 *                            dashboard source: it is typed into the dashboard once. If unset,
 *                            that endpoint always answers 403.
 *   ADMIN_PHONE             - optional; your own WhatsApp number for the daily
 *                            summary cron job (see wrangler.toml [triggers]).
 *                            No-ops if unset.
 *   CHAKUDYA_MCP_AUTH_TOKEN - REQUIRED for the under-5 screening flow to work.
 *                            Must match chakudya-mcp-server-cloudflare's own
 *                            MCP_AUTH_TOKEN secret exactly (same value, both
 *                            repos). Without it, "screen a child" starts the
 *                            conversation but fails with an auth error at
 *                            the final step. See ./under5Screening.js.
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

import { buildRateLimitNotice, checkRateLimit, getLimits, pruneRateLimits } from "./rateLimit.js";
import { parseFeedbackId, pruneFeedback, shouldAskFeedback, splitReferences } from "./feedback.js";
import { verifyWebhookSignature } from "./webhookSignature.js";
import { parseAdminCommand, runAdminCommand } from "./adminCommands.js";
import { recordTopic, pruneTopics } from "./topics.js";
import { buildEditNotice, normalizeIncomingMessage } from "./editedMessages.js";
import { buildFailureReply, classifyFailure } from "./fallbackReplies.js";
import { detectComparisonFollowUp, detectDriRequest, detectDrugInteractionQuery, detectEnergyRequirementRequest, detectFoodComparison, detectFoodQuantity, detectLabelRequest, detectMealPlanEdit, detectMealPlanRequest, detectMultiFoodList, detectServingOnly, detectSubstituteRequest, isBareCancel, isMenuEscape, looksLikeBarcode, looksLikeBareFoodName, parseGreeting } from "./detectors.js";
import { detectLanguageCommand, getLanguageState, languageConfirmation, learnLanguage, resolveLanguage, saveLanguageState } from "./language.js";
import { clearAllScreeningSessions } from "./screeningShared.js";
import { detectSchoolAgeScreeningTrigger, handleSchoolAgeScreeningFlow } from "./schoolAgeScreening.js";
import { detectUnder5ScreeningTrigger, handleUnder5ScreeningFlow } from "./under5Screening.js";
import { detectPregnantPostpartumScreeningTrigger, handlePregnantPostpartumScreeningFlow } from "./pregnantPostpartumScreening.js";
import { detectAdultScreeningTrigger, handleAdultScreeningFlow } from "./adultScreening.js";
import { detectWeightEstimateTrigger, handleWeightEstimateFlow } from "./weightEstimate.js";
import { detectHeightEstimateTrigger, handleHeightEstimateFlow } from "./heightEstimate.js";
import { detectBmiCheckTrigger, handleBmiCheckFlow } from "./bmiCheck.js";
import { detectWeightChangeTrigger, handleWeightChangeFlow } from "./weightChangeCheck.js";
import { ESTIMATE_MENU_BODY, ESTIMATE_MENU_BUTTON, detectEstimateMenuRequest, estimateMenuSections } from "./estimateMenu.js";
import { SCREENING_MENU_BODY, SCREENING_MENU_BUTTON, detectScreeningMenuRequest, screeningMenuSections } from "./screeningMenu.js";
import { handleAdultRefeedingRiskFlow } from "./adultRefeedingRisk.js";
import { calculateEnergyRequirement } from "./energy.js";
import { shouldClassifyIntent } from "./intentClassifier.js";
import { buildToEnglishMessages, isChichewaMessage } from "./chichewa.js";
import { handleStats, handleStatsFeedback, handleStatsTimeseries, isDuplicateMessage, recordActivity, recordError, sendDailySummary } from "./analytics.js";
import { downloadWhatsAppMedia, sendFoodOptionsList, sendPromptList, sendTypingIndicator, sendWhatsAppInteractiveList, sendWhatsAppReply } from "./whatsapp.js";
import { chichewaRepliesEnabled, isChichewaFor } from "./language.js";
import { handleImageMessage, transcribeAudio } from "./media.js";
import { askForFeedback, handleFeedbackTap } from "./feedbackFlow.js";
import { answerFoodQuantity, askChakudya, compareFoodsViaChakudya, getFoodLabel, getFoodSubstitutes, lookupBarcode, lookupDri, lookupFoodByName, lookupFoodsViaBatch, lookupWiderTierFoodByName, resolveUnknownFoodsViaRag, searchDrugInteractions, searchFoodCandidates } from "./chakudyaClient.js";
import { getLastFoodContext, getLastSessionContext, saveLastFoodContext, saveLastSessionContext } from "./context.js";
import { buildConciseNutritionQuery, formatDriAnswer, formatDrugInteractions, formatEnergyRequirementResult, formatFoodResult, formatMultiFoodResults, formatNutritionLabel, formatSubstitutes, getFoodItemName, isDirectFoodMatch, normalizeFoodName, scaleFoodToGrams, toFoodContext } from "./formatting.js";
import { applyMealPlanEdit, generateMealPlan } from "./mealPlan.js";
import { LLM_BUSY_MESSAGE, SUBREQUEST_LIMIT_MESSAGE } from "./errors.js";
import { classifyHelpIntent, localizeAnswer, translateWithGroq } from "./llm.js";

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

    if (request.method === "GET" && url.pathname === "/stats/feedback") {
      return handleStatsFeedback(url, env);
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
    ctx.waitUntil(pruneRateLimits(env.DB));
    ctx.waitUntil(pruneFeedback(env.DB));
    ctx.waitUntil(pruneTopics(env.DB));
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
  // Read the RAW body once: Meta's X-Hub-Signature-256 is computed over the exact bytes sent, so
  // it must be verified before (and independently of) JSON parsing. See ./webhookSignature.js.
  const rawBody = await request.text();

  // Rejects forged POSTs (anyone who finds the worker URL could otherwise spoof messages and burn
  // Groq/Chakudya quota). Needs the Meta App Secret as the APP_SECRET Worker secret. Until that
  // secret is set the check is skipped with a warning, so deploying this code can't take the bot
  // down; once APP_SECRET exists, unsigned or wrongly signed requests get 401.
  if (env.APP_SECRET) {
    const ok = await verifyWebhookSignature(rawBody, request.headers.get("X-Hub-Signature-256"), env.APP_SECRET);
    if (!ok) {
      console.warn("Rejected webhook POST: missing or invalid X-Hub-Signature-256");
      return new Response("Unauthorized", { status: 401 });
    }
  } else {
    console.warn("APP_SECRET is not set: webhook signature verification is DISABLED");
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // WhatsApp Cloud API also sends delivery/read status callbacks with no
  // message content — ignore those and only act on real inbound text messages.
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  let message = change?.value?.messages?.[0];

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

  // Edited messages (see ./editedMessages.js): a readable text edit is rewritten as a normal text
  // message so it is answered as a fresh question; the "unsupported" placeholder Meta currently
  // sends for edits gets a plain explanation instead of silence.
  const normalized = normalizeIncomingMessage(message);
  message = normalized.message;

  const from = message.from; // sender's WhatsApp number

  // Per-number rate limit (see ./rateLimit.js): drops excess messages BEFORE any Groq/Chakudya work,
  // with one polite notice per window. The admin number is exempt. Fails open if D1 is unavailable.
  if (!env.ADMIN_PHONE || from !== env.ADMIN_PHONE) {
    const limit = await checkRateLimit(env.DB, from, getLimits(env));
    if (limit.limited) {
      if (limit.notify) {
        const said = message.text?.body || "";
        await sendWhatsAppReply(from, buildRateLimitNotice(limit.scope, await isChichewaFor(env, from, said)), env).catch(() => {});
      }
      return new Response("OK", { status: 200 });
    }
  }

  if (normalized.kind === "unsupported" || normalized.kind === "edit-unreadable") {
    await sendWhatsAppReply(from, buildEditNotice(normalized.kind), env).catch(() => {});
    return new Response("OK", { status: 200 });
  }
  if (normalized.kind === "edit") {
    // Sent before the typing indicator so the indicator stays up while the real answer is prepared.
    await sendWhatsAppReply(from, buildEditNotice("edit", await isChichewaFor(env, from, message.text.body)), env).catch(() => {});
  }

  // Mark the message read and show WhatsApp's native "typing..." indicator
  // right away — every text/image/audio handler below can take a few
  // seconds (Groq, Chakudya, or both), and this is the "thinking" signal
  // Meta actually supports (see sendTypingIndicator). It auto-dismisses the
  // moment the real reply is sent (sendWhatsAppReply/sendFoodOptionsList),
  // or after 25s on its own — no separate "done thinking" call needed.
  // Fire-and-forget: never worth delaying the real work for this.
  if (
    message.type === "text" ||
    message.type === "image" ||
    message.type === "audio" ||
    message.type === "interactive"
  ) {
    ctx.waitUntil(sendTypingIndicator(message.id, env));
  }

  // Fire-and-forget analytics write — ctx.waitUntil lets it finish after the
  // response is sent, without slowing down or risking the actual reply.
  if (message.type === "text" || message.type === "image" || message.type === "audio" || message.type === "interactive") {
    ctx.waitUntil(recordActivity(from, message.type, env));
  }

  try {
    if (message.type === "text") {
      await handleTextMessage(message.text.body, from, env, ctx, { learnLanguage: true });
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
      const feedbackTap = parseFeedbackId(tapped);
      if (feedbackTap) {
        // 👍/👎 on an answer (see ./feedback.js): record it and say thanks. Never routed as a question.
        await handleFeedbackTap(feedbackTap, from, env);
      } else if (tapped) {
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
    // Tell the person what happened and what to do next (busy / question too big / other), echo
    // their question so they can resend it, and point to "menu". See ./fallbackReplies.js.
    const failedText = message.text?.body || message.interactive?.list_reply?.id || message.interactive?.button_reply?.id || "";
    const reply = buildFailureReply(classifyFailure(err), failedText, (await isChichewaFor(env, from, failedText)) ? "ny" : "en");
    await sendWhatsAppReply(from, reply, env).catch(() => {}); // best-effort; don't crash the webhook ack
  }

  // Always 200 quickly — Meta retries aggressively on non-200/timeout
  return new Response("OK", { status: 200 });
}

// `opts.learnLanguage` is true only for typed text: voice transcripts are forced to English and
// tapped menu rows are English example prompts, so neither says anything about the person's language.
async function handleTextMessage(userText, from, env, ctx, opts = {}) {
  // Usage by topic (./topics.js): the router below sets topic.name as it picks a branch; one
  // timestamp + topic row (no phone number, no text) is written when the message is done.
  const topic = { name: "other" };
  try {
    return await handleTextMessageInner(userText, from, env, ctx, opts, topic);
  } finally {
    const done = recordTopic(env.DB, topic.name);
    if (ctx?.waitUntil) ctx.waitUntil(done);
  }
}

async function handleTextMessageInner(userText, from, env, ctx, opts = {}, topic = { name: "other" }) {
  // Admin commands ("stats", "stats 7", "feedback", "admin") — only from ADMIN_PHONE, and only when the
  // whole message is a command, so everyone else (and the admin's normal questions) is unaffected.
  // See ./adminCommands.js.
  if (env.ADMIN_PHONE && from === env.ADMIN_PHONE && !opts.skipAdmin) {
    const adminCmd = parseAdminCommand(userText);
    if (adminCmd) {
      topic.name = "admin";
      await sendWhatsAppReply(from, await runAdminCommand(adminCmd, env.DB), env);
      return;
    }
  }

  // Flexible openers: "hello Thanzi, how much iron do I need" -> answer the question with the
  // greeting stripped. (A bare greeting / generic help request is handled further down, after the
  // in-progress flow handlers, so a mid-flow answer is never swallowed.) See parseGreeting.
  const openingParse = parseGreeting(userText);
  if (openingParse && openingParse.rest) {
    userText = openingParse.rest;
  }

  // Remembered reply language (./language.js). "English" / "Chichewa" is an explicit, locked choice;
  // otherwise the language follows what the person has been writing, so short messages like
  // "nsima" or "yes" keep the conversation in the same language.
  const repliesInChichewa = chichewaRepliesEnabled(env);
  const langState = repliesInChichewa ? await getLanguageState(env.DB, from) : null;
  const langCommand = repliesInChichewa ? detectLanguageCommand(userText) : null;
  if (langCommand) {
    topic.name = "language";
    await saveLanguageState(env.DB, from, { language: langCommand, locked: true, en_streak: 0 });
    await sendWhatsAppReply(from, languageConfirmation(langCommand), env);
    return;
  }
  const lang = repliesInChichewa ? resolveLanguage(userText, langState) : "en";
  if (opts.learnLanguage && repliesInChichewa) ctx.waitUntil(learnLanguage(env.DB, from, langState, userText));

  // Menu escape: "menu" / "help" / "start over" abandon whatever guided flow is in progress and show
  // the menu (otherwise a mid-flow "menu" is swallowed as an invalid answer). See isMenuEscape.
  if (isMenuEscape(userText)) {
    topic.name = "menu";
    await clearAllScreeningSessions(from, env);
    await sendPromptList(from, repliesInChichewa && lang === "ny" ? "ny" : "en", env);
    return;
  }

  // Under-5 malnutrition screening: multi-turn structured intake (see
  // ./under5Screening.js). Checked first, both to continue an in-progress
  // session (a bare "12" or "yes" mid-flow must never be swallowed by
  // food/greeting detection below) and so the trigger phrase for starting
  // a new session wins over every other detector.
  //
  // Four screening flows now exist (school-age, under-5, pregnant/postpartum, adult), each with its
  // own session kind. A fresh trigger phrase for ANY of them first discards half-finished sessions
  // of the others, so an abandoned flow can never swallow the new request as if it were an answer.
  if (
    detectSchoolAgeScreeningTrigger(userText) ||
    detectUnder5ScreeningTrigger(userText) ||
    detectPregnantPostpartumScreeningTrigger(userText) ||
    detectAdultScreeningTrigger(userText) ||
    detectWeightEstimateTrigger(userText) ||
    detectHeightEstimateTrigger(userText) ||
    detectBmiCheckTrigger(userText) ||
    detectWeightChangeTrigger(userText) ||
    detectEstimateMenuRequest(userText) ||
    detectScreeningMenuRequest(userText)
  ) {
    await clearAllScreeningSessions(from, env);
  }

  // School-age/adolescent (5-17y) screening — see ./schoolAgeScreening.js. Checked BEFORE under-5
  // because "school child" also contains the word "child".
  const schoolAgeScreeningReply = await handleSchoolAgeScreeningFlow(userText, from, env);
  if (schoolAgeScreeningReply !== null) {
    topic.name = "screening";
    await sendWhatsAppReply(from, schoolAgeScreeningReply, env);
    return;
  }

  const screeningReply = await handleUnder5ScreeningFlow(userText, from, env);
  if (screeningReply !== null) {
    topic.name = "screening";
    await sendWhatsAppReply(from, screeningReply, env);
    return;
  }

  // Pregnant/postpartum malnutrition screening: same reasoning as above,
  // see ./pregnantPostpartumScreening.js. Uses a distinct trigger (requires
  // pregnant/postpartum/antenatal wording, not child/baby/infant) and a
  // distinct session kind, so the two flows never collide.
  const pregnantScreeningReply = await handlePregnantPostpartumScreeningFlow(userText, from, env);
  if (pregnantScreeningReply !== null) {
    topic.name = "screening";
    await sendWhatsAppReply(from, pregnantScreeningReply, env);
    return;
  }

  // Adult (18+, not pregnant/postpartum) screening — see ./adultScreening.js. Checked AFTER the
  // pregnant flow because "a pregnant woman" also matches the adult flow's population words.
  const adultScreeningReply = await handleAdultScreeningFlow(userText, from, env);
  if (adultScreeningReply !== null) {
    topic.name = "screening";
    await sendWhatsAppReply(from, adultScreeningReply, env);
    return;
  }

  // ASPEN refeeding syndrome risk follow-up, offered automatically after a severe/moderate adult
  // result above — see ./adultRefeedingRisk.js. No free-text trigger of its own: returns null
  // immediately unless that offer already started a session for this number.
  const refeedingRiskReply = await handleAdultRefeedingRiskFlow(userText, from, env);
  if (refeedingRiskReply !== null) {
    topic.name = "screening";
    await sendWhatsAppReply(from, refeedingRiskReply, env);
    return;
  }

  // Weight estimate for a 65+ patient who can't be weighed — see ./weightEstimate.js. A standalone
  // calculator: its result is never used for malnutrition classification.
  const weightEstimateReply = await handleWeightEstimateFlow(userText, from, env);
  if (weightEstimateReply !== null) {
    topic.name = "calculator";
    await sendWhatsAppReply(from, weightEstimateReply, env);
    return;
  }

  // Height (stature) estimate for a patient who can't be measured directly — see ./heightEstimate.js.
  // Also a standalone calculator: its result is never used for malnutrition classification.
  const heightEstimateReply = await handleHeightEstimateFlow(userText, from, env);
  if (heightEstimateReply !== null) {
    topic.name = "calculator";
    await sendWhatsAppReply(from, heightEstimateReply, env);
    return;
  }

  // Quick BMI check (weight + height -> WHO 2000 / Malawi NCST 2015 classification), with no
  // screening attached — see ./bmiCheck.js.
  const bmiCheckReply = await handleBmiCheckFlow(userText, from, env);
  if (bmiCheckReply !== null) {
    topic.name = "calculator";
    await sendWhatsAppReply(from, bmiCheckReply, env);
    return;
  }

  // Quick percent weight change check (current + usual weight, optional time frame) — see
  // ./weightChangeCheck.js.
  const weightChangeReply = await handleWeightChangeFlow(userText, from, env);
  if (weightChangeReply !== null) {
    topic.name = "calculator";
    await sendWhatsAppReply(from, weightChangeReply, env);
    return;
  }

  // "quick calculators" with none of the four named (typed, or tapped from the greeting list's
  // "Quick calculators" row): show the tappable which-calculator menu. See ./estimateMenu.js.
  if (detectEstimateMenuRequest(userText)) {
    topic.name = "calculator";
    await sendWhatsAppInteractiveList(
      from,
      { body: ESTIMATE_MENU_BODY, buttonText: ESTIMATE_MENU_BUTTON, sections: estimateMenuSections() },
      env
    );
    return;
  }

  // "malnutrition screening" with no population named (typed, or tapped from the greeting list's
  // "Malnutrition screening" row): show the tappable who-to-screen menu. See ./screeningMenu.js.
  if (detectScreeningMenuRequest(userText)) {
    topic.name = "screening";
    await sendWhatsAppInteractiveList(
      from,
      { body: SCREENING_MENU_BODY, buttonText: SCREENING_MENU_BUTTON, sections: screeningMenuSections() },
      env
    );
    return;
  }

  // Bare greeting ("hi", "good morning Thanzi") or a generic "I want help on Thanzi" with no topic:
  // show the tappable menu. Anything with a real question after the greeting was stripped above.
  if (isBareCancel(userText)) {
    topic.name = "menu";
    // Active flows handle their own "cancel" above; reaching here means nothing was in progress.
    await sendWhatsAppReply(from, "There's nothing to cancel right now. Type *menu* to see what I can do. 🙏", env);
    return;
  }
  const greeting = parseGreeting(userText);
  if (greeting && !greeting.rest) {
    topic.name = "menu";
    const menuLang = !repliesInChichewa ? "en" : langState?.locked ? langState.language : greeting.lang === "ny" ? "ny" : lang;
    await sendPromptList(from, menuLang, env);
    return;
  }

  if (looksLikeBarcode(userText)) {
    topic.name = "barcode";
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
    topic.name = "substitutes";
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
    topic.name = "drug_interactions";
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
    topic.name = "nutrition_label";
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
    topic.name = "dri";
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
    return;
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
    topic.name = "food_compare";
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
    topic.name = "food_compare";
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
    topic.name = "food_lookup";
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
    topic.name = "food_lookup";
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
    topic.name = "food_lookup";
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

  // Last stop before nutrition search: a short, help-shaped message the regex detectors missed
  // ("could somebody assist me pls") gets one tiny LLM call to decide menu vs real question.
  // Any failure returns "question", so this can only ever ADD the menu, never block an answer.
  // See ./intentClassifier.js.
  if (shouldClassifyIntent(userText)) {
    const { intent, lang: classifiedLang } = await classifyHelpIntent(userText, env);
    if (intent === "menu") {
      topic.name = "menu";
      const menuLang = !repliesInChichewa ? "en" : langState?.locked ? langState.language : classifiedLang === "ny" ? "ny" : lang;
      await sendPromptList(from, menuLang, env);
      return;
    }
  }

  // Chichewa question (or Chichewa/English mix): search in English, then translate the answer
  // back. Every step falls back to English, never to a worse answer. See ./chichewa.js.
  topic.name = "qa";
  const inChichewa = lang === "ny"; // reply in Chichewa (only when CHICHEWA_REPLIES is on)
  let searchText = userText;
  if (isChichewaMessage(userText) || inChichewa) { // understanding the question always works
    const english = await translateWithGroq(buildToEnglishMessages(userText), env, 8000);
    if (english) searchText = english;
  }

  let answer = await askChakudya(searchText, from, env);
  // askChakudya returns these two canned strings (instead of throwing) when the provider is down,
  // rate-limited, or the question blew the subrequest ceiling: swap in the more helpful reply.
  let isRealAnswer = true;
  if (answer === LLM_BUSY_MESSAGE) {
    answer = buildFailureReply("busy", userText, lang);
    isRealAnswer = false;
  } else if (answer === SUBREQUEST_LIMIT_MESSAGE) {
    answer = buildFailureReply("limit", userText, lang);
    isRealAnswer = false;
  }
  // Real answers: hide the References block behind a 📚 See details button and follow up with the
  // 👍/👎 (+ details or 📤 Share) buttons. See ./feedback.js. Anything that isn't a substantive
  // real answer (failure replies, one-liners) is sent exactly as before, references included.
  let { main, references } = splitReferences(answer);
  if (isRealAnswer && inChichewa) {
    main = await localizeAnswer(main, env);
  }
  if (isRealAnswer && shouldAskFeedback(main)) {
    await sendWhatsAppReply(from, main, env);
    ctx.waitUntil(askForFeedback(from, userText, main, references, env, lang === "ny"));
  } else if (isRealAnswer && inChichewa) {
    await sendWhatsAppReply(from, references ? `${main}\n\n_References:_\n${references}` : main, env);
  } else {
    await sendWhatsAppReply(from, answer, env);
  }
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
      "I received your voice note, but couldn't open it. Please try again. 🙏",
      env
    );
    return;
  }

  await sendWhatsAppReply(
    from,
    "Listening to your voice note... one moment. 🎙️",
    env
  ).catch(() => {}); // best-effort progress ping; not fatal if it fails

  const { bytes, mimeType } = await downloadWhatsAppMedia(mediaId, env);
  const transcript = await transcribeAudio(bytes, mimeType, env);

  if (!transcript) {
    await sendWhatsAppReply(
      from,
      "Sorry, I couldn't hear that clearly. Please try again, or type your question instead. 🙏",
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
