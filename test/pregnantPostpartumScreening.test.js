import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  detectPregnantPostpartumScreeningTrigger,
  handlePregnantPostpartumScreeningFlow,
} from "../src/pregnantPostpartumScreening.js";

describe("detectPregnantPostpartumScreeningTrigger", () => {
  test("matches common phrasings", () => {
    assert.equal(detectPregnantPostpartumScreeningTrigger("screen a pregnant woman for malnutrition"), true);
    assert.equal(detectPregnantPostpartumScreeningTrigger("postpartum screening"), true);
    assert.equal(detectPregnantPostpartumScreeningTrigger("check muac for antenatal patient"), true);
  });

  test("does not fire on the under-5 trigger wording", () => {
    assert.equal(detectPregnantPostpartumScreeningTrigger("screen a child for malnutrition"), false);
    assert.equal(detectPregnantPostpartumScreeningTrigger("check muac for my baby"), false);
  });

  test("does not fire on unrelated messages", () => {
    assert.equal(detectPregnantPostpartumScreeningTrigger("what should a pregnant woman eat"), false);
  });
});

describe("handlePregnantPostpartumScreeningFlow — end to end with a fake env", () => {
  function makeFakeEnv(mcpToolResponse) {
    const rows = new Map();

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
        assert.equal(body.params.name, "pregnant_postpartum_integrated_screen");
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

    return { DB: fakeDB, CHAKUDYA_MCP: fakeMcpWorker, CHAKUDYA_MCP_AUTH_TOKEN: "test-token" };
  }

  test("full flow: trigger -> muac -> cutoff -> edema -> weight loss -> result", async () => {
    const env = makeFakeEnv({
      classification: {
        population: "pregnant/postpartum women",
        indicators: [{ indicator: "muac", value: "180 mm", classification: "severe", cutoffApplied: "x" }],
        overallMalnutritionClassification: "severe",
        note: "x",
      },
      clinical_flags: [],
      recommended_action: { urgency: "urgent", action: "Refer now." },
      referral: { pathway: "x", todo_malawi_protocol: "TODO" },
      explanation: "x",
      limitations: ["x"],
    });
    const from = "265888000010";

    const r1 = await handlePregnantPostpartumScreeningFlow("screen a pregnant woman for malnutrition", from, env);
    assert.match(r1, /MUAC/);

    const r2 = await handlePregnantPostpartumScreeningFlow("180", from, env);
    assert.match(r2, /220mm or 230mm/);

    const r3 = await handlePregnantPostpartumScreeningFlow("skip", from, env); // cutoff -> default 220
    assert.match(r3, /oedema/);

    const r4 = await handlePregnantPostpartumScreeningFlow("no", from, env); // edema
    assert.match(r4, /weight loss/i);

    const r5 = await handlePregnantPostpartumScreeningFlow("skip", from, env); // weight loss -> finish
    assert.match(r5, /Refer now\./);
    assert.match(r5, /decision support only/);
  });

  test("cancel clears the session", async () => {
    const env = makeFakeEnv({});
    const from = "265888000011";
    await handlePregnantPostpartumScreeningFlow("screen a pregnant woman", from, env);
    const reply = await handlePregnantPostpartumScreeningFlow("cancel", from, env);
    assert.match(reply, /cancelled/i);
    const after = await handlePregnantPostpartumScreeningFlow("hello", from, env);
    assert.equal(after, null);
  });

  test("an unrelated message with no active session returns null", async () => {
    const env = makeFakeEnv({});
    const reply = await handlePregnantPostpartumScreeningFlow("what's in a banana?", "265888000012", env);
    assert.equal(reply, null);
  });

  test("invalid muac reply reprompts with an error rather than advancing", async () => {
    const env = makeFakeEnv({});
    const from = "265888000013";
    await handlePregnantPostpartumScreeningFlow("screen a pregnant woman for malnutrition", from, env);
    const reply = await handlePregnantPostpartumScreeningFlow("not a number", from, env);
    assert.match(reply, /Please reply with a number/);
  });
});
