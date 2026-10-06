import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TOPIC_LABELS, normalizeTopic, recordTopic, topicCounts, pruneTopics } from "../src/topics.js";

function fakeDb() {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      return {
        bind: (...a) => ({
          async run() {
            if (/^INSERT/.test(sql)) rows.push({ ts: a[0], topic: a[1] });
            if (/^DELETE/.test(sql)) for (let i = rows.length - 1; i >= 0; i--) if (rows[i].ts < a[0]) rows.splice(i, 1);
            return {};
          },
          async all() {
            const m = {};
            for (const r of rows) if (r.ts >= a[0]) m[r.topic] = (m[r.topic] || 0) + 1;
            return { results: Object.entries(m).map(([topic, n]) => ({ topic, n })).sort((x, y) => y.n - x.n) };
          },
        }),
      };
    },
  };
}

const T0 = Date.UTC(2026, 9, 5, 12);

describe("topics", () => {
  test("normalizeTopic keeps known keys and maps the rest to other", () => {
    assert.equal(normalizeTopic("qa"), "qa");
    assert.equal(normalizeTopic("nope"), "other");
    assert.equal(normalizeTopic(undefined), "other");
    assert.equal(normalizeTopic("constructor"), "other"); // not an inherited property
    assert.ok(Object.keys(TOPIC_LABELS).every((k) => TOPIC_LABELS[k]));
  });

  test("record then count, biggest first, with labels", async () => {
    const db = fakeDb();
    for (const t of ["qa", "qa", "qa", "food_lookup", "screening", "weird"]) await recordTopic(db, t, T0);
    const c = await topicCounts(db, 7, T0 + 1000);
    assert.deepEqual(c[0], { topic: "qa", label: "Nutrition Q&A", n: 3 });
    assert.equal(c.find((r) => r.topic === "other").n, 1);
    assert.equal(c.reduce((s, r) => s + r.n, 0), 6);
  });

  test("only the requested window is counted", async () => {
    const db = fakeDb();
    await recordTopic(db, "qa", T0 - 10 * 86400000);
    await recordTopic(db, "qa", T0);
    assert.equal((await topicCounts(db, 7, T0 + 1000))[0].n, 1);
    assert.equal((await topicCounts(db, 30, T0 + 1000))[0].n, 2);
  });

  test("prune drops rows older than 90 days only", async () => {
    const db = fakeDb();
    await recordTopic(db, "qa", T0 - 100 * 86400000);
    await recordTopic(db, "qa", T0 - 10 * 86400000);
    await pruneTopics(db, T0);
    assert.equal(db.rows.length, 1);
  });

  test("never throws without or with a broken database", async () => {
    const broken = { prepare() { throw new Error("D1 down"); } };
    await recordTopic(undefined, "qa");
    await recordTopic(broken, "qa");
    await pruneTopics(broken);
    assert.deepEqual(await topicCounts(broken, 7), []);
  });
});
