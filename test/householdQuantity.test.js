import test from "node:test";
import assert from "node:assert/strict";
import { detectFoodHouseholdQuantity } from "../src/detectors.js";
import { formatHouseholdConversion, householdConversionContext, scaleFoodToGrams } from "../src/formatting.js";

test("detects household-measure portions in several shapes", () => {
  assert.deepEqual(detectFoodHouseholdQuantity("2 cups of rice"), { food: "rice", amount: "2", unit: "cup" });
  assert.deepEqual(detectFoodHouseholdQuantity("how many calories in half a cup of beans?"), { food: "beans", amount: "0.5", unit: "cup" });
  assert.deepEqual(detectFoodHouseholdQuantity("1 1/2 tbsp peanut butter"), { food: "peanut butter", amount: "1 1/2", unit: "tbsp" });
  assert.deepEqual(detectFoodHouseholdQuantity("nsima 1 scoop"), { food: "nsima", amount: "1", unit: "scoop" });
});

test("ignores gram asks and sentences with no food", () => {
  assert.equal(detectFoodHouseholdQuantity("200g of rice"), null);
  assert.equal(detectFoodHouseholdQuantity("I have 3 cups"), null);
  assert.equal(detectFoodHouseholdQuantity("what is nsima"), null);
});

const converted = {
  food: { food_name: "Rice, cooked" },
  standard: { grams: 316 },
  nutrients: { energy_kcal: 410.8, protein_g: 8.5, carbs_g: 89, fat_g: 0.9, fiber_g: 1.3 },
  assumptions: ["1 g/ml (water-like) was assumed."],
  warnings: [],
};

test("formats the card with grams, nutrients and the API's assumption note", () => {
  const card = formatHouseholdConversion(converted, { amount: "2", unit: "cup" });
  assert.match(card, /2 cups of Rice, cooked\* ≈ 316 g/);
  assert.match(card, /410.8 kcal, 8.5g protein, 89g carbs, 0.9g fat/);
  assert.match(card, /_1 g\/ml \(water-like\) was assumed\._/);
  assert.equal(formatHouseholdConversion({ standard: { grams: 0 } }, { amount: "1", unit: "cup" }), null);
});

test("keeps singular for one cup and no plural for spoons", () => {
  assert.match(formatHouseholdConversion(converted, { amount: "1", unit: "cup" }), /1 cup of /);
  assert.match(formatHouseholdConversion(converted, { amount: "2", unit: "tbsp" }), /2 tbsp of /);
});

test("the saved context rescales a later gram follow-up from the converted amount", () => {
  const ctx = householdConversionContext(converted);
  assert.equal(ctx.baseGrams, 316);
  const half = scaleFoodToGrams(ctx, 158);
  assert.match(half, /205.4 kcal/);
});
