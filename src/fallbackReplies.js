/**
 * Helpful replies for when answering fails (Chakudya slow/down, rate limited, timeouts, bugs),
 * instead of a bare "Sorry, something went wrong". Each reply says what happened in plain words,
 * tells the person what to do next, echoes their question so they can resend it in one tap, and
 * points to "menu". Chichewa when the message looks Chichewa.
 *
 * Pure helpers (no fetch/env), unit-tested in test/fallbackReplies.test.js.
 */

import { isChichewaMessage } from "./chichewa.js";

/** "limit" (question too big for one call), "busy" (upstream slow/down/rate-limited), or "error". */
export function classifyFailure(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  if (msg.includes("too many subrequests") || msg.includes("too many api requests")) return "limit";
  if (
    err?.name === "AbortError" ||
    /abort|timeout|timed out|fetch failed|network|temporarily busy|chakudya api error: (?:429|5\d\d)|service unavailable|overloaded/.test(msg)
  ) {
    return "busy";
  }
  return "error";
}

/** True when the text looks Chichewa (or a Chichewa/English mix). See ./chichewa.js. */
export function looksChichewa(text) {
  return isChichewaMessage(text);
}

function echo(text, lang) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t || t.length < 3) return "";
  const short = t.length > 80 ? t.slice(0, 77) + "…" : t;
  return lang === "ny" ? `\n\nFunso lanu: “${short}”` : `\n\nYour question: “${short}”`;
}

const REPLIES = {
  en: {
    busy:
      "⏳ The nutrition database is busy right now, so I couldn't answer that. Nothing is lost — please send it again in a minute." +
      "\n\nThe BMI, energy-needs and % weight-change calculators still work. Type *menu* for options.",
    limit:
      "That question is too big to answer in one go. Please split it up and ask about one food or topic at a time." +
      "\n\nType *menu* for examples.",
    error:
      "Sorry, I ran into a problem answering that. Please try again, or ask it a different way (one food or one topic works best)." +
      "\n\nType *menu* for options.",
  },
  ny: {
    busy:
      "⏳ Nkhokwe ya zakudya ili otanganidwa pakali pano, choncho sindinathe kuyankha. Palibe chomwe chatayika — chonde tumizaninso patatha mphindi imodzi." +
      "\n\nZowerengera za BMI ndi mphamvu ya thupi zikugwirabe ntchito. Lembani *menu* kuti muone zosankha.",
    limit:
      "Funsoli ndi lalikulu kwambiri. Chonde ligawireni, mufunse za chakudya chimodzi kapena mutu umodzi nthawi imodzi." +
      "\n\nLembani *menu* kuti muone zitsanzo.",
    error:
      "Pepani, pali vuto pakuyankha funsoli. Chonde yesaninso, kapena mufunse m'njira ina (chakudya chimodzi kapena mutu umodzi zimagwira bwino)." +
      "\n\nLembani *menu* kuti muone zosankha.",
  },
};

/** Builds the reply for a failure `kind` ("busy" | "limit" | "error"), echoing the person's text. `forcedLang` ("en" | "ny") overrides detection, e.g. the remembered language. */
export function buildFailureReply(kind, userText, forcedLang) {
  const lang = forcedLang === "ny" || forcedLang === "en" ? forcedLang : looksChichewa(userText) ? "ny" : "en";
  const k = REPLIES[lang][kind] ? kind : "error";
  const withEcho = k === "limit" ? "" : echo(userText, lang);
  return REPLIES[lang][k] + withEcho;
}
