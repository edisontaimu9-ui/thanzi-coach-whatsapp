import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  WEIGHT_CHANGE_SAMPLE_PROMPT,
  detectWeightChangeTrigger,
  parseTimeFrame,
  nextStep,
  applyReply,
  formatWeightChangeResult,
  handleWeightChangeFlow,
} from "../src/weightChangeCheck.js";
import { detectUnder5ScreeningTrigger } from "../src/under5Screening.js";
import { detectPregnantPostpartumScreeningTrigger } from "../src/pregnantPostpartumScreening.js";
import { detectSchoolAgeScreeningTrigger } from "../src/schoolAgeScreening.js";
import { detectAdultScreeningTrigger } from "../src/adultScreening.js";
import { detectWeightEstimateTrigger } from "../src/weightEstimate.js";
import { detectHeightEstimateTrigger } from "../src/heightEstimate.js";
import { detectBmiCheckTrigger } from "../src/bmiCheck.js";
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

const weightChangeResult = (over = {}) => ({
  percent_weight_change: 7.69,
  direction: "loss",
  formula: "% weight change = [(usual weight - current weight) / usual weight] x 100",
  time_frame: undefined,
  significance: undefined,
  ...over,
});

describe("detectWeightChangeTrigger", () => {
  test("matches requests to check/calculate weight change, including the sample prompt", () => {
    for (const t of [
      WEIGHT_CHANGE_SAMPLE_PROMPT,
      "check my weight loss",
      "check percent weight change",
      "calculate weight change",
      "my weight loss",
      "percent weight change",
      "percentage weight gain",
      "how much weight did I lose",
    ]) assert.equal(detectWeightChangeTrigger(t), true, t);
  });

  test("ignores unrelated text and bare 'weight change' with no cue", () => {
    for (const t of ["weight change", "hello", "What foods are high in iron?", ""]) {
      assert.equal(detectWeightChangeTrigger(t), false, t);
    }
  });

  test("does not overlap with any screening trigger, the estimate-flow triggers, the bmi check, or the quick-calculators menu, and vice versa", () => {
    for (const phrase of ["check percent weight change", WEIGHT_CHANGE_SAMPLE_PROMPT]) {
      assert.equal(detectWeightChangeTrigger(phrase), true, phrase);
      assert.equal(detectWeightEstimateTrigger(phrase), false, phrase);
      assert.equal(detectHeightEstimateTrigger(phrase), false, phrase);
      assert.equal(detectBmiCheckTrigger(phrase), false, phrase);
      assert.equal(detectUnder5ScreeningTrigger(phrase), false, phrase);
      assert.equal(detectPregnantPostpartumScreeningTrigger(phrase), false, phrase);
      assert.equal(detectSchoolAgeScreeningTrigger(phrase), false, phrase);
      assert.equal(detectAdultScreeningTrigger(phrase), false, phrase);
      assert.equal(detectScreeningMenuRequest(phrase), false, phrase);
      assert.equal(detectEstimateMenuRequest(phrase), false, phrase);
    }
    for (const t of ["screen an adult for malnutrition", "check my bmi", "quick calculators"]) {
      assert.equal(detectWeightChangeTrigger(t), false, t);
    }
  });

  test("its session kind is cleared with the screening sessions", () => {
    assert.ok(ALL_SCREENING_SESSION_KINDS.includes("weight_change_check"));
  });
});

describe("parseTimeFrame", () => {
  test("accepts the four supported frames in several phrasings", () => {
    for (const t of ["1 week", "1week", "one week", "7 days"]) assert.equal(parseTimeFrame(t), "1_week", t);
    for (const t of ["1 month", "one month", "4 weeks", "30 days"]) assert.equal(parseTimeFrame(t), "1_month", t);
    for (const t of ["3 months", "three months", "90 days"]) assert.equal(parseTimeFrame(t), "3_months", t);
    for (const t of ["6 months", "six months", "180 days"]) assert.equal(parseTimeFrame(t), "6_months", t);
  });

  test("rejects anything else", () => {
    for (const t of ["2 weeks", "a while ago", "yesterday", ""]) assert.equal(parseTimeFrame(t), null, t);
  });
});

describe("step machine", () => {
  test("current -> usual -> timeframe -> finish", () => {
    assert.equal(nextStep("current"), "usual");
    assert.equal(nextStep("usual"), "timeframe");
    assert.equal(nextStep("timeframe"), "finish");
  });
});

describe("applyReply", () => {
  test("current/usual weight are required and range-checked", () => {
    assert.ok("error" in applyReply("current", "abc"));
    assert.ok("error" in applyReply("current", "1"));
    assert.deepEqual(applyReply("current", "58"), { advance: true, value: 58 });
    assert.ok("error" in applyReply("usual", "500"));
    assert.deepEqual(applyReply("usual", "65"), { advance: true, value: 65 });
  });

  test("timeframe accepts skip or one of the four frames, rejects anything else", () => {
    assert.deepEqual(applyReply("timeframe", "skip"), { advance: true, value: undefined });
    assert.deepEqual(applyReply("timeframe", "3 months"), { advance: true, value: "3_months" });
    assert.ok("error" in applyReply("timeframe", "sometime last year"));
  });
});

describe("formatWeightChangeResult", () => {
  test("weight loss with no time frame: no significance line", () => {
    const text = formatWeightChangeResult(weightChangeResult(), { current_weight_kg: 60, usual_weight_kg: 65 });
    assert.match(text, /Usual 65 kg → current 60 kg/);
    assert.match(text, /\*7\.69% weight loss\*$/m);
    assert.doesNotMatch(text, /significant|severe/i);
  });

  test("weight gain is labelled as gain, not a negative loss", () => {
    const text = formatWeightChangeResult(weightChangeResult({ percent_weight_change: -5, direction: "gain" }), { current_weight_kg: 68, usual_weight_kg: 65 });
    assert.match(text, /\*5% weight gain\*/);
  });

  test("with a time frame: shows the time frame and significance", () => {
    const text = formatWeightChangeResult(weightChangeResult({ time_frame: "3 months", significance: "Significant weight loss" }), {
      current_weight_kg: 60,
      usual_weight_kg: 65,
    });
    assert.match(text, /over 3 months/);
    assert.match(text, /\*Significant weight loss\*/);
  });

  test("no change is labelled plainly", () => {
    const text = formatWeightChangeResult(weightChangeResult({ percent_weight_change: 0, direction: "no change" }), { current_weight_kg: 65, usual_weight_kg: 65 });
    assert.match(text, /\*0% no change\*/);
  });

  test("an empty result is reported plainly", () => {
    assert.match(formatWeightChangeResult(null, {}), /No percent weight change could be calculated/);
  });
});

describe("handleWeightChangeFlow — end to end with a fake env", () => {
  test("current -> usual -> timeframe -> result, sends time_frame to the tool", async () => {
    const calls = [];
    const env = makeFakeEnv({ percent_weight_change_calculator: weightChangeResult({ time_frame: "3 months", significance: "Significant weight loss" }) }, calls);
    const from = "265888700000";
    const say = (t) => handleWeightChangeFlow(t, from, env);

    assert.match(await say("check percent weight change"), /CURRENT weight/);
    assert.match(await say("60"), /USUAL \(baseline\) weight/);
    assert.match(await say("65"), /time frame/);
    const final = await say("3 months");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "percent_weight_change_calculator");
    assert.deepEqual(calls[0].args, { current_weight_kg: 60, usual_weight_kg: 65, time_frame: "3_months" });
    assert.match(final, /Percent weight change/);
    assert.match(final, /Significant weight loss/);
    assert.equal(env._rows.size, 0);
  });

  test("skipping the time frame omits it from the tool call", async () => {
    const calls = [];
    const env = makeFakeEnv({ percent_weight_change_calculator: weightChangeResult() }, calls);
    const from = "265888700001";
    const say = (t) => handleWeightChangeFlow(t, from, env);

    await say("check percent weight change");
    await say("60");
    await say("65");
    await say("skip");

    assert.deepEqual(calls[0].args, { current_weight_kg: 60, usual_weight_kg: 65 });
  });

  test("a bad reply reprompts and stays on the step; cancel and unrelated text behave", async () => {
    const env = makeFakeEnv({});
    const from = "265888700002";
    assert.equal(await handleWeightChangeFlow("what is in a banana?", from, env), null);
    await handleWeightChangeFlow("check percent weight change", from, env);
    const reply = await handleWeightChangeFlow("banana", from, env);
    assert.match(reply, /kilograms/);
    assert.equal(JSON.parse(env._rows.get(`${from}:weight_change_check`).payload_json).step, "current");
    assert.match(await handleWeightChangeFlow("cancel", from, env), /Cancelled/);
    assert.equal(await handleWeightChangeFlow("hello", from, env), null);
  });

  test("tool failure is reported plainly and the session is already cleared", async () => {
    const env = makeFakeEnv({ percent_weight_change_calculator: new Error("x") });
    const from = "265888700003";
    const say = (t) => handleWeightChangeFlow(t, from, env);
    await say("check percent weight change");
    await say("60");
    await say("65");
    const reply = await say("skip");
    assert.match(reply, /couldn't be completed/);
    assert.equal(env._rows.size, 0);
  });
});
