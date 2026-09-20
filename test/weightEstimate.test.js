import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  detectWeightEstimateTrigger,
  parseCircumferenceCm,
  nextStep,
  applyReply,
  buildEstimateArgs,
  formatWeightEstimateResult,
  handleWeightEstimateFlow,
} from "../src/weightEstimate.js";
import { detectUnder5ScreeningTrigger } from "../src/under5Screening.js";
import { detectPregnantPostpartumScreeningTrigger } from "../src/pregnantPostpartumScreening.js";
import { detectSchoolAgeScreeningTrigger } from "../src/schoolAgeScreening.js";
import { detectAdultScreeningTrigger } from "../src/adultScreening.js";
import { detectScreeningMenuRequest } from "../src/screeningMenu.js";
import { ALL_SCREENING_SESSION_KINDS } from "../src/screeningShared.js";

function makeFakeEnv(mcpToolResponse, calls = []) {
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
      calls.push({ name: body.params.name, args: body.params.arguments });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ data: mcpToolResponse }) }] } }),
        { status: 200 }
      );
    },
  };
  return { DB, CHAKUDYA_MCP, CHAKUDYA_MCP_AUTH_TOKEN: "t", _rows: rows };
}

const toolResult = (over = {}) => ({
  sex: "female",
  estimates: [
    { estimated_weight_kg: 52.9, formula: "f3", see_kg: 3.8, inputs_used: ["muac", "cc", "ssf", "kh"] },
    { estimated_weight_kg: 51.4, formula: "f2", see_kg: 4.21, inputs_used: ["muac", "cc", "ssf"] },
    { estimated_weight_kg: 52.4, formula: "f1", see_kg: 4.96, inputs_used: ["muac", "cc"] },
  ],
  most_precise_estimate_kg: 52.9,
  ...over,
});

describe("detectWeightEstimateTrigger", () => {
  test("matches requests to estimate a patient's weight", () => {
    for (const t of [
      "estimate weight for a patient",
      "Estimate body weight for an elderly patient",
      "weight estimation for a bedridden patient",
      "how do I estimate the weight of an older woman",
      "my patient cannot be weighed",
      "I can't weigh my grandmother",
      "patient unable to weigh",
    ]) assert.equal(detectWeightEstimateTrigger(t), true, t);
  });

  test("ignores weight loss, ideal weight, energy, meal-plan and food-weight requests", () => {
    for (const t of [
      "calculate weight loss percentage for a patient",
      "what is the ideal weight for a woman",
      "estimate energy requirements for a man weight 70kg",
      "estimate calories for an elderly patient weighing 60 kg",
      "what is the nutrition in 200g of quinoa?",
      "estimate weight of maize flour 200g",
      "weight loss diet for a woman",
      "hello",
    ]) assert.equal(detectWeightEstimateTrigger(t), false, t);
  });

  test("does not overlap with any screening trigger, and no screening phrase triggers it", () => {
    const phrase = "estimate weight for an elderly patient";
    assert.equal(detectWeightEstimateTrigger(phrase), true);
    assert.equal(detectUnder5ScreeningTrigger(phrase), false);
    assert.equal(detectPregnantPostpartumScreeningTrigger(phrase), false);
    assert.equal(detectSchoolAgeScreeningTrigger(phrase), false);
    assert.equal(detectAdultScreeningTrigger(phrase), false);
    assert.equal(detectScreeningMenuRequest(phrase), false);
    for (const t of ["screen an adult for malnutrition", "screen a child for malnutrition", "malnutrition screening", "check muac for an elderly patient"]) {
      assert.equal(detectWeightEstimateTrigger(t), false, t);
    }
  });

  test("its session kind is cleared with the screening sessions", () => {
    assert.ok(ALL_SCREENING_SESSION_KINDS.includes("weight_estimate"));
  });
});

describe("parseCircumferenceCm", () => {
  test("reads cm, mm and bare numbers (>= 100 is mm)", () => {
    assert.equal(parseCircumferenceCm("27.5"), 27.5);
    assert.equal(parseCircumferenceCm("27.5cm"), 27.5);
    assert.equal(parseCircumferenceCm("275mm"), 27.5);
    assert.equal(parseCircumferenceCm("275"), 27.5);
    assert.equal(parseCircumferenceCm("310 mm"), 31);
    assert.equal(parseCircumferenceCm("abc"), null);
  });
});

describe("applyReply / nextStep", () => {
  test("under 65 is declined; exactly 65 is accepted; bare number counts as years", () => {
    assert.deepEqual(applyReply("age", "64 years", { sex: "female" }), { tooYoung: true });
    assert.deepEqual(applyReply("age", "65 years", { sex: "female" }), { advance: true });
    assert.deepEqual(applyReply("age", "72", { sex: "female" }), { advance: true });
    assert.deepEqual(applyReply("age", "64 years 11 months", { sex: "female" }), { tooYoung: true });
  });

  test("arm and calf circumference are required (skip is refused) and range-checked", () => {
    assert.ok("error" in applyReply("muac", "skip", {}));
    assert.ok("error" in applyReply("calf", "skip", {}));
    assert.ok("error" in applyReply("muac", "5", {}));
    assert.ok("error" in applyReply("calf", "90", {}));
    const d = {};
    assert.deepEqual(applyReply("muac", "275", d), { advance: true });
    assert.equal(d.muac_cm, 27.5);
    assert.deepEqual(applyReply("calf", "31.5cm", d), { advance: true });
    assert.equal(d.calf_cm, 31.5);
  });

  test("skinfold and knee height are optional; skinfold gate: yes/no/done", () => {
    assert.deepEqual(applyReply("extra_gate", "done", {}), { finish: true });
    const no = {};
    applyReply("extra_gate", "no", no);
    assert.equal(nextStep("extra_gate", no), "finish");
    const yes = {};
    applyReply("extra_gate", "yes", yes);
    assert.equal(nextStep("extra_gate", yes), "ssf");
    assert.deepEqual(applyReply("ssf", "skip", {}), { advance: true });
    assert.deepEqual(applyReply("kh", "skip", {}), { advance: true });
    assert.ok("error" in applyReply("ssf", "1", {}));
    assert.ok("error" in applyReply("kh", "20", {}));
  });

  test("knee height is only asked after a skinfold was given", () => {
    assert.equal(nextStep("ssf", { ssf_mm: 12 }), "kh");
    assert.equal(nextStep("ssf", {}), "finish");
    assert.equal(nextStep("kh", { ssf_mm: 12, kh_cm: 50 }), "finish");
  });
});

describe("buildEstimateArgs", () => {
  test("arm + calf only", () => {
    assert.deepEqual(buildEstimateArgs({ sex: "female", muac_cm: 27.5, calf_cm: 31.5 }), {
      sex: "female",
      mid_arm_circumference_cm: 27.5,
      calf_circumference_cm: 31.5,
    });
  });

  test("knee height is never sent without the skinfold", () => {
    const a = buildEstimateArgs({ sex: "male", muac_cm: 26, calf_cm: 30, kh_cm: 50 });
    assert.equal("knee_height_cm" in a, false);
    const b = buildEstimateArgs({ sex: "male", muac_cm: 26, calf_cm: 30, ssf_mm: 10, kh_cm: 50 });
    assert.equal(b.subscapular_skinfold_mm, 10);
    assert.equal(b.knee_height_cm, 50);
  });
});

describe("formatWeightEstimateResult", () => {
  test("headlines the most precise equation, lists the others, and states it is only an estimate", () => {
    const text = formatWeightEstimateResult(toolResult(), { muac_cm: 27.5, calf_cm: 31.5, ssf_mm: 12, kh_cm: 50, age_years: 72 });
    assert.match(text, /Woman, 72 years/);
    assert.match(text, /Measurements: arm 27\.5 cm, calf 31\.5 cm, skinfold 12 mm, knee height 50 cm/);
    assert.match(text, /\*≈ 52\.9 kg\* — most precise equation \(standard error ±3\.8 kg\)/);
    assert.match(text, /Less precise: 51\.4 kg \(±4\.21, using arm circumference \+ calf circumference \+ skinfold\); 52\.4 kg/);
    assert.match(text, /An estimate, not a measurement/);
    assert.match(text, /not used to classify malnutrition/);
  });

  test("a single equation has no 'Less precise' line", () => {
    const single = toolResult({ estimates: [toolResult().estimates[2]] });
    assert.doesNotMatch(formatWeightEstimateResult(single, { muac_cm: 27.5, calf_cm: 31.5 }), /Less precise/);
  });

  test("an empty result is reported plainly", () => {
    assert.match(formatWeightEstimateResult({ estimates: [] }, {}), /no estimate/);
  });
});

describe("handleWeightEstimateFlow — end to end with a fake env", () => {
  test("arm + calf only: sends exactly those, no skinfold or knee height", async () => {
    const calls = [];
    const env = makeFakeEnv(toolResult({ estimates: [toolResult().estimates[2]] }), calls);
    const from = "265888400000";
    const say = (t) => handleWeightEstimateFlow(t, from, env);

    assert.match(await say("estimate weight for a bedridden patient"), /man or a woman/);
    assert.match(await say("woman"), /65 and older/);
    assert.match(await say("72 years"), /Mid-upper arm/);
    assert.match(await say("27.5"), /Calf circumference/);
    assert.match(await say("31.5"), /skinfold/);
    const final = await say("no");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "weight_estimate_persons_65_and_older");
    assert.deepEqual(calls[0].args, { sex: "female", mid_arm_circumference_cm: 27.5, calf_circumference_cm: 31.5 });
    assert.match(final, /Estimated body weight \(65\+\)/);
    assert.match(final, /Woman, 72 years/);
    assert.equal(env._rows.size, 0);
  });

  test("with skinfold and knee height: all four measurements are sent", async () => {
    const calls = [];
    const env = makeFakeEnv(toolResult(), calls);
    const from = "265888400001";
    const say = (t) => handleWeightEstimateFlow(t, from, env);
    await say("patient can't be weighed");
    await say("man");
    await say("80");
    await say("265");
    await say("310");
    assert.match(await say("yes"), /Subscapular skinfold in mm/);
    assert.match(await say("12"), /Knee height/);
    await say("50");
    assert.deepEqual(calls[0].args, {
      sex: "male",
      mid_arm_circumference_cm: 26.5,
      calf_circumference_cm: 31,
      subscapular_skinfold_mm: 12,
      knee_height_cm: 50,
    });
  });

  test("skipping the skinfold ends the flow without asking for knee height", async () => {
    const calls = [];
    const env = makeFakeEnv(toolResult({ estimates: [toolResult().estimates[2]] }), calls);
    const from = "265888400002";
    const say = (t) => handleWeightEstimateFlow(t, from, env);
    await say("estimate weight for an elderly patient");
    await say("woman");
    await say("70 years");
    await say("27");
    await say("30");
    await say("yes");
    const final = await say("skip"); // skinfold skipped -> straight to the result
    assert.equal(calls.length, 1);
    assert.equal("knee_height_cm" in calls[0].args, false);
    assert.match(final, /Estimated body weight/);
  });

  test("under 65 is turned away without calling the tool", async () => {
    const calls = [];
    const env = makeFakeEnv(toolResult(), calls);
    const from = "265888400003";
    await handleWeightEstimateFlow("estimate weight for a patient", from, env);
    await handleWeightEstimateFlow("man", from, env);
    const reply = await handleWeightEstimateFlow("50 years", from, env);
    assert.match(reply, /only for people aged 65 and older/);
    assert.match(reply, /weigh them directly/);
    assert.equal(calls.length, 0);
    assert.equal(env._rows.size, 0);
  });

  test("a bad reply reprompts and stays on the step; cancel and unrelated text behave", async () => {
    const env = makeFakeEnv(toolResult());
    const from = "265888400004";
    assert.equal(await handleWeightEstimateFlow("what is in a banana?", from, env), null);
    await handleWeightEstimateFlow("estimate weight for a patient", from, env);
    await handleWeightEstimateFlow("woman", from, env);
    await handleWeightEstimateFlow("70", from, env);
    const reply = await handleWeightEstimateFlow("2", from, env);
    assert.match(reply, /looks off/);
    assert.match(reply, /Mid-upper arm/);
    assert.equal(JSON.parse(env._rows.get(`${from}:weight_estimate`).payload_json).step, "muac");
    assert.match(await handleWeightEstimateFlow("cancel", from, env), /Cancelled/);
    assert.equal(await handleWeightEstimateFlow("hello", from, env), null);
  });

  test("a tool failure is reported plainly and the session is already cleared", async () => {
    const env = makeFakeEnv({});
    env.CHAKUDYA_MCP = { fetch: async () => new Response("nope", { status: 502 }) };
    const from = "265888400005";
    const say = (t) => handleWeightEstimateFlow(t, from, env);
    await say("estimate weight for a patient");
    await say("woman");
    await say("70");
    await say("27");
    await say("30");
    const reply = await say("no");
    assert.match(reply, /couldn't be completed/);
    assert.equal(env._rows.size, 0);
  });
});
