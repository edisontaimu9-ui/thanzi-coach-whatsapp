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
import { parseFeedbackId, pruneFeedback } from "./feedback.js";
import { verifyWebhookSignature } from "./webhookSignature.js";
import { parseAdminCommand, runAdminCommand } from "./adminCommands.js";
import { pruneTopics, recordTopic } from "./topics.js";
import { buildEditNotice, normalizeIncomingMessage } from "./editedMessages.js";
import { buildFailureReply, classifyFailure } from "./fallbackReplies.js";
import { isMenuEscape, parseGreeting } from "./detectors.js";
import { chichewaRepliesEnabled, detectLanguageCommand, getLanguageState, isChichewaFor, languageConfirmation, learnLanguage, resolveLanguage, saveLanguageState } from "./language.js";
import { clearAllScreeningSessions } from "./screeningShared.js";
import { handleStats, handleStatsFeedback, handleStatsTimeseries, isDuplicateMessage, recordActivity, recordError, sendDailySummary } from "./analytics.js";
import { downloadWhatsAppMedia, sendPromptList, sendTypingIndicator, sendWhatsAppReply } from "./whatsapp.js";
import { handleImageMessage, transcribeAudio } from "./media.js";
import { handleFeedbackTap } from "./feedbackFlow.js";
import { handleGuidedFlows, handleMenusAndGreeting } from "./textFlows.js";
import { handleComparisonsAndMultiFood, handleMealPlans, handleReferenceQueries } from "./nutritionHandlers.js";
import { handleFoodQueries } from "./foodQueryHandlers.js";
import { answerQuestion, handleHelpIntent } from "./answerFlow.js";

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

  // The rest of the routing lives in the handler modules, tried in the same order as before. Each
  // returns true once it has replied to the message.
  const c = { userText, from, env, ctx, opts, topic, langState, lang, repliesInChichewa };
  if (await handleGuidedFlows(c)) return;
  if (await handleMenusAndGreeting(c)) return;
  if (await handleReferenceQueries(c)) return;
  if (await handleMealPlans(c)) return;
  if (await handleComparisonsAndMultiFood(c)) return;
  if (await handleFoodQueries(c)) return;
  if (await handleHelpIntent(c)) return;
  await answerQuestion(c);
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
