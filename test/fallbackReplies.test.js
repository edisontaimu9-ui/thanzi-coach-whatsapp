import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, looksChichewa, buildFailureReply } from "../src/fallbackReplies.js";

describe("classifyFailure", () => {
  test("subrequest limit", () => {
    assert.equal(classifyFailure(new Error("Too many subrequests")), "limit");
    assert.equal(classifyFailure(new Error("Too many API requests by single worker invocation")), "limit");
  });
  test("upstream slow/down/rate-limited -> busy", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    assert.equal(classifyFailure(abort), "busy");
    assert.equal(classifyFailure(new Error("Chakudya API error: 503 upstream")), "busy");
    assert.equal(classifyFailure(new Error("Chakudya API error: 429 rate limited")), "busy");
    assert.equal(classifyFailure(new Error("fetch failed")), "busy");
  });
  test("anything else -> error", () => {
    assert.equal(classifyFailure(new Error("Cannot read properties of undefined")), "error");
    assert.equal(classifyFailure(new Error("Chakudya API error: 400 bad request")), "error");
    assert.equal(classifyFailure(undefined), "error");
  });
});

describe("looksChichewa", () => {
  test("detects Chichewa, not English", () => {
    assert.equal(looksChichewa("Ndikufuna thandizo pa zakudya"), true);
    assert.equal(looksChichewa("Ndi zakudya ziti zomwe zili ndi iron wambiri?"), true);
    assert.equal(looksChichewa("what foods are high in iron?"), false);
    assert.equal(looksChichewa("nsima"), false);
    assert.equal(looksChichewa(""), false);
  });
});

describe("buildFailureReply", () => {
  test("busy reply is helpful, mentions menu, echoes the question", () => {
    const r = buildFailureReply("busy", "How much iron do I need?");
    assert.match(r, /busy/);
    assert.match(r, /\*menu\*/);
    assert.match(r, /Your question: “How much iron do I need\?”/);
  });
  test("limit reply tells them to split the question and doesn't echo", () => {
    const r = buildFailureReply("limit", "a very long compound question");
    assert.match(r, /split/);
    assert.doesNotMatch(r, /Your question/);
  });
  test("long questions are truncated in the echo", () => {
    const r = buildFailureReply("error", "x".repeat(300));
    assert.ok(r.length < 400);
    assert.match(r, /…/);
  });
  test("Chichewa messages get a Chichewa reply", () => {
    const r = buildFailureReply("busy", "Ndikufuna thandizo pa zakudya");
    assert.match(r, /Nkhokwe ya zakudya/);
    assert.match(r, /Funso lanu/);
  });
  test("a remembered language overrides detection", () => {
    assert.match(buildFailureReply("busy", "nsima", "ny"), /Nkhokwe ya zakudya/);
    assert.match(buildFailureReply("busy", "Ndikufuna thandizo pa zakudya", "en"), /database is busy/);
  });
  test("unknown kind falls back to the generic error reply; empty text adds no echo", () => {
    const r = buildFailureReply("weird", "");
    assert.match(r, /ran into a problem/);
    assert.doesNotMatch(r, /Your question/);
  });
});
