import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  detectUnder5ScreeningTrigger,
  handleUnder5ScreeningFlow,
  parseSex,
  parseAge,
  parseNumber,
  parseMuacMm,
  parseYesNo,
  parseMeasurementMethod,
  parseContext,
  nextStep,
  applyReply,
  formatUnder5ScreeningResult,
  explainUnder5ScreeningResult,
  toWhatsAppFormatting,
} from "../src/under5Screening.js";

describe("detectUnder5ScreeningTrigger", () => {
  test("matches common phrasings", () => {
    assert.equal(detectUnder5ScreeningTrigger("screen a child for malnutrition"), true);
    assert.equal(detectUnder5ScreeningTrigger("I want to check muac for my baby"), true);
    assert.equal(detectUnder5ScreeningTrigger("malnutrition screening"), false); // no child/baby/infant mentioned
    assert.equal(detectUnder5ScreeningTrigger("child screening please"), true);
  });

  test("does not fire on unrelated messages mentioning 'child'", () => {
    assert.equal(detectUnder5ScreeningTrigger("how much protein does my child need"), false);
    assert.equal(detectUnder5ScreeningTrigger("what should I feed my baby"), false);
  });
});

describe("field parsers", () => {
  test("parseSex", () => {
    assert.equal(parseSex("boy"), "male");
    assert.equal(parseSex("Girl"), "female");
    assert.equal(parseSex("m"), "male");
    assert.equal(parseSex("banana"), null);
  });

  test("parseAge", () => {
    assert.deepEqual(parseAge("18 months"), { age_months: 18 });
    assert.deepEqual(parseAge("2 years"), { age_years: 2 });
    assert.deepEqual(parseAge("2026-01-15"), { date_of_birth: "2026-01-15" });
    assert.equal(parseAge("18"), null); // ambiguous, no unit
  });

  test("parseNumber", () => {
    assert.equal(parseNumber("8.5"), 8.5);
    assert.equal(parseNumber("8.5kg"), 8.5);
    assert.equal(parseNumber("not a number"), null);
  });

  test("parseMuacMm converts cm to mm", () => {
    assert.equal(parseMuacMm("125"), 125);
    assert.equal(parseMuacMm("12.5cm"), 125);
    assert.equal(parseMuacMm("115mm"), 115);
  });

  test("parseYesNo", () => {
    assert.equal(parseYesNo("yes"), "yes");
    assert.equal(parseYesNo("y"), "yes");
    assert.equal(parseYesNo("no"), "no");
    assert.equal(parseYesNo("skip"), "skip");
    assert.equal(parseYesNo("maybe"), null);
  });

  test("parseMeasurementMethod", () => {
    assert.equal(parseMeasurementMethod("lying down"), "recumbent_length");
    assert.equal(parseMeasurementMethod("standing"), "standing_height");
    assert.equal(parseMeasurementMethod("skip"), "skip");
    assert.equal(parseMeasurementMethod("sideways"), null);
  });

  test("parseContext", () => {
    assert.equal(parseContext("1"), "community");
    assert.equal(parseContext("hospital"), "hospital");
    assert.equal(parseContext("skip"), "community");
    assert.equal(parseContext("somewhere"), null);
  });
});

describe("nextStep", () => {
  test("skips measurement_method when height was skipped", () => {
    assert.equal(nextStep("height", {}), "muac");
  });

  test("asks measurement_method when height was provided", () => {
    assert.equal(nextStep("height", { length_or_height_cm: 75 }), "measurement_method");
  });

  test("skips extra_gate for children under 12 months", () => {
    assert.equal(nextStep("context", { age_months: 8 }), "finish");
  });

  test("offers extra_gate for children 12+ months", () => {
    assert.equal(nextStep("context", { age_months: 24 }), "extra_gate");
  });

  test("goes to STRONGkids questions only if wantsExtra is true", () => {
    assert.equal(nextStep("extra_gate", { wantsExtra: true }), "sk_clinical");
    assert.equal(nextStep("extra_gate", { wantsExtra: false }), "finish");
  });
});

describe("applyReply", () => {
  test("advances on a valid sex reply", () => {
    const data = {};
    const result = applyReply("sex", "girl", data);
    assert.deepEqual(result, { advance: true });
    assert.equal(data.sex, "female");
  });

  test("reprompts with an error on an invalid reply", () => {
    const data = {};
    const result = applyReply("sex", "purple", data);
    assert.ok(result.error);
    assert.equal(data.sex, undefined);
  });

  test("skip leaves weight unset rather than inventing a value", () => {
    const data = {};
    const result = applyReply("weight", "skip", data);
    assert.deepEqual(result, { advance: true });
    assert.equal(data.weight_kg, undefined);
  });

  test("'done' at extra_gate signals finish", () => {
    const data = {};
    const result = applyReply("extra_gate", "done", data);
    assert.deepEqual(result, { finish: true });
  });
});

describe("formatUnder5ScreeningResult", () => {
  test("renders a minimal well-formed result without throwing", () => {
    const fakeResult = {
      child: { sex: "male", age_months: 20 },
      anthropometry: {
        weight_for_age: { available: false, reason_unavailable: "weight_kg not provided" },
        height_for_age: { available: false, reason_unavailable: "length_or_height_cm not provided" },
        weight_for_length_or_height: { available: false, reason_unavailable: "missing", standard_used: null },
        bmi_for_age: { available: false, reason_unavailable: "missing" },
      },
      nacs_classification: {
        overallAcuteMalnutritionClassification: "severe",
        indicators: [{ indicator: "muac", value: "110 mm", classification: "severe", cutoffApplied: "x" }],
      },
      nacs_classification_skipped_reason: null,
      screening: { tools_administered: [], tools_skipped: [], strongkids: null, pnst: null, pyms: null, stamp: null, disagreement_noted: false },
      recommended_action: { urgency: "urgent", action: "Refer now." },
      clinical_flags: [{ flag: "nacs_muac:severe", detail: "x" }],
    };
    const text = formatUnder5ScreeningResult(fakeResult);
    assert.match(text, /SEVERE/);
    assert.match(text, /Refer now\./);
    assert.match(text, /decision support only/);
  });
});

describe("toWhatsAppFormatting", () => {
  test("converts markdown **bold** to WhatsApp *bold*", () => {
    assert.equal(toWhatsAppFormatting("Weight-for-age z-score of **-3.67**"), "Weight-for-age z-score of *-3.67*");
  });

  test("converts markdown __italic__ to WhatsApp _italic_", () => {
    assert.equal(toWhatsAppFormatting("__note__"), "_note_");
  });

  test("strips stray markdown headers", () => {
    assert.equal(toWhatsAppFormatting("# Summary\nSome text"), "Summary\nSome text");
  });

  test("leaves already-correct WhatsApp single-asterisk bold untouched", () => {
    assert.equal(toWhatsAppFormatting("*already bold*"), "*already bold*");
  });
});

describe("explainUnder5ScreeningResult", () => {
  const fakeResult = {
    child: { sex: "male", age_months: 20 },
    anthropometry: {
      weight_for_age: { available: false, reason_unavailable: "x" },
      height_for_age: { available: false, reason_unavailable: "x" },
      weight_for_length_or_height: { available: false, reason_unavailable: "x", standard_used: null },
      bmi_for_age: { available: false, reason_unavailable: "x" },
    },
    nacs_classification: {
      overallAcuteMalnutritionClassification: "severe",
      indicators: [{ indicator: "muac", value: "110 mm", classification: "severe", cutoffApplied: "x" }],
    },
    nacs_classification_skipped_reason: null,
    screening: { tools_administered: [], tools_skipped: [], strongkids: null, pnst: null, pyms: null, stamp: null, disagreement_noted: false },
    recommended_action: { urgency: "urgent", action: "Refer now." },
    clinical_flags: [],
  };

  test("falls back to the deterministic format when no GROQ_API_KEY is set", async () => {
    const text = await explainUnder5ScreeningResult(fakeResult, {});
    assert.equal(text, formatUnder5ScreeningResult(fakeResult));
  });

  test("normalizes the model's markdown **bold** into WhatsApp *bold* in the final message", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "Weight-for-age z-score is **-3.67**, severely underweight." } }] }),
          { status: 200 }
        );
      const text = await explainUnder5ScreeningResult(fakeResult, { GROQ_API_KEY: "test-key" });
      assert.match(text, /\*-3\.67\*/);
      assert.doesNotMatch(text, /\*\*/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses the model's text but ALWAYS appends the real recommended action + disclaimer verbatim", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, init) => {
        assert.match(url, /groq\.com/);
        const body = JSON.parse(init.body);
        assert.match(body.messages[1].content, /"urgency":"urgent"/); // real result JSON was actually sent
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "This child shows severe signs on MUAC, achimwene." } }] }),
          { status: 200 }
        );
      };
      const text = await explainUnder5ScreeningResult(fakeResult, { GROQ_API_KEY: "test-key" });
      assert.match(text, /achimwene/);
      // The real recommended action must appear verbatim regardless of what the model said
      assert.match(text, /Refer now\./);
      assert.match(text, /Recommended action \(urgent\)/);
      assert.match(text, /decision support only/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back to deterministic formatting if the Groq call fails", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response("server error", { status: 500 });
      const text = await explainUnder5ScreeningResult(fakeResult, { GROQ_API_KEY: "test-key" });
      assert.equal(text, formatUnder5ScreeningResult(fakeResult));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back to deterministic formatting if Groq returns empty content", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 });
      const text = await explainUnder5ScreeningResult(fakeResult, { GROQ_API_KEY: "test-key" });
      assert.equal(text, formatUnder5ScreeningResult(fakeResult));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back to deterministic formatting if the fetch itself throws (e.g. timeout)", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        throw new Error("network error");
      };
      const text = await explainUnder5ScreeningResult(fakeResult, { GROQ_API_KEY: "test-key" });
      assert.equal(text, formatUnder5ScreeningResult(fakeResult));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("handleUnder5ScreeningFlow — end to end with a fake env", () => {
  function makeFakeEnv(mcpToolResponse) {
    const rows = new Map(); // whatsapp_id -> row

    const fakeDB = {
      prepare(sql) {
        return {
          bind(...args) {
            this._args = args;
            this._sql = sql;
            return this;
          },
          async run() {
            if (sql.startsWith("INSERT INTO last_session_context")) {
              const [whatsappId, kind, payloadJson, updatedAt] = this._args;
              rows.set(`${whatsappId}:${kind}`, { payload_json: payloadJson, updated_at: updatedAt });
            } else if (sql.startsWith("DELETE FROM last_session_context")) {
              const [whatsappId, kind] = this._args;
              rows.delete(`${whatsappId}:${kind}`);
            }
          },
          async first() {
            const [whatsappId, kind] = this._args;
            return rows.get(`${whatsappId}:${kind}`) ?? null;
          },
        };
      },
    };

    const fakeMcpWorker = {
      async fetch(url, init) {
        const body = JSON.parse(init.body);
        assert.equal(body.method, "tools/call");
        assert.equal(body.params.name, "under5_integrated_screen");
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: JSON.stringify({ data: mcpToolResponse }) }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      },
    };

    return {
      DB: fakeDB,
      CHAKUDYA_MCP: fakeMcpWorker,
      CHAKUDYA_MCP_AUTH_TOKEN: "test-token",
    };
  }

  test("full flow: trigger -> sex -> age -> skip the rest -> result", async () => {
    const env = makeFakeEnv({
      child: { sex: "male", age_months: 8 },
      anthropometry: {
        weight_for_age: { available: false, reason_unavailable: "x" },
        height_for_age: { available: false, reason_unavailable: "x" },
        weight_for_length_or_height: { available: false, reason_unavailable: "x", standard_used: null },
        bmi_for_age: { available: false, reason_unavailable: "x" },
      },
      nacs_classification: null,
      nacs_classification_skipped_reason: "No edema, MUAC, or WHZ available to classify.",
      screening: { tools_administered: [], tools_skipped: [], strongkids: null, pnst: null, pyms: null, stamp: null, disagreement_noted: false },
      recommended_action: { urgency: "routine", action: "No malnutrition risk identified." },
      clinical_flags: [],
    });
    const from = "265888000000";

    const r1 = await handleUnder5ScreeningFlow("please screen my child for malnutrition", from, env);
    assert.match(r1, /boy or a girl/);

    const r2 = await handleUnder5ScreeningFlow("boy", from, env);
    assert.match(r2, /how old/i);

    const r3 = await handleUnder5ScreeningFlow("8 months", from, env);
    assert.match(r3, /weight/i);

    const r4 = await handleUnder5ScreeningFlow("skip", from, env); // weight
    const r5 = await handleUnder5ScreeningFlow("skip", from, env); // height
    const r6 = await handleUnder5ScreeningFlow("skip", from, env); // muac
    const r7 = await handleUnder5ScreeningFlow("skip", from, env); // edema
    const r8 = await handleUnder5ScreeningFlow("skip", from, env); // context -> under 12mo, goes straight to finish

    assert.match(r8, /No malnutrition risk identified/);
    assert.match(r8, /decision support only/);
  });

  test("cancel clears the session", async () => {
    const env = makeFakeEnv({});
    const from = "265888000001";
    await handleUnder5ScreeningFlow("screen a child", from, env);
    const reply = await handleUnder5ScreeningFlow("cancel", from, env);
    assert.match(reply, /cancelled/i);
    // A fresh non-trigger message afterward should not be treated as flow input
    const after = await handleUnder5ScreeningFlow("hello", from, env);
    assert.equal(after, null);
  });

  test("an unrelated message with no active session returns null (falls through)", async () => {
    const env = makeFakeEnv({});
    const reply = await handleUnder5ScreeningFlow("what's in a banana?", "265888000002", env);
    assert.equal(reply, null);
  });
});
