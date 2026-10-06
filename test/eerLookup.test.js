import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planEerLookup, formatEer, formatEerMissing } from "../src/eerLookup.js";
import { detectEnergyRequirementRequest } from "../src/detectors.js";

const plan = (text) => {
  const d = detectEnergyRequirementRequest(text);
  return d ? planEerLookup(d) : "no-detect";
};

describe("age parsing in energy requests", () => {
  test("babies in months and weeks, single-digit weights", () => {
    const d = detectEnergyRequirementRequest("calorie needs for a 7 month old baby 7kg");
    assert.equal(d.ageMonths, 7);
    assert.equal(d.weightKg, 7);
    assert.ok(Math.abs(d.age - 0.58) < 0.01);
    assert.equal(detectEnergyRequirementRequest("energy requirements for a 10 week old infant 4.2 kg").weightKg, 4.2);
    assert.equal(detectEnergyRequirementRequest("energy requirements for a toddler, 2 years 3 months, 12kg").age, 2.25);
  });
  test("a duration is not an age, and goal weights are not the person's weight", () => {
    assert.equal(detectEnergyRequirementRequest("energy requirements for 3 months of recovery in a 40 year old man 70kg").ageMonths, null);
    assert.equal(detectEnergyRequirementRequest("calorie needs for a 50 year old woman 80kg who wants to lose 5kg").weightKg, 80);
  });
});

describe("planEerLookup scope", () => {
  test("adults, unknown ages and clinical stress keep the existing calculator", () => {
    assert.equal(plan("calculate energy requirements for a 45 year old man, 70kg, 175cm"), null);
    assert.equal(plan("energy requirements for an 80 year old woman 50kg 155cm"), null);
    assert.equal(plan("energy requirements"), null);
    assert.equal(plan("energy requirements for a 5 year old boy with sepsis 20kg 110cm"), null);
  });

  test("infant: weight-only call to the infant stage", () => {
    const p = plan("calorie needs for a 7 month old baby 7kg");
    assert.equal(p.scope, "infant");
    assert.deepEqual(p.calls, [{ label: "", args: { life_stage: "infant_0_2y", age_months: 7, weight_kg: 7 } }]);
    assert.equal(p.label, "7-month-old");
  });

  test("toddlers under 3 years are infants in IOM terms", () => {
    const p = plan("energy requirements for a 2 year old girl 12kg 85cm");
    assert.equal(p.scope, "infant");
    assert.equal(p.calls[0].args.age_months, 24);
  });

  test("child: stage by sex and age band, three activity levels", () => {
    const boy = plan("energy requirements for a 15 year old boy 55kg 170cm");
    assert.equal(boy.scope, "child");
    assert.deepEqual(boy.calls.map((c) => c.args.life_stage), Array(3).fill("child_boy_9_18_normal"));
    assert.deepEqual(boy.calls.map((c) => c.args.physical_activity_level), ["sedentary", "low_active", "active"]);
    assert.equal(boy.calls[0].args.height_cm, 170);
    const girl = plan("how many calories does a 6 year old girl need 20kg 115cm");
    assert.equal(girl.calls[0].args.life_stage, "child_girl_3_8_normal");
    assert.equal(plan("energy requirements for a 3 year old boy 14kg 95cm").calls[0].args.life_stage, "child_boy_3_8_normal");
  });

  test("pregnancy and lactation read trimester / baby's age", () => {
    const preg = plan("energy requirements for a pregnant woman 28 years 65kg 163cm in her second trimester");
    assert.equal(preg.scope, "pregnancy");
    assert.equal(preg.calls[0].args.life_stage, "pregnant_19_50");
    assert.equal(preg.calls[0].args.trimester, "second");
    assert.equal(plan("energy needs pregnant 16 year old girl 50kg 160cm 3rd trimester").calls[0].args.life_stage, "pregnant_14_18");
    const lac = plan("energy requirements for a breastfeeding mother 28 years 62kg 163cm, baby is 3 months");
    assert.equal(lac.scope, "lactation");
    assert.equal(lac.calls[0].args.months_postpartum, "first_6_months");
    assert.equal(plan("energy requirements lactating mother 30 years 60kg 160cm 9 months postpartum baby 9 months").calls[0].args.months_postpartum, "second_6_months");
  });
});

describe("missing inputs", () => {
  test("each group asks only for what it needs, with an example", () => {
    let p = plan("calorie needs of a toddler");
    assert.equal(p.scope, "infant");
    assert.deepEqual(p.missing, ["age (e.g. 7 months)", "weight (kg)"]);
    assert.match(formatEerMissing(p), /I still need: age \(e\.g\. 7 months\), weight \(kg\)\./);
    p = plan("energy requirements for a 5 year old");
    assert.deepEqual(p.missing, ["sex (boy or girl)", "weight (kg)", "height (cm)"]);
    p = plan("energy requirements for a pregnant woman 28 years 65kg 163cm");
    assert.deepEqual(p.missing, ["trimester (1st, 2nd or 3rd)"]);
    p = plan("energy requirements for a breastfeeding woman 28 years 62kg 163cm");
    assert.deepEqual(p.missing, ["baby's age (under or over 6 months)"]);
  });
});

describe("formatEer", () => {
  test("infant: one value with kcal/kg and the resting line", () => {
    const p = plan("calorie needs for a 7 month old baby 7kg");
    const t = formatEer(p, [{ eer_kcal_per_day: 545 }], { equation: "WHO (1985) BMR", baseKcalPerDay: 376 });
    assert.match(t, /7-month-old/);
    assert.match(t, /\*545 kcal\/day\* \(≈78 kcal\/kg\/day\)/);
    assert.match(t, /Resting energy \(WHO \(1985\) BMR\): 376 kcal\/day/);
  });
  test("child: three activity levels with thousands separators", () => {
    const p = plan("energy requirements for a 15 year old boy 55kg 170cm");
    const t = formatEer(p, [{ eer_kcal_per_day: 2335 }, { eer_kcal_per_day: 2579 }, { eer_kcal_per_day: 2826 }], null);
    assert.match(t, /boy, 15 years/);
    assert.match(t, /Sedentary: \*2,335 kcal\/day\*/);
    assert.match(t, /Low active: \*2,579 kcal\/day\*/);
    assert.match(t, /healthy-weight child/);
    assert.doesNotMatch(t, /Resting energy/);
  });
  test("pregnancy and lactation show the add-on", () => {
    const preg = plan("energy requirements for a pregnant woman 28 years 65kg 163cm in her second trimester");
    const r = { eer_kcal_per_day: 2327, pregnancy_energy_deposition_kcal: 160 };
    assert.match(formatEer(preg, [r, r, r], null), /\+160 kcal for pregnancy/);
    const lac = plan("energy requirements for a breastfeeding mother 28 years 62kg 163cm, baby is 3 months");
    const l = { eer_kcal_per_day: 2354, milk_energy_output_minus_weight_loss_kcal: 430 };
    assert.match(formatEer(lac, [l, l, l], null), /\+430 kcal for milk production/);
  });
  test("a malformed tool result throws so the caller falls back", () => {
    const p = plan("calorie needs for a 7 month old baby 7kg");
    assert.throws(() => formatEer(p, [{}], null));
    assert.throws(() => formatEer(p, [], null));
  });
});
