# Thanzi Coach — WhatsApp Bridge

Bridges the +265 886 29 53 24 WhatsApp Business number (Meta Cloud API) to
your Chakudya API `/rag/ask` endpoint.

## Before deploying — fill in one thing

`CHAKUDYA_API_URL` is already set to `https://chakudya-api.edisontaimu9.workers.dev`
and the `/rag/ask` request/response shapes match `openapi.json` exactly (public,
no API key needed). You only need to set, in `wrangler.toml`:

- `PHONE_NUMBER_ID` — from Meta App Dashboard > WhatsApp > API Setup

## Push to your repo and deploy from Termux

```bash
cd thanzi-coach-whatsapp
git init
git remote add origin https://github.com/edisontaimu9-ui/thanzi-coach-whatsapp.git
git add .
git commit -m "Rebuild Thanzi Coach WhatsApp bridge -> Chakudya /rag/ask"
git branch -M main
git push -u origin main

npm install
npx wrangler login          # once, opens browser auth
npx wrangler deploy
```

## Set secrets (after first deploy)

```bash
npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put VERIFY_TOKEN
# only if your RAG endpoint requires auth:
npx wrangler secret put CHAKUDYA_API_KEY
```

`VERIFY_TOKEN` can be any string you invent — just remember it for the next step.

## Register the webhook with Meta

1. Meta App Dashboard > WhatsApp > Configuration
2. Callback URL: `https://thanzi-coach-whatsapp.<your-subdomain>.workers.dev/webhook`
3. Verify token: the same string you set as `VERIFY_TOKEN`
4. Subscribe to the `messages` webhook field

## Test

Send a WhatsApp message to +265 886 29 53 24 asking a nutrition question —
it should route through Chakudya's RAG and reply in the chat.

## Watch logs while testing

```bash
npx wrangler tail
```
