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
  if (message.type === "text" || message.type === "image") {
    ctx.waitUntil(recordActivity(from, message.type, env));
  }

  try {
    if (message.type === "text") {
      await handleTextMessage(message.text.body, from, env);
    } else if (message.type === "image") {
      await handleImageMessage(message.image, from, env);
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

// Plain small-talk (greetings, "how are you", thanks, bye) doesn't need
// Chakudya's nutrition retrieval at all — routing it through /rag/ask just
// burns a request and comes back with an odd, citation-laden answer to a
// question that was never really about food/health data. Handled with a
// static, instant reply instead, matched on the whole message (trimmed,
// punctuation stripped) so it doesn't misfire on a real question that
// merely starts with "hi" or similar. Replies in whichever language the
// greeting itself was in, rather than always defaulting to one.
const GREETING_REPLY_EN =
  "Hi there! 👋 I'm Thanzi Coach. I can help with questions about nutrition and health — ask me something, send a barcode, or snap a photo of a nutrition label. What would you like help with today?";
const GREETING_REPLY_NY =
  "Muli bwanji! 👋 Ndine Thanzi Coach. Ndingakuthandizeni ndi mafunso okhudza zakudya ndi thanzi — mungandifunse funso, mutumize barcode, kapena mujambule chizindikiro cha zakudya (nutrition label). Kodi mukufuna chithandizo cha chiyani lero?";

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

async function handleTextMessage(userText, from, env) {
  const greetingLang = detectGreetingLanguage(userText);
  if (greetingLang) {
    await sendWhatsAppReply(from, greetingLang === "en" ? GREETING_REPLY_EN : GREETING_REPLY_NY, env);
    return;
  }

  if (looksLikeBarcode(userText)) {
    const barcode = userText.trim();
    const product = await lookupBarcode(barcode, env);
    if (product) {
      await sendWhatsAppReply(from, product, env);
      return;
    }
    // No product found for that barcode — fall through to rag/ask, which
    // can still respond helpfully (e.g. "I couldn't find that product").
  }

  const answer = await askChakudya(userText, from, env);
  await sendWhatsAppReply(from, answer, env);
}

async function handleImageMessage(image, from, env) {
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
    const product = await lookupBarcode(barcode, env);
    await sendWhatsAppReply(
      from,
      product ||
        `Ndawerenga barcode ${barcode}, koma sindinapeze mankhwala ake m'databasi. 🙏`,
      env
    );
    return;
  }

  const result = await scanPackagedLabel(base64, mimeType, env);
  await sendWhatsAppReply(from, result, env);
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
    return "Sindinathe kuwerenga zambiri pa chithunzichi. Chonde jambulani bwino chizindikiro cha zakudya (nutrition label) ndikutumizanso. 🙏";
  }
  if (isProviderUnavailable(res.status)) {
    console.error("Packaged scan provider unavailable:", res.status, await res.text());
    return LLM_BUSY_MESSAGE;
  }
  if (!res.ok) {
    throw new Error(`Packaged scan error: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  const result = formatFoodResult(body?.data);
  if (result && looksLikeLeakedProviderError(result)) {
    console.error("Packaged scan leaked a provider error:", result);
    return SUBREQUEST_LIMIT_MESSAGE;
  }
  return result || "Ndawerenga chithunzicho, koma sindinapeze zambiri zokwanira.";
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
  return item ? formatFoodResult(item) : null;
}

// Formats a Food/PackagedFood/external-lookup result (field names vary by
// source) into a short WhatsApp-friendly card.
function formatFoodResult(item) {
  if (!item) return null;
  const name = item.product_name || item.food_name || item.name;
  if (!name) return null;

  const brandName = item.brand || item.raw_data?.brands;
  const brand = brandName ? ` (${brandName})` : "";
  const measure = item.measure || item.raw_data?.quantity;
  const measureText = measure ? ` — ${measure}` : "";
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

// Nudges every answer to state the actual reference/serving amount (e.g.
// "185 g", "1 cup cooked") alongside any nutrient values, instead of a vague
// "per the reference amount shown" with no number attached to it.
function withReferenceAmountInstruction(query) {
  return `${query} (Always state the specific reference/serving amount — in grams, cups, or another concrete unit — for any nutrient values given, rather than referring to it without stating it.)`;
}

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
      query: withReferenceAmountInstruction(normalizeMultiTopicQuery(query)),
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
