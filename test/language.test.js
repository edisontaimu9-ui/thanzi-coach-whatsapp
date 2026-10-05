import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMessageLanguage, resolveLanguage, nextLanguageState, detectLanguageCommand, languageConfirmation,
  getLanguageState, saveLanguageState, learnLanguage,
} from "../src/language.js";

function fakeDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind: (...a) => ({
          async first() {
            const r = rows.get(a[0]);
            return r ? { language: r.language, locked: r.locked, en_streak: r.en_streak } : null;
          },
          async run() {
            rows.set(a[0], { language: a[1], locked: a[2], en_streak: a[3] });
            return {};
          },
        }),
      };
    },
  };
}

describe("classifyMessageLanguage", () => {
  test("Chichewa, English, and unclear", () => {
    assert.equal(classifyMessageLanguage("Kodi nsima ili ndi ma calories angati?"), "ny");
    assert.equal(classifyMessageLanguage("what foods are high in iron?"), "en");
    for (const t of ["nsima", "yes", "50g", "and for children?", "ok thanks"]) {
      assert.equal(classifyMessageLanguage(t), null, t);
    }
  });
});

describe("resolveLanguage", () => {
  const ny = { language: "ny", locked: false, en_streak: 0 };
  test("ambiguous messages follow the stored language", () => {
    assert.equal(resolveLanguage("nsima", ny), "ny");
    assert.equal(resolveLanguage("nsima", { language: "en", locked: false, en_streak: 0 }), "en");
    assert.equal(resolveLanguage("nsima", null), "en");
  });
  test("a clear signal in this message beats the stored preference", () => {
    assert.equal(resolveLanguage("what foods are high in iron?", ny), "en");
    assert.equal(resolveLanguage("Kodi nsima ndi wabwino?", { language: "en", locked: false, en_streak: 0 }), "ny");
  });
  test("a locked choice always wins", () => {
    assert.equal(resolveLanguage("Kodi nsima ndi wabwino?", { language: "en", locked: true, en_streak: 0 }), "en");
    assert.equal(resolveLanguage("what foods are high in iron?", { language: "ny", locked: true, en_streak: 0 }), "ny");
  });
});

describe("nextLanguageState", () => {
  test("Chichewa switches immediately; unclear changes nothing", () => {
    assert.deepEqual(nextLanguageState(null, "Kodi nsima ndi wabwino?"), { language: "ny", locked: false, en_streak: 0 });
    const s = { language: "ny", locked: false, en_streak: 1 };
    assert.deepEqual(nextLanguageState(s, "nsima"), s);
  });
  test("a Chichewa user needs two clear English messages in a row to switch", () => {
    let s = { language: "ny", locked: false, en_streak: 0 };
    s = nextLanguageState(s, "how much protein do I need daily");
    assert.deepEqual(s, { language: "ny", locked: false, en_streak: 1 });
    s = nextLanguageState(s, "what foods are high in iron?");
    assert.equal(s.language, "en");
    assert.equal(s.en_streak, 0);
  });
  test("a Chichewa message resets the English streak", () => {
    const s = nextLanguageState({ language: "ny", locked: false, en_streak: 1 }, "Kodi nsima ndi wabwino?");
    assert.equal(s.en_streak, 0);
    assert.equal(s.language, "ny");
  });
  test("new users start as English on a clear English message; locked never changes", () => {
    assert.equal(nextLanguageState(null, "what foods are high in iron?").language, "en");
    const locked = { language: "en", locked: true, en_streak: 0 };
    assert.deepEqual(nextLanguageState(locked, "Kodi nsima ndi wabwino?"), locked);
  });
});

describe("detectLanguageCommand", () => {
  test("explicit switches in both languages", () => {
    for (const t of ["English", "english please", "Reply in English", "in english", "Switch to English", "Yankhani mu Chingerezi", "chingerezi"]) {
      assert.equal(detectLanguageCommand(t), "en", t);
    }
    for (const t of ["Chichewa", "Reply in Chichewa", "speak chichewa please", "Yankhani mu Chichewa", "mu chichewa", "Chinyanja"]) {
      assert.equal(detectLanguageCommand(t), "ny", t);
    }
  });
  test("ordinary messages that merely mention a language are not commands", () => {
    for (const t of ["what is the english name for nsima", "Chichewa name for beans?", "hi", ""]) {
      assert.equal(detectLanguageCommand(t), null, t);
    }
    assert.match(languageConfirmation("en"), /Chichewa/);
    assert.match(languageConfirmation("ny"), /English/);
  });
});

describe("D1 helpers", () => {
  test("save then read round-trips; unknown ids are null", async () => {
    const db = fakeDb();
    assert.equal(await getLanguageState(db, "A"), null);
    assert.equal(await saveLanguageState(db, "A", { language: "ny", locked: true, en_streak: 0 }), true);
    assert.deepEqual(await getLanguageState(db, "A"), { language: "ny", locked: true, en_streak: 0 });
  });
  test("learnLanguage writes only on change", async () => {
    const db = fakeDb();
    assert.equal(await learnLanguage(db, "A", null, "nsima"), false); // unclear: nothing to save
    assert.equal(await learnLanguage(db, "A", null, "Kodi nsima ndi wabwino?"), true);
    const st = await getLanguageState(db, "A");
    assert.equal(st.language, "ny");
    assert.equal(await learnLanguage(db, "A", st, "Kodi nsima ndi wabwino?"), false); // unchanged
  });
  test("database trouble never throws", async () => {
    const broken = { prepare() { throw new Error("D1 down"); } };
    assert.equal(await getLanguageState(broken, "A"), null);
    assert.equal(await saveLanguageState(broken, "A", { language: "en", locked: false, en_streak: 0 }), false);
    assert.equal(await getLanguageState(undefined, "A"), null);
    assert.equal(await saveLanguageState(undefined, "A", { language: "en" }), false);
  });
});
