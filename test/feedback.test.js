import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildFeedbackId, parseFeedbackId, shouldAskFeedback, buildFeedbackPrompt, buildFeedbackThanks,
  feedbackCounts, listFeedback,
  buildShareText, buildShareUrl, buildShareLink, buildShareMessage, getAnswerForShare, splitReferences, buildDetailsMessage,
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
          async first(col) {
            if (/SELECT answer/.test(sql)) {
              return rows.find((r) => r.id === a[0] && r.whatsapp_id === a[1]) || null;
            }
            if (/SELECT question/.test(sql)) {
              return rows.find((r) => r.id === a[0])?.question ?? null;
            }
            // cooldown count: whatsapp_id = a[0], ts >= a[1]
            return rows.filter((r) => r.whatsapp_id === a[0] && r.ts >= a[1]).length;
          },
          async run() {
            if (/^INSERT/.test(sql)) {
              const row = { id: nextId++, whatsapp_id: a[0], ts: a[1], question: a[2], answer: a[3], sources: a[4], rating: null, rated_at: null };
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
            if (/SELECT id, rated_at/.test(sql)) {
              const withRating = /rating = \?2/.test(sql);
              const limit = withRating ? a[2] : a[1];
              return {
                results: rows
                  .filter((r) => r.rating && r.rated_at >= a[0] && (!withRating || r.rating === a[1]))
                  .sort((x, y) => (x.rated_at < y.rated_at ? 1 : -1))
                  .slice(0, limit),
              };
            }
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
    assert.deepEqual(parseFeedbackId("fb:share:9"), { rating: "share", id: 9 });
    assert.deepEqual(parseFeedbackId("fb:details:11"), { rating: "details", id: 11 });
    assert.equal(buildFeedbackId("share", 9), "fb:share:9");
    for (const bad of ["fb:maybe:1", "fb:up:", "fb:up:abc", "hello", "", null, undefined, "fb:up:1 "]) {
      assert.equal(parseFeedbackId(bad), null, String(bad));
    }
  });
});

describe("prompt text", () => {
  test("titles fit WhatsApp's 20-char limit in both languages", () => {
    for (const ny of [false, true]) {
      const p = buildFeedbackPrompt(5, ny);
      assert.equal(p.buttons.length, 3);
      for (const b of p.buttons) assert.ok([...b.title].length <= 20, b.title);
      assert.equal(parseFeedbackId(p.buttons[0].id).id, 5);
    }
  });
  test("with hidden sources the first button is 📚 See details", () => {
    const p = buildFeedbackPrompt(8, false, true);
    assert.equal(p.buttons.length, 3);
    assert.match(p.buttons[0].title, /See details/);
    assert.equal(parseFeedbackId(p.buttons[0].id).rating, "details");
    assert.deepEqual(p.buttons.slice(1).map((b) => parseFeedbackId(b.id).rating), ["up", "down"]);
    assert.match(buildFeedbackPrompt(8, true, true).buttons[0].title, /Onani/);
    for (const b of [...p.buttons, ...buildFeedbackPrompt(8, true, true).buttons]) assert.ok([...b.title].length <= 20, b.title);
    // without sources, 📤 Share takes the third slot
    assert.match(buildFeedbackPrompt(8).buttons[2].title, /Share/);
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
    // error notices are never rated, however long
    assert.equal(shouldAskFeedback("Sorry, the BMI check couldn't be completed: tool failed. Please try again in a moment."), false);
    assert.equal(shouldAskFeedback("⏳ The nutrition database is busy right now, so I couldn't answer that. Nothing is lost, please send it again."), false);
    assert.equal(shouldAskFeedback("Nsima: 112 kcal, 2.5 g protein per 100 g. A real result card that is long enough to rate."), true);
  });
});

describe("createFeedbackPrompt / recordFeedback", () => {
  test("creates a row (truncated); every answer gets one unless a cooldown is requested", async () => {
    const db = fakeDb();
    const id = await createFeedbackPrompt(db, { whatsappId: "A", question: "q".repeat(500), answer: "a".repeat(2000), nowMs: T0 });
    assert.equal(id, 1);
    assert.equal(await createFeedbackPrompt(db, { whatsappId: "A", question: "q", answer: "a", nowMs: T0 + 1000 }), 2); // no cooldown by default
    db.rows.length = 0;
    assert.equal(await createFeedbackPrompt(db, { whatsappId: "A", question: "q".repeat(500), answer: "a".repeat(2000), sources: "s".repeat(2000), nowMs: T0, cooldownMs: FEEDBACK_COOLDOWN_MS }), 3);
    assert.equal(db.rows[0].sources.length, 800);
    assert.equal(db.rows[0].question.length, 200);
    assert.equal(db.rows[0].answer.length, 1500);
    assert.equal(await createFeedbackPrompt(db, { whatsappId: "A", question: "q", answer: "a", nowMs: T0 + 1000, cooldownMs: FEEDBACK_COOLDOWN_MS }), null);
    assert.equal(await createFeedbackPrompt(db, { whatsappId: "B", question: "q", answer: "a", nowMs: T0 + 1000, cooldownMs: FEEDBACK_COOLDOWN_MS }), 4);
    assert.equal(await createFeedbackPrompt(db, { whatsappId: "A", question: "q", answer: "a", nowMs: T0 + FEEDBACK_COOLDOWN_MS + 1000, cooldownMs: FEEDBACK_COOLDOWN_MS }), 5);
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

describe("📤 Share", () => {
  const answer =
    "Iron-rich foods include beans, green leafy vegetables and fortified cereals [1]. Pair them with vitamin C to help absorption [2]. " +
    "x".repeat(0) + "\n\nReferences:\n[1] Chakudya Malawi Guidelines 2017\n[2] Chakudya Database";

  test("share text drops citations and the References block, and signs off", () => {
    const t = buildShareText(answer);
    assert.doesNotMatch(t, /\[\d\]/);
    assert.doesNotMatch(t, /References/);
    assert.match(t, /Iron-rich foods include beans/);
    assert.match(t, /— Thanzi Coach$/);
    assert.match(buildShareText(answer, "+265 886 29 53 24"), /https:\/\/wa\.me\/265886295324/);
  });

  test("a short answer is shared whole, without the excerpt marker", () => {
    const t = buildShareText("Beans are rich in iron [1].\n\nPair them with vitamin C [2].");
    assert.match(t, /Pair them with vitamin C\./);
    assert.doesNotMatch(t, /More in/);
    assert.match(t, /— Thanzi Coach$/);
  });

  test("long answers are cut at a paragraph break and marked as an excerpt", () => {
    const para = (i) => `Paragraph ${i} says something useful about nutrition. `.repeat(8).trim();
    const long = [1, 2, 3, 4, 5, 6].map(para).join("\n\n");
    const t = buildShareText(long, "265886295324");
    assert.ok(t.length < 1400);
    assert.match(t, /\n\n…\n— More in Thanzi Coach \(https:\/\/wa\.me\/265886295324\)$/);
    const body = t.split("\n\n…")[0];
    assert.ok(body.split("\n\n").every((p) => /^Paragraph \d says/.test(p)), "only whole paragraphs");
  });

  test("never ends on a dangling heading (the reported DASH bug)", () => {
    const intro = "The DASH diet is a heart-healthy eating pattern that lowers blood pressure. ".repeat(12).trim();
    const answer = `${intro}\n\nTypical Malawi DASH servings\n• Vegetables – 2 handfuls per day, e.g. tomatoes, carrots, leafy greens. ${"More detail here. ".repeat(40)}`;
    const t = buildShareText(answer, undefined, 900);
    assert.doesNotMatch(t, /Typical Malawi DASH servings\s*(\n\n…|$)/);
    assert.match(t, /More in Thanzi Coach/);
  });

  test("share URL decodes back to the text and stays under the limit", () => {
    const url = buildShareUrl("Hello nsima & beans — 100%");
    assert.equal(decodeURIComponent(url.split("text=")[1]), "Hello nsima & beans — 100%");
    const huge = buildShareUrl("ñ ".repeat(3000));
    assert.ok(huge.length <= 1900, String(huge.length));
  });

  test("buildShareLink picks the longest excerpt that fits the URL limit", () => {
    const long = Array.from({ length: 80 }, (_, i) => `Sentence ${i} with ñ and 100% accents & symbols.`).join(" ");
    const url = buildShareLink(long, "265886295324");
    assert.ok(url.length <= 1900, String(url.length));
    const text = decodeURIComponent(url.split("text=")[1]);
    assert.match(text, /More in Thanzi Coach/);
    const short = buildShareLink("Beans are rich in iron.", undefined);
    assert.equal(decodeURIComponent(short.split("text=")[1]), "Beans are rich in iron.\n\n— Thanzi Coach");
  });

  test("share message exists in both languages", () => {
    assert.match(buildShareMessage().body, /share this answer/);
    assert.match(buildShareMessage(true).displayText, /Gawirani/);
    assert.ok([...buildShareMessage().displayText].length <= 20);
    assert.ok([...buildShareMessage(true).displayText].length <= 20);
  });

  test("answer lookup only works for the owner", async () => {
    const db = fakeDb();
    const id = await createFeedbackPrompt(db, { whatsappId: "A", question: "iron?", answer, nowMs: T0 });
    assert.match((await getAnswerForShare(db, { id, whatsappId: "A" })).answer, /Iron-rich/);
    assert.equal(await getAnswerForShare(db, { id, whatsappId: "B" }), null);
    assert.equal(await getAnswerForShare({ prepare() { throw new Error("x"); } }, { id, whatsappId: "A" }), null);
  });
});

describe("📚 See details", () => {
  test("splitReferences separates the hidden References block", () => {
    const a = "Iron is in beans [1].\n\n_References:_\n[1] Chakudya Malawi Ncst Guidelines 2017 Database";
    assert.deepEqual(splitReferences(a), { main: "Iron is in beans [1].", references: "[1] Chakudya Malawi Ncst Guidelines 2017 Database" });
    assert.deepEqual(splitReferences("Plain answer."), { main: "Plain answer.", references: "" });
    assert.deepEqual(splitReferences(""), { main: "", references: "" });
    assert.equal(splitReferences("Mentions references in passing, no block.").references, "");
  });

  test("details message holds the sources, fits WhatsApp's limits, in both languages", () => {
    const m = buildDetailsMessage("[1] Chakudya Guidelines");
    assert.match(m.body, /Sources/);
    assert.match(m.body, /\[1\] Chakudya Guidelines/);
    assert.ok([...m.displayText].length <= 20);
    assert.match(buildDetailsMessage("[1] x", true).body, /Magwero/);
    assert.ok(buildDetailsMessage("z".repeat(5000)).body.length <= 1024);
  });

  test("the stored sources come back through the owner-only lookup", async () => {
    const db = fakeDb();
    const id = await createFeedbackPrompt(db, { whatsappId: "A", question: "q", answer: "answer", sources: "[1] Src", nowMs: T0 });
    assert.equal((await getAnswerForShare(db, { id, whatsappId: "A" })).sources, "[1] Src");
    assert.equal(await getAnswerForShare(db, { id, whatsappId: "B" }), null);
  });
});

describe("dashboard queries", () => {
  async function seed(db) {
    for (const [who, rating, q, dt] of [["A", "up", "good q", 1000], ["B", "down", "bad q1", 2000], ["C", "down", "bad q2", 3000]]) {
      const id = await createFeedbackPrompt(db, { whatsappId: who, question: q, answer: "ans ".repeat(200), nowMs: T0 });
      await recordFeedback(db, { id, whatsappId: who, rating, nowMs: T0 + dt });
    }
    await createFeedbackPrompt(db, { whatsappId: "D", question: "unrated", answer: "a", nowMs: T0 });
  }

  test("feedbackCounts counts rated rows only; zeros on error", async () => {
    const db = fakeDb();
    await seed(db);
    assert.deepEqual(await feedbackCounts(db, 30, T0 + 5000), { up: 1, down: 2 });
    assert.deepEqual(await feedbackCounts({ prepare() { throw new Error("no table"); } }, 30), { up: 0, down: 0 });
  });

  test("listFeedback defaults to 👎, newest first, trims answers, never includes phone numbers", async () => {
    const db = fakeDb();
    await seed(db);
    const downs = await listFeedback(db, { nowMs: T0 + 5000 });
    assert.deepEqual(downs.map((r) => r.question), ["bad q2", "bad q1"]);
    assert.ok(downs[0].answer.length <= 300);
    assert.equal(JSON.stringify(downs).includes("whatsapp_id"), false);
    assert.deepEqual((await listFeedback(db, { rating: "up", nowMs: T0 + 5000 })).map((r) => r.question), ["good q"]);
    assert.equal((await listFeedback(db, { rating: "all", nowMs: T0 + 5000 })).length, 3);
    assert.equal((await listFeedback(db, { rating: "all", limit: 1, nowMs: T0 + 5000 })).length, 1);
    assert.equal(await listFeedback({ prepare() { throw new Error("x"); } }), null);
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

  test("prune drops rows older than 30 days only", async () => {
    const db = fakeDb();
    await createFeedbackPrompt(db, { whatsappId: "old", question: "q", answer: "a", nowMs: T0 - 100 * 86400 * 1000 });
    await createFeedbackPrompt(db, { whatsappId: "new", question: "q", answer: "a", nowMs: T0 - 10 * 86400 * 1000 });
    await pruneFeedback(db, T0);
    assert.deepEqual(db.rows.map((r) => r.whatsapp_id), ["new"]);
  });
});
