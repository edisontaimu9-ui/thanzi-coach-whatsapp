/**
 * 👍/👎/Share/See details: sending the buttons and handling taps (data layer is feedback.js).
 *
 * Split out of src/index.js with no behaviour change.
 */

import { buildDetailsMessage, buildFeedbackPrompt, buildFeedbackThanks, buildShareMessage, buildShareText, buildShareUrl, createFeedbackPrompt, getAnswerForShare, recordFeedback } from "./feedback.js";
import { sendWhatsAppInteractiveButtons, sendWhatsAppInteractiveCtaUrl, sendWhatsAppReply } from "./whatsapp.js";
import { isChichewaFor } from "./language.js";

// Follow-up buttons after an answer. Best-effort, but the hidden references must never be lost:
// if the buttons can't be created or sent, the sources are sent as plain text instead.
export async function askForFeedback(from, question, answer, references, env, isNy = false) {
  try {
    const id = await createFeedbackPrompt(env.DB, { whatsappId: from, question, answer, sources: references });
    if (!id) throw new Error("no feedback row");
    await sendWhatsAppInteractiveButtons(from, buildFeedbackPrompt(id, isNy, Boolean(references)), env);
  } catch (err) {
    console.error("askForFeedback failed:", err);
    if (references) {
      await sendWhatsAppReply(from, `📚 *${isNy ? "Magwero" : "Sources"}*\n${references}`, env).catch(() => {});
    }
  }
}

export async function handleFeedbackTap({ rating, id }, from, env) {
  if (rating === "details") {
    // 📚 See details: reveal the hidden sources, with a 📤 Share link button underneath.
    const stored = await getAnswerForShare(env.DB, { id, whatsappId: from });
    if (!stored || !stored.sources) return;
    const isNy = await isChichewaFor(env, from, stored.question);
    const msg = buildDetailsMessage(stored.sources, isNy);
    const url = buildShareUrl(buildShareText(stored.answer, env.BOT_WA_NUMBER));
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
    const url = buildShareUrl(buildShareText(stored.answer, env.BOT_WA_NUMBER));
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
