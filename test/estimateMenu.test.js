import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ESTIMATE_MENU_ROW_ID,
  ESTIMATE_MENU_BODY,
  ESTIMATE_MENU_BUTTON,
  ESTIMATE_MENU_SECTION_TITLE,
  ESTIMATE_MENU_ROWS,
  estimateMenuSections,
  detectEstimateMenuRequest,
} from "../src/estimateMenu.js";
import { detectWeightEstimateTrigger, WEIGHT_ESTIMATE_SAMPLE_PROMPT } from "../src/weightEstimate.js";
import { detectHeightEstimateTrigger, HEIGHT_ESTIMATE_SAMPLE_PROMPT } from "../src/heightEstimate.js";
import { detectScreeningMenuRequest } from "../src/screeningMenu.js";

// Same order index.js dispatches in: weight, then height.
function firstFlow(text) {
  if (detectWeightEstimateTrigger(text)) return "weight";
  if (detectHeightEstimateTrigger(text)) return "height";
  return null;
}

describe("each menu row starts exactly its own flow", () => {
  for (const row of ESTIMATE_MENU_ROWS) {
    test(`"${row.id}" -> ${row.flow}`, () => {
      assert.equal(firstFlow(row.id), row.flow);
      assert.equal(detectEstimateMenuRequest(row.id), false, "a row must not re-open the menu");
    });
  }

  test("both flows are covered, once each, using the flows' own sample prompts", () => {
    assert.deepEqual(ESTIMATE_MENU_ROWS.map((r) => r.flow).sort(), ["height", "weight"]);
    assert.equal(ESTIMATE_MENU_ROWS.find((r) => r.flow === "weight").id, WEIGHT_ESTIMATE_SAMPLE_PROMPT);
    assert.equal(ESTIMATE_MENU_ROWS.find((r) => r.flow === "height").id, HEIGHT_ESTIMATE_SAMPLE_PROMPT);
  });
});

describe("WhatsApp list limits", () => {
  test("row ids are unique and within 200 chars; titles <= 24; descriptions <= 72", () => {
    const ids = new Set();
    for (const r of [...ESTIMATE_MENU_ROWS, { id: ESTIMATE_MENU_ROW_ID, title: "Estimate Patient" }]) {
      assert.ok(r.id.length <= 200, r.id);
      assert.ok(r.title.length <= 24, `${r.title} (${r.title.length})`);
      if (r.description) assert.ok(r.description.length <= 72, r.description);
      if (r.flow) {
        assert.ok(!ids.has(r.id), `duplicate id ${r.id}`);
        ids.add(r.id);
      }
    }
  });

  test("menu body, button and section title fit", () => {
    assert.ok(ESTIMATE_MENU_BODY.length <= 1024);
    assert.ok(ESTIMATE_MENU_BUTTON.length <= 20);
    assert.ok(ESTIMATE_MENU_SECTION_TITLE.length <= 24);
  });

  test("estimateMenuSections has one section, <= 10 rows, and no internal fields", () => {
    const sections = estimateMenuSections();
    assert.equal(sections.length, 1);
    assert.ok(sections[0].rows.length <= 10);
    for (const row of sections[0].rows) assert.deepEqual(Object.keys(row).sort(), ["description", "id", "title"]);
  });
});

describe("detectEstimateMenuRequest", () => {
  test("accepts the greeting-list row id and plain requests to estimate, without naming weight or height", () => {
    for (const t of [
      ESTIMATE_MENU_ROW_ID,
      "estimate a patient",
      "Estimate a patient!",
      "estimate the patient",
      "estimate patient",
      "estimate patient's measurements",
      "please estimate a patient",
      "estimate measurements",
      "estimate measurements for a patient",
      "  estimate a patient  ",
    ]) assert.equal(detectEstimateMenuRequest(t), true, t);
  });

  test("ignores questions and unrelated text", () => {
    for (const t of ["how do I estimate a patient's weight", "what is malnutrition?", "hello", "What foods are high in iron?", ""]) {
      assert.equal(detectEstimateMenuRequest(t), false, t);
    }
  });

  test("does not fire for anything that already names weight or height — those go straight to their own flow", () => {
    for (const t of [WEIGHT_ESTIMATE_SAMPLE_PROMPT, HEIGHT_ESTIMATE_SAMPLE_PROMPT, "estimate weight for a patient", "estimate height for a patient", "patient can't stand", "patient can't be weighed"]) {
      assert.notEqual(firstFlow(t), null, t);
      assert.equal(detectEstimateMenuRequest(t), false, t);
    }
  });

  test("the greeting-list row id does not start either estimate flow (it only opens the menu)", () => {
    assert.equal(firstFlow(ESTIMATE_MENU_ROW_ID), null);
  });

  test("does not collide with the malnutrition screening menu", () => {
    assert.equal(detectScreeningMenuRequest(ESTIMATE_MENU_ROW_ID), false);
    assert.equal(detectEstimateMenuRequest("malnutrition screening"), false);
  });
});
