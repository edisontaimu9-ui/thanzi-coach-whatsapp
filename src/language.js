/**
 * Remembered reply language per person ("en" | "ny" = Chichewa).
 *
 * Short or ambiguous messages ("nsima", "yes", "and for children?") carry no language signal of
 * their own, so the reply language follows what the person has been writing. Rules:
 *   - A clearly Chichewa message switches to Chichewa immediately.
 *   - A Chichewa user needs TWO clearly English messages in a row to switch back (one stray English
 *     message doesn't flip them); ambiguous messages never change anything.
 *   - An explicit choice ("English" / "Chichewa" / "Yankhani mu Chichewa") is locked and always wins.
 *   - Within a single message, a clear signal beats the stored preference (an English question gets
 *     an English reply even from a Chichewa user), unless the choice is locked.
 *
 * Pure logic + D1 helpers that never throw (no database = no memory, never an error shown).
 * Unit-tested in test/language.test.js.
 */

import { chichewaScore, isChichewaMessage } from "./chichewa.js";

const EN_STREAK_TO_SWITCH = 2;

export const EMPTY_STATE = Object.freeze({ language: null, locked: false, en_streak: 0 });

/** "ny" for Chichewa, "en" for clearly English (4+ words, no Chichewa words), else null (unclear). */
export function classifyMessageLanguage(text) {
  if (isChichewaMessage(text)) return "ny";
  const { strong, weak, total } = chichewaScore(text);
  if (total >= 4 && strong + weak === 0) return "en";
  return null;
}

/** Language to reply in for this message given the stored state. */
export function resolveLanguage(text, state) {
  if (state?.locked && state.language) return state.language;
  return classifyMessageLanguage(text) || state?.language || "en";
}

/** New state after observing this message. Locked states never change. */
export function nextLanguageState(state, text) {
  const cur = { ...EMPTY_STATE, ...(state || {}) };
  if (cur.locked) return cur;
  const seen = classifyMessageLanguage(text);
  if (seen === "ny") return { language: "ny", locked: false, en_streak: 0 };
  if (seen === "en") {
    if (cur.language !== "ny") return { language: "en", locked: false, en_streak: 0 };
    const streak = cur.en_streak + 1;
    return streak >= EN_STREAK_TO_SWITCH
      ? { language: "en", locked: false, en_streak: 0 }
      : { language: "ny", locked: false, en_streak: streak };
  }
  return cur;
}

const EN_CMD = /^(?:(?:please\s+)?(?:reply|answer|respond|speak|talk|write|use|switch(?:\s+to)?|change(?:\s+to)?)\s+(?:in\s+|to\s+)?english|in\s+english|english|yankhani\s+mu\s+chingerezi|mu\s+chingerezi|chingerezi)(?:\s+(?:please|chonde))?$/;
const NY_CMD = /^(?:(?:please\s+)?(?:reply|answer|respond|speak|talk|write|use|switch(?:\s+to)?|change(?:\s+to)?)\s+(?:in\s+|to\s+)?(?:chichewa|chinyanja|nyanja)|in\s+(?:chichewa|chinyanja|nyanja)|chichewa|chinyanja|yankhani\s+mu\s+chichewa|mu\s+chichewa)(?:\s+(?:please|chonde))?$/;

/** "en" | "ny" when the whole message is an explicit language switch, else null. */
export function detectLanguageCommand(text) {
  const t = String(text || "").trim().toLowerCase().replace(/[!?.,;:]+$/g, "").replace(/\s+/g, " ");
  if (EN_CMD.test(t)) return "en";
  if (NY_CMD.test(t)) return "ny";
  return null;
}

/** Confirmation after an explicit switch (mentions how to switch back). */
export function languageConfirmation(lang) {
  return lang === "ny"
    ? "✅ Ndiyankha mu Chichewa. Lembani *English* nthawi iliyonse kuti musinthe."
    : "✅ I'll reply in English. Type *Chichewa* any time to switch.";
}

// ── D1 ──

/** { language, locked, en_streak } or null when unknown / on error. */
export async function getLanguageState(db, whatsappId) {
  if (!db || !whatsappId) return null;
  try {
    const row = await db
      .prepare(`SELECT language, locked, en_streak FROM user_language WHERE whatsapp_id = ?1`)
      .bind(whatsappId)
      .first();
    if (!row || (row.language !== "en" && row.language !== "ny")) return null;
    return { language: row.language, locked: Number(row.locked) === 1, en_streak: Number(row.en_streak) || 0 };
  } catch (err) {
    console.error("Language read failed:", err);
    return null;
  }
}

/** Upserts the state. Returns true if written. */
export async function saveLanguageState(db, whatsappId, state, nowMs = Date.now()) {
  if (!db || !whatsappId || (state?.language !== "en" && state?.language !== "ny")) return false;
  try {
    await db
      .prepare(
        `INSERT INTO user_language (whatsapp_id, language, locked, en_streak, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(whatsapp_id) DO UPDATE SET language = ?2, locked = ?3, en_streak = ?4, updated_at = ?5`
      )
      .bind(whatsappId, state.language, state.locked ? 1 : 0, state.en_streak || 0, new Date(nowMs).toISOString())
      .run();
    return true;
  } catch (err) {
    console.error("Language save failed:", err);
    return false;
  }
}

/** Observes a message and saves the new state only if it changed. */
export async function learnLanguage(db, whatsappId, previous, text) {
  const next = nextLanguageState(previous, text);
  const prev = { ...EMPTY_STATE, ...(previous || {}) };
  if (next.language === prev.language && next.locked === prev.locked && next.en_streak === prev.en_streak) return false;
  if (!next.language) return false;
  return saveLanguageState(db, whatsappId, next);
}

// ── Env-aware helpers (moved from src/index.js) ──

// Plain small-talk (greetings, "how are you", thanks, bye) doesn't need
// Chakudya's nutrition retrieval at all — routing it through /rag/ask just
// burns a request and comes back with an odd, citation-laden answer to a
// question that was never really about food/health data. Handled with an
// instant tappable prompt list instead (see sendPromptList), matched on the
// whole message (trimmed, punctuation stripped) so it doesn't misfire on a
// real question that merely starts with "hi" or similar. Replies in
// whichever language the greeting itself was in. See detectGreetingLanguage
// in ./detectors.js.

// True when replies to this person should be in Chichewa: a clear signal in `text` wins, otherwise
// the remembered language (see ./language.js). Used by the notice/feedback paths that don't already
// hold the language state.
export async function isChichewaFor(env, from, text) {
  if (!chichewaRepliesEnabled(env)) return false;
  return resolveLanguage(text, await getLanguageState(env.DB, from)) === "ny";
}

// Replies are pure English by default. Chichewa questions are still UNDERSTOOD (translated to
// English before searching), but the bot only answers in Chichewa — menus, notices, buttons and
// translated answers — when the Worker variable CHICHEWA_REPLIES is set to "on".
export function chichewaRepliesEnabled(env) {
  return String(env.CHICHEWA_REPLIES || "").toLowerCase() === "on";
}
