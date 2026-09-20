import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  HEIGHT_ESTIMATE_SAMPLE_PROMPT,
  detectHeightEstimateTrigger,
  availableMethods,
  parseMethod,
  nextStep,
  applyReply,
  buildEstimateCall,
  formatHeightEstimateResult,
  handleHeightEstimateFlow,
} from "../src/heightEstimate.js";
import { detectUnder5ScreeningTrigger } from "../src/under5Screening.js";
import { detectPregnantPostpartumScreeningTrigger } from "../src/pregnantPostpartumScreening.js";
import { detectSchoolAgeScreeningTrigger } from "../src/schoolAgeScreening.js";
import { detectAdultScreeningTrigger } from "../src/adultScreening.js";
import { detectWeightEstimateTrigger } from "../src/weightEstimate.js";
import { detectScreeningMenuRequest } from "../src/screeningMenu.js";
import { ALL_SCREENING_SESSION_KINDS } from "../src/screeningShared.js";

/** Fake env whose MCP binding answers by tool name from `responses`. */
function makeFakeEnv(responses, calls = []) {
  const rows = new Map();
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          this._args = args;
          return this;
        },
        async run() {
          if (sql.startsWith("INSERT INTO last_session_context")) {
            const [id, kind, payload, at] = this._args;
            rows.set(`${id}:${kind}`, { payload_json: payload, updated_at: at });
          } else if (sql.startsWith("DELETE FROM last_session_context")) {
            const [id, kind] = this._args;
            rows.delete(`${id}:${kind}`);
          }
        },
        async first() {
          const [id, kind] = this._args;
          return rows.get(`${id}:${kind}`) ?? null;
        },
      };
    },
  };
  const CHAKUDYA_MCP = {
    async fetch(_url, init) {
      const body = JSON.parse(init.body);
      const name = body.params.name;
      calls.push({ name, args: body.params.arguments });
      const data = responses[name];
      if (data instanceof Error) return new Response("boom", { status: 502 });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ data }) }] } }),
        { status: 200 }
      );
    },
  };
  return { DB, CHAKUDYA_MCP, CHAKUDYA_MCP_AUTH_TOKEN: "t", _rows: rows };
}

const kneeHeightResult = (over = {}) => ({
  race: "black",
  sex: "male",
  age_years: 40,
  age_band: "19-60",
  knee_height_cm: 50,
  estimated_stature_cm: 162.92,
  formula: "S = 73.42 + (1.79 x KH)",
  error_cm: 7.2,
  note: "S: stature in cm; KH: knee height in cm; A: age in years.",
  ...over,
});
const demiSpanResult = (over = {}) => ({
  sex: "female",
  age_years: 30,
  age_band: "16-54 years",
  demi_span_cm: 35,
  estimated_height_cm: 107.5,
  formula: "Height (cm) = (DS x 1.3) + 62",
  note: "DS: demi span in cm.",
  ...over,
});
const ulnaResult = (over = {}) => ({
  sex: "male",
  age_years: 40,
  age_band: "<65 years",
  ulna_length_cm: 26.5,
  matched_table_ulna_cm: 26.5,
  estimated_height_m: 1.78,
  estimated_height_cm: 178,
  note: undefined,
  ...over,
});

describe("detectHeightEstimateTrigger", () => {
  test("matches requests to estimate a patient's height, including the sample prompt", () => {
    for (const t of [
      HEIGHT_ESTIMATE_SAMPLE_PROMPT,
      "estimate height for a patient",
      "Estimate stature for an elderly patient",
      "height estimation for a bedridden patient",
      "how do I estimate the height of an older woman",
      "my patient can't stand to be measured",
      "patient unable to stand",
      "can't measure my grandmother's height",
    ]) assert.equal(detectHeightEstimateTrigger(t), true, t);
  });

  test("ignores stunting/height-for-age screening language and unrelated requests", () => {
    for (const t of [
      "check height-for-age for a child",
      "is this child stunted",
      "what is the z-score for this measurement",
      "what is the ideal weight for a woman",
      "hello",
      "how tall is Mount Mulanje",
    ]) assert.equal(detectHeightEstimateTrigger(t), false, t);
  });

  test("does not overlap with the weight-estimate trigger or any screening trigger, and vice versa", () => {
    for (const phrase of ["estimate height for an elderly patient", HEIGHT_ESTIMATE_SAMPLE_PROMPT]) {
      assert.equal(detectHeightEstimateTrigger(phrase), true, phrase);
      assert.equal(detectWeightEstimateTrigger(phrase), false, phrase);
      assert.equal(detectUnder5ScreeningTrigger(phrase), false, phrase);
      assert.equal(detectPregnantPostpartumScreeningTrigger(phrase), false, phrase);
      assert.equal(detectSchoolAgeScreeningTrigger(phrase), false, phrase);
      assert.equal(detectAdultScreeningTrigger(phrase), false, phrase);
      assert.equal(detectScreeningMenuRequest(phrase), false, phrase);
    }
    for (const t of ["estimate weight for a patient", "screen an adult for malnutrition", "screen a child for malnutrition", "check muac for an elderly patient"]) {
      assert.equal(detectHeightEstimateTrigger(t), false, t);
    }
  });

  test("its session kind is cleared with the screening sessions", () => {
    assert.ok(ALL_SCREENING_SESSION_KINDS.includes("height_estimate"));
  });
});

describe("availableMethods / parseMethod", () => {
  test("under 6: ulna only; 6-15: knee height + ulna; 16+: all three", () => {
    assert.deepEqual(availableMethods(5), ["ulna"]);
    assert.deepEqual(availableMethods(10), ["knee_height", "ulna"]);
    assert.deepEqual(availableMethods(40), ["knee_height", "demi_span", "ulna"]);
    assert.deepEqual(availableMethods(70), ["knee_height", "demi_span", "ulna"]);
  });

  test("parseMethod accepts a menu number, a keyword, or rejects an unlisted method/gibberish", () => {
    const methods = ["knee_height", "demi_span", "ulna"];
    assert.equal(parseMethod("1", methods), "knee_height");
    assert.equal(parseMethod("2", methods), "demi_span");
    assert.equal(parseMethod("3", methods), "ulna");
    assert.equal(parseMethod("knee height", methods), "knee_height");
    assert.equal(parseMethod("Demi span", methods), "demi_span");
    assert.equal(parseMethod("forearm", methods), "ulna");
    assert.equal(parseMethod("4", methods), null);
    assert.equal(parseMethod("xyz", methods), null);
    // demi span not offered at this age -> keyword and its menu number are both rejected
    const young = ["knee_height", "ulna"];
    assert.equal(parseMethod("demi span", young), null);
    assert.equal(parseMethod("2", young), "ulna");
  });
});

describe("step machine", () => {
  test("sex -> age -> method, then branches by chosen method", () => {
    assert.equal(nextStep("sex", {}), "age");
    assert.equal(nextStep("age", {}), "method");
    assert.equal(nextStep("method", { method: "knee_height" }), "race");
    assert.equal(nextStep("method", { method: "demi_span" }), "ds");
    assert.equal(nextStep("method", { method: "ulna" }), "ulna");
    assert.equal(nextStep("race", {}), "kh");
    assert.equal(nextStep("kh", {}), "finish");
    assert.equal(nextStep("ds", {}), "finish");
    assert.equal(nextStep("ulna", {}), "finish");
  });
});

describe("applyReply", () => {
  test("age: rejects unparseable/out-of-bounds ages, accepts sensible ones, bare number = years", () => {
    assert.ok("error" in applyReply("age", "not sure", { sex: "male" }));
    assert.ok("error" in applyReply("age", "200 years", { sex: "male" }));
    for (const a of ["0 years", "6 years", "40", "85 years"]) {
      assert.deepEqual(applyReply("age", a, { sex: "male" }), { advance: true }, a);
    }
  });

  test("method is validated against what's available at the patient's age", () => {
    const child = { age_years: 10 };
    assert.ok("error" in applyReply("method", "demi span", child)); // not offered under 16
    assert.deepEqual(applyReply("method", "1", child), { advance: true });
    assert.equal(child.method, "knee_height");

    const adult = { age_years: 40 };
    assert.deepEqual(applyReply("method", "2", adult), { advance: true });
    assert.equal(adult.method, "demi_span");
  });

  test("race must be black or white", () => {
    const d = {};
    assert.ok("error" in applyReply("race", "brown", d));
    assert.deepEqual(applyReply("race", "black", d), { advance: true });
    assert.equal(d.race, "black");
  });

  test("kh/ds/ulna are required and range-checked", () => {
    assert.ok("error" in applyReply("kh", "abc", {}));
    assert.ok("error" in applyReply("kh", "10", {})); // too short to be plausible
    const kh = {};
    assert.deepEqual(applyReply("kh", "50", kh), { advance: true });
    assert.equal(kh.kh_cm, 50);

    assert.ok("error" in applyReply("ds", "5", {}));
    const ds = {};
    applyReply("ds", "35", ds);
    assert.equal(ds.ds_cm, 35);

    assert.ok("error" in applyReply("ulna", "10", {})); // below the 18.5cm table floor
    assert.ok("error" in applyReply("ulna", "40", {})); // above the 32cm table ceiling
    const ulna = {};
    applyReply("ulna", "26.5", ulna);
    assert.equal(ulna.ulna_cm, 26.5);
  });
});

describe("buildEstimateCall", () => {
  test("knee height sends race + rounded age", () => {
    const call = buildEstimateCall({ sex: "male", age_years: 40, method: "knee_height", race: "black", kh_cm: 50 });
    assert.deepEqual(call, { tool: "stature_from_knee_height", args: { race: "black", sex: "male", age_years: 40, knee_height_cm: 50 } });
  });

  test("demi span sends only sex/age/measurement", () => {
    const call = buildEstimateCall({ sex: "female", age_years: 30, method: "demi_span", ds_cm: 35 });
    assert.deepEqual(call, { tool: "stature_from_demi_span", args: { sex: "female", age_years: 30, demi_span_cm: 35 } });
  });

  test("ulna sends only sex/age/measurement", () => {
    const call = buildEstimateCall({ sex: "male", age_years: 40, method: "ulna", ulna_cm: 26.5 });
    assert.deepEqual(call, { tool: "stature_from_ulna_length", args: { sex: "male", age_years: 40, ulna_length_cm: 26.5 } });
  });
});

describe("formatHeightEstimateResult", () => {
  test("knee height: shows the standard error", () => {
    const text = formatHeightEstimateResult("stature_from_knee_height", kneeHeightResult(), { sex: "male", age_years: 40, kh_cm: 50, race: "black" });
    assert.match(text, /Male, 40 years/);
    assert.match(text, /Measurement: knee height 50 cm, race: black/);
    assert.match(text, /\*≈ 162\.9 cm\* — knee height, race-specific equation \(Lee & Nieman\) \(standard error ±7\.2 cm\)/);
    assert.match(text, /typical error is about ±7\.2 cm/);
  });

  test("demi span: no standard error field, so none is shown", () => {
    const text = formatHeightEstimateResult("stature_from_demi_span", demiSpanResult(), { sex: "female", age_years: 30, ds_cm: 35 });
    assert.match(text, /Female, 30 years/);
    assert.match(text, /Measurement: demi span 35 cm/);
    assert.match(text, /\*≈ 107\.5 cm\* — demi span equation \(Gibson\)$/m);
    assert.doesNotMatch(text, /standard error/);
  });

  test("ulna: a normal lookup has no warning; the one known doubtful cell surfaces its note", () => {
    const clean = formatHeightEstimateResult("stature_from_ulna_length", ulnaResult(), { sex: "male", age_years: 40, ulna_cm: 26.5 });
    assert.match(clean, /\*≈ 178 cm\* — ulna \(forearm\) length reference table$/m);
    assert.doesNotMatch(clean, /⚠️/);

    const doubtful = formatHeightEstimateResult(
      "stature_from_ulna_length",
      ulnaResult({ note: "This table cell (men >65 years, 30.0cm ulna = 1.71m) breaks the otherwise-monotonic sequence..." }),
      { sex: "male", age_years: 70, ulna_cm: 30 }
    );
    assert.match(doubtful, /⚠️ This table cell/);
  });

  test("an empty result is reported plainly", () => {
    assert.match(formatHeightEstimateResult("stature_from_ulna_length", null, {}), /No estimate could be calculated/);
  });
});

describe("handleHeightEstimateFlow — end to end with a fake env", () => {
  test("knee height route: sex -> age -> method -> race -> knee height -> result", async () => {
    const calls = [];
    const env = makeFakeEnv({ stature_from_knee_height: kneeHeightResult() }, calls);
    const from = "265888500000";
    const say = (t) => handleHeightEstimateFlow(t, from, env);

    assert.match(await say("estimate height for a bedridden patient"), /male or female/);
    assert.match(await say("male"), /How old/);
    const methodQ = await say("40 years");
    assert.match(methodQ, /Which measurement/);
    assert.match(methodQ, /1\. Knee height/);
    assert.match(methodQ, /2\. Demi span/);
    assert.match(methodQ, /3\. Ulna/);
    assert.match(await say("1"), /race-specific/);
    assert.match(await say("black"), /Knee height in cm/);
    const final = await say("50");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "stature_from_knee_height");
    assert.deepEqual(calls[0].args, { race: "black", sex: "male", age_years: 40, knee_height_cm: 50 });
    assert.match(final, /Estimated height/);
    assert.match(final, /≈ 162\.9 cm/);
    assert.equal(env._rows.size, 0);
  });

  test("demi span route for a 30-year-old woman", async () => {
    const calls = [];
    const env = makeFakeEnv({ stature_from_demi_span: demiSpanResult() }, calls);
    const from = "265888500001";
    const say = (t) => handleHeightEstimateFlow(t, from, env);

    await say("Estimate height for a patient");
    await say("female");
    await say("30 years");
    assert.match(await say("demi span"), /sternal notch/);
    const final = await say("35");

    assert.equal(calls[0].name, "stature_from_demi_span");
    assert.deepEqual(calls[0].args, { sex: "female", age_years: 30, demi_span_cm: 35 });
    assert.match(final, /≈ 107\.5 cm/);
  });

  test("a 10-year-old is not offered demi span; ulna route works at any age", async () => {
    const calls = [];
    const env = makeFakeEnv({ stature_from_ulna_length: ulnaResult({ age_years: 10, estimated_height_cm: 130 }) }, calls);
    const from = "265888500002";
    const say = (t) => handleHeightEstimateFlow(t, from, env);

    await say("estimate height for a patient");
    await say("male");
    const methodQ = await say("10 years");
    assert.doesNotMatch(methodQ, /Demi span/);
    assert.match(await say("ulna"), /point of the elbow/);
    const final = await say("22");

    assert.equal(calls[0].name, "stature_from_ulna_length");
    assert.deepEqual(calls[0].args, { sex: "male", age_years: 10, ulna_length_cm: 22 });
    assert.match(final, /≈ 130 cm/);
  });

  test("a bad reply reprompts and stays on the step; cancel and unrelated text behave", async () => {
    const env = makeFakeEnv({});
    const from = "265888500003";
    assert.equal(await handleHeightEstimateFlow("what is in a banana?", from, env), null);
    await handleHeightEstimateFlow("estimate height for a patient", from, env);
    await handleHeightEstimateFlow("female", from, env);
    const reply = await handleHeightEstimateFlow("banana", from, env);
    assert.match(reply, /like \*72 years\*/);
    assert.equal(JSON.parse(env._rows.get(`${from}:height_estimate`).payload_json).step, "age");
    assert.match(await handleHeightEstimateFlow("cancel", from, env), /Cancelled/);
    assert.equal(await handleHeightEstimateFlow("hello", from, env), null);
  });

  test("tool failure is reported plainly and the session is already cleared", async () => {
    const env = makeFakeEnv({ stature_from_ulna_length: new Error("x") });
    const from = "265888500004";
    const say = (t) => handleHeightEstimateFlow(t, from, env);
    await say("estimate height for a patient");
    await say("male");
    await say("40");
    await say("ulna");
    const reply = await say("26.5");
    assert.match(reply, /couldn't be completed/);
    assert.equal(env._rows.size, 0);
  });
});
