/**
 * Thanzi Coach — WhatsApp Cloud API bridge
 *
 * Flow:
 *   1. Meta sends webhook verification (GET) once when you register the webhook URL.
 *   2. Meta POSTs incoming messages here whenever someone messages +265 886 29 53 24.
 *   3. We extract the text, call Chakudya API's /rag/ask endpoint.
 *   4. We send the answer back to the user via the WhatsApp Cloud API.
 *
 * Required secrets (set with `wrangler secret put <NAME>` — never hardcode these):
 *   WHATSAPP_TOKEN         - Meta permanent/system-user access token
 *   VERIFY_TOKEN           - a string you invent; must match what you enter in
 *                            Meta App Dashboard > WhatsApp > Configuration > Webhook
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
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/webhook") {
      return handleVerification(url, env);
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleIncomingMessage(request, env);
    }

    return new Response("Thanzi Coach webhook is running.", { status: 200 });
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
async function handleIncomingMessage(request, env) {
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

  if (!message || message.type !== "text") {
    return new Response("OK", { status: 200 }); // ack, nothing to do
  }

  const from = message.from; // sender's WhatsApp number
  const userText = message.text.body;

  try {
    const answer = await askChakudya(userText, from, env);
    await sendWhatsAppReply(from, answer, env);
  } catch (err) {
    console.error("Thanzi Coach error:", err);
    await sendWhatsAppReply(
      from,
      "Pepani, pali vuto pakadali pano. Yesaninso pambuyo pa mphindi zochepa. 🙏",
      env
    ).catch(() => {}); // best-effort; don't crash the webhook ack
  }

  // Always 200 quickly — Meta retries aggressively on non-200/timeout
  return new Response("OK", { status: 200 });
}

async function askChakudya(query, fromNumber, env) {
  // Service binding call — internal Worker-to-Worker, not a public fetch.
  // See wrangler.toml for why (avoids Cloudflare error 1042).
  const res = await env.CHAKUDYA_API.fetch("https://chakudya-api/rag/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      context: "both",
      top_k: 6,
      // Using the sender's WhatsApp number as session_id gives each user
      // their own Thandizo memory thread across conversations.
      session_id: `whatsapp-${fromNumber}`,
    }),
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") || "a minute";
    return `Ndikulandila mafunso ambiri pakadali pano. Chonde yesaninso pambuyo pa ${retryAfter}s. 🙏`;
  }

  if (!res.ok) {
    throw new Error(`Chakudya API error: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  const answer = body?.data?.answer;
  return markdownToWhatsApp(
    answer || "Pepani, sindinapeze yankho pa funso limeneli."
  );
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
    .replace(/^[-*]\s+/gm, "• ");
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

async function sendWhatsAppReply(to, text, env) {
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
        text: { body: text },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`WhatsApp send error: ${res.status} ${await res.text()}`);
  }
}
