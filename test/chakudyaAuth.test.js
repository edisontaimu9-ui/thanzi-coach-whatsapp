import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chakudyaFetch, withChakudyaKey } from "../src/http.js";

function envWith(key) {
  const calls = [];
  const env = {
    CHAKUDYA_API: { fetch: async (url, init) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); } },
  };
  if (key) env.CHAKUDYA_API_KEY = key;
  return { env, calls };
}

describe("chakudyaFetch sends the chakudya-api key", () => {
  test("adds Authorization to a bare GET", async () => {
    const { env, calls } = envWith("cnr_test");
    await chakudyaFetch(env, "https://chakudya-api/foods/categories");
    assert.equal(calls[0].init.headers.Authorization, "Bearer cnr_test");
  });

  test("keeps existing headers and the body on a POST", async () => {
    const { env, calls } = envWith("cnr_test");
    await chakudyaFetch(env, "https://chakudya-api/rag/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, "{}");
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    assert.equal(calls[0].init.headers.Authorization, "Bearer cnr_test");
  });

  test("accepts a Headers object", () => {
    const init = withChakudyaKey({ CHAKUDYA_API_KEY: "k" }, { headers: new Headers({ "X-A": "1" }) });
    assert.equal(init.headers["x-a"], "1");
    assert.equal(init.headers.Authorization, "Bearer k");
  });

  test("does not mutate the caller's init", () => {
    const init = { headers: { A: "1" } };
    withChakudyaKey({ CHAKUDYA_API_KEY: "k" }, init);
    assert.deepEqual(init, { headers: { A: "1" } });
  });

  test("with no key it sends the request unchanged (the API will answer 401)", async () => {
    const { env, calls } = envWith(null);
    const orig = console.warn; console.warn = () => {};
    try { await chakudyaFetch(env, "https://chakudya-api/foods/categories"); } finally { console.warn = orig; }
    assert.equal(calls[0].init?.headers?.Authorization, undefined);
  });
});
