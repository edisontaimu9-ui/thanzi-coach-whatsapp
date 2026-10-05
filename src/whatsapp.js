/**
 * WhatsApp Cloud API senders (text, typing, lists, buttons, link buttons) and media download.
 *
 * Split out of src/index.js with no behaviour change.
 */

import { IRON_NEEDS_SAMPLE_PROMPT, WEIGHT_NUTRITION_SAMPLE_PROMPT } from "./detectors.js";
import { SCREENING_MENU_ROW_ID } from "./screeningMenu.js";
import { ESTIMATE_MENU_ROW_ID } from "./estimateMenu.js";
import { fetchWithTimeout } from "./http.js";
import { getFoodItemName, normalizeFoodName, sourceLabel, splitForWhatsApp } from "./formatting.js";

// Single link-button message ("cta_url"): one button that opens `url`. display_text <= 20 chars.
export async function sendWhatsAppInteractiveCtaUrl(to, { body, displayText, url }, env) {
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
          type: "cta_url",
          body: { text: body },
          action: { name: "cta_url", parameters: { display_text: displayText, url } },
        },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`WhatsApp link-button send error: ${res.status} ${await res.text()}`);
  }
}

// Reply-button message (max 3 buttons; titles <= 20 chars, body <= 1024). Throws on a failed send;
// callers that must not fail (askForFeedback) catch it.
export async function sendWhatsAppInteractiveButtons(to, { body, buttons }, env) {
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
          type: "button",
          body: { text: body },
          action: {
            buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })),
          },
        },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`WhatsApp buttons send error: ${res.status} ${await res.text()}`);
  }
}

// WhatsApp media is two-step: first ask Graph API for a short-lived URL,
// then fetch the actual bytes from that URL (both calls need the same
// bearer token).
export async function downloadWhatsAppMedia(mediaId, env) {
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

// Marks the incoming message read and shows WhatsApp's native "typing..."
// bubble — see https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators.
// Requires Graph API v22.0+ (typing_indicator isn't recognized on the
// older v20.0 this file's other calls use, so this one call pins a newer
// version rather than bumping the shared one everywhere). Best-effort: a
// failure here should never block or fail the actual reply, so errors are
// logged and swallowed, not thrown.
export async function sendTypingIndicator(messageId, env) {
  try {
    const res = await fetchWithTimeout(
      fetch,
      `https://graph.facebook.com/v22.0/${env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
          typing_indicator: { type: "text" },
        }),
      },
      5000 // short timeout — this is a nice-to-have, never worth waiting long for
    );
    if (!res.ok) {
      console.error("Typing indicator error:", res.status, await res.text());
    }
  } catch (err) {
    console.error("Failed to send typing indicator:", err);
  }
}

export async function sendWhatsAppReply(to, text, env) {
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
  { id: IRON_NEEDS_SAMPLE_PROMPT, title: "Iron Needs" },
  { id: "Quinoa", title: "Look Up Any Food" },
  { id: WEIGHT_NUTRITION_SAMPLE_PROMPT, title: "Nutrition by Weight" },
  { id: SCREENING_MENU_ROW_ID, title: "Malnutrition Screening" },
  { id: ESTIMATE_MENU_ROW_ID, title: "Quick Calculators" }, // opens a weight/height/BMI/weight-change sub-menu — see ./estimateMenu.js
];

const PROMPT_EXAMPLES_NY = [
  { id: "Ndi zakudya ziti zomwe zili ndi iron wambiri?", title: "Zakudya za Iron" },
  { id: "Compare nsima, rice and potatoes", title: "Yerekezerani Zakudya" },
  { id: "Substitute for nsima", title: "Zam'malo mwa Nsima" },
  { id: "Exchange list for a diabetic patient", title: "Kudya kwa Shuga" },
  { id: IRON_NEEDS_SAMPLE_PROMPT, title: "Iron Yofunika Tsiku" },
  { id: "Quinoa", title: "Funsani Chakudya" },
  { id: WEIGHT_NUTRITION_SAMPLE_PROMPT, title: "Kulemera kwa Chakudya" },
  { id: SCREENING_MENU_ROW_ID, title: "Kuyeza Malnutrition" },
  { id: ESTIMATE_MENU_ROW_ID, title: "Quick Calculators" },
];

export async function sendPromptList(to, lang, env) {
  const isEnglish = lang === "en";
  const body = isEnglish
    ? "Hi there! 👋 I'm Thanzi Coach. I can answer nutrition questions, screen for malnutrition, run quick calculators (BMI, weight/height estimate), and read a barcode or nutrition label photo. Tap an example below, or just type whatever you need — any question, any way you like."
    : "Muli bwanji! 👋 Ndine Thanzi Coach. Sankhani chitsanzo pansipa, kapena lembani funso lanu lililonse nthawi ina iliyonse. Mutha kutumizanso barcode kapena chithunzi cha nutrition label.";
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

export async function sendWhatsAppInteractiveList(to, { body, buttonText, sections }, env) {
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
export async function sendFoodOptionsList(to, query, candidates, env) {
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
