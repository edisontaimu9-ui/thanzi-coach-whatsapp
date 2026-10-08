import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isKnowledgeQuestion } from "../src/screeningShared.js";
import { detectUnder5ScreeningTrigger } from "../src/under5Screening.js";

describe("knowledge questions are answered, not turned into a screening intake (the reported bug)", () => {
  test("the reported question and similar ones do not start the under-5 screening", () => {
    for (const t of [
      "What interventions are appropriate for a child with moderate acute malnutrition?",
      "What is the MUAC cut-off for a child with severe malnutrition?",
      "How is malnutrition in an infant treated?",
      "Why do children get malnutrition",
      "Which foods help a baby with malnutrition recover",
      "Can a child with malnutrition eat groundnuts?",
      "Explain the treatment of malnutrition in a child",
    ]) {
      assert.equal(isKnowledgeQuestion(t), true, t);
      assert.equal(detectUnder5ScreeningTrigger(t), false, t);
    }
  });

  test("real screening requests still start the flow", () => {
    for (const t of [
      "Screen a child for malnutrition",
      "screen a child for malnutrition",
      "check muac for my baby",
      "child malnutrition screening",
      "How do I screen a child for malnutrition?",
      "Can you check my baby for malnutrition?",
      "assess this infant for malnutrition",
    ]) {
      assert.equal(isKnowledgeQuestion(t), false, t);
      assert.equal(detectUnder5ScreeningTrigger(t), true, t);
    }
  });

  test("unrelated text is unaffected", () => {
    assert.equal(isKnowledgeQuestion("nsima"), false);
    assert.equal(isKnowledgeQuestion(""), false);
    assert.equal(detectUnder5ScreeningTrigger("what foods are high in iron"), false);
  });
});
