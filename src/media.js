/**
 * Image messages: barcode decoding (zxing-wasm) and nutrition-label reading, plus audio transcription helpers.
 *
 * Split out of src/index.js with no behaviour change.
 */

import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import zxingReaderWasmModule from "zxing-wasm/dist/reader/zxing_reader.wasm";
import { downloadWhatsAppMedia, sendWhatsAppReply } from "./whatsapp.js";
import { lookupBarcode, scanPackagedLabel } from "./chakudyaClient.js";
import { saveLastFoodContext } from "./context.js";
import { toFoodContext } from "./formatting.js";
import { fetchWithRetry } from "./http.js";

export async function handleImageMessage(image, from, env, ctx) {
  const mediaId = image?.id;
  if (!mediaId) {
    await sendWhatsAppReply(
      from,
      "I received an image, but couldn't read it. Please try again. 🙏",
      env
    );
    return;
  }

  await sendWhatsAppReply(
    from,
    "Reading your image... one moment. 📷",
    env
  ).catch(() => {}); // best-effort progress ping; not fatal if it fails

  const { base64, bytes, mimeType } = await downloadWhatsAppMedia(mediaId, env);

  // Try reading it as a barcode first (fast, cheap, precise task). A local
  // ZXing decode runs first — free, instant, no image data leaves
  // Cloudflare — and only if that finds nothing do we fall back to the
  // Groq vision reader, which is slower/costlier but more forgiving of
  // blur, glare, or an off-angle shot.
  let barcode = await decodeBarcodeLocally(bytes);
  if (!barcode) {
    barcode = await readBarcodeFromImage(base64, mimeType, env);
  }

  if (barcode) {
    const found = await lookupBarcode(barcode, env);
    if (found) {
      await sendWhatsAppReply(from, found.text, env);
      ctx.waitUntil(saveLastFoodContext(from, toFoodContext(found.item), env));
      return;
    }

    // Barcode read fine, but this product isn't in Chakudya yet — this is
    // the actual "submit a new product" path: run the same nutrition-label
    // OCR pipeline used below for photos with no barcode, passing along
    // the barcode we already decoded so the submission is correctly keyed
    // to it. /packaged/scan inserts it into the review queue as
    // status="pending" — this is what lets ANY user grow the database via
    // WhatsApp, not just a one-off manual /packaged/submit call.
    const result = await scanPackagedLabel(base64, mimeType, env, barcode);
    const prefix = `I read barcode ${barcode}, but it's not in the database yet. `;
    await sendWhatsAppReply(from, prefix + result.text, env);
    if (result.context) ctx.waitUntil(saveLastFoodContext(from, result.context, env));
    return;
  }

  const result = await scanPackagedLabel(base64, mimeType, env);
  await sendWhatsAppReply(from, result.text, env);
  if (result.context) ctx.waitUntil(saveLastFoodContext(from, result.context, env));
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
export async function transcribeAudio(bytes, mimeType, env) {
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
  try {
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
  } catch (err) {
    // fetchWithRetry's own retry can still throw (e.g. two consecutive
    // network failures/timeouts) — that's not caught anywhere upstream of
    // this call, so without this it crashes the whole image handler
    // instead of falling open to the nutrition-label OCR path below.
    console.error("Groq barcode read failed:", err);
    return null; // fail open -> falls back to nutrition-label OCR
  }
}
