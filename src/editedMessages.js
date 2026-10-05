/**
 * Edited WhatsApp messages.
 *
 * A person can edit a sent message for 15 minutes. What the bot receives depends on Meta:
 *   - type "edit" (Meta's edit webhook): { edit: { original_message_id, message: { type, text|image... } } }.
 *     A text edit carries the NEW text, which we treat as a fresh question and answer.
 *   - type "unsupported": what Meta currently delivers for edits on a normal Cloud API number
 *     (its docs say edit delivery is "temporarily unsupported" and that the real edit webhook is
 *     limited to Coexistence numbers). There is no text to read, so we say so instead of going
 *     silent, which looks to the person like the bot ignored them.
 *
 * Bots cannot edit their own earlier replies, so an edit is answered with a new message.
 *
 * Pure (no fetch/env); unit-tested in test/editedMessages.test.js.
 */

/**
 * Returns { message, kind }.
 *   kind "edit"            -> `message` is rewritten as a plain text message with the edited text.
 *   kind "edit-unreadable" -> an edit we can't read (e.g. only a media caption changed).
 *   kind "unsupported"     -> Meta's "unsupported" placeholder (this is how edits arrive today).
 *   kind null              -> any other message, returned untouched.
 */
export function normalizeIncomingMessage(message) {
  if (message?.type === "edit") {
    const inner = message.edit?.message;
    const body = inner?.type === "text" ? inner.text?.body : undefined;
    if (typeof body === "string" && body.trim()) {
      return { message: { ...message, type: "text", text: { body } }, kind: "edit" };
    }
    return { message, kind: "edit-unreadable" };
  }
  if (message?.type === "unsupported") {
    return { message, kind: "unsupported" };
  }
  return { message, kind: null };
}

/** The notice for a non-null `kind`. Chichewa is only used when the (edited) text looks Chichewa. */
export function buildEditNotice(kind, isChichewa = false) {
  switch (kind) {
    case "edit":
      return isChichewa
        ? "✏️ Ndalandira uthenga womwe mwasintha — nayi yankho la funso latsopano."
        : "✏️ Got your edited message — answering the updated version.";
    case "edit-unreadable":
      return "I can see you edited a message, but I can't read the change. Please send it again as a new message. 🙏";
    default:
      return "I couldn't read that message. If you edited an earlier message, I can't see edits yet — please send your question as a new message. 🙏";
  }
}
