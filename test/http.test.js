import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { retryOnceOnUnavailable } from "../src/http.js";

const res = (status, headers = {}) => new Response("x", { status, headers });

function harness(responses, { elapsed = 0 } = {}) {
  let i = 0;
  let clock = 0;
  const waits = [];
  const attempt = async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    clock += elapsed;
    if (r instanceof Error) throw r;
    return r;
  };
  return { attempt, waits, calls: () => i, opts: { now: () => clock, wait: async (ms) => { waits.push(ms); } } };
}

describe("retryOnceOnUnavailable", () => {
  test("a good first answer is returned with no retry", async () => {
    const h = harness([res(200)]);
    assert.equal((await retryOnceOnUnavailable(h.attempt, h.opts)).status, 200);
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.waits, []);
  });

  test("a client error (4xx other than 429) is not retried", async () => {
    const h = harness([res(400)]);
    assert.equal((await retryOnceOnUnavailable(h.attempt, h.opts)).status, 400);
    assert.equal(h.calls(), 1);
  });

  test("429 / 5xx gets exactly one more try after ~2s and returns its result", async () => {
    for (const bad of [429, 500, 502, 503, 504]) {
      const h = harness([res(bad), res(200)]);
      assert.equal((await retryOnceOnUnavailable(h.attempt, h.opts)).status, 200, String(bad));
      assert.equal(h.calls(), 2);
      assert.deepEqual(h.waits, [2000]);
    }
  });

  test("still failing after the retry: returns that failure, never a third attempt", async () => {
    const h = harness([res(503), res(503), res(200)]);
    assert.equal((await retryOnceOnUnavailable(h.attempt, h.opts)).status, 503);
    assert.equal(h.calls(), 2);
  });

  test("honours Retry-After but caps the pause at 3s", async () => {
    let h = harness([res(429, { "Retry-After": "1" }), res(200)]);
    await retryOnceOnUnavailable(h.attempt, h.opts);
    assert.deepEqual(h.waits, [1000]);
    h = harness([res(429, { "Retry-After": "60" }), res(200)]);
    await retryOnceOnUnavailable(h.attempt, h.opts);
    assert.deepEqual(h.waits, [3000]);
  });

  test("a slow first attempt is not retried (no stacking long waits)", async () => {
    const h = harness([res(503), res(200)], { elapsed: 13000 });
    assert.equal((await retryOnceOnUnavailable(h.attempt, h.opts)).status, 503);
    assert.equal(h.calls(), 1);
  });

  test("a quick thrown error is retried once; a slow one is rethrown", async () => {
    let h = harness([new Error("network blip"), res(200)]);
    assert.equal((await retryOnceOnUnavailable(h.attempt, h.opts)).status, 200);
    assert.equal(h.calls(), 2);
    h = harness([new Error("timeout"), res(200)], { elapsed: 13000 });
    await assert.rejects(() => retryOnceOnUnavailable(h.attempt, h.opts), /timeout/);
    assert.equal(h.calls(), 1);
  });

  test("a throwing retry surfaces the error to the caller's existing handling", async () => {
    const h = harness([new Error("a"), new Error("b")]);
    await assert.rejects(() => retryOnceOnUnavailable(h.attempt, h.opts), /b/);
  });
});
