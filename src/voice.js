/**
 * Voice-note replies: a short spoken version of an answer, sent as a WhatsApp voice note AFTER the
 * normal text reply (the text is always sent first and is never affected by anything here).
 *
 * Pipeline: spoken text -> Groq Orpheus TTS (WAV) -> ffmpeg converter service (OGG/Opus, the only
 * format WhatsApp shows as a voice bubble; Workers can't run ffmpeg) -> WhatsApp media upload ->
 * audio message. See voice-converter/ for the converter and README.md "Voice-note replies".
 *
 * Modes per person (migrations/0011_add_user_voice.sql), set by sending "voice on|off|auto":
 *   auto (default) - reply with a voice note only when they sent a voice note
 *   on             - a voice note with every English answer
 *   off            - never
 * English only: Orpheus has no Chichewa voice, so Chichewa replies are never spoken.
 *
 * Off unless the Worker variable VOICE_REPLIES is "on" AND VOICE_CONVERTER_URL is set, so deploying
 * this code changes nothing until you opt in. Every step fails soft: no voice note, no error shown.
 * Pure helpers are unit-tested in test/voice.test.js.
 */

import { fetchWithTimeout } from "./http.js";
import { sendWhatsAppVoiceNote } from "./whatsapp.js";

export const TTS_URL = "https://api.groq.com/openai/v1/audio/speech";
export const TTS_MODEL = "canopylabs/orpheus-v1-english";
export const DEFAULT_VOICE = "autumn";
// Groq's Orpheus accepts at most 200 characters per request, so a longer spoken text is split into
// sentence-sized pieces (TTS_CHUNK_CHARS each), spoken one request at a time, and joined into one
// voice note. VOICE_MAX_CHARS is the total spoken length; MAX_SPOKEN_CHUNKS caps requests per reply
// (each one is a Worker subrequest and uses Groq quota).
export const DEFAULT_MAX_CHARS = 600;
export const TTS_CHUNK_CHARS = 190;
export const MAX_SPOKEN_CHUNKS = 5;
const MIN_MAX_CHARS = 60;
const MAX_MAX_CHARS = 1200;

export function voiceRepliesEnabled(env = {}) {
  return (
    String(env.VOICE_REPLIES || "").toLowerCase() === "on" &&
    Boolean(env.GROQ_API_KEY) &&
    Boolean(env.VOICE_CONVERTER_URL)
  );
}

export function maxSpokenChars(env = {}) {
  const n = Number.parseInt(env.VOICE_MAX_CHARS, 10);
  return Number.isFinite(n) && n >= MIN_MAX_CHARS && n <= MAX_MAX_CHARS ? n : DEFAULT_MAX_CHARS;
}

// ── Pure helpers ──

/**
 * Turns a WhatsApp-formatted answer into plain speakable text of at most `maxChars`, ending on a
 * sentence boundary where possible. Returns "" when nothing speakable is left.
 */
export function prepareSpokenText(text, maxChars = DEFAULT_MAX_CHARS) {
  let t = String(text || "");
  // Drop a trailing References/Sources block.
  t = t.split(/\n\s*[_*]*(?:references|sources|magwero)[_*]*\s*:?\s*(?:\n|$)/i)[0];
  t = t
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/<[^>]*>/g, " ") // Orpheus reads <tags> as vocal directions: never pass any through
    .replace(/\[\d+(?:[\s,\-–]+\d+)*\]/g, " ") // [1] [2,3] citation markers
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, " ")
    .replace(/[*_~`#>|]/g, " ")
    .replace(/^\s*(?:[-•▪◦]|\d+[.)])\s+/gm, "") // list bullets / numbering
    .replace(/\bkcal\b/gi, "calories")
    .replace(/%/g, " percent");

  // One line per thought: join lines, adding a full stop where a line has no closing punctuation.
  t = t
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((l) => (/[.!?:;,]$/.test(l) ? l : `${l}.`))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!/\p{L}/u.test(t)) return "";
  if (t.length <= maxChars) return t;

  // Cut at the last sentence end that fits ("." inside "2.5" doesn't count), else at a word.
  const window = t.slice(0, maxChars);
  let cut = -1;
  const boundary = /[.!?](?=\s|$)/g;
  let m;
  while ((m = boundary.exec(window))) cut = m.index + 1;
  if (cut >= 40) return window.slice(0, cut).trim();
  const lastSpace = window.lastIndexOf(" ");
  const base = (lastSpace > 20 ? window.slice(0, lastSpace) : window).replace(/[\s,;:]+$/, "");
  return `${base}.`;
}

function splitWords(sentence, limit) {
  const pieces = [];
  let cur = "";
  for (const word of sentence.split(/\s+/)) {
    if (word.length > limit) {
      if (cur) { pieces.push(cur); cur = ""; }
      for (let i = 0; i < word.length; i += limit) pieces.push(word.slice(i, i + limit));
      continue;
    }
    if (cur && cur.length + 1 + word.length > limit) { pieces.push(cur); cur = ""; }
    cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/** Splits spoken text into pieces of at most `limit` characters, breaking at sentence ends where it can. */
export function splitForSpeech(text, limit = TTS_CHUNK_CHARS) {
  const t = String(text || "").trim();
  if (!t) return [];
  const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean); // "2.5" has no space after the dot: not split
  const out = [];
  let cur = "";
  const flush = () => { if (cur) { out.push(cur); cur = ""; } };
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      flush();
      out.push(...splitWords(sentence, limit));
      continue;
    }
    if (cur && cur.length + 1 + sentence.length > limit) flush();
    cur = cur ? `${cur} ${sentence}` : sentence;
  }
  flush();
  return out;
}

const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));

// Reads a WAV's format block and sample bytes. Returns null if it isn't a plain RIFF/WAVE file.
function parseWav(bytes) {
  if (!bytes || bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= bytes.length) {
    const id = ascii(bytes, pos, 4);
    const size = dv.getUint32(pos + 4, true);
    const start = pos + 8;
    if (id === "fmt " && start + 16 <= bytes.length) fmt = bytes.slice(start, start + 16);
    if (id === "data") {
      // Streaming encoders may write 0 or 0xFFFFFFFF as the size: then the data runs to the end.
      const end = size === 0 || size === 0xffffffff || start + size > bytes.length ? bytes.length : start + size;
      return fmt ? { fmt, data: bytes.subarray(start, end) } : null;
    }
    pos = start + size + (size & 1);
  }
  return null;
}

/**
 * Joins several WAVs (same format, as Groq returns for one voice) into one. A single WAV is returned
 * untouched. Returns null if any is unreadable or the formats differ.
 */
export function mergeWavs(wavs) {
  if (!wavs?.length) return null;
  if (wavs.length === 1) return wavs[0];
  const parsed = wavs.map(parseWav);
  if (parsed.some((p) => !p)) return null;
  const fmt = parsed[0].fmt;
  if (parsed.some((p) => p.fmt.length !== fmt.length || p.fmt.some((v, i) => v !== fmt[i]))) return null;
  const total = parsed.reduce((n, p) => n + p.data.length, 0);
  const out = new Uint8Array(44 + total);
  const dv = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  dv.setUint32(4, 36 + total, true);
  out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8); // WAVEfmt 
  dv.setUint32(16, 16, true);
  out.set(fmt, 20);
  out.set([0x64, 0x61, 0x74, 0x61], 36); // data
  dv.setUint32(40, total, true);
  let at = 44;
  for (const p of parsed) { out.set(p.data, at); at += p.data.length; }
  return out;
}

const CMD = /^(?:turn\s+)?voice(?:\s+(?:replies|reply|notes|note|mode))?\s+(on|off|auto)$/;
const CMD_ENABLE = /^(enable|disable)\s+voice(?:\s+(?:replies|notes))?$/;

/** "on" | "off" | "auto" when the WHOLE message is a voice-mode command, else null. */
export function parseVoiceCommand(text) {
  const t = String(text || "").trim().toLowerCase().replace(/[!?.,;:]+$/g, "").replace(/\s+/g, " ");
  const m = t.match(CMD);
  if (m) return m[1];
  const e = t.match(CMD_ENABLE);
  if (e) return e[1] === "enable" ? "on" : "off";
  return null;
}

export function voiceModeConfirmation(mode) {
  if (mode === "on") {
    return "🎙️ Voice replies are *on*: I'll add a short voice note to every English answer. Type *voice off* to stop, or *voice auto* to get one only when you send me a voice note.";
  }
  if (mode === "off") {
    return "🔇 Voice replies are *off*. Type *voice on* to turn them back on.";
  }
  return "🎙️ Voice replies are on *auto*: when you send me a voice note, I'll answer with a voice note too (English answers only). Type *voice on* for always, or *voice off* to stop.";
}

/** Whether to speak this answer: `pref` is the saved mode (or null), `heardVoice` = they sent a voice note. */
export function shouldSpeak(pref, heardVoice) {
  if (pref === "off") return false;
  if (pref === "on") return true;
  return Boolean(heardVoice);
}

// ── D1: saved mode per person (never throws; no database = default "auto") ──

/** "on" | "off" | "auto" | null (not set or on error). */
export async function getVoicePref(db, whatsappId) {
  if (!db || !whatsappId) return null;
  try {
    const row = await db.prepare(`SELECT mode FROM user_voice WHERE whatsapp_id = ?1`).bind(whatsappId).first();
    return row && ["on", "off", "auto"].includes(row.mode) ? row.mode : null;
  } catch (err) {
    console.error("Voice pref read failed:", err);
    return null;
  }
}

/** Upserts the mode. Returns true if written. */
export async function saveVoicePref(db, whatsappId, mode, nowMs = Date.now()) {
  if (!db || !whatsappId || !["on", "off", "auto"].includes(mode)) return false;
  try {
    await db
      .prepare(
        `INSERT INTO user_voice (whatsapp_id, mode, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(whatsapp_id) DO UPDATE SET mode = ?2, updated_at = ?3`
      )
      .bind(whatsappId, mode, new Date(nowMs).toISOString())
      .run();
    return true;
  } catch (err) {
    console.error("Voice pref save failed:", err);
    return false;
  }
}

// ── Network steps (each returns null on failure) ──

/** Groq Orpheus TTS -> WAV bytes. */
export async function synthesizeSpeech(text, env) {
  const res = await fetchWithTimeout(
    fetch,
    TTS_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: env.VOICE_NAME || DEFAULT_VOICE,
        input: text,
        response_format: "wav",
      }),
    },
    15000
  );
  if (!res.ok) {
    console.error("Groq TTS error:", res.status, await res.text().catch(() => ""));
    return null;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.length ? bytes : null;
}

/** WAV bytes -> OGG/Opus bytes via the voice-converter service (see voice-converter/). */
export async function convertToOggOpus(wav, env) {
  const headers = { "Content-Type": "audio/wav" };
  if (env.VOICE_CONVERTER_TOKEN) headers.Authorization = `Bearer ${env.VOICE_CONVERTER_TOKEN}`;
  const res = await fetchWithTimeout(fetch, env.VOICE_CONVERTER_URL, { method: "POST", headers, body: wav }, 20000);
  if (!res.ok) {
    console.error("Voice converter error:", res.status);
    return null;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.length ? bytes : null;
}

/**
 * Speaks `text` to `from` as a voice note. Never throws; returns true if a voice note was sent.
 * `deps` lets tests swap the network steps.
 */
export async function speakReply(text, from, env, deps = {}) {
  const synthesize = deps.synthesize || synthesizeSpeech;
  const convert = deps.convert || convertToOggOpus;
  const send = deps.send || sendWhatsAppVoiceNote;
  try {
    if (!voiceRepliesEnabled(env)) return false;
    const spoken = prepareSpokenText(text, maxSpokenChars(env));
    const chunks = splitForSpeech(spoken).slice(0, MAX_SPOKEN_CHUNKS);
    if (!chunks.length) return false;
    // One TTS request per piece, in order. If a later piece fails, speak what we have so far: the
    // pieces end on sentence boundaries, so a shorter note still makes sense.
    const wavs = [];
    for (const chunk of chunks) {
      const piece = await synthesize(chunk, env);
      if (!piece) break;
      wavs.push(piece);
    }
    if (!wavs.length) return false;
    const wav = wavs.length === 1 ? wavs[0] : (deps.merge || mergeWavs)(wavs) || wavs[0];
    const ogg = await convert(wav, env);
    if (!ogg) return false;
    await send(from, ogg, env);
    return true;
  } catch (err) {
    console.error("Voice reply failed:", err?.message || err);
    return false;
  }
}

/**
 * Admin-only "voice test": runs every step for real and returns report lines saying which one fails.
 * Never includes secret values. `deps` lets tests swap fetch and the WhatsApp send.
 */
export async function diagnoseVoice(env, from, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const send = deps.send || sendWhatsAppVoiceNote;
  const lines = ["🔧 *Voice check*"];
  const flag = (v) => (v ? "set" : "MISSING");
  const mode = String(env.VOICE_REPLIES || "").toLowerCase();
  lines.push(`VOICE_REPLIES: ${mode === "on" ? "on ✅" : `${env.VOICE_REPLIES ? `"${env.VOICE_REPLIES}"` : "MISSING"} ❌ (must be on)`}`);
  lines.push(`GROQ_API_KEY: ${flag(env.GROQ_API_KEY)}`);
  lines.push(`VOICE_CONVERTER_URL: ${env.VOICE_CONVERTER_URL ? env.VOICE_CONVERTER_URL : "MISSING ❌"}`);
  lines.push(`VOICE_CONVERTER_TOKEN: ${flag(env.VOICE_CONVERTER_TOKEN)}${env.VOICE_CONVERTER_TOKEN ? "" : " ❌ (converter needs it)"}`);
  if (!env.GROQ_API_KEY || !env.VOICE_CONVERTER_URL) {
    lines.push("Stopped: fix the settings above in Cloudflare, then send *voice test* again.");
    return lines;
  }

  const snippet = async (res) => (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
  let ok = true;

  let wav = null;
  try {
    const res = await fetchWithTimeout(
      doFetch,
      TTS_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({ model: TTS_MODEL, voice: env.VOICE_NAME || DEFAULT_VOICE, input: "Hello from Thanzi Coach.", response_format: "wav" }),
      },
      20000
    );
    if (res.ok) {
      wav = new Uint8Array(await res.arrayBuffer());
      lines.push(`✅ Groq TTS: ${wav.length} bytes`);
    } else {
      ok = false;
      lines.push(`❌ Groq TTS: HTTP ${res.status} ${await snippet(res)}`);
    }
  } catch (err) {
    ok = false;
    lines.push(`❌ Groq TTS: ${err?.message || err}`);
  }

  let ogg = null;
  if (wav) {
    try {
      const headers = { "Content-Type": "audio/wav" };
      if (env.VOICE_CONVERTER_TOKEN) headers.Authorization = `Bearer ${env.VOICE_CONVERTER_TOKEN}`;
      const res = await fetchWithTimeout(doFetch, env.VOICE_CONVERTER_URL, { method: "POST", headers, body: wav }, 45000);
      if (res.ok) {
        ogg = new Uint8Array(await res.arrayBuffer());
        lines.push(`✅ Converter: ${ogg.length} bytes`);
      } else {
        ok = false;
        const hint = res.status === 401 ? " (token doesn't match Render's CONVERTER_TOKEN)" : "";
        lines.push(`❌ Converter: HTTP ${res.status}${hint} ${await snippet(res)}`);
      }
    } catch (err) {
      ok = false;
      lines.push(`❌ Converter: ${err?.message || err} (wrong URL, or Render was asleep: try again in a minute)`);
    }
  }

  if (ogg) {
    try {
      await send(from, ogg, env);
      lines.push("✅ WhatsApp: voice note sent, you should have received it");
    } catch (err) {
      ok = false;
      lines.push(`❌ WhatsApp: ${String(err?.message || err).slice(0, 300)}`);
    }
  }

  lines.push(ok ? "All steps passed." : "Fix the first ❌ above, then send *voice test* again.");
  return lines;
}
