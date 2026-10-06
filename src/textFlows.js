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
import { clearAllScreeningSessions } from "./screeningShared.js";
import { detectUnder5ScreeningTrigger, handleUnder5ScreeningFlow } from "./under5Screening.js";
import { detectWeightChangeTrigger, handleWeightChangeFlow } from "./weightChangeCheck.js";
import { detectWeightEstimateTrigger, handleWeightEstimateFlow } from "./weightEstimate.js";
import { sendPromptList, sendWhatsAppInteractiveList, sendWhatsAppReply } from "./whatsapp.js";

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
    await sendWhatsAppReply(from, schoolAgeScreeningReply, env);
    return true;
  }

  const screeningReply = await handleUnder5ScreeningFlow(userText, from, env);
  if (screeningReply !== null) {
    topic.name = "screening";
    await sendWhatsAppReply(from, screeningReply, env);
    return true;
  }

  // Pregnant/postpartum malnutrition screening: same reasoning as above,
  // see ./pregnantPostpartumScreening.js. Uses a distinct trigger (requires
  // pregnant/postpartum/antenatal wording, not child/baby/infant) and a
  // distinct session kind, so the two flows never collide.
  const pregnantScreeningReply = await handlePregnantPostpartumScreeningFlow(userText, from, env);
  if (pregnantScreeningReply !== null) {
    topic.name = "screening";
    await sendWhatsAppReply(from, pregnantScreeningReply, env);
    return true;
  }

  // Adult (18+, not pregnant/postpartum) screening — see ./adultScreening.js. Checked AFTER the
  // pregnant flow because "a pregnant woman" also matches the adult flow's population words.
  const adultScreeningReply = await handleAdultScreeningFlow(userText, from, env);
  if (adultScreeningReply !== null) {
    topic.name = "screening";
    await sendWhatsAppReply(from, adultScreeningReply, env);
    return true;
  }

  // ASPEN refeeding syndrome risk follow-up, offered automatically after a severe/moderate adult
  // result above — see ./adultRefeedingRisk.js. No free-text trigger of its own: returns null
  // immediately unless that offer already started a session for this number.
  const refeedingRiskReply = await handleAdultRefeedingRiskFlow(userText, from, env);
  if (refeedingRiskReply !== null) {
    topic.name = "screening";
    await sendWhatsAppReply(from, refeedingRiskReply, env);
    return true;
  }

  // Weight estimate for a 65+ patient who can't be weighed — see ./weightEstimate.js. A standalone
  // calculator: its result is never used for malnutrition classification.
  const weightEstimateReply = await handleWeightEstimateFlow(userText, from, env);
  if (weightEstimateReply !== null) {
    topic.name = "calculator";
    await sendWhatsAppReply(from, weightEstimateReply, env);
    return true;
  }

  // Height (stature) estimate for a patient who can't be measured directly — see ./heightEstimate.js.
  // Also a standalone calculator: its result is never used for malnutrition classification.
  const heightEstimateReply = await handleHeightEstimateFlow(userText, from, env);
  if (heightEstimateReply !== null) {
    topic.name = "calculator";
    await sendWhatsAppReply(from, heightEstimateReply, env);
    return true;
  }

  // Quick BMI check (weight + height -> WHO 2000 / Malawi NCST 2015 classification), with no
  // screening attached — see ./bmiCheck.js.
  const bmiCheckReply = await handleBmiCheckFlow(userText, from, env);
  if (bmiCheckReply !== null) {
    topic.name = "calculator";
    await sendWhatsAppReply(from, bmiCheckReply, env);
    return true;
  }

  // Quick percent weight change check (current + usual weight, optional time frame) — see
  // ./weightChangeCheck.js.
  const weightChangeReply = await handleWeightChangeFlow(userText, from, env);
  if (weightChangeReply !== null) {
    topic.name = "calculator";
    await sendWhatsAppReply(from, weightChangeReply, env);
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
