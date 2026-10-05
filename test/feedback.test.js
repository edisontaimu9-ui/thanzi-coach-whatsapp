import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildFeedbackId, parseFeedbackId, shouldAskFeedback, buildFeedbackPrompt, buildFeedbackThanks,
  createFeedbackPrompt, recordFeedback, feedbackSummary, pruneFeedback, FEEDBACK_COOLDOWN_MS,
} from "../src/feedback.js";

// Tiny in-memory D1 stand-in that understands exactly the statements src/feedback.js issues.
function fakeDb() {
  const rows = [];
  let nextId = 1;
  return {
    rows,
    prepare(sql) {
      return {
        bind: (...a) => ({
          async first() {
            // cooldown count: whatsapp_id = a[0], ts >= a[1]
            return rows.filter((r) => r.whatsapp_id === a[0] && r.ts >= a[1]).length;
          },
          async run() {
            if (/^INSERT/.test(sql)) {
              const row = { id: nextId++, whatsapp_id: a[0], ts: a[1], question: a[2], answer: a[3], rating: null, rated_at: null };
              rows.push(row);
              return { meta: { last_row_id: row.id } };
            }
            if (/^UPDATE/.test(sql)) {
              const row = rows.find((r) => r.id === a[2] && r.whatsapp_id === a[3] && r.rating === null);
              if (!row) return { meta: { changes: 0 } };
              row.rating = a[0];
              row.rated_at = a[1];
              return { meta: { changes: 1 } };
            }
            if (/^DELETE/.test(sql)) {
              for (let i = rows.length - 1; i >= 0; i--) if (rows[i].ts < a[0]) rows.splice(i, 1);
              return { meta: {} };
            }
            return { meta: {} };
          },
          async all() {
            if (/GROUP BY/.test(sql)) {
              const m = {};
              for (const r of rows) if (r.rating && r.rated_at >= a[0]) m[r.rating] = (m[r.rating] || 0) + 1;
              return { results: Object.entries(m).map(([rating, n]) => ({ rating, n })) };
            }
            return {
              results: rows
                .filter((r) => r.rating === "down" && r.rated_at >= a[0])
                .sort((x, y) => (x.rated_at < y.rated_at ? 1 : -1))
                .slice(0, 3)
                .map((r) => ({ question: r.question })),
            };
          },
        }),
      };
    },
  };
}

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);

describe("button ids", () => {
  test("round-trip and reject junk", () => {
    assert.equal(buildFeedbackId("up", 42), "fb:up:42");
    assert.deepEqual(parseFeedbackId("fb:down:7"), { rating: "down", id: 7 });
    for (const bad of ["fb:maybe:1", "fb:up:", "fb:up:abc", "hello", "", null, undefined, "fb:up:1 "]) {
      assert.equal(parseFeedbackId(bad), null, String(bad));
    }
  });
});

describe("prompt text", () => {
  test("titles fit WhatsApp's 20-char limit in both languages", () => {
    for (const ny of [false, true]) {
      const p = buildFeedbackPrompt(5, ny);
      assert.equal(p.buttons.length, 2);
      for (const b of p.buttons) assert.ok([...b.title].length <= 20, b.title);
      assert.equal(parseFeedbackId(p.buttons[0].id).id, 5);
    }
  });
  test("thanks differs by rating and language", () => {
    assert.match(buildFeedbackThanks("up"), /Glad/);
    assert.match(buildFeedbackThanks("down"), /another way/);
    assert.match(buildFeedbackThanks("up", true), /Zikomo/);
  });
  test("only substantive answers get asked about", () => {
    assert.equal(shouldAskFeedback("short"), false);
    assert.equal(shouldAskFeedback("x".repeat(200)), true);
    assert.equal(shouldAskFeedback(undefined), false);
  });
});

describe("createFeedbackPrompt / recordFeedback", () => {
  test("creates a row (truncated) and then respects the cooldown", async () => {
    const db = fakeDb();
    const id = await createFeedbackPrompt(db, { whatsappId: "A", question: "q".repeat(500), answer: "a".repeat(900), nowMs: T0 });
    assert.equal(id, 1);
    assert.equal(db.rows[0].question.length, 200);
    assert.equal(db.rows[0].answer.length, 300);
    assert.equal(await createFeedbackPrompt(db, { whatsappId: "A", question: "q", answer: "a", nowMs: T0 + 1000 }), null);
    assert.equal(await createFeedbackPrompt(db, { whatsappId: "B", question: "q", answer: "a", nowMs: T0 + 1000 }), 2);
    assert.equal(await createFeedbackPrompt(db, { whatsappId: "A", question: "q", answer: "a", nowMs: T0 + FEEDBACK_COOLDOWN_MS + 1000 }), 3);
  });

  test("a tap records once, only for the owner", async () => {
    const db = fakeDb();
    const id = await createFeedbackPrompt(db, { whatsappId: "A", question: "q", answer: "a", nowMs: T0 });
    assert.equal(await recordFeedback(db, { id, whatsappId: "B", rating: "up", nowMs: T0 }), false); // someone else's row
    assert.equal(await recordFeedback(db, { id, whatsappId: "A", rating: "down", nowMs: T0 }), true);
    assert.equal(await recordFeedback(db, { id, whatsappId: "A", rating: "up", nowMs: T0 }), false); // already rated
    assert.equal(db.rows[0].rating, "down");
  });

  test("database failures never throw", async () => {
    const broken = { prepare() { throw new Error("D1 down"); } };
    assert.equal(await createFeedbackPrompt(broken, { whatsappId: "A", question: "q", answer: "a" }), null);
    assert.equal(await recordFeedback(broken, { id: 1, whatsappId: "A", rating: "up" }), false);
    assert.equal(await feedbackSummary(broken), null);
    await pruneFeedback(broken);
    assert.equal(await createFeedbackPrompt(undefined, { whatsappId: "A" }), null);
  });
});

describe("feedbackSummary / pruneFeedback", () => {
  test("counts ratings and lists recent 👎 questions", async () => {
    const db = fakeDb();
    for (const [who, rating, q] of [["A", "up", "q1"], ["B", "down", "q2"], ["C", "down", "q3"]]) {
      const id = await createFeedbackPrompt(db, { whatsappId: who, question: q, answer: "a", nowMs: T0 });
      await recordFeedback(db, { id, whatsappId: who, rating, nowMs: T0 + 1000 });
    }
    const s = await feedbackSummary(db, T0 + 5000);
    assert.equal(s.up, 1);
    assert.equal(s.down, 2);
    assert.deepEqual(new Set(s.recentDown), new Set(["q2", "q3"]));
  });

  test("prune drops rows older than 90 days only", async () => {
    const db = fakeDb();
    await createFeedbackPrompt(db, { whatsappId: "old", question: "q", answer: "a", nowMs: T0 - 100 * 86400 * 1000 });
    await createFeedbackPrompt(db, { whatsappId: "new", question: "q", answer: "a", nowMs: T0 - 10 * 86400 * 1000 });
    await pruneFeedback(db, T0);
    assert.deepEqual(db.rows.map((r) => r.whatsapp_id), ["new"]);
  });
});
