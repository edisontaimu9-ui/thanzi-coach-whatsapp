import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  harrisBenedictBEE,
  schofieldBMR,
  whoBMR,
  calculateEnergyRequirement,
  stressFactorMidpoint,
} from "../src/energy.js";

describe("harrisBenedictBEE", () => {
  test("matches the published female coefficients", () => {
    // 655.1 + 9.6(90) + 1.9(168) - 4.7(53)
    const bee = harrisBenedictBEE("female", 90, 168, 53);
    assert.equal(Math.round(bee), Math.round(655.1 + 9.6 * 90 + 1.9 * 168 - 4.7 * 53));
  });

  test("matches the published male coefficients", () => {
    const bee = harrisBenedictBEE("male", 70, 175, 45);
    assert.equal(Math.round(bee), Math.round(66.5 + 13.8 * 70 + 5.0 * 175 - 6.8 * 45));
  });
});

describe("schofieldBMR", () => {
  test("uses the 3-10y band for a school-age child", () => {
    const bmr = schofieldBMR("male", 20, 110, 6);
    assert.equal(Math.round(bmr), Math.round(19.6 * 20 + 1.303 * 110 + 414.9));
  });

  test("uses the 10-18y band for a teenager", () => {
    const bmr = schofieldBMR("female", 45, 155, 14);
    assert.equal(Math.round(bmr), Math.round(8.365 * 45 + 4.65 * 155 + 200));
  });
});

describe("whoBMR", () => {
  test("uses the 0-3y band for a toddler", () => {
    const bmr = whoBMR("male", 12, 2);
    assert.equal(Math.round(bmr), Math.round(60.9 * 12 - 54));
  });
});

describe("calculateEnergyRequirement", () => {
  test("routes an adult (>=18y) to Harris-Benedict", () => {
    const result = calculateEnergyRequirement({ sex: "female", ageYears: 53, weightKg: 90, heightCm: 168 });
    assert.equal(result.population, "adult");
    assert.equal(result.equation, "Harris-Benedict BEE");
    assert.equal(result.stressFactor, null);
    assert.equal(result.adjustedKcalPerDay, result.baseKcalPerDay);
  });

  test("routes a child with height given to Schofield", () => {
    const result = calculateEnergyRequirement({ sex: "male", ageYears: 6, weightKg: 20, heightCm: 110 });
    assert.equal(result.population, "pediatric");
    assert.equal(result.equation, "Schofield (1985) BMR");
  });

  test("falls back to WHO when a child's height is unavailable", () => {
    const result = calculateEnergyRequirement({ sex: "male", ageYears: 2, weightKg: 12 });
    assert.equal(result.population, "pediatric");
    assert.equal(result.equation, "WHO (1985) BMR");
  });

  test("applies a stress factor as a single midpoint multiplier", () => {
    const result = calculateEnergyRequirement({
      sex: "male",
      ageYears: 40,
      weightKg: 70,
      heightCm: 175,
      stressFactorKey: "sepsis_severe",
    });
    assert.equal(result.stressFactor, 1.38); // midpoint of 1.3-1.45
    assert.ok(result.adjustedKcalPerDay > result.baseKcalPerDay);
  });

  test("returns null when there isn't enough data (adult, no height)", () => {
    const result = calculateEnergyRequirement({ sex: "female", ageYears: 30, weightKg: 60 });
    assert.equal(result, null);
  });

  test("returns null with no age at all", () => {
    const result = calculateEnergyRequirement({ sex: "male", weightKg: 70, heightCm: 175 });
    assert.equal(result, null);
  });
});

describe("stressFactorMidpoint", () => {
  test("returns null for an unknown key", () => {
    assert.equal(stressFactorMidpoint("not_a_real_key"), null);
  });
});
