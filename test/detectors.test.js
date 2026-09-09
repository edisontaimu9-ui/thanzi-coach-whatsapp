import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  looksLikeBarcode,
  looksLikeBareFoodName,
  detectGreetingLanguage,
  detectFoodComparison,
  detectMultiFoodList,
  detectFoodQuantity,
  detectServingOnly,
  detectSubstituteRequest,
  detectDrugInteractionQuery,
  detectLabelRequest,
  detectDriRequest,
} from "../src/detectors.js";

describe("looksLikeBarcode", () => {
  test("accepts 8-14 digit strings", () => {
    assert.equal(looksLikeBarcode("12345678"), true);
    assert.equal(looksLikeBarcode("6009123456789"), true);
  });

  test("rejects anything shorter, longer, or non-numeric", () => {
    assert.equal(looksLikeBarcode("1234567"), false); // 7 digits
    assert.equal(looksLikeBarcode("123456789012345"), false); // 15 digits
    assert.equal(looksLikeBarcode("nsima"), false);
    assert.equal(looksLikeBarcode("200g rice"), false);
  });
});

describe("looksLikeBareFoodName", () => {
  test("accepts a short plain food name", () => {
    assert.equal(looksLikeBareFoodName("Quinoa"), true);
    assert.equal(looksLikeBareFoodName("Soya pieces"), true);
  });

  test("rejects real questions and long phrases", () => {
    assert.equal(looksLikeBareFoodName("What is nsima?"), false);
    assert.equal(looksLikeBareFoodName("How much protein is in beans"), false);
    assert.equal(looksLikeBareFoodName("one two three four five six"), false);
    assert.equal(looksLikeBareFoodName(""), false);
  });
});

describe("detectGreetingLanguage", () => {
  test("recognizes English and Chichewa greetings", () => {
    assert.equal(detectGreetingLanguage("hi"), "en");
    assert.equal(detectGreetingLanguage("Good morning!"), "en");
    assert.equal(detectGreetingLanguage("moni"), "ny");
    assert.equal(detectGreetingLanguage("Muli bwanji"), "ny");
  });

  test("returns null for anything else", () => {
    assert.equal(detectGreetingLanguage("how much iron do I need"), null);
    assert.equal(detectGreetingLanguage("nsima"), null);
  });
});

describe("detectFoodComparison", () => {
  test("matches a comma/and list after 'compare'", () => {
    assert.deepEqual(
      detectFoodComparison("compare nsima, rice and potatoes"),
      ["nsima", "rice", "potatoes"]
    );
  });

  test("matches 'X vs Y'", () => {
    assert.deepEqual(
      detectFoodComparison("brown rice vs white rice"),
      ["brown rice", "white rice"]
    );
  });

  test("matches 'of X compared to Y'", () => {
    assert.deepEqual(
      detectFoodComparison("protein of chicken compared to beans"),
      ["chicken", "beans"]
    );
  });

  test("caps a long list at 6 items", () => {
    const result = detectFoodComparison("compare a, b, c, d, e, f, g, h");
    assert.equal(result.length, 6);
  });

  test("returns null when nothing matches", () => {
    assert.equal(detectFoodComparison("what is nsima"), null);
  });
});

describe("detectMultiFoodList", () => {
  test("matches a plain 'X and Y' food list", () => {
    assert.deepEqual(detectMultiFoodList("nsima and beans"), ["nsima", "beans"]);
    assert.deepEqual(detectMultiFoodList("eggs, rice and greens"), ["eggs", "rice", "greens"]);
  });

  test("rejects real questions", () => {
    assert.equal(detectMultiFoodList("What is nsima and beans?"), null);
    assert.equal(detectMultiFoodList("How much protein in eggs and rice"), null);
  });

  test("rejects a single item or an overlong item", () => {
    assert.equal(detectMultiFoodList("nsima"), null);
    assert.equal(
      detectMultiFoodList("a very long description of a dish and rice"),
      null
    );
  });
});

describe("detectFoodQuantity", () => {
  test("matches amount-first phrasing", () => {
    assert.deepEqual(detectFoodQuantity("200g of quinoa"), { food: "quinoa", grams: 200 });
    assert.deepEqual(
      detectFoodQuantity("how many calories in 150g of rice?"),
      { food: "rice", grams: 150 }
    );
  });

  test("matches amount-last phrasing and strips filler words", () => {
    assert.deepEqual(detectFoodQuantity("quinoa 200g"), { food: "quinoa", grams: 200 });
    assert.deepEqual(
      detectFoodQuantity("find energy and macros for quinoa 200g"),
      { food: "quinoa", grams: 200 }
    );
  });

  test("returns null with no gram amount, or an out-of-range amount", () => {
    assert.equal(detectFoodQuantity("nsima"), null);
    assert.equal(detectFoodQuantity("20000g of rice"), null);
  });
});

describe("detectServingOnly", () => {
  test("matches a bare gram amount with only filler words", () => {
    assert.deepEqual(detectServingOnly("50g"), { grams: 50 });
    assert.deepEqual(detectServingOnly("calculate for 50g serving"), { grams: 50 });
    assert.deepEqual(detectServingOnly("how much can it provide in 100g?"), { grams: 100 });
  });

  test("returns null when a real food name is present", () => {
    assert.equal(detectServingOnly("chicken 100g"), null);
  });

  test("returns null with no gram amount at all", () => {
    assert.equal(detectServingOnly("how much protein does it have"), null);
  });
});

describe("detectSubstituteRequest", () => {
  test("matches the common phrasings", () => {
    assert.equal(detectSubstituteRequest("substitute for nsima"), "nsima");
    assert.equal(
      detectSubstituteRequest("what can I use instead of rice"),
      "rice"
    );
    assert.equal(
      detectSubstituteRequest("instead of rice, what can I use"),
      "rice"
    );
  });

  test("returns null otherwise", () => {
    assert.equal(detectSubstituteRequest("what is nsima"), null);
  });
});

describe("detectDrugInteractionQuery", () => {
  test("matches the common phrasings", () => {
    assert.equal(detectDrugInteractionQuery("interactions with warfarin"), "warfarin");
    assert.equal(
      detectDrugInteractionQuery("foods to avoid while taking metformin"),
      "metformin"
    );
  });

  test("returns null otherwise", () => {
    assert.equal(detectDrugInteractionQuery("what is warfarin"), null);
  });
});

describe("detectLabelRequest", () => {
  test("matches the common phrasings", () => {
    assert.equal(detectLabelRequest("nutrition label for rice"), "rice");
    assert.equal(detectLabelRequest("show me the label for beans"), "beans");
  });

  test("returns null otherwise", () => {
    assert.equal(detectLabelRequest("what is in rice"), null);
  });
});

describe("detectDriRequest", () => {
  test("assumes a default adult age when sex is given but not age", () => {
    assert.deepEqual(detectDriRequest("how much iron does a man need"), {
      nutrientKey: "iron_mg",
      age: 30,
      sex: "male",
      lifeStageType: "normal",
      assumedAge: true,
    });
  });

  test("declines to guess when neither age nor sex is given", () => {
    assert.equal(detectDriRequest("how much iron do I need"), null);
  });

  test("resolves pregnancy to female + a reproductive-age default", () => {
    assert.deepEqual(detectDriRequest("RDA for calcium for a pregnant woman"), {
      nutrientKey: "calcium_mg",
      age: 25,
      sex: "female",
      lifeStageType: "pregnancy",
      assumedAge: true,
    });
  });

  test("uses a stated age instead of the default", () => {
    assert.deepEqual(
      detectDriRequest("how much iron does a 10 year old boy need"),
      {
        nutrientKey: "iron_mg",
        age: 10,
        sex: "male",
        lifeStageType: "normal",
        assumedAge: false,
      }
    );
  });

  test("declines to guess for a child with no age given", () => {
    assert.equal(detectDriRequest("how much iron does my child need"), null);
  });

  test("returns null for an unrecognized nutrient or phrasing", () => {
    assert.equal(detectDriRequest("how much love do I need"), null);
    assert.equal(detectDriRequest("what is nsima"), null);
  });
});
