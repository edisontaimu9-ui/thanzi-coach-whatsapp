import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isPretermMention, detectPretermEnergyRequest, formatPretermEnergy } from "../src/pretermEnergy.js";
import { detectEnergyRequirementRequest } from "../src/detectors.js";

const RESULT = {
  source: "BND 415 Paediatric Medicine Resources — preterm infants (enteral)",
  weight_kg: 1.5,
  fluid_ml_per_kg_per_day: "120-200 mL/kg/d",
  fluid_ml_per_day_estimate: { low: 180, high: 300 },
  energy_kcal_per_kg_per_day: "110-130 kcal/kg/day",
  energy_kcal_per_day_estimate: { low: 165, high: 195 },
};

describe("detectPretermEnergyRequest", () => {
  test("the reported question and common variants", () => {
    for (const t of [
      "Caloric requirements for preterm babes",
      "caloric requirements for premature babies",
      "energy needs of a preterm infant",
      "How many calories does a low birth weight baby need",
      "fluid requirements for neonates",
      "What is the calorie intake for a newborn preterm",
      "kcal per kg for VLBW infants",
    ]) {
      assert.deepEqual(detectPretermEnergyRequest(t), { weightKg: null }, t);
    }
  });

  test("parses a weight in kg or g, ignoring implausible values", () => {
    assert.equal(detectPretermEnergyRequest("energy needs for a preterm baby 1.5kg").weightKg, 1.5);
    assert.equal(detectPretermEnergyRequest("calorie requirements preterm infant weighing 1500 g").weightKg, 1.5);
    assert.equal(detectPretermEnergyRequest("calories for premature baby, 1,2 kg").weightKg, 1.2);
    assert.equal(detectPretermEnergyRequest("energy needs of a preterm baby 70kg").weightKg, null);
    assert.equal(detectPretermEnergyRequest("energy needs of a preterm baby 40g").weightKg, null);
  });

  test("non-preterm or non-requirement questions are left alone", () => {
    for (const t of [
      "calculate energy requirements for a 45 year old man, 70kg, 175cm",
      "caloric requirements for toddlers",
      "what is a preterm baby",
      "preterm birth causes",
      "newborn",
      "",
    ]) {
      assert.equal(detectPretermEnergyRequest(t), null, t);
    }
  });

  test("isPretermMention", () => {
    assert.equal(isPretermMention("preterm babes"), true);
    assert.equal(isPretermMention("NEONATE feeding"), true);
    assert.equal(isPretermMention("my term baby"), false);
  });

  test("the adult calculator detector still fires on the same words (the handler guards on isPretermMention)", () => {
    assert.ok(detectEnergyRequirementRequest("Caloric requirements for preterm babes"));
  });
});

describe("formatPretermEnergy", () => {
  test("with a weight shows daily totals", () => {
    const t = formatPretermEnergy(RESULT, 1.5);
    assert.match(t, /Energy: 110-130 kcal\/kg\/day/);
    assert.match(t, /Fluid: 120-200 mL\/kg\/d/);
    assert.match(t, /For 1\.5 kg: ≈165–195 kcal\/day · ≈180–300 mL\/day/);
    assert.match(t, /BND 415/);
    assert.match(t, /not a substitute/);
  });
  test("without a weight asks for it instead of inventing totals", () => {
    const t = formatPretermEnergy(RESULT, null);
    assert.match(t, /Send the baby's weight/);
    assert.doesNotMatch(t, /For .* kg/);
  });
  test("a malformed tool result throws so the caller falls back to the nutrition search", () => {
    assert.throws(() => formatPretermEnergy({}, 1.5));
  });
});
