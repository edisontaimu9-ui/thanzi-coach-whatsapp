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
  splitForSpeech,
  mergeWavs,
  TTS_CHUNK_CHARS,
  diagnoseVoice,
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

describe("diagnoseVoice", () => {
  const okFetch = (status = 200) => async (url) => new Response(new Uint8Array([1, 2, 3]), { status });
  const route = (tts, conv) => async (url) => (String(url).includes("groq.com") ? tts() : conv());

  test("stops early and names missing settings", async () => {
    const out = (await diagnoseVoice({ VOICE_REPLIES: "off" }, "265")).join("\n");
    assert.match(out, /VOICE_REPLIES: "off" ❌/);
    assert.match(out, /VOICE_CONVERTER_URL: MISSING/);
    assert.match(out, /Stopped/);
  });
  test("all steps pass", async () => {
    let sent = false;
    const out = (await diagnoseVoice({ ...ENV, VOICE_CONVERTER_TOKEN: "t" }, "265", {
      fetch: okFetch(),
      send: async () => { sent = true; },
    })).join("\n");
    assert.equal(sent, true);
    assert.match(out, /✅ Groq TTS/);
    assert.match(out, /✅ Converter/);
    assert.match(out, /✅ WhatsApp/);
    assert.match(out, /All steps passed/);
    assert.doesNotMatch(out, /❌/);
  });
  test("reports a Groq failure and does not try later steps", async () => {
    let sent = false;
    const out = (await diagnoseVoice({ ...ENV, VOICE_CONVERTER_TOKEN: "t" }, "265", {
      fetch: async () => new Response('{"error":"model_terms_required"}', { status: 400 }),
      send: async () => { sent = true; },
    })).join("\n");
    assert.match(out, /❌ Groq TTS: HTTP 400 .*model_terms_required/);
    assert.doesNotMatch(out, /Converter:/);
    assert.equal(sent, false);
  });
  test("converter 401 hints at the token", async () => {
    const out = (await diagnoseVoice({ ...ENV, VOICE_CONVERTER_TOKEN: "t" }, "265", {
      fetch: route(() => new Response(new Uint8Array([1])), () => new Response("Unauthorized", { status: 401 })),
      send: async () => {},
    })).join("\n");
    assert.match(out, /❌ Converter: HTTP 401 \(token doesn't match/);
  });
  test("a WhatsApp upload error is reported", async () => {
    const out = (await diagnoseVoice({ ...ENV, VOICE_CONVERTER_TOKEN: "t" }, "265", {
      fetch: okFetch(),
      send: async () => { throw new Error("WhatsApp media upload error: 400 bad"); },
    })).join("\n");
    assert.match(out, /❌ WhatsApp: WhatsApp media upload error: 400 bad/);
  });
  test("never prints secret values", async () => {
    const out = (await diagnoseVoice({ ...ENV, GROQ_API_KEY: "SECRETKEY", VOICE_CONVERTER_TOKEN: "SECRETTOKEN" }, "265", { fetch: okFetch(), send: async () => {} })).join("\n");
    assert.doesNotMatch(out, /SECRETKEY|SECRETTOKEN/);
  });
});

function makeWav(samples, { rate = 48000, sizeField } = {}) {
  const data = new Uint8Array(samples);
  const out = new Uint8Array(44 + data.length);
  const dv = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  dv.setUint32(4, 36 + data.length, true);
  out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  out.set([0x64, 0x61, 0x74, 0x61], 36);
  dv.setUint32(40, sizeField ?? data.length, true);
  out.set(data, 44);
  return out;
}

describe("splitForSpeech", () => {
  test("short text stays whole; empty gives nothing", () => {
    assert.deepEqual(splitForSpeech("Hello there."), ["Hello there."]);
    assert.deepEqual(splitForSpeech(""), []);
  });
  test("packs whole sentences into pieces within the limit", () => {
    const text = "One two three. Four five six. Seven eight nine. Ten eleven twelve.";
    const parts = splitForSpeech(text, 40);
    assert.deepEqual(parts, ["One two three. Four five six.", "Seven eight nine. Ten eleven twelve."]);
    assert.ok(parts.every((p) => p.length <= 40));
  });
  test("does not split decimals", () => {
    assert.deepEqual(splitForSpeech("Rice has 2.5 g of fibre.", 60), ["Rice has 2.5 g of fibre."]);
  });
  test("an over-long sentence is split at word boundaries", () => {
    const parts = splitForSpeech("word ".repeat(100).trim() + ".", 50);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((p) => p.length <= 50));
    assert.equal(parts.join(" ").replace(/\s+/g, " "), "word ".repeat(100).trim() + ".");
  });
  test("every piece fits Groq's 200 character limit by default", () => {
    assert.ok(TTS_CHUNK_CHARS <= 200);
    const parts = splitForSpeech("Beans are rich in iron and protein. ".repeat(40));
    assert.ok(parts.every((p) => p.length <= TTS_CHUNK_CHARS));
  });
});

describe("mergeWavs", () => {
  test("a single wav is returned untouched", () => {
    const w = makeWav([1, 2, 3, 4]);
    assert.equal(mergeWavs([w]), w);
  });
  test("joins sample data under one valid header", () => {
    const merged = mergeWavs([makeWav([1, 2, 3, 4]), makeWav([5, 6]), makeWav([7, 8, 9, 10])]);
    const dv = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
    assert.equal(String.fromCharCode(...merged.subarray(0, 4)), "RIFF");
    assert.equal(dv.getUint32(40, true), 10);
    assert.equal(dv.getUint32(4, true), 36 + 10);
    assert.equal(dv.getUint32(24, true), 48000);
    assert.deepEqual([...merged.subarray(44)], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  test("treats a streaming size field (0 or 0xFFFFFFFF) as data to the end", () => {
    const merged = mergeWavs([makeWav([1, 2], { sizeField: 0xffffffff }), makeWav([3, 4], { sizeField: 0 })]);
    assert.deepEqual([...merged.subarray(44)], [1, 2, 3, 4]);
  });
  test("returns null for mismatched formats or non-wav input", () => {
    assert.equal(mergeWavs([makeWav([1, 2]), makeWav([3, 4], { rate: 24000 })]), null);
    assert.equal(mergeWavs([makeWav([1, 2]), new Uint8Array([1, 2, 3])]), null);
    assert.equal(mergeWavs([]), null);
  });
});

describe("speakReply with long text", () => {
  const LONG = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} says that beans are rich in iron and fibre.`).join(" ");
  test("speaks several pieces, each within the limit, and joins them", async () => {
    const pieces = [];
    let merged = null;
    let sent = null;
    const ok = await speakReply(LONG, "265", ENV, {
      synthesize: async (t) => { pieces.push(t); return makeWav([pieces.length, pieces.length]); },
      convert: async (w) => { merged = w; return new Uint8Array([9]); },
      send: async (to, b) => { sent = b; },
    });
    assert.equal(ok, true);
    assert.ok(pieces.length > 1 && pieces.length <= 5);
    assert.ok(pieces.every((p) => p.length <= 190));
    assert.equal(merged.length, 44 + pieces.length * 2);
    assert.deepEqual([...sent], [9]);
  });
  test("a later piece failing still sends the earlier ones", async () => {
    let n = 0;
    let merged = null;
    const ok = await speakReply(LONG, "265", ENV, {
      synthesize: async () => (++n <= 2 ? makeWav([n, n]) : null),
      convert: async (w) => { merged = w; return new Uint8Array([9]); },
      send: async () => {},
    });
    assert.equal(ok, true);
    assert.equal(n, 3);
    assert.equal(merged.length, 44 + 4);
  });
  test("never more than 5 TTS requests", async () => {
    let n = 0;
    await speakReply("A fairly long sentence about nutrition. ".repeat(100), "265", { ...ENV, VOICE_MAX_CHARS: "1200" }, {
      synthesize: async () => { n++; return makeWav([1, 1]); },
      convert: async () => new Uint8Array([9]),
      send: async () => {},
    });
    assert.equal(n, 5);
  });
});
