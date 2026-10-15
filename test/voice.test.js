import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_CHARS,
  getVoicePref,
  maxSpokenChars,
  parseVoiceCommand,
  prepareSpokenText,
  saveVoicePref,
  shouldSpeak,
  speakReply,
  voiceModeConfirmation,
  voiceRepliesEnabled,
} from "../src/voice.js";

const ENV = { VOICE_REPLIES: "on", GROQ_API_KEY: "k", VOICE_CONVERTER_URL: "https://conv.example" };

describe("voiceRepliesEnabled / maxSpokenChars", () => {
  test("needs the switch, the Groq key and the converter URL", () => {
    assert.equal(voiceRepliesEnabled(ENV), true);
    assert.equal(voiceRepliesEnabled({ ...ENV, VOICE_REPLIES: "off" }), false);
    assert.equal(voiceRepliesEnabled({ ...ENV, GROQ_API_KEY: "" }), false);
    assert.equal(voiceRepliesEnabled({ ...ENV, VOICE_CONVERTER_URL: undefined }), false);
    assert.equal(voiceRepliesEnabled({}), false);
  });
  test("VOICE_MAX_CHARS is bounded, else default", () => {
    assert.equal(maxSpokenChars({}), DEFAULT_MAX_CHARS);
    assert.equal(maxSpokenChars({ VOICE_MAX_CHARS: "250" }), 250);
    assert.equal(maxSpokenChars({ VOICE_MAX_CHARS: "5" }), DEFAULT_MAX_CHARS);
    assert.equal(maxSpokenChars({ VOICE_MAX_CHARS: "9999" }), DEFAULT_MAX_CHARS);
  });
});

describe("prepareSpokenText", () => {
  test("strips markdown, emojis, citations, links and tags", () => {
    const out = prepareSpokenText("*Iron* is found in _beans_ [1] 🌱 <giggle> see https://x.org/a ok");
    assert.equal(out, "Iron is found in beans see ok.");
  });
  test("drops a trailing References block", () => {
    const out = prepareSpokenText("Beans are rich in iron.\n\nReferences:\n[1] Some guideline");
    assert.equal(out, "Beans are rich in iron.");
  });
  test("joins lines and speaks units naturally", () => {
    const out = prepareSpokenText("Nsima\n- 120 kcal\n- 5% protein");
    assert.equal(out, "Nsima. 120 calories. 5 percent protein.");
  });
  test("cuts at the last sentence that fits and ignores decimal points", () => {
    const text = "Rice has 2.5 g of fibre in every single serving you eat. Beans have more fibre and plenty of protein too. Eat both.";
    const out = prepareSpokenText(text, 80);
    assert.equal(out, "Rice has 2.5 g of fibre in every single serving you eat.");
    assert.ok(out.length <= 80);
  });
  test("falls back to a word boundary when the first sentence is too long", () => {
    const out = prepareSpokenText("word ".repeat(80), 100);
    assert.ok(out.length <= 101);
    assert.ok(out.endsWith("."));
  });
  test("returns empty when nothing speakable remains", () => {
    assert.equal(prepareSpokenText("🙂🙂 [1] https://x.org"), "");
    assert.equal(prepareSpokenText(""), "");
    assert.equal(prepareSpokenText(null), "");
  });
});

describe("parseVoiceCommand / shouldSpeak", () => {
  test("recognises whole-message commands only", () => {
    assert.equal(parseVoiceCommand("voice on"), "on");
    assert.equal(parseVoiceCommand("Voice OFF!"), "off");
    assert.equal(parseVoiceCommand("voice auto"), "auto");
    assert.equal(parseVoiceCommand("turn voice replies off"), "off");
    assert.equal(parseVoiceCommand("enable voice"), "on");
    assert.equal(parseVoiceCommand("disable voice notes"), "off");
    assert.equal(parseVoiceCommand("is voice on in my iron plan?"), null);
    assert.equal(parseVoiceCommand("voice"), null);
    assert.equal(parseVoiceCommand(""), null);
  });
  test("modes decide whether to speak", () => {
    assert.equal(shouldSpeak(null, true), true);
    assert.equal(shouldSpeak("auto", true), true);
    assert.equal(shouldSpeak("auto", false), false);
    assert.equal(shouldSpeak("on", false), true);
    assert.equal(shouldSpeak("off", true), false);
  });
  test("each confirmation names the mode", () => {
    assert.match(voiceModeConfirmation("on"), /\*on\*/);
    assert.match(voiceModeConfirmation("off"), /\*off\*/);
    assert.match(voiceModeConfirmation("auto"), /\*auto\*/);
  });
});

describe("voice pref in D1", () => {
  function fakeDb() {
    const rows = new Map();
    return {
      rows,
      prepare(sql) {
        return {
          bind: (...a) => ({
            async first() {
              return rows.has(a[0]) ? { mode: rows.get(a[0]) } : null;
            },
            async run() {
              if (/^INSERT/.test(sql.trim())) rows.set(a[0], a[1]);
              return {};
            },
          }),
        };
      },
    };
  }
  test("round-trips and rejects bad modes", async () => {
    const db = fakeDb();
    assert.equal(await getVoicePref(db, "265"), null);
    assert.equal(await saveVoicePref(db, "265", "on"), true);
    assert.equal(await getVoicePref(db, "265"), "on");
    assert.equal(await saveVoicePref(db, "265", "loud"), false);
    assert.equal(await getVoicePref(null, "265"), null);
  });
  test("a broken database never throws", async () => {
    const bad = { prepare() { throw new Error("boom"); } };
    assert.equal(await getVoicePref(bad, "265"), null);
    assert.equal(await saveVoicePref(bad, "265", "off"), false);
  });
});

describe("speakReply", () => {
  const wav = new Uint8Array([1, 2, 3]);
  const ogg = new Uint8Array([4, 5]);

  test("runs the pipeline in order and sends the converted audio", async () => {
    const seen = {};
    const ok = await speakReply("Beans are rich in iron. More detail follows.", "265", ENV, {
      synthesize: async (t) => { seen.text = t; return wav; },
      convert: async (w) => { seen.wav = w; return ogg; },
      send: async (to, bytes) => { seen.to = to; seen.bytes = bytes; },
    });
    assert.equal(ok, true);
    assert.equal(seen.text, "Beans are rich in iron. More detail follows.");
    assert.equal(seen.wav, wav);
    assert.equal(seen.to, "265");
    assert.equal(seen.bytes, ogg);
  });
  test("does nothing when voice is not enabled", async () => {
    let called = false;
    const ok = await speakReply("Hello there friend.", "265", {}, { synthesize: async () => { called = true; return wav; } });
    assert.equal(ok, false);
    assert.equal(called, false);
  });
  test("a failed step stops quietly and never throws", async () => {
    let sent = false;
    const send = async () => { sent = true; };
    assert.equal(await speakReply("Hello there friend.", "265", ENV, { synthesize: async () => null, send }), false);
    assert.equal(await speakReply("Hello there friend.", "265", ENV, { synthesize: async () => wav, convert: async () => null, send }), false);
    assert.equal(await speakReply("Hello there friend.", "265", ENV, { synthesize: async () => { throw new Error("x"); }, send }), false);
    assert.equal(await speakReply("Hello there friend.", "265", ENV, { synthesize: async () => wav, convert: async () => ogg, send: async () => { throw new Error("send"); } }), false);
    assert.equal(sent, false);
  });
  test("skips text with nothing speakable", async () => {
    let called = false;
    const ok = await speakReply("🙂", "265", ENV, { synthesize: async () => { called = true; return wav; } });
    assert.equal(ok, false);
    assert.equal(called, false);
  });
});
