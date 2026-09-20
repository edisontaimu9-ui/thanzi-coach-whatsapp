import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectUnder5ScreeningTrigger, handleUnder5ScreeningFlow, parseAge } from "../src/under5Screening.js";
import { detectPregnantPostpartumScreeningTrigger } from "../src/pregnantPostpartumScreening.js";
import { detectSchoolAgeScreeningTrigger, handleSchoolAgeScreeningFlow } from "../src/schoolAgeScreening.js";
import { detectAdultScreeningTrigger } from "../src/adultScreening.js";
import { clearAllScreeningSessions, ALL_SCREENING_SESSION_KINDS } from "../src/screeningShared.js";

function makeFakeDb() {
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
  return { DB, _rows: rows };
}

/** Which flow's trigger(s) fire for a phrase — index.js checks school-age, under-5, pregnant, adult in that order. */
function firstMatch(text) {
  if (detectSchoolAgeScreeningTrigger(text)) return "school";
  if (detectUnder5ScreeningTrigger(text)) return "under5";
  if (detectPregnantPostpartumScreeningTrigger(text)) return "pregnant";
  if (detectAdultScreeningTrigger(text)) return "adult";
  return null;
}

describe("trigger routing (dispatch order: school-age, under-5, pregnant, adult)", () => {
  const cases = [
    ["screen a child for malnutrition", "under5"],
    ["check muac for my baby", "under5"],
    ["screen a school child for malnutrition", "school"],
    ["screen an adolescent for malnutrition", "school"],
    ["check BMI for a 9 year old", "school"],
    ["screen a 9 year old child for malnutrition", "under5"], // under-5 flow hands over by age
    ["screen a pregnant woman for malnutrition", "pregnant"],
    ["postpartum malnutrition screening", "pregnant"],
    ["screen an adult for malnutrition", "adult"],
    ["check muac for an elderly patient", "adult"],
    ["screen a man for malnutrition", "adult"],
    ["what is malnutrition?", null],
    ["how much protein in eggs", null],
  ];
  for (const [text, expected] of cases) {
    test(`"${text}" -> ${expected}`, () => assert.equal(firstMatch(text), expected));
  }
});

describe("clearAllScreeningSessions", () => {
  test("removes every flow's session for that number only", async () => {
    const env = makeFakeDb();
    for (const kind of ALL_SCREENING_SESSION_KINDS) env._rows.set(`111:${kind}`, { payload_json: "{}", updated_at: new Date().toISOString() });
    env._rows.set(`222:under5_screening`, { payload_json: "{}", updated_at: new Date().toISOString() });
    await clearAllScreeningSessions("111", env);
    assert.equal(env._rows.size, 1);
    assert.ok(env._rows.has("222:under5_screening"));
  });
});

describe("under-5 age parsing (fix: combined years + months)", () => {
  test("'2 years 6 months' is 30 months, not 6", () => {
    assert.deepEqual(parseAge("2 years 6 months"), { age_months: 30 });
    assert.deepEqual(parseAge("2y 6m"), { age_months: 30 });
    assert.deepEqual(parseAge("1 year and 3 months"), { age_months: 15 });
  });
  test("existing single-unit forms are unchanged", () => {
    assert.deepEqual(parseAge("18 months"), { age_months: 18 });
    assert.deepEqual(parseAge("2 years"), { age_years: 2 });
    assert.deepEqual(parseAge("2024-05-01"), { date_of_birth: "2024-05-01" });
    assert.equal(parseAge("8"), null);
  });
});

describe("under-5 flow hands a child of 5+ to the school-age flow", () => {
  test("'screen a child' -> boy -> '8 years' continues in the school-age flow with sex and age kept", async () => {
    const env = makeFakeDb();
    const from = "265888300000";
    await handleUnder5ScreeningFlow("screen a child for malnutrition", from, env);
    await handleUnder5ScreeningFlow("boy", from, env);
    const reply = await handleUnder5ScreeningFlow("8 years", from, env);
    assert.match(reply, /5–17 year screen/);
    assert.match(reply, /weight/i);
    assert.ok(!env._rows.has(`${from}:under5_screening`));
    const saved = JSON.parse(env._rows.get(`${from}:school_age_screening`).payload_json);
    assert.equal(saved.step, "weight");
    assert.equal(saved.data.sex, "male");
    assert.equal(saved.data.age_years, 8);
    // and the next message is handled by the school-age flow
    assert.match(await handleSchoolAgeScreeningFlow("24.5", from, env), /height/i);
  });

  test("exactly 60 months hands over; 59 months stays in the under-5 flow", async () => {
    const env = makeFakeDb();
    const a = "265888300001";
    await handleUnder5ScreeningFlow("screen a child for malnutrition", a, env);
    await handleUnder5ScreeningFlow("girl", a, env);
    assert.match(await handleUnder5ScreeningFlow("60 months", a, env), /5–17 year screen/);

    const b = "265888300002";
    await handleUnder5ScreeningFlow("screen a child for malnutrition", b, env);
    await handleUnder5ScreeningFlow("girl", b, env);
    assert.match(await handleUnder5ScreeningFlow("59 months", b, env), /weight/i);
    assert.ok(env._rows.has(`${b}:under5_screening`));
    assert.ok(!env._rows.has(`${b}:school_age_screening`));
  });

  test("an 18+ 'child' passes through the school-age flow to the adult flow", async () => {
    const env = makeFakeDb();
    const from = "265888300003";
    await handleUnder5ScreeningFlow("screen a child for malnutrition", from, env);
    await handleUnder5ScreeningFlow("boy", from, env);
    const reply = await handleUnder5ScreeningFlow("20 years", from, env);
    assert.match(reply, /adult screen/);
    assert.ok(env._rows.has(`${from}:adult_screening`));
    assert.ok(!env._rows.has(`${from}:school_age_screening`));
  });
});
