/**
 * 👍/👎/Share/See details: sending the buttons and handling taps (data layer is feedback.js).
 *
 * Split out of src/index.js with no behaviour change.
 */

import { buildDetailsMessage, buildFeedbackPrompt, buildFeedbackThanks, buildShareMessage, buildShareLink, createFeedbackPrompt, getAnswerForShare, recordFeedback, shouldAskFeedback, splitReferences } from "./feedback.js";
import { LLM_BUSY_MESSAGE, SUBREQUEST_LIMIT_MESSAGE } from "./errors.js";
import { sendWhatsAppInteractiveButtons, sendWhatsAppInteractiveCtaUrl, sendWhatsAppReply } from "./whatsapp.js";
import { isChichewaFor } from "./language.js";

// Follow-up buttons after an answer or result. Best-effort, but hidden references must never be lost:
// if the buttons can't be created or sent, real references are sent as plain text instead.
// `references` are an answer's own sources; `fallbackDetails` is the generic "how this was produced" text
// used by results that have none, so every result still has a 📚 See details button.
export async function askForFeedback(from, question, answer, references, env, isNy = false, fallbackDetails = "") {
  try {
    const details = references || fallbackDetails;
    const id = await createFeedbackPrompt(env.DB, { whatsappId: from, question, answer, sources: details });
    if (!id) throw new Error("no feedback row");
    await sendWhatsAppInteractiveButtons(from, buildFeedbackPrompt(id, isNy, Boolean(details)), env);
  } catch (err) {
    console.error("askForFeedback failed:", err);
    if (references) {
      await sendWhatsAppReply(from, `📚 *${isNy ? "Magwero" : "Sources"}*\n${references}`, env).catch(() => {});
    }
  }
}

export const DEFAULT_RESULT_DETAILS =
  "Information comes from the Chakudya Nutrition Registry and the guidelines linked to it. Reference only, not a substitute for individual clinical assessment.";

/**
 * Sends a RESULT (a food card, comparison, calculation, plan...) and follows it with the
 * 📚 See details / 👍 / 👎 buttons (📤 Share lives under See details). `c` is the routing context.
 * An answer's References block, if present, is hidden behind See details; otherwise `details` is shown.
 * Failure notices and one-liners get no buttons. `opts.buttons === false` sends without them.
 */
export async function sendResult(c, text, details = DEFAULT_RESULT_DETAILS, opts = {}) {
  const { from, env, ctx, userText, lang } = c;
  const failure = text === LLM_BUSY_MESSAGE || text === SUBREQUEST_LIMIT_MESSAGE;
  const { main, references } = failure ? { main: text, references: "" } : splitReferences(text);
  const hide = Boolean(references) && shouldAskFeedback(main);
  const shown = hide ? main : text;
  await sendWhatsAppReply(from, shown, env);
  if (failure || opts.buttons === false || !shouldAskFeedback(shown)) return;
  const task = askForFeedback(from, userText, shown, hide ? references : "", env, lang === "ny", details);
  if (ctx?.waitUntil) ctx.waitUntil(task);
}

export async function handleFeedbackTap({ rating, id }, from, env) {
  if (rating === "details") {
    // 📚 See details: reveal the hidden sources, with a 📤 Share link button underneath.
    const stored = await getAnswerForShare(env.DB, { id, whatsappId: from });
    if (!stored || !stored.sources) return;
    const isNy = await isChichewaFor(env, from, stored.question);
    const msg = buildDetailsMessage(stored.sources, isNy);
    const url = buildShareLink(stored.answer, env.BOT_WA_NUMBER);
    await sendWhatsAppInteractiveCtaUrl(from, { body: msg.body, displayText: msg.displayText, url }, env).catch(async (err) => {
      console.error("Details send failed:", err);
      await sendWhatsAppReply(from, `📚 *${isNy ? "Magwero" : "Sources"}*\n${stored.sources}`, env).catch(() => {});
    });
    return;
  }
  if (rating === "share") {
    // 📤 Share: reply with a link button that opens WhatsApp's chat picker with the answer
    // pre-filled (wa.me/?text=...). Optional BOT_WA_NUMBER (digits, e.g. 265...) adds a "chat with
    // Thanzi Coach" link to the shared text. Can be tapped repeatedly; it never touches the rating.
    const stored = await getAnswerForShare(env.DB, { id, whatsappId: from });
    if (!stored) return;
    const msg = buildShareMessage(await isChichewaFor(env, from, stored.question));
    const url = buildShareLink(stored.answer, env.BOT_WA_NUMBER);
    await sendWhatsAppInteractiveCtaUrl(from, { body: msg.body, displayText: msg.displayText, url }, env).catch((err) => {
      console.error("Share link send failed:", err);
    });
    return;
  }
  const recorded = await recordFeedback(env.DB, { id, whatsappId: from, rating });
  if (!recorded) return; // repeat tap, someone else's id, or DB trouble: stay quiet
  // The tap only carries the id, so the language of the thanks follows the stored question.
  let question = "";
  try {
    question = (await env.DB.prepare(`SELECT question FROM feedback WHERE id = ?1`).bind(id).first("question")) || "";
  } catch {}
  await sendWhatsAppReply(from, buildFeedbackThanks(rating, await isChichewaFor(env, from, question)), env).catch(() => {});
}
