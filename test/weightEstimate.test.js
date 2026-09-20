import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  WEIGHT_ESTIMATE_SAMPLE_PROMPT,
  detectWeightEstimateTrigger,
  parseCircumferenceCm,
  parseRace,
  raceToolCovers,
  estimationPossibleForAge,
  plannedTools,
  nextStep,
  applyReply,
  buildEstimateCalls,
  normaliseEstimates,
  formatWeightEstimateResult,
  handleWeightEstimateFlow,
} from "../src/weightEstimate.js";
import { detectUnder5ScreeningTrigger } from "../src/under5Screening.js";
import { detectPregnantPostpartumScreeningTrigger } from "../src/pregnantPostpartumScreening.js";
import { detectSchoolAgeScreeningTrigger } from "../src/schoolAgeScreening.js";
import { detectAdultScreeningTrigger } from "../src/adultScreening.js";
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

const elderlyResult = (over = {}) => ({
  sex: "female",
  estimates: [
    { estimated_weight_kg: 52.9, formula: "f3", see_kg: 3.8, inputs_used: ["muac", "cc", "ssf", "kh"] },
    { estimated_weight_kg: 51.4, formula: "f2", see_kg: 4.21, inputs_used: ["muac", "cc", "ssf"] },
    { estimated_weight_kg: 52.4, formula: "f1", see_kg: 4.96, inputs_used: ["muac", "cc"] },
  ],
  ...over,
});
const raceResult = (over = {}) => ({ estimated_weight_kg: 64.98, see_kg: 11.3, formula: "x", age_band: "19-59", ...over });

describe("detectWeightEstimateTrigger", () => {
  test("matches requests to estimate a patient's weight, including the greeting-list sample prompt", () => {
    for (const t of [
      WEIGHT_ESTIMATE_SAMPLE_PROMPT,
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
    for (const phrase of ["estimate weight for an elderly patient", WEIGHT_ESTIMATE_SAMPLE_PROMPT]) {
      assert.equal(detectWeightEstimateTrigger(phrase), true, phrase);
      assert.equal(detectUnder5ScreeningTrigger(phrase), false, phrase);
      assert.equal(detectPregnantPostpartumScreeningTrigger(phrase), false, phrase);
      assert.equal(detectSchoolAgeScreeningTrigger(phrase), false, phrase);
      assert.equal(detectAdultScreeningTrigger(phrase), false, phrase);
      assert.equal(detectScreeningMenuRequest(phrase), false, phrase);
    }
    for (const t of ["screen an adult for malnutrition", "screen a child for malnutrition", "malnutrition screening", "check muac for an elderly patient"]) {
      assert.equal(detectWeightEstimateTrigger(t), false, t);
    }
  });

  test("its session kind is cleared with the screening sessions", () => {
    assert.ok(ALL_SCREENING_SESSION_KINDS.includes("weight_estimate"));
  });
});

describe("parsers and age helpers", () => {
  test("parseCircumferenceCm reads cm, mm and bare numbers (>= 100 is mm)", () => {
    assert.equal(parseCircumferenceCm("27.5"), 27.5);
    assert.equal(parseCircumferenceCm("27.5cm"), 27.5);
    assert.equal(parseCircumferenceCm("275mm"), 27.5);
    assert.equal(parseCircumferenceCm("275"), 27.5);
    assert.equal(parseCircumferenceCm("abc"), null);
  });

  test("parseRace accepts black/white only", () => {
    assert.equal(parseRace("Black"), "black");
    assert.equal(parseRace("white"), "white");
    assert.equal(parseRace("b"), "black");
    assert.equal(parseRace("brown"), null);
    assert.equal(parseRace("skip"), null);
  });

  test("the race tool's age bands and their gaps (6-18, 19-59, 60-80)", () => {
    for (const a of [6, 18, 19, 59, 60, 80]) assert.equal(raceToolCovers(a), true, String(a));
    for (const a of [5, 18.5, 59.5, 81]) assert.equal(raceToolCovers(a), false, String(a));
  });

  test("an estimate is possible at 6-18, 19-59, 60-80 and everything 65+, not in the gaps or below 6", () => {
    assert.equal(estimationPossibleForAge(40), true);
    assert.equal(estimationPossibleForAge(90), true);
    assert.equal(estimationPossibleForAge(18.5), false);
    assert.equal(estimationPossibleForAge(59.5), false);
    assert.equal(estimationPossibleForAge(5), false);
  });
});

describe("step machine — which questions are asked", () => {
  test("under 65: arm -> knee height -> race -> finish (no calf, no skinfold)", () => {
    const d = { age_years: 40, muac_cm: 30 };
    assert.equal(nextStep("muac", d), "kh");
    d.kh_cm = 50;
    assert.equal(nextStep("kh", d), "race");
    d.race = "black";
    assert.equal(nextStep("race", d), "finish");
  });

  test("65-80: arm -> calf -> knee height (optional) -> race (only if knee height) -> skinfold offer", () => {
    const d = { age_years: 72, muac_cm: 27, calf_cm: 31 };
    assert.equal(nextStep("muac", d), "calf");
    assert.equal(nextStep("calf", d), "kh");
    assert.equal(nextStep("kh", d), "extra_gate"); // knee height skipped -> straight to the skinfold offer
    d.kh_cm = 50;
    assert.equal(nextStep("kh", d), "race");
    assert.equal(nextStep("race", d), "extra_gate");
    assert.equal(nextStep("extra_gate", { ...d, wantsSkinfold: true }), "ssf");
    assert.equal(nextStep("extra_gate", { ...d, wantsSkinfold: false }), "finish");
    assert.equal(nextStep("ssf", d), "finish");
  });

  test("81+: no race equation exists, so knee height never leads to a race question", () => {
    const d = { age_years: 85, muac_cm: 25, calf_cm: 29, kh_cm: 45 };
    assert.equal(nextStep("kh", d), "extra_gate");
  });

  test("no calf and no knee height route -> the flow can only finish (and then refuses to estimate)", () => {
    assert.equal(nextStep("kh", { age_years: 72, muac_cm: 27 }), "finish");
  });
});

describe("applyReply — ages, required measurements, skipping", () => {
  test("age: under 6 and the 18-19 / 59-60 gaps are declined; 6, 19, 59, 65, 85 are accepted; bare number = years", () => {
    assert.deepEqual(applyReply("age", "5 years", { sex: "male" }), { outOfRange: "under6" });
    assert.deepEqual(applyReply("age", "18 years 6 months", { sex: "male" }), { outOfRange: "gap" });
    assert.deepEqual(applyReply("age", "59 years 6 months", { sex: "male" }), { outOfRange: "gap" });
    for (const a of ["6 years", "19 years", "59 years", "65 years", "85", "18 years"]) {
      assert.deepEqual(applyReply("age", a, { sex: "male" }), { advance: true }, a);
    }
  });

  test("arm circumference is always required and range-checked; mm are converted", () => {
    assert.ok("error" in applyReply("muac", "skip", {}));
    assert.ok("error" in applyReply("muac", "5", {}));
    const d = {};
    assert.deepEqual(applyReply("muac", "275", d), { advance: true });
    assert.equal(d.muac_cm, 27.5);
  });

  test("under 65: knee height and race cannot be skipped (they are the only equation)", () => {
    const d = { age_years: 40, muac_cm: 30 };
    assert.ok("error" in applyReply("kh", "skip", d));
    assert.match(applyReply("kh", "skip", d).error, /only equation/);
    assert.ok("error" in applyReply("race", "skip", d));
    assert.ok("error" in applyReply("kh", "20", d));
    assert.deepEqual(applyReply("kh", "50", d), { advance: true });
    assert.equal(d.kh_cm, 50);
    assert.ok("error" in applyReply("race", "brown", d));
    assert.deepEqual(applyReply("race", "black", d), { advance: true });
    assert.equal(d.race, "black");
  });

  test("65-80: calf may be skipped (knee-height route exists); once calf is given knee height and race may be skipped", () => {
    const d = { age_years: 72, muac_cm: 27 };
    assert.deepEqual(applyReply("calf", "skip", d), { advance: true });
    assert.ok("error" in applyReply("kh", "skip", d)); // no calf -> knee height now required
    d.calf_cm = 31;
    assert.deepEqual(applyReply("kh", "skip", d), { advance: true });
    assert.deepEqual(applyReply("race", "skip", d), { advance: true });
  });

  test("81+: calf cannot be skipped", () => {
    const r = applyReply("calf", "skip", { age_years: 85, muac_cm: 25 });
    assert.ok("error" in r);
    assert.match(r.error, /over 80/);
  });

  test("skinfold is optional and range-checked", () => {
    assert.deepEqual(applyReply("ssf", "skip", {}), { advance: true });
    assert.ok("error" in applyReply("ssf", "1", {}));
    const d = {};
    applyReply("ssf", "12", d);
    assert.equal(d.ssf_mm, 12);
    assert.deepEqual(applyReply("extra_gate", "done", {}), { finish: true });
  });
});

describe("plannedTools / buildEstimateCalls", () => {
  test("under 65 with knee height + race -> only the race tool, with the age sent as a number", () => {
    const calls = buildEstimateCalls({ sex: "male", age_years: 40, muac_cm: 30, kh_cm: 50, race: "black" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, "weight_from_knee_height_and_mac");
    assert.deepEqual(calls[0].args, { sex: "male", race: "black", age_years: 40, knee_height_cm: 50, mid_arm_circumference_cm: 30 });
  });

  test("65+ with calf only -> only the 65+ tool, no knee height, skinfold or race", () => {
    const calls = buildEstimateCalls({ sex: "female", age_years: 72, muac_cm: 27.5, calf_cm: 31.5 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, "weight_estimate_persons_65_and_older");
    assert.deepEqual(calls[0].args, { sex: "female", mid_arm_circumference_cm: 27.5, calf_circumference_cm: 31.5 });
  });

  test("65-80 with everything -> both tools; knee height goes to the 65+ tool only alongside a skinfold", () => {
    const both = buildEstimateCalls({ sex: "male", age_years: 70, muac_cm: 26, calf_cm: 30, kh_cm: 50, race: "black", ssf_mm: 10 });
    assert.deepEqual(both.map((c) => c.tool), ["weight_estimate_persons_65_and_older", "weight_from_knee_height_and_mac"]);
    assert.equal(both[0].args.knee_height_cm, 50);
    assert.equal(both[0].args.subscapular_skinfold_mm, 10);
    const noSsf = buildEstimateCalls({ sex: "male", age_years: 70, muac_cm: 26, calf_cm: 30, kh_cm: 50, race: "black" });
    assert.equal("knee_height_cm" in noSsf[0].args, false);
  });

  test("knee height without race, or race tool outside its bands, is not called", () => {
    assert.deepEqual(plannedTools({ age_years: 40, muac_cm: 30, kh_cm: 50 }), []);
    assert.deepEqual(plannedTools({ age_years: 85, muac_cm: 25, kh_cm: 45, race: "black" }), []);
    assert.deepEqual(plannedTools({ age_years: 40, muac_cm: 30, calf_cm: 34 }), []); // calf equations are 65+
    assert.deepEqual(plannedTools({ age_years: 40, kh_cm: 50, race: "black" }), []); // no arm circumference
  });
});

describe("normaliseEstimates / formatWeightEstimateResult", () => {
  test("normalises both tools' responses", () => {
    const race = normaliseEstimates("weight_from_knee_height_and_mac", raceResult());
    assert.deepEqual(race, [{ estimated_weight_kg: 64.98, see_kg: 11.3, using: "arm circumference + knee height, race-specific equation" }]);
    const eld = normaliseEstimates("weight_estimate_persons_65_and_older", elderlyResult());
    assert.equal(eld.length, 3);
    assert.equal(eld[1].using, "arm circumference + calf circumference + skinfold");
  });

  test("headlines the lowest standard error across BOTH tools and lists the rest", () => {
    const estimates = [
      ...normaliseEstimates("weight_from_knee_height_and_mac", raceResult({ estimated_weight_kg: 60, see_kg: 7.04 })),
      ...normaliseEstimates("weight_estimate_persons_65_and_older", { estimates: [elderlyResult().estimates[2]] }),
    ];
    const text = formatWeightEstimateResult(estimates, { sex: "female", age_years: 72, muac_cm: 27.5, calf_cm: 31.5, kh_cm: 50 });
    assert.match(text, /Female, 72 years/);
    assert.match(text, /Measurements: arm 27\.5 cm, calf 31\.5 cm, knee height 50 cm/);
    assert.match(text, /\*≈ 52\.4 kg\* — most precise equation \(standard error ±4\.96 kg\)/);
    assert.match(text, /Less precise: 60 kg \(±7\.04, arm circumference \+ knee height, race-specific equation\)/);
    assert.match(text, /An estimate, not a measurement/);
    assert.match(text, /not used to classify malnutrition/);
  });

  test("a large standard error gets an explicit rough-guide warning; a small one does not", () => {
    const big = formatWeightEstimateResult(normaliseEstimates("weight_from_knee_height_and_mac", raceResult()), { sex: "male", age_years: 40, muac_cm: 30, kh_cm: 50 });
    assert.match(big, /⚠️ The error of this equation is large \(±11\.3 kg\)/);
    const small = formatWeightEstimateResult(normaliseEstimates("weight_estimate_persons_65_and_older", { estimates: [elderlyResult().estimates[2]] }), { sex: "female", age_years: 72, muac_cm: 27.5, calf_cm: 31.5 });
    assert.doesNotMatch(small, /⚠️/);
  });

  test("an empty result is reported plainly", () => {
    assert.match(formatWeightEstimateResult([], {}), /No estimate could be calculated/);
  });
});

describe("handleWeightEstimateFlow — end to end with a fake env", () => {
  test("65+, arm + calf only: sends exactly those to the 65+ tool", async () => {
    const calls = [];
    const env = makeFakeEnv({ weight_estimate_persons_65_and_older: { ...elderlyResult(), estimates: [elderlyResult().estimates[2]] } }, calls);
    const from = "265888400000";
    const say = (t) => handleWeightEstimateFlow(t, from, env);

    assert.match(await say("estimate weight for a bedridden patient"), /male or female/);
    assert.match(await say("female"), /Estimates cover ages 6 and up/);
    assert.match(await say("72 years"), /Mid-upper arm/);
    assert.match(await say("27.5"), /Calf circumference/);
    assert.match(await say("31.5"), /Knee height/);
    assert.match(await say("skip"), /skinfold/); // knee height skipped (calf given) -> skinfold offer
    const final = await say("no");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "weight_estimate_persons_65_and_older");
    assert.deepEqual(calls[0].args, { sex: "female", mid_arm_circumference_cm: 27.5, calf_circumference_cm: 31.5 });
    assert.match(final, /Estimated body weight/);
    assert.match(final, /Female, 72 years/);
    assert.equal(env._rows.size, 0);
  });

  test("40-year-old man: arm -> knee height -> RACE is asked -> only the race tool is called", async () => {
    const calls = [];
    const env = makeFakeEnv({ weight_from_knee_height_and_mac: raceResult() }, calls);
    const from = "265888400001";
    const say = (t) => handleWeightEstimateFlow(t, from, env);

    await say("Estimate weight for a patient");
    await say("male");
    await say("40 years");
    assert.match(await say("300"), /Knee height/);
    const raceQ = await say("50");
    assert.match(raceQ, /race-specific/);
    assert.match(raceQ, /\*black\* or \*white\*/);
    const final = await say("black");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "weight_from_knee_height_and_mac");
    assert.deepEqual(calls[0].args, { sex: "male", race: "black", age_years: 40, knee_height_cm: 50, mid_arm_circumference_cm: 30 });
    assert.match(final, /≈ 65 kg/);
    assert.match(final, /⚠️ The error of this equation is large/);
    assert.equal(env._rows.size, 0);
  });

  test("70-year-old with calf, knee height, race and skinfold: both tools are called and the more precise one leads", async () => {
    const calls = [];
    const env = makeFakeEnv(
      { weight_estimate_persons_65_and_older: elderlyResult({ sex: "male" }), weight_from_knee_height_and_mac: raceResult({ estimated_weight_kg: 60, see_kg: 7.04, age_band: "60-80" }) },
      calls
    );
    const from = "265888400002";
    const say = (t) => handleWeightEstimateFlow(t, from, env);
    await say("patient cannot be weighed");
    await say("male");
    await say("70");
    await say("265");
    await say("310");
    await say("50"); // knee height
    assert.match(await say("white"), /skinfold/);
    await say("yes");
    const final = await say("12");
    assert.deepEqual(calls.map((c) => c.name), ["weight_estimate_persons_65_and_older", "weight_from_knee_height_and_mac"]);
    assert.equal(calls[0].args.knee_height_cm, 50);
    assert.equal(calls[0].args.subscapular_skinfold_mm, 12);
    assert.match(final, /\*≈ 52\.9 kg\* — most precise equation \(standard error ±3\.8 kg\)/);
    assert.match(final, /Less precise/);
  });

  test("under 6 and the age gaps are turned away without calling any tool", async () => {
    const calls = [];
    const env = makeFakeEnv({}, calls);
    const a = "265888400003";
    await handleWeightEstimateFlow("estimate weight for a patient", a, env);
    await handleWeightEstimateFlow("female", a, env);
    assert.match(await handleWeightEstimateFlow("4 years", a, env), /ages 6 and up/);
    const b = "265888400004";
    await handleWeightEstimateFlow("estimate weight for a patient", b, env);
    await handleWeightEstimateFlow("male", b, env);
    assert.match(await handleWeightEstimateFlow("59 years 6 months", b, env), /no published equation for this exact age/);
    assert.equal(calls.length, 0);
    assert.equal(env._rows.size, 0);
  });

  test("a bad reply reprompts and stays on the step; cancel and unrelated text behave", async () => {
    const env = makeFakeEnv({});
    const from = "265888400005";
    assert.equal(await handleWeightEstimateFlow("what is in a banana?", from, env), null);
    await handleWeightEstimateFlow("estimate weight for a patient", from, env);
    await handleWeightEstimateFlow("female", from, env);
    await handleWeightEstimateFlow("70", from, env);
    const reply = await handleWeightEstimateFlow("2", from, env);
    assert.match(reply, /looks off/);
    assert.match(reply, /Mid-upper arm/);
    assert.equal(JSON.parse(env._rows.get(`${from}:weight_estimate`).payload_json).step, "muac");
    assert.match(await handleWeightEstimateFlow("cancel", from, env), /Cancelled/);
    assert.equal(await handleWeightEstimateFlow("hello", from, env), null);
  });

  test("65+ who skips calf, knee height and race cannot be estimated — the flow refuses rather than guessing", async () => {
    const calls = [];
    const env = makeFakeEnv({}, calls);
    const from = "265888400006";
    const say = (t) => handleWeightEstimateFlow(t, from, env);
    await say("estimate weight for a patient");
    await say("female");
    await say("70");
    await say("27");
    await say("skip"); // calf skipped (allowed: a knee-height route exists)
    assert.match(await say("skip"), /I need the knee height/); // ...but then knee height is required
    assert.equal(calls.length, 0);
  });

  test("one tool failing still shows the other's estimate, with a note", async () => {
    const env = makeFakeEnv({ weight_estimate_persons_65_and_older: elderlyResult({ estimates: [elderlyResult().estimates[2]] }), weight_from_knee_height_and_mac: new Error("x") });
    const from = "265888400007";
    const say = (t) => handleWeightEstimateFlow(t, from, env);
    await say("estimate weight for a patient");
    await say("female");
    await say("70");
    await say("27");
    await say("31");
    await say("50"); // knee height
    await say("black"); // race -> both tools
    const final = await say("no");
    assert.match(final, /≈ 52\.4 kg/);
    assert.match(final, /One equation could not be calculated/);
  });

  test("all tools failing is reported plainly and the session is already cleared", async () => {
    const env = makeFakeEnv({ weight_from_knee_height_and_mac: new Error("x") });
    const from = "265888400008";
    const say = (t) => handleWeightEstimateFlow(t, from, env);
    await say("estimate weight for a patient");
    await say("male");
    await say("40");
    await say("30");
    await say("50");
    const reply = await say("white");
    assert.match(reply, /couldn't be completed/);
    assert.equal(env._rows.size, 0);
  });
});
