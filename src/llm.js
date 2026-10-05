/**
 * Small Groq calls: translation, Chichewa localisation, and help-intent classification.
 *
 * Split out of src/index.js with no behaviour change.
 */

import { CHICHEWA_AI_NOTE, CHICHEWA_FALLBACK_NOTE, buildToChichewaMessages, cleanTranslation, translationPreservesFacts } from "./chichewa.js";
import { buildIntentMessages, parseIntentResponse } from "./intentClassifier.js";
import { fetchWithTimeout } from "./http.js";

// English answer -> Chichewa + an "AI-translated" note. If the translation fails or doesn't keep
// every number and [n] marker, the English answer is sent with a short Chichewa apology instead.
export async function localizeAnswer(englishMain, env) {
  const raw = await translateWithGroq(buildToChichewaMessages(englishMain), env, 25000);
  if (raw && translationPreservesFacts(englishMain, raw)) {
    return `${raw}\n\n${CHICHEWA_AI_NOTE}`;
  }
  if (raw) console.warn("Chichewa translation rejected (numbers/markers changed or bad length)");
  return `${CHICHEWA_FALLBACK_NOTE}\n\n${englishMain}`;
}

// One Groq chat call used for translation. Returns the cleaned text, or null on any failure.
export async function translateWithGroq(messages, env, timeoutMs) {
  if (!env.GROQ_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(
      fetch,
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          messages,
          temperature: 0.2,
          max_completion_tokens: 3000,
          reasoning_effort: "low",
        }),
      },
      timeoutMs
    );
    if (!res.ok) {
      console.error("Translation call error:", res.status);
      return null;
    }
    const body = await res.json();
    const text = cleanTranslation(body?.choices?.[0]?.message?.content);
    return text || null;
  } catch (err) {
    console.error("Translation call failed:", err?.message || err);
    return null;
  }
}

// One small, fast Groq call (no retry, short timeout) -> { intent: "menu"|"question", lang }.
export async function classifyHelpIntent(text, env) {
  const fallback = { intent: "question", lang: "en" };
  if (!env.GROQ_API_KEY) return fallback;
  try {
    const res = await fetchWithTimeout(
      fetch,
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b",
          messages: buildIntentMessages(text),
          temperature: 0,
          max_completion_tokens: 200,
          reasoning_effort: "low",
          response_format: { type: "json_object" },
        }),
      },
      4000
    );
    if (!res.ok) {
      console.error("Intent classifier error:", res.status);
      return fallback;
    }
    const body = await res.json();
    return parseIntentResponse(body?.choices?.[0]?.message?.content);
  } catch (err) {
    console.error("Intent classifier failed:", err?.message || err);
    return fallback;
  }
}
