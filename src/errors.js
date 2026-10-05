/**
 * Provider/limit error detection and the canned messages askChakudya returns for them.
 *
 * Split out of src/index.js with no behaviour change.
 */



// Cloudflare throws this (not an HTTP status — a runtime exception) when a
// single Worker invocation makes too many outbound fetch() calls, e.g. a
// query that fans out across several internal Chakudya lookups. Detected by
// message text since Cloudflare doesn't give it a distinct error type.
export const SUBREQUEST_LIMIT_MESSAGE =
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
export function looksLikeLeakedProviderError(text) {
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
export const LLM_BUSY_MESSAGE = "Sorry, Thanzi Coach is temporarily busy. Please try again in a moment.";

export function isProviderUnavailable(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}
