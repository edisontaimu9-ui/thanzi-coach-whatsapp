import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BMI_CHECK_SAMPLE_PROMPT,
  detectBmiCheckTrigger,
  nextStep,
  applyReply,
  formatBmiResult,
  handleBmiCheckFlow,
} from "../src/bmiCheck.js";
import { detectUnder5ScreeningTrigger } from "../src/under5Screening.js";
import { detectPregnantPostpartumScreeningTrigger } from "../src/pregnantPostpartumScreening.js";
import { detectSchoolAgeScreeningTrigger } from "../src/schoolAgeScreening.js";
import { detectAdultScreeningTrigger } from "../src/adultScreening.js";
import { detectWeightEstimateTrigger } from "../src/weightEstimate.js";
import { detectHeightEstimateTrigger } from "../src/heightEstimate.js";
import { detectScreeningMenuRequest } from "../src/screeningMenu.js";
import { detectEstimateMenuRequest } from "../src/estimateMenu.js";
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

const bmiResult = (over = {}) => ({
  bmi: 22.8,
  who_2000: { classification: "Normal", risk_of_comorbidities: "Average risk" },
  ncst_2015: { classification: "Normal" },
  ...over,
});

describe("detectBmiCheckTrigger", () => {
  test("matches requests to check/calculate a BMI, including the sample prompt", () => {
    for (const t of [
      BMI_CHECK_SAMPLE_PROMPT,
      "check my bmi",
      "Check my BMI!",
      "what's my bmi",
      "what is my bmi",
      "calculate bmi",
      "bmi check",
      "quick bmi",
      "bmi for a patient",
      "bmi of 24",
    ]) assert.equal(detectBmiCheckTrigger(t), true, t);
  });

  test("ignores bare definitional questions and unrelated text", () => {
    for (const t of ["what is bmi", "how is bmi calculated", "explain bmi", "hello", "What foods are high in iron?", ""]) {
      assert.equal(detectBmiCheckTrigger(t), false, t);
    }
  });

  test("does not overlap with any screening trigger, the estimate-flow triggers, or the quick-calculators menu, and vice versa", () => {
    for (const phrase of ["check my bmi", BMI_CHECK_SAMPLE_PROMPT]) {
      assert.equal(detectBmiCheckTrigger(phrase), true, phrase);
      assert.equal(detectWeightEstimateTrigger(phrase), false, phrase);
      assert.equal(detectHeightEstimateTrigger(phrase), false, phrase);
      assert.equal(detectUnder5ScreeningTrigger(phrase), false, phrase);
      assert.equal(detectPregnantPostpartumScreeningTrigger(phrase), false, phrase);
      assert.equal(detectSchoolAgeScreeningTrigger(phrase), false, phrase);
      assert.equal(detectAdultScreeningTrigger(phrase), false, phrase);
      assert.equal(detectScreeningMenuRequest(phrase), false, phrase);
      assert.equal(detectEstimateMenuRequest(phrase), false, phrase);
    }
    for (const t of ["screen an adult for malnutrition", "check muac for an elderly patient", "quick calculators"]) {
      assert.equal(detectBmiCheckTrigger(t), false, t);
    }
  });

  test("its session kind is cleared with the screening sessions", () => {
    assert.ok(ALL_SCREENING_SESSION_KINDS.includes("bmi_check"));
  });
});

describe("step machine", () => {
  test("weight -> height -> finish", () => {
    assert.equal(nextStep("weight"), "height");
    assert.equal(nextStep("height"), "finish");
  });
});

describe("applyReply", () => {
  test("weight and height are required and range-checked", () => {
    assert.ok("error" in applyReply("weight", "abc"));
    assert.ok("error" in applyReply("weight", "1")); // below plausibility floor
    assert.ok("error" in applyReply("weight", "500")); // above plausibility ceiling
    assert.deepEqual(applyReply("weight", "62"), { advance: true, value: 62 });

    assert.ok("error" in applyReply("height", "10")); // below plausibility floor
    assert.ok("error" in applyReply("height", "300")); // above plausibility ceiling
    assert.deepEqual(applyReply("height", "165"), { advance: true, value: 165 });
  });
});

describe("formatBmiResult", () => {
  test("shows the BMI value and both classification bands", () => {
    const text = formatBmiResult(bmiResult(), { weight_kg: 62, height_cm: 165 });
    assert.match(text, /Weight 62 kg, height 165 cm/);
    assert.match(text, /\*BMI 22\.8\*/);
    assert.match(text, /WHO 2000: Normal \(average risk\)/);
    assert.match(text, /Malawi NCST 2015: Normal/);
    assert.doesNotMatch(text, /⚠️/);
  });

  test("flags a note when the height suggests a child", () => {
    const text = formatBmiResult(bmiResult({ bmi: 15.2, who_2000: { classification: "Severe thinness", risk_of_comorbidities: "Low risk" }, ncst_2015: { classification: "Severe acute malnutrition (SAM) — check for medical complications" } }), {
      weight_kg: 25,
      height_cm: 125,
    });
    assert.match(text, /⚠️.*adult BMI bands.*child this height/);
    assert.match(text, /screen a child for malnutrition/);
  });

  test("no warning for an adult-height result", () => {
    const text = formatBmiResult(bmiResult(), { weight_kg: 62, height_cm: 165 });
    assert.doesNotMatch(text, /child this height/);
  });

  test("an empty result is reported plainly", () => {
    assert.match(formatBmiResult(null, {}), /No BMI could be calculated/);
  });
});

describe("handleBmiCheckFlow — end to end with a fake env", () => {
  test("weight -> height -> result", async () => {
    const calls = [];
    const env = makeFakeEnv({ bmi_classification: bmiResult() }, calls);
    const from = "265888600000";
    const say = (t) => handleBmiCheckFlow(t, from, env);

    assert.match(await say("check my bmi"), /weight in kilograms/);
    assert.match(await say("62"), /height in centimetres/);
    const final = await say("165");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "bmi_classification");
    assert.deepEqual(calls[0].args, { weight_kg: 62, height_cm: 165 });
    assert.match(final, /BMI check/);
    assert.match(final, /BMI 22\.8/);
    assert.equal(env._rows.size, 0);
  });

  test("a bad reply reprompts and stays on the step; cancel and unrelated text behave", async () => {
    const env = makeFakeEnv({});
    const from = "265888600001";
    assert.equal(await handleBmiCheckFlow("what is in a banana?", from, env), null);
    await handleBmiCheckFlow("check my bmi", from, env);
    const reply = await handleBmiCheckFlow("banana", from, env);
    assert.match(reply, /kilograms/);
    assert.equal(JSON.parse(env._rows.get(`${from}:bmi_check`).payload_json).step, "weight");
    assert.match(await handleBmiCheckFlow("cancel", from, env), /Cancelled/);
    assert.equal(await handleBmiCheckFlow("hello", from, env), null);
  });

  test("tool failure is reported plainly and the session is already cleared", async () => {
    const env = makeFakeEnv({ bmi_classification: new Error("x") });
    const from = "265888600002";
    const say = (t) => handleBmiCheckFlow(t, from, env);
    await say("check my bmi");
    await say("62");
    const reply = await say("165");
    assert.match(reply, /couldn't be completed/);
    assert.equal(env._rows.size, 0);
  });
});
