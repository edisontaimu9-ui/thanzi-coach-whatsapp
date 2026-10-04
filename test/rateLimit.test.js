import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  getLimits, evaluateCounts, checkRateLimit, pruneRateLimits, buildRateLimitNotice,
  DEFAULT_PER_MINUTE, DEFAULT_PER_HOUR,
} from "../src/rateLimit.js";

// Minimal in-memory stand-in for D1: only what checkRateLimit/pruneRateLimits use.
function fakeDb() {
  const rows = new Map(); // "id|window|start" -> count
  return {
    rows,
    prepare(sql) {
      return {
        bind: (...args) => ({
          sql,
          args,
          async run() {
            if (/DELETE/.test(sql)) {
              for (const k of [...rows.keys()]) if (Number(k.split("|")[2]) < args[0]) rows.delete(k);
            }
            return {};
          },
        }),
      };
    },
    async batch(stmts) {
      return stmts.map(({ args }) => {
        const key = args.join("|");
        rows.set(key, (rows.get(key) || 0) + 1);
        return { results: [{ count: rows.get(key) }] };
      });
    },
  };
}

describe("getLimits", () => {
  test("defaults, overrides, junk, and 0 (= disabled)", () => {
    assert.deepEqual(getLimits({}), { perMinute: DEFAULT_PER_MINUTE, perHour: DEFAULT_PER_HOUR });
    assert.deepEqual(getLimits({ RATE_LIMIT_PER_MINUTE: "5", RATE_LIMIT_PER_HOUR: "30" }), { perMinute: 5, perHour: 30 });
    assert.deepEqual(getLimits({ RATE_LIMIT_PER_MINUTE: "abc", RATE_LIMIT_PER_HOUR: "-3" }), { perMinute: 10, perHour: 100 });
    assert.deepEqual(getLimits({ RATE_LIMIT_PER_MINUTE: "0" }), { perMinute: 0, perHour: 100 });
  });
});

describe("evaluateCounts", () => {
  const limits = { perMinute: 10, perHour: 100 };
  test("at the limit is allowed; the first message over notifies; later ones are silent", () => {
    assert.equal(evaluateCounts({ minuteCount: 10, hourCount: 10 }, limits).limited, false);
    assert.deepEqual(evaluateCounts({ minuteCount: 11, hourCount: 11 }, limits), { limited: true, notify: true, scope: "minute" });
    assert.deepEqual(evaluateCounts({ minuteCount: 12, hourCount: 12 }, limits), { limited: true, notify: false, scope: "minute" });
  });
  test("hour window applies when the minute window is fine", () => {
    assert.deepEqual(evaluateCounts({ minuteCount: 2, hourCount: 101 }, limits), { limited: true, notify: true, scope: "hour" });
  });
  test("0 disables a window", () => {
    assert.equal(evaluateCounts({ minuteCount: 999, hourCount: 5 }, { perMinute: 0, perHour: 100 }).limited, false);
  });
});

describe("checkRateLimit", () => {
  const limits = { perMinute: 3, perHour: 100 };
  const t0 = Date.UTC(2026, 9, 4, 12, 0, 5);

  test("allows up to the limit, then limits with exactly one notice", async () => {
    const db = fakeDb();
    const out = [];
    for (let i = 0; i < 6; i++) out.push(await checkRateLimit(db, "265888", limits, t0 + i * 100));
    assert.deepEqual(out.map((r) => r.limited), [false, false, false, true, true, true]);
    assert.deepEqual(out.map((r) => r.notify), [false, false, false, true, false, false]);
  });

  test("the next minute starts fresh", async () => {
    const db = fakeDb();
    for (let i = 0; i < 5; i++) await checkRateLimit(db, "265888", limits, t0);
    assert.equal((await checkRateLimit(db, "265888", limits, t0 + 61_000)).limited, false);
  });

  test("senders are counted separately", async () => {
    const db = fakeDb();
    for (let i = 0; i < 5; i++) await checkRateLimit(db, "A", limits, t0);
    assert.equal((await checkRateLimit(db, "B", limits, t0)).limited, false);
  });

  test("fails open when the database errors or is missing", async () => {
    const broken = { prepare() { throw new Error("D1 down"); }, batch() { throw new Error("D1 down"); } };
    assert.deepEqual(await checkRateLimit(broken, "A", limits, t0), { limited: false, notify: false, scope: null });
    assert.equal((await checkRateLimit(undefined, "A", limits, t0)).limited, false);
  });

  test("both windows disabled -> no database call", async () => {
    const db = { prepare() { throw new Error("should not be called"); }, batch() { throw new Error("nope"); } };
    assert.equal((await checkRateLimit(db, "A", { perMinute: 0, perHour: 0 }, t0)).limited, false);
  });
});

describe("pruneRateLimits and notices", () => {
  test("prune removes only windows older than two hours", async () => {
    const db = fakeDb();
    const now = Date.UTC(2026, 9, 4, 12, 0, 0);
    const nowSec = Math.floor(now / 1000);
    db.rows.set(`A|60|${nowSec - 3 * 3600}`, 4);
    db.rows.set(`A|60|${nowSec - 60}`, 2);
    await pruneRateLimits(db, now);
    assert.equal(db.rows.size, 1);
    assert.ok(db.rows.has(`A|60|${nowSec - 60}`));
  });

  test("notices exist in English and Chichewa for both scopes", () => {
    assert.match(buildRateLimitNotice("minute"), /wait a minute/);
    assert.match(buildRateLimitNotice("hour"), /hourly/);
    assert.match(buildRateLimitNotice("minute", true), /mphindi/);
    assert.match(buildRateLimitNotice("hour", true), /ola/);
  });
});
