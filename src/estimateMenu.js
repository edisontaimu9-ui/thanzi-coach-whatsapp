/**
 * Tappable "what would you like to estimate?" menu for the two standalone
 * body-measurement estimate flows (weightEstimate.js, heightEstimate.js),
 * plus the one-row entry that leads to it from the greeting prompt list.
 *
 * WHY A SUB-MENU: the greeting list already sits at WhatsApp's 10-row cap
 * (see index.js's PROMPT_EXAMPLES_EN/NY), so a separate row for each
 * estimate flow doesn't fit. Instead the greeting list gets ONE row
 * (ESTIMATE_MENU_ROW_ID); tapping it (or typing "estimate a patient") shows
 * this menu, whose two rows each carry the full trigger phrase for one flow
 * — the exact same WEIGHT_ESTIMATE_SAMPLE_PROMPT / HEIGHT_ESTIMATE_SAMPLE_PROMPT
 * strings those flows already trigger on, so tapping a row is identical to
 * typing it.
 *
 * The row id is sent back to the bot verbatim when tapped and goes through
 * the normal text pipeline, so each id MUST trigger exactly its own flow —
 * test/estimateMenu.test.js enforces that, so the menu and the flow
 * triggers can't drift apart. ESTIMATE_MENU_ROW_ID itself is deliberately
 * worded WITHOUT "weight" or "height" next to a person word, so it can
 * never accidentally satisfy detectWeightEstimateTrigger or
 * detectHeightEstimateTrigger and get swallowed by one of them instead of
 * opening this menu.
 *
 * WhatsApp limits: row title <= 24 chars, row description <= 72, section
 * title <= 24, button label <= 20, list body <= 1024, rows <= 10 in total.
 */

import { WEIGHT_ESTIMATE_SAMPLE_PROMPT } from "./weightEstimate.js";
import { HEIGHT_ESTIMATE_SAMPLE_PROMPT } from "./heightEstimate.js";

/** Id of the single row added to the greeting prompt lists. Doubles as a phrase detectEstimateMenuRequest() accepts. */
export const ESTIMATE_MENU_ROW_ID = "Estimate weight or height";

export const ESTIMATE_MENU_BODY =
  "Estimate a measurement 📏⚖️\n\nFor a patient who can't be weighed or measured directly, which would " +
  'you like to estimate? Pick below, or just type it — for example "estimate weight for a patient". ' +
  "Reply *cancel* at any point to stop.";

export const ESTIMATE_MENU_BUTTON = "Choose one";
export const ESTIMATE_MENU_SECTION_TITLE = "What to estimate";

export const ESTIMATE_MENU_ROWS = [
  {
    id: WEIGHT_ESTIMATE_SAMPLE_PROMPT,
    title: "Weight",
    description: "From arm + calf circumference (65+), or knee height + race",
    flow: "weight",
  },
  {
    id: HEIGHT_ESTIMATE_SAMPLE_PROMPT,
    title: "Height",
    description: "From knee height, demi span, or ulna length",
    flow: "height",
  },
];

/** The rows as WhatsApp expects them (no internal `flow` field). */
export function estimateMenuSections() {
  return [
    {
      title: ESTIMATE_MENU_SECTION_TITLE,
      rows: ESTIMATE_MENU_ROWS.map(({ id, title, description }) => ({ id, title, description })),
    },
  ];
}

// Whole-message match only (after trimming and dropping trailing punctuation), so a real question
// like "how do I estimate a patient's weight" doesn't open the menu instead of answering it, and a
// phrase that already names weight or height (which the individual flows' own triggers handle) is
// deliberately left unmatched here.
const MENU_REQUEST_RE = new RegExp(
  "^(?:" +
    "estimate\\s+weight\\s+or\\s+height" +
    "|estimate\\s+height\\s+or\\s+weight" +
    "|(?:please\\s+)?estimate(?:\\s+(?:a|the))?\\s+patient(?:'s)?(?:\\s+measurements?)?" +
    "|(?:please\\s+)?estimate\\s+measurements?(?:\\s+for\\s+a\\s+patient)?" +
    ")$",
  "i"
);

/** True when the message is just a request to estimate something, without saying weight or height. */
export function detectEstimateMenuRequest(text) {
  const t = text.trim().replace(/[.!?\s]+$/, "").replace(/\s+/g, " ");
  return MENU_REQUEST_RE.test(t);
}
