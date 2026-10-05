/**
 * HTTP helpers: fetch with a timeout, bounded retry, and the Chakudya service-binding fetch.
 *
 * Split out of src/index.js with no behaviour change.
 */



// Default per-request timeout for outbound HTTP calls (Chakudya, Groq,
// WhatsApp Cloud API). Without this, a hung upstream stalls the request
// until the Worker's own wall-clock limit kills it with no clean error;
// with it, callers get a normal rejected promise at a predictable point,
// which the existing try/catch in handleIncomingMessage already turns
// into a friendly reply instead of a silent timeout.
const FETCH_TIMEOUT_MS = 10000;

export async function fetchWithTimeout(fetcher, input, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One retry (2 attempts total) after a short backoff, for a transient 5xx
// response or the request itself throwing (network blip, or the
// FETCH_TIMEOUT_MS abort above). Never retries a 4xx — that's a real
// client-side result (bad query, not found) and retrying would just waste
// a subrequest and return the same thing. Kept to a single retry to stay
// well inside Cloudflare's per-invocation subrequest ceiling, which is
// already tight on some multi-topic queries (see SUBREQUEST_LIMIT_MESSAGE).
// Used for Chakudya and Groq — read/analyze calls, safe to repeat when the
// first attempt didn't succeed. NOT used for WhatsApp Cloud API sends:
// retrying a send that actually went through server-side would double-
// message the user, which is worse than the occasional failed send.
const RETRY_BACKOFF_MS = 300;

export async function fetchWithRetry(fetcher, input, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    const res = await fetchWithTimeout(fetcher, input, init, timeoutMs);
    if (res.status >= 500 && res.status < 600) {
      await sleep(RETRY_BACKOFF_MS);
      return fetchWithTimeout(fetcher, input, init, timeoutMs);
    }
    return res;
  } catch (err) {
    await sleep(RETRY_BACKOFF_MS);
    return fetchWithTimeout(fetcher, input, init, timeoutMs);
  }
}

// Thin wrapper for CHAKUDYA_API service-binding calls (see wrangler.toml
// for why this is a binding, not a public fetch URL). Every Chakudya call
// site below uses this instead of env.CHAKUDYA_API.fetch directly so none
// of them can hang past FETCH_TIMEOUT_MS, and a transient 5xx gets one
// retry instead of surfacing straight to the user.
export function chakudyaFetch(env, path, init) {
  return fetchWithRetry(env.CHAKUDYA_API.fetch.bind(env.CHAKUDYA_API), path, init);
}
