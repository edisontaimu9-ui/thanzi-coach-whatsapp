/**
 * Verifies Meta's X-Hub-Signature-256 header on incoming WhatsApp webhooks.
 *
 * Meta signs the RAW request body with HMAC-SHA256 using the app's App Secret and sends
 * "sha256=<hex>". Without this check anyone who finds the worker URL can POST fake
 * messages (spending Groq/Chakudya quota, spoofing users). No fetch/env/D1 dependency,
 * so it's unit-testable under plain Node (see test/webhookSignature.test.js).
 */

const encoder = new TextEncoder();

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Constant-time byte comparison (no early exit on the first mismatch). */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Hex HMAC-SHA256 of `rawBody` under `secret`. Exported for tests. */
export async function computeSignatureHex(rawBody, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * True only if `signatureHeader` ("sha256=<hex>") is the correct signature of `rawBody`.
 * Missing/malformed header, missing secret, or any mismatch -> false.
 */
export async function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret || typeof signatureHeader !== "string") return false;
  const m = /^sha256=([0-9a-f]+)$/i.exec(signatureHeader.trim());
  if (!m) return false;
  const provided = hexToBytes(m[1]);
  const expected = hexToBytes(await computeSignatureHex(rawBody, secret));
  if (!provided || !expected) return false;
  return timingSafeEqual(provided, expected);
}
