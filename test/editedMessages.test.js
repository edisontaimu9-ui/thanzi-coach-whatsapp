import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeIncomingMessage, buildEditNotice } from "../src/editedMessages.js";

describe("normalizeIncomingMessage", () => {
  test("a text edit becomes a plain text message with the NEW text", () => {
    const msg = {
      from: "265888", id: "wamid.EDIT", timestamp: "1", type: "edit",
      edit: { original_message_id: "wamid.ORIG", message: { type: "text", text: { body: "iron in beans" } } },
    };
    const out = normalizeIncomingMessage(msg);
    assert.equal(out.kind, "edit");
    assert.equal(out.message.type, "text");
    assert.equal(out.message.text.body, "iron in beans");
    assert.equal(out.message.id, "wamid.EDIT"); // keeps its own id for dedupe
    assert.equal(out.message.from, "265888");
  });

  test("edits with nothing readable are flagged, not guessed", () => {
    const caption = { type: "edit", edit: { original_message_id: "x", message: { type: "image", image: { caption: "new caption" } } } };
    assert.equal(normalizeIncomingMessage(caption).kind, "edit-unreadable");
    assert.equal(normalizeIncomingMessage({ type: "edit" }).kind, "edit-unreadable");
    const blank = { type: "edit", edit: { message: { type: "text", text: { body: "   " } } } };
    assert.equal(normalizeIncomingMessage(blank).kind, "edit-unreadable");
  });

  test("Meta's 'unsupported' placeholder is recognised", () => {
    assert.equal(normalizeIncomingMessage({ type: "unsupported", errors: [{ code: 131051 }] }).kind, "unsupported");
  });

  test("ordinary messages pass through untouched", () => {
    const text = { type: "text", text: { body: "hi" } };
    const out = normalizeIncomingMessage(text);
    assert.equal(out.kind, null);
    assert.equal(out.message, text);
    assert.equal(normalizeIncomingMessage(undefined).kind, null);
  });
});

describe("buildEditNotice", () => {
  test("each kind has its own notice", () => {
    assert.match(buildEditNotice("edit"), /edited message/);
    assert.match(buildEditNotice("edit", true), /Ndalandira/);
    assert.match(buildEditNotice("edit-unreadable"), /send it again/);
    assert.match(buildEditNotice("unsupported"), /can't see edits yet/);
  });
});
