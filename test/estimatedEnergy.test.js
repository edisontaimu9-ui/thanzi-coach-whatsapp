import test from "node:test";
import assert from "node:assert/strict";
import { formatFoodResult } from "../src/formatting.js";

const base = { product_name: "Milk", protein_g: 3.4, carbs_g: 4.6, fat_g: 3.1, energy_kcal: 60 };

test("estimated energy is marked as an estimate", () => {
  const out = formatFoodResult({ ...base, ocr_raw: { energy_estimated: true } });
  assert.match(out, /~60 kcal \(estimated from macros\)/);
});

test("printed energy is shown plainly", () => {
  const out = formatFoodResult({ ...base, ocr_raw: {} });
  assert.match(out, /60 kcal/);
  assert.doesNotMatch(out, /estimated/);
});
