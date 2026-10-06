/**
 * Text routing, part 4: help-intent fallback and the final nutrition-search answer.
 *
 * Split out of handleTextMessage in src/index.js with no behaviour change: each handler gets the
 * shared routing context `c` ({ userText, from, env, ctx, opts, topic, langState, lang,
 * repliesInChichewa }) and returns true when it handled (replied to) the message.
 */

import { askChakudya } from "./chakudyaClient.js";
import { buildToEnglishMessages, isChichewaMessage } from "./chichewa.js";
import { LLM_BUSY_MESSAGE, SUBREQUEST_LIMIT_MESSAGE } from "./errors.js";
import { buildFailureReply } from "./fallbackReplies.js";
import { shouldAskFeedback, splitReferences } from "./feedback.js";
import { askForFeedback } from "./feedbackFlow.js";
import { shouldClassifyIntent } from "./intentClassifier.js";
import { classifyHelpIntent, localizeAnswer, translateWithGroq } from "./llm.js";
import { sendPromptList, sendWhatsAppReply } from "./whatsapp.js";

/** AI fallback for help-shaped messages the regex detectors missed: shows the menu. Returns true when handled. */
export async function handleHelpIntent(c) {
  const { userText, from, env, topic, langState, lang, repliesInChichewa } = c;

  // Last stop before nutrition search: a short, help-shaped message the regex detectors missed
  // ("could somebody assist me pls") gets one tiny LLM call to decide menu vs real question.
  // Any failure returns "question", so this can only ever ADD the menu, never block an answer.
  // See ./intentClassifier.js.
  if (shouldClassifyIntent(userText)) {
    const { intent, lang: classifiedLang } = await classifyHelpIntent(userText, env);
    if (intent === "menu") {
      topic.name = "menu";
      const menuLang = !repliesInChichewa ? "en" : langState?.locked ? langState.language : classifiedLang === "ny" ? "ny" : lang;
      await sendPromptList(from, menuLang, env);
      return true;
    }
  }

  return false;
}

/** The final stop: nutrition search (with Chichewa understanding), the answer, and the follow-up buttons. */
export async function answerQuestion(c) {
  const { userText, from, env, ctx, topic, lang } = c;

  // Chichewa question (or Chichewa/English mix): search in English, then translate the answer
  // back. Every step falls back to English, never to a worse answer. See ./chichewa.js.
  topic.name = "qa";
  const inChichewa = lang === "ny"; // reply in Chichewa (only when CHICHEWA_REPLIES is on)
  let searchText = userText;
  if (isChichewaMessage(userText) || inChichewa) { // understanding the question always works
    const english = await translateWithGroq(buildToEnglishMessages(userText), env, 8000);
    if (english) searchText = english;
  }

  let answer = await askChakudya(searchText, from, env);
  // askChakudya returns these two canned strings (instead of throwing) when the provider is down,
  // rate-limited, or the question blew the subrequest ceiling: swap in the more helpful reply.
  let isRealAnswer = true;
  if (answer === LLM_BUSY_MESSAGE) {
    answer = buildFailureReply("busy", userText, lang);
    isRealAnswer = false;
  } else if (answer === SUBREQUEST_LIMIT_MESSAGE) {
    answer = buildFailureReply("limit", userText, lang);
    isRealAnswer = false;
  }
  // Real answers: hide the References block behind a 📚 See details button and follow up with the
  // 👍/👎 (+ details or 📤 Share) buttons. See ./feedback.js. Anything that isn't a substantive
  // real answer (failure replies, one-liners) is sent exactly as before, references included.
  let { main, references } = splitReferences(answer);
  if (isRealAnswer && inChichewa) {
    main = await localizeAnswer(main, env);
  }
  if (isRealAnswer && shouldAskFeedback(main)) {
    await sendWhatsAppReply(from, main, env);
    ctx.waitUntil(askForFeedback(from, userText, main, references, env, lang === "ny"));
  } else if (isRealAnswer && inChichewa) {
    await sendWhatsAppReply(from, references ? `${main}\n\n_References:_\n${references}` : main, env);
  } else {
    await sendWhatsAppReply(from, answer, env);
  }
}
