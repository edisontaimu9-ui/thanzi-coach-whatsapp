import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  SCREENING_MENU_ROW_ID,
  SCREENING_MENU_BODY,
  SCREENING_MENU_BUTTON,
  SCREENING_MENU_SECTION_TITLE,
  SCREENING_MENU_ROWS,
  screeningMenuSections,
  detectScreeningMenuRequest,
} from "../src/screeningMenu.js";
import { detectUnder5ScreeningTrigger } from "../src/under5Screening.js";
import { detectPregnantPostpartumScreeningTrigger } from "../src/pregnantPostpartumScreening.js";
import { detectSchoolAgeScreeningTrigger } from "../src/schoolAgeScreening.js";
import { detectAdultScreeningTrigger } from "../src/adultScreening.js";

// Same order index.js dispatches in.
function firstFlow(text) {
  if (detectSchoolAgeScreeningTrigger(text)) return "school";
  if (detectUnder5ScreeningTrigger(text)) return "under5";
  if (detectPregnantPostpartumScreeningTrigger(text)) return "pregnant";
  if (detectAdultScreeningTrigger(text)) return "adult";
  return null;
}

describe("each menu row starts exactly its own flow", () => {
  for (const row of SCREENING_MENU_ROWS) {
    test(`"${row.id}" -> ${row.flow}`, () => {
      assert.equal(firstFlow(row.id), row.flow);
      assert.equal(detectScreeningMenuRequest(row.id), false, "a row must not re-open the menu");
    });
  }

  test("all four flows are covered, once each", () => {
    assert.deepEqual(SCREENING_MENU_ROWS.map((r) => r.flow).sort(), ["adult", "pregnant", "school", "under5"]);
  });
});

describe("WhatsApp list limits", () => {
  test("row ids are unique and within 200 chars; titles <= 24; descriptions <= 72", () => {
    const ids = new Set();
    for (const r of [...SCREENING_MENU_ROWS, { id: SCREENING_MENU_ROW_ID, title: "Malnutrition Screening" }, { id: SCREENING_MENU_ROW_ID, title: "Kuyeza Malnutrition" }]) {
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
    assert.ok(SCREENING_MENU_BODY.length <= 1024);
    assert.ok(SCREENING_MENU_BUTTON.length <= 20);
    assert.ok(SCREENING_MENU_SECTION_TITLE.length <= 24);
  });

  test("screeningMenuSections has one section, <= 10 rows, and no internal fields", () => {
    const sections = screeningMenuSections();
    assert.equal(sections.length, 1);
    assert.ok(sections[0].rows.length <= 10);
    for (const row of sections[0].rows) assert.deepEqual(Object.keys(row).sort(), ["description", "id", "title"]);
  });
});

describe("detectScreeningMenuRequest", () => {
  test("accepts the greeting-list row id and plain requests for screening", () => {
    for (const t of [
      SCREENING_MENU_ROW_ID,
      "malnutrition screening",
      "Malnutrition Screening!",
      "nutrition screening",
      "muac screening",
      "screen for malnutrition",
      "screening for malnutrition",
      "please screen for malnutrition",
      "check for malnutrition",
      "test for malnutrition.",
      "start malnutrition screening",
      "show the malnutrition screening menu",
      "  do a malnutrition screening  ",
    ]) assert.equal(detectScreeningMenuRequest(t), true, t);
  });

  test("ignores questions, sentences that name a person, and unrelated text", () => {
    for (const t of [
      "what is malnutrition screening",
      "how do I screen for malnutrition in children",
      "screen a child for malnutrition",
      "screen an adult for malnutrition",
      "malnutrition in children",
      "hello",
      "What foods are high in iron?",
      "",
    ]) assert.equal(detectScreeningMenuRequest(t), false, t);
  });

  test("does not fire for anything that already starts one of the flows", () => {
    for (const t of ["screen a child for malnutrition", "check BMI for a 9 year old", "screen a pregnant woman for malnutrition", "check muac for an elderly patient"]) {
      assert.notEqual(firstFlow(t), null, t);
      assert.equal(detectScreeningMenuRequest(t), false, t);
    }
  });

  test("the greeting-list row id does not start any flow (it only opens the menu)", () => {
    assert.equal(firstFlow(SCREENING_MENU_ROW_ID), null);
  });
});
