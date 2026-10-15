// Tiny WAV -> OGG/Opus converter for the Thanzi Coach voice-note replies.
// POST raw WAV bytes (Authorization: Bearer $CONVERTER_TOKEN) -> 200 audio/ogg (Opus, mono, 16 kHz).
// Needs ffmpeg on PATH. No npm dependencies. GET / is a health check.
import http from "node:http";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT) || 8080;
const TOKEN = process.env.CONVERTER_TOKEN || "";
const MAX_BYTES = 8 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 15000;

if (!TOKEN) {
  console.error("CONVERTER_TOKEN is not set: refusing to start an open converter.");
  process.exit(1);
}

const FFMPEG_ARGS = [
  "-hide_banner", "-loglevel", "error",
  "-i", "pipe:0",
  "-vn", "-c:a", "libopus", "-b:a", "24k", "-ar", "16000", "-ac", "1", "-application", "voip",
  "-f", "ogg", "pipe:1",
];

function convert(wav) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", FFMPEG_ARGS, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    let err = "";
    const timer = setTimeout(() => { ff.kill("SIGKILL"); reject(new Error("ffmpeg timed out")); }, FFMPEG_TIMEOUT_MS);
    ff.stdout.on("data", (d) => out.push(d));
    ff.stderr.on("data", (d) => { err += d; });
    ff.on("error", (e) => { clearTimeout(timer); reject(e); });
    ff.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 300)}`));
    });
    ff.stdin.on("error", () => {}); // ffmpeg may close stdin early on bad input; "close" reports it
    ff.stdin.end(wav);
  });
}

http
  .createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("voice-converter ok");
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      return res.end();
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401);
      return res.end("Unauthorized");
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (d) => {
      size += d.length;
      if (size > MAX_BYTES) { tooBig = true; req.destroy(); return; }
      chunks.push(d);
    });
    req.on("close", () => { if (tooBig && !res.headersSent) { res.writeHead(413); res.end(); } });
    req.on("end", async () => {
      if (tooBig) return;
      try {
        const ogg = await convert(Buffer.concat(chunks));
        res.writeHead(200, { "Content-Type": "audio/ogg", "Content-Length": ogg.length });
        res.end(ogg);
      } catch (e) {
        console.error("Convert failed:", e.message);
        res.writeHead(500);
        res.end("Conversion failed");
      }
    });
  })
  .listen(PORT, () => console.log(`voice-converter listening on ${PORT}`));
