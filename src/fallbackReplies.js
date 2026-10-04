/**
 * Helpful replies for when answering fails (Chakudya slow/down, rate limited, timeouts, bugs),
 * instead of a bare "Sorry, something went wrong". Each reply says what happened in plain words,
 * tells the person what to do next, echoes their question so they can resend it in one tap, and
 * points to "menu". Chichewa when the message looks Chichewa.
 *
 * Pure helpers (no fetch/env), unit-tested in test/fallbackReplies.test.js.
 */

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

// Common Chichewa words/greetings; two hits (or one very distinctive one) marks a message as Chichewa.
const CHICHEWA_STRONG = /\b(?:ndikufuna|ndifuna|ndithandizeni|thandizo|zakudya|chakudya|mungandithandize|muli\s+bwanji|zikomo|ndili|funso|mafunso|bwanji|nsima\s+ndi|ndi\s+zakudya|kodi)\b/i;
const CHICHEWA_WEAK = /\b(?:ndi|ya|za|wa|pa|kwa|mu|ku|ali|ndani|chiyani|ziti|ndingathe|ndingatani)\b/gi;

export function looksChichewa(text) {
  const t = String(text || "");
  if (CHICHEWA_STRONG.test(t)) return true;
  return (t.match(CHICHEWA_WEAK) || []).length >= 2;
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

/** Builds the reply for a failure `kind` ("busy" | "limit" | "error"), echoing the person's text. */
export function buildFailureReply(kind, userText) {
  const lang = looksChichewa(userText) ? "ny" : "en";
  const k = REPLIES[lang][kind] ? kind : "error";
  const withEcho = k === "limit" ? "" : echo(userText, lang);
  return REPLIES[lang][k] + withEcho;
}
