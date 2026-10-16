import test from "node:test";
import assert from "node:assert/strict";
import { handleFoodQueries } from "../src/foodQueryHandlers.js";

// Minimal environment: a chakudya-api service binding answering by path, a no-op D1, and a global fetch that
// records everything sent to WhatsApp.
function setup(routes) {
  const apiCalls = [];
  const sent = [];
  const env = {
    WHATSAPP_TOKEN: "t",
    PHONE_NUMBER_ID: "1",
    CHAKUDYA_API: {
      fetch: async (url) => {
        const u = new URL(url);
        apiCalls.push(u.pathname + u.search);
        for (const [prefix, body, status = 200] of routes) {
          if (u.pathname.startsWith(prefix)) return new Response(JSON.stringify(body), { status });
        }
        return new Response("{}", { status: 404 });
      },
    },
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) }) },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (init?.body) sent.push(String(init.body));
    return new Response(JSON.stringify({ messages: [{ id: "x" }] }), { status: 200 });
  };
  const c = (userText) => ({ userText, from: "265999", env, ctx: { waitUntil: () => {} }, opts: {}, topic: {}, langState: {}, lang: "en", repliesInChichewa: false });
  return { env, apiCalls, sent, c, restore: () => (globalThis.fetch = original) };
}

const convertBody = {
  status: "success",
  data: {
    food: { food_name: "Rice, cooked" },
    standard: { grams: 316 },
    nutrients: { energy_kcal: 410.8, protein_g: 8.5, carbs_g: 89, fat_g: 0.9 },
    assumptions: [],
    warnings: [],
  },
};

test("'2 cups of rice' goes through /foods/convert and replies with the weight and nutrients", async () => {
  const t = setup([["/foods/convert", convertBody]]);
  try {
    const handled = await handleFoodQueries(t.c("2 cups of rice"));
    assert.equal(handled, true);
    const url = new URL("https://x" + t.apiCalls[0]);
    assert.equal(url.pathname, "/foods/convert");
    assert.equal(url.searchParams.get("q"), "rice");
    assert.equal(url.searchParams.get("amount"), "2");
    assert.equal(url.searchParams.get("unit"), "cup");
    assert.ok(t.sent.some((b) => b.includes("≈ 316 g")));
  } finally {
    t.restore();
  }
});

test("an unresolvable household amount falls through instead of replying", async () => {
  const t = setup([["/foods/convert", { status: "error", message: "no" }, 422]]);
  try {
    const handled = await handleFoodQueries(t.c("2 cups of zzzfood"));
    assert.equal(handled, false);
  } finally {
    t.restore();
  }
});

test("an ambiguous bare name is offered as a list built from /foods/lookup's alternates (no /foods/search call)", async () => {
  const lookup = {
    status: "success",
    source: "local_fuzzy",
    ambiguous: true,
    data: { food_name: "Rice, soaked", energy_kcal: 130 },
    alternates: [{ food_name: "Rice, cooked", energy_kcal: 130 }, { food_name: "Rice, raw", energy_kcal: 360 }],
  };
  const t = setup([["/foods/lookup", lookup]]);
  try {
    const handled = await handleFoodQueries(t.c("Rice"));
    assert.equal(handled, true);
    assert.ok(!t.apiCalls.some((p) => p.startsWith("/foods/search")));
    const list = t.sent.find((b) => b.includes('"interactive"') && b.includes("Rice, cooked"));
    assert.ok(list, "expected an interactive options list containing the alternates");
  } finally {
    t.restore();
  }
});

test("a confident local pick is shown directly as a card, not a list", async () => {
  const lookup = {
    status: "success",
    source: "local",
    data: { food_name: "Rice, cooked", energy_kcal: 130, protein_g: 2.7, carbs_g: 28, fat_g: 0.3 },
  };
  const t = setup([["/foods/lookup", lookup]]);
  try {
    const handled = await handleFoodQueries(t.c("Rice"));
    assert.equal(handled, true);
    assert.ok(!t.sent.some((b) => b.includes('"interactive"')));
    assert.ok(t.sent.some((b) => b.includes("Rice, cooked")));
  } finally {
    t.restore();
  }
});
