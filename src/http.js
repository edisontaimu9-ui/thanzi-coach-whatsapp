/**
 * HTTP helpers: fetch with a timeout, bounded retry, and the Chakudya service-binding fetch.
 *
 * Split out of src/index.js with no behaviour change.
 */

import { isProviderUnavailable } from "./errors.js";



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

// ── One more try for "provider busy" answers ──
// fetchWithRetry (above) already retries a 5xx or a thrown request once after 300ms, which only helps
// with blips. A rate-limited (429) or briefly overloaded provider usually needs a couple of seconds,
// so askChakudya wraps its call in this: if the answer comes back 429/5xx, wait ~2s (or the server's
// Retry-After, capped at 3s) and ask exactly once more, quietly, before the person sees "busy".
// Skipped when the first try already took long (a hung request has used its time), so the person
// never waits through several slow attempts. Returns the final Response; callers keep their
// existing handling for a response that is still unavailable.
export const RAG_RETRY_DELAY_MS = 2000;
export const RAG_RETRY_MAX_WAIT_MS = 3000;
export const RAG_RETRY_MAX_ELAPSED_MS = 12000;

export async function retryOnceOnUnavailable(attempt, opts = {}) {
  const {
    delayMs = RAG_RETRY_DELAY_MS,
    maxElapsedMs = RAG_RETRY_MAX_ELAPSED_MS,
    isRetryable = isProviderUnavailable,
    now = Date.now,
    wait = sleep,
  } = opts;
  const started = now();
  let res;
  try {
    res = await attempt();
  } catch (err) {
    if (now() - started >= maxElapsedMs) throw err;
    console.warn("Chakudya request failed quickly, retrying once:", err?.message || err);
    await wait(delayMs);
    return attempt();
  }
  if (!isRetryable(res.status) || now() - started >= maxElapsedMs) return res;
  const retryAfter = Number(res.headers?.get?.("Retry-After"));
  const pause = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delayMs, RAG_RETRY_MAX_WAIT_MS);
  console.warn(`Chakudya answered ${res.status}, retrying once after ${pause}ms`);
  try { await res.body?.cancel?.(); } catch {}
  await wait(pause);
  return attempt();
}
