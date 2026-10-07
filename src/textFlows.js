/**
 * Text routing, part 1: guided flows, tappable menus, bare greetings.
 *
 * Split out of handleTextMessage in src/index.js with no behaviour change: each handler gets the
 * shared routing context `c` ({ userText, from, env, ctx, opts, topic, langState, lang,
 * repliesInChichewa }) and returns true when it handled (replied to) the message.
 */

import { handleAdultRefeedingRiskFlow } from "./adultRefeedingRisk.js";
import { detectAdultScreeningTrigger, handleAdultScreeningFlow } from "./adultScreening.js";
import { detectBmiCheckTrigger, handleBmiCheckFlow } from "./bmiCheck.js";
import { isBareCancel, parseGreeting } from "./detectors.js";
import { ESTIMATE_MENU_BODY, ESTIMATE_MENU_BUTTON, detectEstimateMenuRequest, estimateMenuSections } from "./estimateMenu.js";
import { detectHeightEstimateTrigger, handleHeightEstimateFlow } from "./heightEstimate.js";
import { detectPregnantPostpartumScreeningTrigger, handlePregnantPostpartumScreeningFlow } from "./pregnantPostpartumScreening.js";
import { detectSchoolAgeScreeningTrigger, handleSchoolAgeScreeningFlow } from "./schoolAgeScreening.js";
import { SCREENING_MENU_BODY, SCREENING_MENU_BUTTON, detectScreeningMenuRequest, screeningMenuSections } from "./screeningMenu.js";
import { askForFeedback } from "./feedbackFlow.js";
import { shouldAskFeedback } from "./feedback.js";
import { clearAllScreeningSessions, isCancel, loadSession } from "./screeningShared.js";
import { detectUnder5ScreeningTrigger, handleUnder5ScreeningFlow } from "./under5Screening.js";
import { detectWeightChangeTrigger, handleWeightChangeFlow } from "./weightChangeCheck.js";
import { detectWeightEstimateTrigger, handleWeightEstimateFlow } from "./weightEstimate.js";
import { sendPromptList, sendWhatsAppInteractiveList, sendWhatsAppReply } from "./whatsapp.js";

const SCREENING_DETAILS =
  "Uses WHO growth standards and Malawi national nutrition guidelines through the Chakudya server. A screening aid only, not a diagnosis. Please send anyone who looks unwell to a health facility.";
const CALCULATOR_DETAILS = {
  bmi_check: "BMI is classified with published reference tables (WHO / national for adults, WHO BMI-for-age for children). Reference only, not a substitute for a full nutrition assessment.",
  weight_estimate: "Estimated from body measurements with published equations in the Chakudya server. This estimate is never used for malnutrition classification.",
  height_estimate: "Estimated from body measurements with published equations in the Chakudya server. This estimate is never used for malnutrition classification.",
  weight_change_check: "Percent weight change and its significance come from a hospital dietetics anthropometry guideline in the Chakudya server. Reference only, not a substitute for individual clinical assessment.",
  adult_refeeding_risk: "ASPEN consensus criteria for refeeding syndrome risk (expert consensus). Not a substitute for individual clinical assessment.",
};

// Sends a guided-flow reply. When the flow has just finished (its session is gone and the person did not
// cancel) the reply is a RESULT, so the 👍/👎/Share/See details buttons follow it; mid-flow questions and
// "please send a number" prompts never get them. The session check runs after the reply is sent.
async function sendFlowReply(c, reply, kind, details) {
  const { from, env, ctx, userText, lang } = c;
  await sendWhatsAppReply(from, reply, env);
  if (!shouldAskFeedback(reply) || isCancel(userText)) return;
  const task = (async () => {
    if (await loadSession(kind, from, env)) return;
    await askForFeedback(from, userText, reply, "", env, lang === "ny", details);
  })().catch((err) => console.error("flow feedback failed:", err));
  if (ctx?.waitUntil) ctx.waitUntil(task);
}

/** Multi-turn guided flows (screenings and calculators). Returns true when the message was handled. */
export async function handleGuidedFlows(c) {
  const { userText, from, env, topic } = c;

  // Under-5 malnutrition screening: multi-turn structured intake (see
  // ./under5Screening.js). Checked first, both to continue an in-progress
  // session (a bare "12" or "yes" mid-flow must never be swallowed by
  // food/greeting detection below) and so the trigger phrase for starting
  // a new session wins over every other detector.
  //
  // Four screening flows now exist (school-age, under-5, pregnant/postpartum, adult), each with its
  // own session kind. A fresh trigger phrase for ANY of them first discards half-finished sessions
  // of the others, so an abandoned flow can never swallow the new request as if it were an answer.
  if (
    detectSchoolAgeScreeningTrigger(userText) ||
    detectUnder5ScreeningTrigger(userText) ||
    detectPregnantPostpartumScreeningTrigger(userText) ||
    detectAdultScreeningTrigger(userText) ||
    detectWeightEstimateTrigger(userText) ||
    detectHeightEstimateTrigger(userText) ||
    detectBmiCheckTrigger(userText) ||
    detectWeightChangeTrigger(userText) ||
    detectEstimateMenuRequest(userText) ||
    detectScreeningMenuRequest(userText)
  ) {
    await clearAllScreeningSessions(from, env);
  }

  // School-age/adolescent (5-17y) screening — see ./schoolAgeScreening.js. Checked BEFORE under-5
  // because "school child" also contains the word "child".
  const schoolAgeScreeningReply = await handleSchoolAgeScreeningFlow(userText, from, env);
  if (schoolAgeScreeningReply !== null) {
    topic.name = "screening";
    await sendFlowReply(c, schoolAgeScreeningReply, "school_age_screening", SCREENING_DETAILS);
    return true;
  }

  const screeningReply = await handleUnder5ScreeningFlow(userText, from, env);
  if (screeningReply !== null) {
    topic.name = "screening";
    await sendFlowReply(c, screeningReply, "under5_screening", SCREENING_DETAILS);
    return true;
  }

  // Pregnant/postpartum malnutrition screening: same reasoning as above,
  // see ./pregnantPostpartumScreening.js. Uses a distinct trigger (requires
  // pregnant/postpartum/antenatal wording, not child/baby/infant) and a
  // distinct session kind, so the two flows never collide.
  const pregnantScreeningReply = await handlePregnantPostpartumScreeningFlow(userText, from, env);
  if (pregnantScreeningReply !== null) {
    topic.name = "screening";
    await sendFlowReply(c, pregnantScreeningReply, "pregnant_postpartum_screening", SCREENING_DETAILS);
    return true;
  }

  // Adult (18+, not pregnant/postpartum) screening — see ./adultScreening.js. Checked AFTER the
  // pregnant flow because "a pregnant woman" also matches the adult flow's population words.
  const adultScreeningReply = await handleAdultScreeningFlow(userText, from, env);
  if (adultScreeningReply !== null) {
    topic.name = "screening";
    await sendFlowReply(c, adultScreeningReply, "adult_screening", SCREENING_DETAILS);
    return true;
  }

  // ASPEN refeeding syndrome risk follow-up, offered automatically after a severe/moderate adult
  // result above — see ./adultRefeedingRisk.js. No free-text trigger of its own: returns null
  // immediately unless that offer already started a session for this number.
  const refeedingRiskReply = await handleAdultRefeedingRiskFlow(userText, from, env);
  if (refeedingRiskReply !== null) {
    topic.name = "screening";
    await sendFlowReply(c, refeedingRiskReply, "adult_refeeding_risk", CALCULATOR_DETAILS.adult_refeeding_risk);
    return true;
  }

  // Weight estimate for a 65+ patient who can't be weighed — see ./weightEstimate.js. A standalone
  // calculator: its result is never used for malnutrition classification.
  const weightEstimateReply = await handleWeightEstimateFlow(userText, from, env);
  if (weightEstimateReply !== null) {
    topic.name = "calculator";
    await sendFlowReply(c, weightEstimateReply, "weight_estimate", CALCULATOR_DETAILS.weight_estimate);
    return true;
  }

  // Height (stature) estimate for a patient who can't be measured directly — see ./heightEstimate.js.
  // Also a standalone calculator: its result is never used for malnutrition classification.
  const heightEstimateReply = await handleHeightEstimateFlow(userText, from, env);
  if (heightEstimateReply !== null) {
    topic.name = "calculator";
    await sendFlowReply(c, heightEstimateReply, "height_estimate", CALCULATOR_DETAILS.height_estimate);
    return true;
  }

  // Quick BMI check (weight + height -> WHO 2000 / Malawi NCST 2015 classification), with no
  // screening attached — see ./bmiCheck.js.
  const bmiCheckReply = await handleBmiCheckFlow(userText, from, env);
  if (bmiCheckReply !== null) {
    topic.name = "calculator";
    await sendFlowReply(c, bmiCheckReply, "bmi_check", CALCULATOR_DETAILS.bmi_check);
    return true;
  }

  // Quick percent weight change check (current + usual weight, optional time frame) — see
  // ./weightChangeCheck.js.
  const weightChangeReply = await handleWeightChangeFlow(userText, from, env);
  if (weightChangeReply !== null) {
    topic.name = "calculator";
    await sendFlowReply(c, weightChangeReply, "weight_change_check", CALCULATOR_DETAILS.weight_change_check);
    return true;
  }

  return false;
}

/** Tappable menus, bare cancel, and bare greetings / generic help. Returns true when handled. */
export async function handleMenusAndGreeting(c) {
  const { userText, from, env, topic, langState, lang, repliesInChichewa } = c;

  // "quick calculators" with none of the four named (typed, or tapped from the greeting list's
  // "Quick calculators" row): show the tappable which-calculator menu. See ./estimateMenu.js.
  if (detectEstimateMenuRequest(userText)) {
    topic.name = "calculator";
    await sendWhatsAppInteractiveList(
      from,
      { body: ESTIMATE_MENU_BODY, buttonText: ESTIMATE_MENU_BUTTON, sections: estimateMenuSections() },
      env
    );
    return true;
  }

  // "malnutrition screening" with no population named (typed, or tapped from the greeting list's
  // "Malnutrition screening" row): show the tappable who-to-screen menu. See ./screeningMenu.js.
  if (detectScreeningMenuRequest(userText)) {
    topic.name = "screening";
    await sendWhatsAppInteractiveList(
      from,
      { body: SCREENING_MENU_BODY, buttonText: SCREENING_MENU_BUTTON, sections: screeningMenuSections() },
      env
    );
    return true;
  }

  // Bare greeting ("hi", "good morning Thanzi") or a generic "I want help on Thanzi" with no topic:
  // show the tappable menu. Anything with a real question after the greeting was stripped above.
  if (isBareCancel(userText)) {
    topic.name = "menu";
    // Active flows handle their own "cancel" above; reaching here means nothing was in progress.
    await sendWhatsAppReply(from, "There's nothing to cancel right now. Type *menu* to see what I can do. 🙏", env);
    return true;
  }
  const greeting = parseGreeting(userText);
  if (greeting && !greeting.rest) {
    topic.name = "menu";
    const menuLang = !repliesInChichewa ? "en" : langState?.locked ? langState.language : greeting.lang === "ny" ? "ny" : lang;
    await sendPromptList(from, menuLang, env);
    return true;
  }

  return false;
}
