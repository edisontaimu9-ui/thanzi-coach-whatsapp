import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { verifyWebhookSignature, computeSignatureHex } from "../src/webhookSignature.js";

const SECRET = "test_app_secret";
const BODY = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "x", text: { body: "hi" } }] } }] }] });

describe("verifyWebhookSignature", () => {
  test("accepts a correct signature", async () => {
    const hex = await computeSignatureHex(BODY, SECRET);
    assert.equal(await verifyWebhookSignature(BODY, `sha256=${hex}`, SECRET), true);
  });

  test("matches a known HMAC-SHA256 vector", async () => {
    // RFC-style check: HMAC_SHA256(key="key", msg="The quick brown fox jumps over the lazy dog")
    const hex = await computeSignatureHex("The quick brown fox jumps over the lazy dog", "key");
    assert.equal(hex, "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });

  test("rejects a tampered body", async () => {
    const hex = await computeSignatureHex(BODY, SECRET);
    assert.equal(await verifyWebhookSignature(BODY + " ", `sha256=${hex}`, SECRET), false);
  });

  test("rejects a signature made with the wrong secret", async () => {
    const hex = await computeSignatureHex(BODY, "other_secret");
    assert.equal(await verifyWebhookSignature(BODY, `sha256=${hex}`, SECRET), false);
  });

  test("rejects missing, malformed, or wrong-length headers", async () => {
    const hex = await computeSignatureHex(BODY, SECRET);
    assert.equal(await verifyWebhookSignature(BODY, undefined, SECRET), false);
    assert.equal(await verifyWebhookSignature(BODY, null, SECRET), false);
    assert.equal(await verifyWebhookSignature(BODY, "", SECRET), false);
    assert.equal(await verifyWebhookSignature(BODY, hex, SECRET), false); // no "sha256=" prefix
    assert.equal(await verifyWebhookSignature(BODY, "sha256=zzzz", SECRET), false);
    assert.equal(await verifyWebhookSignature(BODY, "sha256=abcd", SECRET), false);
    assert.equal(await verifyWebhookSignature(BODY, `sha1=${hex}`, SECRET), false);
  });

  test("rejects everything when no secret is configured", async () => {
    const hex = await computeSignatureHex(BODY, SECRET);
    assert.equal(await verifyWebhookSignature(BODY, `sha256=${hex}`, undefined), false);
  });
});
