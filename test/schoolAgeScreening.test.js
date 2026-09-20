import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  detectSchoolAgeScreeningTrigger,
  nextStep,
  applyReply,
  buildScreenArgs,
  formatSchoolAgeScreeningResult,
  explainSchoolAgeScreeningResult,
  handleSchoolAgeScreeningFlow,
} from "../src/schoolAgeScreening.js";
import { parseAgeFlexible, parseSex, looksLikeScreeningRequest } from "../src/screeningShared.js";

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
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  };
  return { DB, CHAKUDYA_MCP, CHAKUDYA_MCP_AUTH_TOKEN: "t", _rows: rows };
}

const sampleResult = (over = {}) => ({
  child: { sex: "female", age_days: 2892, age_months: 95, age_years: 7.9, age_source: "age_months" },
  anthropometry: { bmi_for_age: { available: true, bmi: 17.7, status: "overweight", z_score: 1.6, source: "chakudya_api_bmi_for_age" } },
  nacs_classification: {
    ageGroup: "5-17 years",
    overallMalnutritionClassification: "normal",
    indicators: [
      { indicator: "muac", value: "170 mm", classification: "normal", cutoffApplied: "x" },
      { indicator: "bmi_for_age", value: "17.7 kg/m2 (z=1.6) -> overweight", classification: "overweight", cutoffApplied: "y" },
    ],
  },
  nacs_classification_skipped_reason: null,
  screening: { tools_administered: [], tools_skipped: [], strongkids: null },
  recommended_action: { urgency: "routine", action: "No acute malnutrition identified, but BMI-for-age is above the normal range." },
  clinical_flags: [],
  ...over,
});

describe("detectSchoolAgeScreeningTrigger", () => {
  test("matches school-age / adolescent screening requests", () => {
    for (const t of [
      "screen a school child for malnutrition",
      "please screen this adolescent for malnutrition",
      "check BMI for a 9 year old",
      "check muac for a 12-year-old boy",
      "malnutrition screening for a teenager",
      "assess a pupil for malnutrition",
    ]) assert.equal(detectSchoolAgeScreeningTrigger(t), true, t);
  });

  test("does not match ordinary questions or the other flows' phrases", () => {
    for (const t of [
      "what causes malnutrition in school children", // no action word
      "screen a child for malnutrition", // under-5 flow (hands over by age)
      "check muac for my baby",
      "screen a 9 year old child for malnutrition", // has 'child' -> under-5 flow, which hands over by age
      "check BMI for a 3 year old", // under 5
      "screen a pregnant woman for malnutrition",
      "what is a healthy BMI for a 9 year old", // no action word
    ]) assert.equal(detectSchoolAgeScreeningTrigger(t), false, t);
  });
});

describe("parsers", () => {
  test("parseAgeFlexible", () => {
    assert.deepEqual(parseAgeFlexible("8 years"), { age_years: 8 });
    assert.deepEqual(parseAgeFlexible("8y"), { age_years: 8 });
    assert.deepEqual(parseAgeFlexible("96 months"), { age_months: 96 });
    assert.deepEqual(parseAgeFlexible("8 years 3 months"), { age_months: 99 });
    assert.deepEqual(parseAgeFlexible("8y 3m"), { age_months: 99 });
    assert.deepEqual(parseAgeFlexible("2015-04-02"), { date_of_birth: "2015-04-02" });
    assert.equal(parseAgeFlexible("8"), null);
    assert.deepEqual(parseAgeFlexible("8", { bareAsYears: true }), { age_years: 8 });
    assert.equal(parseAgeFlexible("hello", { bareAsYears: true }), null);
  });

  test("parseSex reads boy/girl and does not confuse female with male", () => {
    assert.equal(parseSex("Boy"), "male");
    assert.equal(parseSex("girl"), "female");
    assert.equal(parseSex("female"), "female");
    assert.equal(parseSex("dunno"), null);
  });

  test("looksLikeScreeningRequest needs action + topic + population", () => {
    const pop = /\bteen\b/i;
    assert.equal(looksLikeScreeningRequest("screen a teen for malnutrition", pop), true);
    assert.equal(looksLikeScreeningRequest("a teen and malnutrition", pop), false);
    assert.equal(looksLikeScreeningRequest("screen a teen", pop), false);
  });
});

describe("applyReply / nextStep", () => {
  test("age below 60 months hands off to under-5; 18+ hands off to adult; otherwise advances", () => {
    assert.deepEqual(applyReply("age", "4 years", { sex: "male" }), { handoff: "under5" });
    assert.deepEqual(applyReply("age", "18 years", { sex: "male" }), { handoff: "adult" });
    assert.deepEqual(applyReply("age", "17 years 11 months", { sex: "male" }), { advance: true });
    assert.deepEqual(applyReply("age", "60 months", { sex: "male" }), { advance: true });
    assert.deepEqual(applyReply("age", "7", { sex: "male" }), { advance: true }); // bare number = years here
  });

  test("girls of 10+ are asked about pregnancy; younger girls and boys are not", () => {
    assert.equal(nextStep("age", { sex: "female", age_years: 14 }), "pregnant");
    assert.equal(nextStep("age", { sex: "female", age_years: 9 }), "weight");
    assert.equal(nextStep("age", { sex: "male", age_years: 14 }), "weight");
    assert.equal(nextStep("age", { sex: "female", age_months: 120 }), "pregnant");
  });

  test("pregnant 'yes' hands off to the maternal flow", () => {
    assert.deepEqual(applyReply("pregnant", "yes", {}), { handoff: "pregnant" });
    assert.deepEqual(applyReply("pregnant", "no", {}), { advance: true });
    assert.ok("error" in applyReply("pregnant", "skip", {}));
  });

  test("height/weight guard against unit mix-ups; skip leaves the field unset", () => {
    const d = {};
    assert.ok("error" in applyReply("height", "1.25", d)); // metres
    assert.equal(d.height_cm, undefined);
    assert.ok("error" in applyReply("weight", "2", d));
    assert.deepEqual(applyReply("height", "skip", d), { advance: true });
    assert.equal(d.height_cm, undefined);
    assert.deepEqual(applyReply("height", "125", d), { advance: true });
    assert.equal(d.height_cm, 125);
  });

  test("MUAC accepts mm and cm; oedema tri-state", () => {
    const d = {};
    applyReply("muac", "16cm", d);
    assert.equal(d.muac_mm, 160);
    applyReply("edema", "yes", d);
    assert.equal(d.edema, true);
    const d2 = {};
    applyReply("edema", "skip", d2);
    assert.equal(d2.edema, undefined);
  });

  test("STRONGkids questions cannot be skipped (they would send an incomplete questionnaire)", () => {
    assert.ok("error" in applyReply("sk_clinical", "skip", {}));
  });

  test("optional STRONGkids gate: 'done' finishes, 'no' finishes, 'yes' asks the four questions", () => {
    assert.deepEqual(applyReply("extra_gate", "done", {}), { finish: true });
    const d = {};
    applyReply("extra_gate", "no", d);
    assert.equal(nextStep("extra_gate", d), "finish");
    const d2 = {};
    applyReply("extra_gate", "yes", d2);
    assert.equal(nextStep("extra_gate", d2), "sk_clinical");
    assert.equal(nextStep("sk_intake", d2), "sk_weightloss");
    assert.equal(nextStep("sk_weightloss", d2), "finish");
  });
});

describe("buildScreenArgs", () => {
  test("sends only what was collected — no invented values", () => {
    const args = buildScreenArgs({ sex: "female", age_months: 95, weight_kg: 26 });
    const json = JSON.parse(JSON.stringify(args));
    assert.deepEqual(json, { sex: "female", age_months: 95, weight_kg: 26 });
  });

  test("includes STRONGkids only when all four answers exist", () => {
    const a = buildScreenArgs({ sex: "male", age_years: 9, wantsExtra: true, sk_clinical: true, sk_disease: false, sk_intake: true, sk_weightloss: false });
    assert.deepEqual(a.strongkids, {
      clinical_assessment_poor_nutritional_status: true,
      high_risk_disease: false,
      reduced_intake_or_losses: true,
      weight_loss_or_poor_gain: false,
    });
    assert.equal(buildScreenArgs({ sex: "male", age_years: 9, wantsExtra: true }).strongkids, undefined);
  });
});

describe("formatSchoolAgeScreeningResult", () => {
  test("shows BMI-for-age, NACS status without duplicating the BMI indicator, and the action", () => {
    const text = formatSchoolAgeScreeningResult(sampleResult());
    assert.match(text, /BMI 17\.7 kg\/m², z=1\.6 — overweight/);
    assert.match(text, /Acute malnutrition \(NACS\): NORMAL/);
    assert.match(text, /• muac: 170 mm → normal/);
    assert.equal((text.match(/bmi_for_age/g) || []).length, 0);
    assert.match(text, /Recommended action \(routine\)/);
    assert.match(text, /decision support only/);
  });

  test("says so when the built-in fallback classified BMI-for-age", () => {
    const r = sampleResult();
    r.anthropometry.bmi_for_age.source = "local_who2007_lms";
    assert.match(formatSchoolAgeScreeningResult(r), /built-in WHO 2007 reference/);
  });

  test("reports BMI-for-age unavailable with the reason, and urgent actions with 🚨", () => {
    const r = sampleResult({ recommended_action: { urgency: "urgent", action: "Urgent referral." }, clinical_flags: [{ flag: "nacs_muac:severe", detail: "d" }] });
    r.anthropometry.bmi_for_age = { available: false, reason_unavailable: "weight/height not provided" };
    const text = formatSchoolAgeScreeningResult(r);
    assert.match(text, /not available \(weight\/height not provided\)/);
    assert.match(text, /🚨/);
    assert.match(text, /\*Flags\*\n• nacs_muac:severe/);
  });
});

describe("explainSchoolAgeScreeningResult", () => {
  test("falls back to the deterministic message when there is no Groq key", async () => {
    assert.equal(await explainSchoolAgeScreeningResult(sampleResult(), {}), formatSchoolAgeScreeningResult(sampleResult()));
  });

  test("appends the recommended action verbatim after model text, whatever the model says", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "**Looks fine.** Nothing to do." } }] }), { status: 200 });
    try {
      const text = await explainSchoolAgeScreeningResult(sampleResult(), { GROQ_API_KEY: "k" });
      assert.match(text, /^\*Looks fine\.\* Nothing to do\./);
      assert.match(text, /No acute malnutrition identified, but BMI-for-age is above the normal range\./);
      assert.match(text, /decision support only/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("falls back cleanly on a Groq failure", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("boom", { status: 500 });
    try {
      assert.equal(await explainSchoolAgeScreeningResult(sampleResult(), { GROQ_API_KEY: "k" }), formatSchoolAgeScreeningResult(sampleResult()));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("handleSchoolAgeScreeningFlow — end to end with a fake env", () => {
  test("full flow: trigger -> girl -> 7 years 11 months -> weight/height/skip rest -> tool call -> result", async () => {
    const calls = [];
    const env = makeFakeEnv(sampleResult(), calls);
    const from = "265888100000";
    const say = (t) => handleSchoolAgeScreeningFlow(t, from, env);

    assert.match(await say("please screen a school child for malnutrition"), /boy or a girl/);
    assert.match(await say("girl"), /how old/i);
    assert.match(await say("7 years 11 months"), /weight/i); // girl under 10: no pregnancy question
    assert.match(await say("26"), /height/i);
    assert.match(await say("121.1"), /MUAC/);
    assert.match(await say("skip"), /oedema/);
    assert.match(await say("skip"), /Where is this screening/);
    assert.match(await say("skip"), /STRONGkids/);
    const final = await say("no");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "school_age_integrated_screen");
    assert.deepEqual(calls[0].args, { sex: "female", age_months: 95, weight_kg: 26, height_cm: 121.1 });
    assert.match(final, /School-Age \/ Adolescent Malnutrition Screening Result/);
    assert.equal(env._rows.size, 0); // session cleared
    assert.equal(await say("hello"), null);
  });

  test("cancel clears the session", async () => {
    const env = makeFakeEnv({});
    const from = "265888100001";
    await handleSchoolAgeScreeningFlow("screen an adolescent for malnutrition", from, env);
    assert.match(await handleSchoolAgeScreeningFlow("cancel", from, env), /cancelled/i);
    assert.equal(await handleSchoolAgeScreeningFlow("hello", from, env), null);
  });

  test("an unrelated message with no session is not handled", async () => {
    assert.equal(await handleSchoolAgeScreeningFlow("what is in a banana?", "265888100002", makeFakeEnv({})), null);
  });

  test("age under 5 is turned away toward the under-5 flow and the session ends", async () => {
    const env = makeFakeEnv({});
    const from = "265888100003";
    await handleSchoolAgeScreeningFlow("screen a 9 year old boy for malnutrition", from, env);
    await handleSchoolAgeScreeningFlow("boy", from, env);
    assert.match(await handleSchoolAgeScreeningFlow("3 years", from, env), /screen a child/);
    assert.equal(env._rows.size, 0);
  });

  test("a 10+ year old girl who is pregnant is handed to the maternal flow (MUAC question), not screened for BMI-for-age", async () => {
    const env = makeFakeEnv({});
    const from = "265888100004";
    await handleSchoolAgeScreeningFlow("screen an adolescent for malnutrition", from, env);
    await handleSchoolAgeScreeningFlow("girl", from, env);
    assert.match(await handleSchoolAgeScreeningFlow("15 years", from, env), /pregnant, or has she recently given birth/);
    const reply = await handleSchoolAgeScreeningFlow("yes", from, env);
    assert.match(reply, /maternal screen/);
    assert.match(reply, /pregnant or postpartum woman/);
    assert.ok(env._rows.has(`${from}:pregnant_postpartum_screening`));
    assert.ok(!env._rows.has(`${from}:school_age_screening`));
  });

  test("age 18+ is handed to the adult flow with sex and age carried over", async () => {
    const env = makeFakeEnv({});
    const from = "265888100005";
    await handleSchoolAgeScreeningFlow("screen an adolescent for malnutrition", from, env);
    await handleSchoolAgeScreeningFlow("boy", from, env);
    const reply = await handleSchoolAgeScreeningFlow("19 years", from, env);
    assert.match(reply, /adult screen/);
    assert.match(reply, /weight/i); // sex + age already known, so straight to weight
    const saved = JSON.parse(env._rows.get(`${from}:adult_screening`).payload_json);
    assert.equal(saved.data.sex, "male");
    assert.equal(saved.data.age_years, 19);
  });

  test("a tool failure is reported plainly and the session is already cleared", async () => {
    const env = makeFakeEnv({});
    env.CHAKUDYA_MCP = { fetch: async () => new Response("nope", { status: 502 }) };
    const from = "265888100006";
    const say = (t) => handleSchoolAgeScreeningFlow(t, from, env);
    await say("screen a school child for malnutrition");
    await say("boy");
    await say("9 years");
    for (let i = 0; i < 5; i++) await say("skip"); // weight, height, muac, edema, context
    const reply = await say("no");
    assert.match(reply, /couldn't complete/);
    assert.equal(env._rows.size, 0);
  });
});
