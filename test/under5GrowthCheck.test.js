import test from "node:test";
import assert from "node:assert/strict";
import { buildGrowthAssessParams, formatGrowthCheckBlock } from "../src/under5Screening.js";
import { assessGrowthViaChakudya } from "../src/chakudyaClient.js";

test("builds /growth/assess params: sex words, length for lying, mm to cm", () => {
  const p = buildGrowthAssessParams(
    { sex: "female", weight_kg: 9.5, length_or_height_cm: 74.3, measurement_method: "lying", muac_mm: 125 },
    18
  );
  assert.deepEqual(p, { sex: "girls", age_months: 18, weight_kg: 9.5, length_cm: 74.3, measured: "lying", muac_cm: 12.5 });
});

test("a standing measurement is sent as height_cm", () => {
  const p = buildGrowthAssessParams({ sex: "male", length_or_height_cm: 90, measurement_method: "standing" }, 30);
  assert.equal(p.height_cm, 90);
  assert.equal(p.length_cm, undefined);
  assert.equal(p.sex, "boys");
});

test("returns null with no usable age, sex or measurement", () => {
  assert.equal(buildGrowthAssessParams({ sex: "male", weight_kg: 8 }, undefined), null);
  assert.equal(buildGrowthAssessParams({ sex: "male" }, 12), null);
  assert.equal(buildGrowthAssessParams({ weight_kg: 8 }, 12), null);
});

const growth = {
  indicators: { muac_for_age: { status: "normal", z_score: -1.2 } },
  attention: [
    { indicator: "weight_for_length_height", status: "moderate wasting", z_score: -2.4 },
    { indicator: "length_height_for_age", status: "stunted", z_score: -2.1 },
  ],
  acute_malnutrition_signals: { level: "moderate", reasons: ["weight-for-length/height z -2.4 (-3 to -2)"] },
};

test("formats MUAC-for-age, the attention list and acute signals", () => {
  const block = formatGrowthCheckBlock(growth);
  assert.match(block, /WHO growth check/);
  assert.match(block, /MUAC-for-age: z=-1.2 — normal/);
  assert.match(block, /Weight-for-length\/height \(moderate wasting, z -2.4\); Length\/height-for-age \(stunted, z -2.1\)/);
  assert.match(block, /Acute malnutrition signals: \*moderate\*/);
  assert.doesNotMatch(block, /oedema/);
});

test("says so when everything is normal, and flags reported oedema", () => {
  const calm = { indicators: {}, attention: [], acute_malnutrition_signals: { level: "none", reasons: [] } };
  assert.match(formatGrowthCheckBlock(calm), /within the normal range/);
  assert.match(formatGrowthCheckBlock(calm), /signals \(weight-for-height and MUAC\): none/);
  assert.match(formatGrowthCheckBlock(calm, { oedema: true }), /oedema was reported/);
  assert.equal(formatGrowthCheckBlock(null), null);
});

test("assessGrowthViaChakudya calls /growth/assess and degrades to null on failure", async () => {
  const seen = [];
  const mk = (status, body) => ({ CHAKUDYA_API: { fetch: async (url) => (seen.push(new URL(url)), new Response(JSON.stringify(body), { status })) } });
  const ok = await assessGrowthViaChakudya({ sex: "girls", age_months: 18, weight_kg: 9.5, muac_cm: 12.5, hc_cm: undefined }, mk(200, { status: "success", data: growth }));
  assert.equal(seen[0].pathname, "/growth/assess");
  assert.equal(seen[0].searchParams.get("muac_cm"), "12.5");
  assert.equal(seen[0].searchParams.has("hc_cm"), false);
  assert.equal(ok.acute_malnutrition_signals.level, "moderate");
  assert.equal(await assessGrowthViaChakudya({ sex: "boys", age_months: 3 }, mk(400, { status: "error" })), null);
  assert.equal(await assessGrowthViaChakudya({ sex: "boys", age_months: 3 }, { CHAKUDYA_API: { fetch: async () => { throw new Error("down"); } } }), null);
});
