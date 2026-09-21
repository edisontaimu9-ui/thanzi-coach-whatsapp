import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  promptFor,
  nextStep,
  applyReply,
  formatRefeedingRiskResult,
  beginAdultRefeedingRisk,
  handleAdultRefeedingRiskFlow,
} from "../src/adultRefeedingRisk.js";
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

const riskResult = (over = {}) => ({
  population: "adults 18y+",
  criteria: [
    { criterion: "bmi", level: "significant", basis: "BMI 15.4: moderate 16-18.5, significant <16" },
    { criterion: "caloric_intake", level: "moderate", basis: "Clinician-assessed per Table 3 caloric intake pattern" },
    { criterion: "prefeeding_electrolyte_abnormality", level: "none", basis: "Clinician-assessed per Table 3 electrolyte abnormality pattern" },
  ],
  overallRisk: "significant",
  rule: "Significant risk needs only 1 criterion at 'significant'; moderate risk needs 2 criteria at 'moderate' or higher. ASPEN provides no 'mild risk' category for adults by design.",
  ...over,
});

describe("its session kind is cleared with the screening sessions", () => {
  test("adult_refeeding_risk is in ALL_SCREENING_SESSION_KINDS", () => {
    assert.ok(ALL_SCREENING_SESSION_KINDS.includes("adult_refeeding_risk"));
  });
});

describe("promptFor", () => {
  test("gate shows the severity in the question", () => {
    assert.match(promptFor("gate", { severity: "severe" }), /\*SEVERE\* result/);
    assert.match(promptFor("gate", { severity: "moderate" }), /\*MODERATE\* result/);
  });

  test("intake and electrolytes give a 1/2/3 choice", () => {
    assert.match(promptFor("intake"), /Reply 1, 2, or 3\./);
    assert.match(promptFor("electrolytes"), /Reply 1, 2, or 3\./);
  });
});

describe("step machine", () => {
  test("gate -> intake -> electrolytes -> finish when accepted", () => {
    assert.equal(nextStep("gate", { wantsCheck: true }), "intake");
    assert.equal(nextStep("intake", {}), "electrolytes");
    assert.equal(nextStep("electrolytes", {}), "finish");
  });

  test("gate -> finish immediately when declined", () => {
    assert.equal(nextStep("gate", { wantsCheck: false }), "finish");
  });
});

describe("applyReply", () => {
  test("gate requires yes/no", () => {
    assert.ok("error" in applyReply("gate", "maybe", {}));
    const yes = {};
    assert.deepEqual(applyReply("gate", "yes", yes), { advance: true });
    assert.equal(yes.wantsCheck, true);
    const no = {};
    assert.deepEqual(applyReply("gate", "no", no), { advance: true });
    assert.equal(no.wantsCheck, false);
  });

  test("intake/electrolytes accept 1/2/3, mapping to moderate/significant/none", () => {
    assert.ok("error" in applyReply("intake", "4", {}));
    assert.ok("error" in applyReply("intake", "yes", {}));
    const a = {};
    applyReply("intake", "1", a);
    assert.equal(a.caloric_intake_level, "moderate");
    const b = {};
    applyReply("intake", "2", b);
    assert.equal(b.caloric_intake_level, "significant");
    const c = {};
    applyReply("intake", "3", c);
    assert.equal(c.caloric_intake_level, "none");

    const d = {};
    applyReply("electrolytes", "2", d);
    assert.equal(d.prefeeding_electrolyte_abnormality_level, "significant");
  });
});

describe("formatRefeedingRiskResult", () => {
  test("shows each criterion, the overall risk, and the rule", () => {
    const text = formatRefeedingRiskResult(riskResult());
    assert.match(text, /BMI: significant/);
    assert.match(text, /Caloric intake pattern: moderate/);
    assert.match(text, /Prefeeding electrolyte abnormality: none/);
    assert.match(text, /⚠️ SIGNIFICANT RISK for refeeding syndrome/);
    assert.match(text, /Significant risk needs only 1 criterion/);
  });

  test("moderate and not-at-risk labels", () => {
    assert.match(formatRefeedingRiskResult(riskResult({ overallRisk: "moderate" })), /⚠️ MODERATE RISK/);
    assert.match(formatRefeedingRiskResult(riskResult({ overallRisk: "not_at_risk_by_these_criteria" })), /Not at risk by these criteria/);
  });

  test("an empty result is reported plainly", () => {
    assert.match(formatRefeedingRiskResult(null), /No refeeding risk could be calculated/);
  });
});

describe("beginAdultRefeedingRisk + handleAdultRefeedingRiskFlow — end to end with a fake env", () => {
  test("has no cold-start trigger: returns null with no session", async () => {
    const env = makeFakeEnv({});
    assert.equal(await handleAdultRefeedingRiskFlow("check refeeding risk", "265888800000", env), null);
    assert.equal(await handleAdultRefeedingRiskFlow("yes", "265888800000", env), null);
  });

  test("full accept path: gate -> intake -> electrolytes -> result, BMI carried over from the screen", async () => {
    const calls = [];
    const env = makeFakeEnv({ aspen_refeeding_risk_adult: riskResult() }, calls);
    const from = "265888800001";

    const gate = await beginAdultRefeedingRisk(from, env, { bmi: 15.4, severity: "severe" });
    assert.match(gate, /\*SEVERE\* result/);
    assert.match(gate, /ASPEN refeeding syndrome risk/);

    const say = (t) => handleAdultRefeedingRiskFlow(t, from, env);
    assert.match(await say("yes"), /Caloric intake pattern/);
    assert.match(await say("1"), /Prefeeding electrolytes/);
    const final = await say("3");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "aspen_refeeding_risk_adult");
    assert.deepEqual(calls[0].args, { bmi: 15.4, caloric_intake_level: "moderate", prefeeding_electrolyte_abnormality_level: "none" });
    assert.match(final, /ASPEN refeeding syndrome risk \(adult\)/);
    assert.match(final, /SIGNIFICANT RISK/);
    assert.equal(env._rows.size, 0);
  });

  test("declining the gate ends the follow-up with no tool call", async () => {
    const calls = [];
    const env = makeFakeEnv({}, calls);
    const from = "265888800002";
    await beginAdultRefeedingRisk(from, env, { bmi: 20, severity: "moderate" });
    const reply = await handleAdultRefeedingRiskFlow("no", from, env);
    assert.match(reply, /No problem/);
    assert.equal(calls.length, 0);
    assert.equal(env._rows.size, 0);
  });

  test("no BMI available (e.g. no height): the tool call omits it", async () => {
    const calls = [];
    const env = makeFakeEnv({ aspen_refeeding_risk_adult: riskResult() }, calls);
    const from = "265888800003";
    await beginAdultRefeedingRisk(from, env, { bmi: null, severity: "severe" });
    const say = (t) => handleAdultRefeedingRiskFlow(t, from, env);
    await say("yes");
    await say("2");
    await say("1");
    assert.deepEqual(calls[0].args, { caloric_intake_level: "significant", prefeeding_electrolyte_abnormality_level: "moderate" });
  });

  test("a bad reply reprompts and stays on the step; cancel behaves", async () => {
    const env = makeFakeEnv({});
    const from = "265888800004";
    await beginAdultRefeedingRisk(from, env, { bmi: 17, severity: "moderate" });
    const reply = await handleAdultRefeedingRiskFlow("maybe", from, env);
    assert.match(reply, /yes.*no/i);
    assert.equal(JSON.parse(env._rows.get(`${from}:adult_refeeding_risk`).payload_json).step, "gate");
    assert.match(await handleAdultRefeedingRiskFlow("cancel", from, env), /Cancelled/);
    assert.equal(env._rows.size, 0);
  });

  test("tool failure is reported plainly and the session is already cleared", async () => {
    const env = makeFakeEnv({ aspen_refeeding_risk_adult: new Error("x") });
    const from = "265888800005";
    await beginAdultRefeedingRisk(from, env, { bmi: 15, severity: "severe" });
    const say = (t) => handleAdultRefeedingRiskFlow(t, from, env);
    await say("yes");
    await say("1");
    const reply = await say("1");
    assert.match(reply, /couldn't be completed/);
    assert.equal(env._rows.size, 0);
  });
});
