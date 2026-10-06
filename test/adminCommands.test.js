import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseAdminCommand, buildStatsText, buildFeedbackText, getAdminStats, runAdminCommand, ADMIN_HELP_TEXT,
} from "../src/adminCommands.js";

describe("parseAdminCommand", () => {
  test("stats windows", () => {
    assert.deepEqual(parseAdminCommand("stats"), { type: "stats", days: 1 });
    assert.deepEqual(parseAdminCommand("Stats today"), { type: "stats", days: 1 });
    assert.deepEqual(parseAdminCommand("stats week"), { type: "stats", days: 7 });
    assert.deepEqual(parseAdminCommand("stats month"), { type: "stats", days: 30 });
    assert.deepEqual(parseAdminCommand("stats 7"), { type: "stats", days: 7 });
    assert.deepEqual(parseAdminCommand("stats 14d"), { type: "stats", days: 14 });
    assert.deepEqual(parseAdminCommand("stats 365"), { type: "stats", days: 90 }); // capped
    assert.deepEqual(parseAdminCommand("stats 0"), { type: "stats", days: 1 });
  });
  test("feedback and help", () => {
    assert.deepEqual(parseAdminCommand("feedback"), { type: "feedback", days: 7 });
    assert.deepEqual(parseAdminCommand("feedback 30"), { type: "feedback", days: 30 });
    assert.deepEqual(parseAdminCommand("admin"), { type: "help" });
    assert.deepEqual(parseAdminCommand("Commands!"), { type: "help" });
  });
  test("anything else is not a command (so it flows to the normal bot)", () => {
    for (const t of ["stats for nsima", "feedback on my diet", "statistics", "what are my stats", "", "hi"]) {
      assert.equal(parseAdminCommand(t), null, t);
    }
  });
});

describe("formatting", () => {
  const stats = { totalUsers: 120, newUsers: 5, activeUsers: 18, messages: 200, errors: 2, byType: [{ type: "text", n: 170 }, { type: "interactive", n: 30 }], up: 9, down: 3 };
  test("stats text has the numbers, error rate, mix and feedback", () => {
    const t = buildStatsText(7, stats);
    assert.match(t, /last 7 days/);
    assert.match(t, /120 total · 5 new · 18 active/);
    assert.match(t, /Errors: 2 \(1\.0%\)/);
    assert.match(t, /text 170 · interactive 30/);
    assert.match(t, /👍 9 · 👎 3 \(75% helpful\)/);
    assert.match(buildStatsText(1, { ...stats, errors: 0, up: 0, down: 0, byType: [] }), /last 24 hours[\s\S]*Errors: 0 ✅/);
    assert.doesNotMatch(buildStatsText(1, { ...stats, up: 0, down: 0 }), /Feedback/);
  });
  test("feedback text truncates, handles empty and errors", () => {
    assert.match(buildFeedbackText(7, [{ question: "iron in beans" }]), /“iron in beans”/);
    assert.match(buildFeedbackText(7, [{ question: "x".repeat(300) }]), /…/);
    assert.match(buildFeedbackText(7, []), /No 👎/);
    assert.match(buildFeedbackText(7, null), /Couldn't read/);
  });
});

function fakeDb() {
  return {
    prepare(sql) {
      const val = /FROM users$/.test(sql) ? 120 : /FROM users WHERE first_seen/.test(sql) ? 5 : /FROM users WHERE last_seen/.test(sql) ? 18
        : /type = 'error'/.test(sql) ? 2 : /type != 'error'/.test(sql) && !/GROUP BY/.test(sql) ? 200 : null;
      return {
        bind: () => ({
          async first() { return val; },
          async all() {
            if (/GROUP BY type/.test(sql)) return { results: [{ type: "text", n: 170 }, { type: "interactive", n: 30 }] };
            if (/GROUP BY rating/.test(sql)) return { results: [{ rating: "up", n: 9 }, { rating: "down", n: 3 }] };
            return { results: [{ id: 1, rated_at: "t", rating: "down", question: "bad q", answer: "a" }] };
          },
        }),
        first: async () => val,
      };
    },
  };
}

describe("D1 reads", () => {
  test("getAdminStats gathers everything", async () => {
    const s = await getAdminStats(fakeDb(), 7);
    assert.deepEqual(s, { totalUsers: 120, newUsers: 5, activeUsers: 18, messages: 200, errors: 2, byType: [{ type: "text", n: 170 }, { type: "interactive", n: 30 }], up: 9, down: 3 });
  });
  test("runAdminCommand routes each command", async () => {
    assert.equal(await runAdminCommand({ type: "help" }, fakeDb()), ADMIN_HELP_TEXT);
    assert.match(await runAdminCommand({ type: "stats", days: 7 }, fakeDb()), /120 total/);
    assert.match(await runAdminCommand({ type: "feedback", days: 7 }, fakeDb()), /“bad q”/);
  });
  test("database trouble gives a polite message, never a throw", async () => {
    const broken = { prepare() { throw new Error("D1 down"); } };
    assert.equal(await getAdminStats(broken, 7), null);
    assert.match(await runAdminCommand({ type: "stats", days: 7 }, broken), /Couldn't read stats/);
    assert.match(await runAdminCommand({ type: "feedback", days: 7 }, broken), /Couldn't read feedback/);
  });
});
