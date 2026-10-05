import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isChichewaMessage, chichewaScore, cleanTranslation, translationPreservesFacts,
  buildToEnglishMessages, buildToChichewaMessages, CHICHEWA_AI_NOTE,
} from "../src/chichewa.js";

describe("isChichewaMessage", () => {
  test("Chichewa and mixed Chichewa/English are detected", () => {
    for (const t of [
      "Kodi nsima ili ndi ma calories angati?",
      "Ndi zakudya ziti zomwe zili ndi iron wambiri?",
      "Ndi iron ingati ndikufunika?",
      "mkaka ndi wabwino kwa mwana wanga",
      "ndikufuna thandizo pa zakudya za mwana",
      "Ndingadye chiyani ndikakhala ndi pakati",
      "thandizo",
      "kodi?",
    ]) {
      assert.equal(isChichewaMessage(t), true, t);
    }
  });

  test("English, lone food words and numbers are not", () => {
    for (const t of [
      "what foods are high in iron?",
      "nsima",
      "mkaka",
      "nsima and rice calories",
      "how much protein do I need",
      "compare nsima and rice",
      "12",
      "",
      "BMI for 70kg 170cm",
    ]) {
      assert.equal(isChichewaMessage(t), false, t);
    }
  });

  test("score counts strong and weak words", () => {
    const s = chichewaScore("Kodi nsima ndi wabwino");
    assert.ok(s.strong >= 1 && s.weak >= 2);
    assert.equal(chichewaScore("").total, 0);
  });
});

describe("cleanTranslation", () => {
  test("strips fences, quotes and label prefixes", () => {
    assert.equal(cleanTranslation('```\nHow much iron?\n```'), "How much iron?");
    assert.equal(cleanTranslation('"How much iron?"'), "How much iron?");
    assert.equal(cleanTranslation("Translation: How much iron?"), "How much iron?");
    assert.equal(cleanTranslation(undefined), "");
  });
});

describe("translationPreservesFacts", () => {
  const en = "Adults need 18 mg of iron daily [1]. Eat beans 3 times a week [2].";
  test("accepts a translation that keeps every number and marker", () => {
    assert.equal(translationPreservesFacts(en, "Akuluakulu amafunika 18 mg ya iron tsiku lililonse [1]. Idyani nyemba katatu pa mlungu, 3 times [2]."), true);
  });
  test("rejects changed or missing numbers", () => {
    assert.equal(translationPreservesFacts(en, "Akuluakulu amafunika 8 mg ya iron tsiku lililonse [1]. Idyani nyemba 3 pa mlungu [2]."), false);
    assert.equal(translationPreservesFacts(en, "Akuluakulu amafunika mg ya iron [1] ndi nyemba [2]."), false);
  });
  test("rejects lost citation markers, empty output and absurd lengths", () => {
    assert.equal(translationPreservesFacts(en, "Akuluakulu amafunika 18 mg ya iron tsiku lililonse. Idyani nyemba 3 pa mlungu."), false);
    assert.equal(translationPreservesFacts(en, ""), false);
    assert.equal(translationPreservesFacts("x".repeat(500) + " 5", "5"), false);
  });
  test("decimals are compared as written", () => {
    assert.equal(translationPreservesFacts("Take 0.5 g", "Imwani 0.5 g"), true);
    assert.equal(translationPreservesFacts("Take 0.5 g", "Imwani 5 g"), false);
  });
});

describe("prompts", () => {
  test("messages carry the text as data with a translation-only system prompt", () => {
    const a = buildToEnglishMessages("Kodi nsima ili ndi chiyani?");
    assert.equal(a[0].role, "system");
    assert.match(a[0].content, /untrusted data/);
    assert.equal(a[1].content, "Kodi nsima ili ndi chiyani?");
    assert.match(buildToChichewaMessages("Iron is in beans [1].")[0].content, /never add, remove or soften/i);
    assert.ok(buildToChichewaMessages("x".repeat(9000))[1].content.length <= 4000);
  });
  test("AI note is Chichewa and short", () => {
    assert.match(CHICHEWA_AI_NOTE, /AI/);
    assert.ok(CHICHEWA_AI_NOTE.length < 120);
  });
});
