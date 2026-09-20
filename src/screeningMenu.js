/**
 * Tappable "who do you want to screen?" menu for the four malnutrition
 * screening flows, plus the one-row entry that leads to it from the greeting
 * prompt list.
 *
 * WHY A SUB-MENU: WhatsApp interactive lists allow at most 10 rows in total.
 * The greeting list already has 8, so the four screening triggers can't all
 * sit in it. Instead the greeting list gets ONE row (SCREENING_MENU_ROW_ID);
 * tapping it (or typing "malnutrition screening") shows this menu, whose four
 * rows each carry a full trigger phrase for one flow.
 *
 * Every row id is sent back to the bot verbatim when tapped and goes through
 * the normal text pipeline, so each id MUST trigger exactly its own flow —
 * test/screeningMenu.test.js enforces that, so the menu and the flow triggers
 * can't drift apart.
 *
 * WhatsApp limits: row title <= 24 chars, row description <= 72, section
 * title <= 24, button label <= 20, list body <= 1024, rows <= 10 in total.
 */

/** Id of the single row added to the greeting prompt lists. Doubles as a phrase detectScreeningMenuRequest() accepts. */
export const SCREENING_MENU_ROW_ID = "Malnutrition screening";

export const SCREENING_MENU_BODY =
  "Malnutrition screening 🩺\n\nWho would you like to screen? Pick a group below, or just type it — " +
  'for example "screen an adult for malnutrition". Reply *cancel* at any point during a screening to stop.';

export const SCREENING_MENU_BUTTON = "Choose a group";
export const SCREENING_MENU_SECTION_TITLE = "Who to screen";

export const SCREENING_MENU_ROWS = [
  {
    id: "Screen a child for malnutrition",
    title: "Child under 5",
    description: "0–59 months: MUAC, growth z-scores, oedema",
    flow: "under5",
  },
  {
    id: "Screen a school child for malnutrition",
    title: "School-age (5-17)",
    description: "BMI-for-age, MUAC, oedema",
    flow: "school",
  },
  {
    id: "Screen an adult for malnutrition",
    title: "Adult (18+)",
    description: "Men and non-pregnant women, incl. older adults",
    flow: "adult",
  },
  {
    id: "Screen a pregnant woman for malnutrition",
    title: "Pregnant / postpartum",
    description: "MUAC, oedema, weight loss",
    flow: "pregnant",
  },
];

/** The rows as WhatsApp expects them (no internal `flow` field). */
export function screeningMenuSections() {
  return [
    {
      title: SCREENING_MENU_SECTION_TITLE,
      rows: SCREENING_MENU_ROWS.map(({ id, title, description }) => ({ id, title, description })),
    },
  ];
}

// Whole-message match only (after trimming and dropping trailing punctuation), so questions like
// "what is malnutrition screening?" or "how do I screen for malnutrition in children" don't open the menu.
const MENU_REQUEST_RE = new RegExp(
  "^(?:" +
    "(?:please\\s+)?(?:(?:do|start|begin|run|open|show)\\s+)?(?:(?:a|the|me)\\s+)?(?:malnutrition|nutrition(?:al)?|muac)\\s+screening(?:\\s+(?:menu|options|types))?" +
    "|(?:please\\s+)?screen(?:ing)?\\s+(?:for\\s+)?malnutrition" +
    "|(?:please\\s+)?(?:check|test)\\s+(?:for\\s+)?malnutrition" +
    ")$",
  "i"
);

/** True when the message is just a request to start malnutrition screening, without saying who. */
export function detectScreeningMenuRequest(text) {
  const t = text.trim().replace(/[.!?\s]+$/, "").replace(/\s+/g, " ");
  return MENU_REQUEST_RE.test(t);
}
