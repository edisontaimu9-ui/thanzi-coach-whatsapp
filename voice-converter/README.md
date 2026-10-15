# voice-converter

Converts the WAV that Groq TTS returns into OGG/Opus, the format WhatsApp plays as a voice note.
Cloudflare Workers can't run ffmpeg, so this runs as a small separate service.

## Run / test locally (also works in Termux: `pkg install ffmpeg nodejs`)

    CONVERTER_TOKEN=test node server.mjs
    curl -H "Authorization: Bearer test" --data-binary @in.wav http://localhost:8080 -o out.ogg

## Deploy

Any host that builds a Dockerfile from GitHub (Render, Koyeb, Fly.io, Railway). Root directory:
`voice-converter`. Set the secret `CONVERTER_TOKEN` (any long random string). Free tiers that sleep
when idle make the first voice note after a quiet spell time out; the text reply is unaffected.

## Connect the bot

In Cloudflare, Workers & Pages > thanzi-coach-whatsapp > Settings > Variables and Secrets:

- `VOICE_CONVERTER_URL` = the service's public URL
- `VOICE_CONVERTER_TOKEN` = the same value as `CONVERTER_TOKEN`
- `VOICE_REPLIES` = `on`
