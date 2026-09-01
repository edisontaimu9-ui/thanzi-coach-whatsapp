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
 *   4. Image messages (photo of a nutrition label) -> downloaded from
 *      WhatsApp, sent to /packaged/scan for OCR + nutrient extraction.
 *   5. Reply sent back via the WhatsApp Cloud API.
 *
 * Required secrets (set with `wrangler secret put <NAME>` — never hardcode these):
 *   WHATSAPP_TOKEN         - Meta permanent/system-user access token
 *   VERIFY_TOKEN           - a string you invent; must match what you enter in
 *                            Meta App Dashboard > WhatsApp > Configuration > Webhook
 *   GROQ_API_KEY            - console.groq.com API key, for direct barcode-from-photo reads
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
  if (message.type === "text" || message.type === "image" || message.type === "interactive") {
    ctx.waitUntil(recordActivity(from, message.type, env));
  }

  try {
    if (message.type === "text") {
      await handleTextMessage(message.text.body, from, env, ctx);
    } else if (message.type === "image") {
      await handleImageMessage(message.image, from, env, ctx);
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

  // Two-food nutrient comparisons ("100g of X vs 100g of Y") get pulled
  // straight from /foods/lookup's real per-100g food-database records
  // (with USDA/OFF/FatSecret cascade), bypassing /rag/ask entirely — its
  // retrieval sometimes mixes in exchange-list data (per-serving, e.g.
  // "2 sardines"), which isn't comparable to a 100g figure. If either food
  // isn't found this way, fall through to the normal RAG path below.
  const twoFood = detectTwoFoodComparison(userText);
  if (twoFood) {
    const comparison = await compareTwoFoods(twoFood.foodA, twoFood.foodB, env);
    if (comparison) {
      await sendWhatsAppReply(from, comparison, env);
      return;
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
      ctx.waitUntil(saveLastFoodContext(from, scaled.context, env));
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

// Detects phrasing like "100g of X ... compared with/to 100g of Y",
// "compare X and Y", or "X vs Y" and extracts both food names.
function detectTwoFoodComparison(query) {
  const patterns = [
    /\bof\s+([a-z0-9 ,()'-]+?)\s+compared\s+(?:with|to)\s+(?:\d+\s*g(?:rams)?\s+of\s+)?([a-z0-9 ,()'-]+?)[?.!]?$/i,
    /\bcompare\b.*?\bof\s+([a-z0-9 ,()'-]+?)\s+(?:and|with|to|&|vs\.?|versus)\s+([a-z0-9 ,()'-]+?)[?.!]?$/i,
    /\bcompare\b\s+([a-z0-9 ,()'-]+?)\s+(?:and|with|to|&|vs\.?|versus)\s+([a-z0-9 ,()'-]+?)[?.!]?$/i,
    /^([a-z0-9 ,()'-]+?)\s+(?:vs\.?|versus)\s+([a-z0-9 ,()'-]+?)[?.!]?$/i,
  ];
  const stripTrailingVerb = (s) =>
    s.replace(/\s+(provide|providing|have|has|contain|contains)$/i, "").trim();
  for (const re of patterns) {
    const m = query.match(re);
    if (m && m[1] && m[2]) {
      return { foodA: stripTrailingVerb(m[1].trim()), foodB: m[2].trim() };
    }
  }
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

// Returns two formatted food cards side by side, or null (to fall back to
// /rag/ask) if either food isn't found in the food database.
async function compareTwoFoods(nameA, nameB, env) {
  const [itemA, itemB] = await Promise.all([
    lookupFoodByName(nameA, env),
    lookupFoodByName(nameB, env),
  ]);
  const cardA = formatFoodResult(itemA);
  const cardB = formatFoodResult(itemB);
  if (!cardA || !cardB) return null;
  return `${cardA}\n\n${cardB}`;
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

// Filler words allowed in a "just a gram amount" follow-up — e.g.
// "Calculate for 50g serving", "scale to 200g please". If any OTHER word
// remains after stripping the gram token and these fillers, the message
// names an actual food and isn't a bare follow-up (detectFoodQuantity
// above handles that case).
const SERVING_ONLY_FILLERS = new Set([
  "calculate", "calc", "compute", "scale", "convert", "recalculate",
  "show", "give", "make", "it", "for", "to", "a", "an", "the", "of",
  "me", "please", "now", "serving", "portion", "size", "amount", "sized",
]);

function detectServingOnly(query) {
  const gramMatch = query.match(/(\d+(?:\.\d+)?)\s*g(?:rams)?\b/i);
  if (!gramMatch) return null;
  const grams = Number(gramMatch[1]);
  if (!(grams > 0 && grams < 10000)) return null;

  const withoutGram = query.slice(0, gramMatch.index) + query.slice(gramMatch.index + gramMatch[0].length);
  const words = withoutGram
    .toLowerCase()
    .replace(/[?.!,]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const namesAFood = words.some((w) => !SERVING_ONLY_FILLERS.has(w));
  if (namesAFood) return null;

  return { grams };
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
    kcal: item.kcal ?? item.energy_kcal,
    protein: item.protein_g,
    carbs: item.carbs_g,
    fat: item.fat_g,
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

  const macros = [];
  if (kcal != null) macros.push(`${kcal} kcal`);
  if (protein != null) macros.push(`${protein}g protein`);
  if (carbs != null) macros.push(`${carbs}g carbs`);
  if (fat != null) macros.push(`${fat}g fat`);
  if (!macros.length) return null;

  return `*${context.name}* — ${grams} g\n${macros.join(", ")}`;
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

  const { base64, mimeType } = await downloadWhatsAppMedia(mediaId, env);

  // Try reading it as a barcode first (fast, cheap, precise task). Only if
  // no barcode is found do we fall back to Chakudya's nutrition-label OCR —
  // this way one photo handles either case automatically.
  const barcode = await readBarcodeFromImage(base64, mimeType, env);
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
  return { base64, mimeType: meta.mime_type || "image/jpeg" };
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

  const macros = [];
  if (kcal != null) macros.push(`${kcal} kcal`);
  if (protein != null) macros.push(`${protein}g protein`);
  if (carbs != null) macros.push(`${carbs}g carbs`);
  if (fat != null) macros.push(`${fat}g fat`);

  const lines = [`*${name}*${brand}${measureText}`];
  if (macros.length) lines.push(macros.join(", "));
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
  { id: "What foods are high in iron?", title: "High-iron foods" },
  { id: "Compare nsima and rice", title: "Compare two foods" },
  { id: "Exchange list for a diabetic patient", title: "Diabetic exchange list" },
  { id: "What should I feed my child if they are malnourished?", title: "Child malnutrition" },
  { id: "Quinoa", title: "Look up a food" },
  { id: "quinoa 200g", title: "Nutrition for a weight" },
];

const PROMPT_EXAMPLES_NY = [
  { id: "Ndi zakudya ziti zomwe zili ndi iron wambiri?", title: "Zakudya za iron" },
  { id: "Compare nsima and rice", title: "Yerekezani zakudya" },
  { id: "Exchange list for a diabetic patient", title: "Exchange list - shuga" },
  { id: "What should I feed my child if they are malnourished?", title: "Kudyetsa mwana wowonda" },
  { id: "Quinoa", title: "Funsani za chakudya" },
  { id: "quinoa 200g", title: "Zambiri pa kulemera" },
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
