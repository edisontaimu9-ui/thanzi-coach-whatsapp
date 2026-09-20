import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  detectAdultScreeningTrigger,
  nextStep,
  applyReply,
  buildScreenArgs,
  formatAdultScreeningResult,
  explainAdultScreeningResult,
  handleAdultScreeningFlow,
  beginAdultScreening,
} from "../src/adultScreening.js";

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
  person: { sex: "male", age_years: 45, age_source: "age_years", older_adult: false },
  measurements: { bmi: 15.4 },
  nacs_classification: {
    population: "adults 18+ (non-pregnant/non-postpartum)",
    overallMalnutritionClassification: "severe",
    indicators: [{ indicator: "bmi", value: "15.4", classification: "severe", cutoffApplied: "x" }],
  },
  nacs_classification_skipped_reason: null,
  screening: { tools_administered: [], tools_skipped: [], must: null },
  recommended_action: { urgency: "urgent", action: "Urgent referral to a qualified health worker." },
  clinical_flags: [],
  ...over,
});

describe("detectAdultScreeningTrigger", () => {
  test("matches adult screening requests", () => {
    for (const t of [
      "screen an adult for malnutrition",
      "please check muac for an elderly patient",
      "malnutrition screening for a woman",
      "assess my grandmother for malnutrition",
      "check BMI for a 45 year old",
      "screen a man for malnutrition",
    ]) assert.equal(detectAdultScreeningTrigger(t), true, t);
  });

  test("does not match general questions or under-18 phrases", () => {
    for (const t of [
      "what causes malnutrition in women", // no action word
      "screen a child for malnutrition",
      "check BMI for a 9 year old",
      "hello",
      "how do I cook nsima",
    ]) assert.equal(detectAdultScreeningTrigger(t), false, t);
  });
});

describe("applyReply / nextStep", () => {
  test("under 18 hands off as 'underage'; 18+ advances; bare number counts as years", () => {
    assert.deepEqual(applyReply("age", "17 years", { sex: "male" }), { handoff: "underage" });
    assert.deepEqual(applyReply("age", "18 years", { sex: "male" }), { advance: true });
    assert.deepEqual(applyReply("age", "45", { sex: "male" }), { advance: true });
  });

  test("women under 50 are asked about pregnancy; men and women 50+ are not", () => {
    assert.equal(nextStep("age", { sex: "female", age_years: 30 }), "pregnant");
    assert.equal(nextStep("age", { sex: "female", age_years: 55 }), "weight");
    assert.equal(nextStep("age", { sex: "male", age_years: 30 }), "weight");
  });

  test("pregnant 'yes' hands off to the maternal flow", () => {
    assert.deepEqual(applyReply("pregnant", "yes", {}), { handoff: "pregnant" });
    assert.deepEqual(applyReply("pregnant", "no", {}), { advance: true });
  });

  test("weight/height guard against unit mix-ups", () => {
    assert.ok("error" in applyReply("height", "1.65", {}));
    assert.ok("error" in applyReply("weight", "5", {}));
    const d = {};
    assert.deepEqual(applyReply("weight", "58.5", d), { advance: true });
    assert.equal(d.weight_kg, 58.5);
  });

  test("weight-loss question is tri-state and never invents a value on skip", () => {
    const d = {};
    applyReply("weight_loss", "skip", d);
    assert.equal(d.confirmed_weight_loss_over_10_percent, undefined);
    applyReply("weight_loss", "yes", d);
    assert.equal(d.confirmed_weight_loss_over_10_percent, true);
  });

  test("MUST is only offered when both weight and height were given", () => {
    assert.equal(nextStep("context", { weight_kg: 60, height_cm: 170 }), "must_gate");
    assert.equal(nextStep("context", { weight_kg: 60 }), "finish");
    assert.equal(nextStep("context", {}), "finish");
  });

  test("MUST gate and questions: bands 1/2/3, yes/no, cannot skip the scored questions", () => {
    assert.deepEqual(applyReply("must_gate", "done", {}), { finish: true });
    const d = {};
    applyReply("must_gate", "yes", d);
    assert.equal(nextStep("must_gate", d), "must_wl");
    applyReply("must_wl", "2", d);
    assert.equal(d.must_weight_loss_band, "5_to_10_percent");
    applyReply("must_wl", "more than 10%", d);
    assert.equal(d.must_weight_loss_band, "gt_10_percent");
    applyReply("must_wl", "1", d);
    assert.equal(d.must_weight_loss_band, "lt_5_percent");
    assert.ok("error" in applyReply("must_wl", "skip", d));
    assert.ok("error" in applyReply("must_wl", "maybe", d));
    assert.equal(nextStep("must_wl", d), "must_acute");
    assert.ok("error" in applyReply("must_acute", "skip", d));
    assert.deepEqual(applyReply("must_acute", "yes", d), { advance: true });
    assert.equal(nextStep("must_acute", d), "finish");
  });
});

describe("buildScreenArgs", () => {
  test("sends only what was collected", () => {
    const json = JSON.parse(JSON.stringify(buildScreenArgs({ sex: "male", age_years: 45, weight_kg: 60, height_cm: 170 })));
    assert.deepEqual(json, { sex: "male", age_years: 45, weight_kg: 60, height_cm: 170 });
  });

  test("includes MUST only when both answers exist", () => {
    const full = buildScreenArgs({ sex: "male", age_years: 45, wantsMust: true, must_weight_loss_band: "5_to_10_percent", must_acute: false });
    assert.deepEqual(full.must, { weight_loss_band: "5_to_10_percent", acute_disease_no_intake_over_5_days: false });
    assert.equal(buildScreenArgs({ sex: "male", age_years: 45, wantsMust: true, must_weight_loss_band: "lt_5_percent" }).must, undefined);
  });
});

describe("formatAdultScreeningResult", () => {
  test("shows NACS status, indicators, BMI and the action", () => {
    const text = formatAdultScreeningResult(sampleResult());
    assert.match(text, /Adult: 45 years, man, BMI 15\.4/);
    assert.match(text, /Acute malnutrition \(NACS\): SEVERE/);
    assert.match(text, /• bmi: 15\.4 → severe/);
    assert.match(text, /🚨 \*Recommended action \(urgent\)\*/);
    assert.match(text, /manage the person/);
  });

  test("shows MUST on a separate axis and the older-adult caveat", () => {
    const text = formatAdultScreeningResult(
      sampleResult({
        person: { sex: "female", age_years: 72, age_source: "age_years", older_adult: true },
        screening: { tools_administered: ["must"], tools_skipped: [], must: { total_score: 2, risk_category: "high" } },
      })
    );
    assert.match(text, /woman/);
    assert.match(text, /\*Risk screening\*\n• MUST: score 2 — high risk/);
    assert.match(text, /not age-adjusted/);
  });

  test("says so plainly when nothing could be classified", () => {
    const text = formatAdultScreeningResult(sampleResult({ nacs_classification: null, measurements: { bmi: null }, recommended_action: { urgency: "routine", action: "Not enough measurements." } }));
    assert.match(text, /not computed/);
    assert.doesNotMatch(text, /BMI /);
  });
});

describe("explainAdultScreeningResult", () => {
  test("no Groq key -> deterministic message", async () => {
    assert.equal(await explainAdultScreeningResult(sampleResult(), {}), formatAdultScreeningResult(sampleResult()));
  });

  test("model text never replaces the recommended action", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "All good, no action needed." } }] }), { status: 200 });
    try {
      const text = await explainAdultScreeningResult(sampleResult(), { GROQ_API_KEY: "k" });
      assert.match(text, /^All good, no action needed\./);
      assert.match(text, /Urgent referral to a qualified health worker\./);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("handleAdultScreeningFlow — end to end with a fake env", () => {
  test("full flow for a man with MUST: trigger -> answers -> tool call with exactly the supplied fields", async () => {
    const calls = [];
    const env = makeFakeEnv(sampleResult(), calls);
    const from = "265888200000";
    const say = (t) => handleAdultScreeningFlow(t, from, env);

    assert.match(await say("please screen an adult for malnutrition"), /man or a woman/);
    assert.match(await say("man"), /how old/i);
    assert.match(await say("45 years"), /weight/i); // men are not asked about pregnancy
    assert.match(await say("48"), /height/i);
    assert.match(await say("170"), /MUAC/);
    assert.match(await say("skip"), /oedema/);
    assert.match(await say("no"), /more than 10%/);
    assert.match(await say("no"), /Where is this screening/);
    assert.match(await say("4"), /MUST/);
    assert.match(await say("yes"), /Q1\/2/);
    assert.match(await say("3"), /Q2\/2/);
    const final = await say("yes");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "adult_integrated_screen");
    assert.deepEqual(calls[0].args, {
      sex: "male",
      age_years: 45,
      weight_kg: 48,
      height_cm: 170,
      edema: false,
      confirmed_weight_loss_over_10_percent: false,
      measurement_context: "hospital",
      must: { weight_loss_band: "gt_10_percent", acute_disease_no_intake_over_5_days: true },
    });
    assert.match(final, /Adult Malnutrition Screening Result/);
    assert.equal(env._rows.size, 0);
  });

  test("without weight and height MUST is not offered and the screen runs after the context step", async () => {
    const calls = [];
    const env = makeFakeEnv(sampleResult(), calls);
    const from = "265888200001";
    const say = (t) => handleAdultScreeningFlow(t, from, env);
    await say("screen an adult for malnutrition");
    await say("man");
    await say("60");
    for (let i = 0; i < 2; i++) await say("skip"); // weight, height
    await say("230"); // muac
    await say("skip"); // edema
    await say("skip"); // weight loss
    const final = await say("skip"); // context -> finish (no MUST gate)
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, { sex: "male", age_years: 60, muac_mm: 230 });
    assert.match(final, /Adult Malnutrition Screening Result/);
  });

  test("under 18 is turned away toward the other flows", async () => {
    const env = makeFakeEnv({});
    const from = "265888200002";
    await handleAdultScreeningFlow("screen an adult for malnutrition", from, env);
    await handleAdultScreeningFlow("woman", from, env);
    const reply = await handleAdultScreeningFlow("16 years", from, env);
    assert.match(reply, /screen a school child/);
    assert.equal(env._rows.size, 0);
  });

  test("a woman under 50 who is pregnant is handed to the maternal flow", async () => {
    const env = makeFakeEnv({});
    const from = "265888200003";
    await handleAdultScreeningFlow("screen a woman for malnutrition", from, env);
    await handleAdultScreeningFlow("woman", from, env);
    assert.match(await handleAdultScreeningFlow("28 years", from, env), /pregnant, or has she recently given birth/);
    const reply = await handleAdultScreeningFlow("yes", from, env);
    assert.match(reply, /maternal screen/);
    assert.ok(env._rows.has(`${from}:pregnant_postpartum_screening`));
    assert.ok(!env._rows.has(`${from}:adult_screening`));
  });

  test("cancel and unrelated messages", async () => {
    const env = makeFakeEnv({});
    const from = "265888200004";
    assert.equal(await handleAdultScreeningFlow("what is in a banana?", from, env), null);
    await handleAdultScreeningFlow("screen an adult for malnutrition", from, env);
    assert.match(await handleAdultScreeningFlow("cancel", from, env), /cancelled/i);
    assert.equal(await handleAdultScreeningFlow("hello", from, env), null);
  });

  test("beginAdultScreening carries sex and age over and skips straight to the next question", async () => {
    const env = makeFakeEnv({});
    const reply = await beginAdultScreening("265888200005", env, { sex: "female", age_years: 60, weight_kg: 99 });
    assert.match(reply, /adult screen/);
    assert.match(reply, /weight/i); // woman aged 60 is not asked about pregnancy
    const saved = JSON.parse(env._rows.get("265888200005:adult_screening").payload_json);
    assert.equal(saved.data.weight_kg, undefined); // only sex/age fields are carried, nothing else
  });
});

describe("height estimated from ulna length", () => {
  test("the ulna question is asked only when weight was given but standing height was skipped", () => {
    assert.equal(nextStep("height", { weight_kg: 50 }), "ulna");
    assert.equal(nextStep("height", { weight_kg: 50, height_cm: 165 }), "muac");
    assert.equal(nextStep("height", {}), "muac"); // no weight: an estimated height could not produce a BMI
    assert.equal(nextStep("ulna", { weight_kg: 50 }), "muac");
  });

  test("ulna reply: accepts 18.5-32 cm, rejects out-of-table values with a clear prompt, skip leaves it unset", () => {
    const d = {};
    assert.deepEqual(applyReply("ulna", "26.5", d), { advance: true });
    assert.equal(d.ulna_length_cm, 26.5);
    for (const bad of ["17", "40", "265"]) {
      const r = applyReply("ulna", bad, {});
      assert.ok("error" in r, bad);
      assert.match(r.error, /18\.5 to 32/);
    }
    assert.ok("error" in applyReply("ulna", "abc", {}));
    const d2 = {};
    assert.deepEqual(applyReply("ulna", "skip", d2), { advance: true });
    assert.equal(d2.ulna_length_cm, undefined);
  });

  test("the MUST offer follows an estimable height, not only a measured one", () => {
    assert.equal(nextStep("context", { weight_kg: 50, ulna_length_cm: 26 }), "must_gate");
    assert.equal(nextStep("context", { weight_kg: 50 }), "finish");
    assert.equal(nextStep("context", { ulna_length_cm: 26 }), "finish"); // no weight, still no BMI
  });

  test("buildScreenArgs sends ulna_length_cm and only when collected", () => {
    const withUlna = JSON.parse(JSON.stringify(buildScreenArgs({ sex: "male", age_years: 70, weight_kg: 50, ulna_length_cm: 26.5 })));
    assert.deepEqual(withUlna, { sex: "male", age_years: 70, weight_kg: 50, ulna_length_cm: 26.5 });
    assert.equal("ulna_length_cm" in JSON.parse(JSON.stringify(buildScreenArgs({ sex: "male", age_years: 70 }))), false);
  });

  test("the result names the estimate and adds the caveat; measured heights get neither", () => {
    const estimated = formatAdultScreeningResult(
      sampleResult({ measurements: { bmi: 20, height_cm: 173, height_source: "ulna_length" } })
    );
    assert.match(estimated, /Height: 173 cm — _estimated from ulna length, not measured_/);
    assert.match(estimated, /BMI is based on an estimated height/);

    const knee = formatAdultScreeningResult(sampleResult({ measurements: { bmi: 17, height_cm: 162.9, height_source: "knee_height" } }));
    assert.match(knee, /estimated from knee height/);

    const measured = formatAdultScreeningResult(sampleResult({ measurements: { bmi: 20, height_cm: 170, height_source: "measured" } }));
    assert.doesNotMatch(measured, /estimated/i);
    const none = formatAdultScreeningResult(sampleResult());
    assert.doesNotMatch(none, /estimated/i);
  });

  test("end to end: weight given, height skipped -> ulna question -> tool receives ulna_length_cm and no height", async () => {
    const calls = [];
    const env = makeFakeEnv(
      sampleResult({ measurements: { bmi: 20, height_cm: 173, height_source: "ulna_length" } }),
      calls
    );
    const from = "265888200010";
    const say = (t) => handleAdultScreeningFlow(t, from, env);

    await say("screen an adult for malnutrition");
    await say("man");
    await say("72 years");
    await say("58"); // weight
    assert.match(await say("skip"), /ULNA length/); // height skipped -> ulna question
    assert.match(await say("26.5"), /MUAC/);
    await say("230"); // muac
    await say("no"); // oedema
    await say("no"); // weight loss
    assert.match(await say("skip"), /MUST/); // context -> MUST offered because a height can be estimated
    const final = await say("no");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "adult_integrated_screen");
    assert.equal(calls[0].args.ulna_length_cm, 26.5);
    assert.equal(calls[0].args.height_cm, undefined);
    assert.equal(calls[0].args.weight_kg, 58);
    assert.match(final, /estimated from ulna length/);
  });

  test("an out-of-range ulna reprompts and the session stays on that step", async () => {
    const env = makeFakeEnv({});
    const from = "265888200011";
    const say = (t) => handleAdultScreeningFlow(t, from, env);
    await say("screen an adult for malnutrition");
    await say("woman");
    await say("70 years");
    await say("50");
    await say("skip"); // height
    const reply = await say("45");
    assert.match(reply, /18\.5 to 32/);
    assert.match(reply, /ULNA length/);
    assert.equal(JSON.parse(env._rows.get(`${from}:adult_screening`).payload_json).step, "ulna");
  });
});
