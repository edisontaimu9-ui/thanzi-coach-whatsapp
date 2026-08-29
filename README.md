# Thanzi Coach — WhatsApp Bridge

Bridges the +265 886 29 53 24 WhatsApp Business number (Meta Cloud API) to
your Chakudya API `/rag/ask` endpoint.

## Before pushing — fill in one thing

`CHAKUDYA_API_URL` is already set to `https://chakudya-api.edisontaimu9.workers.dev`
and the `/rag/ask` request/response shapes match `openapi.json` exactly (public,
no API key needed). You only need to set, in `wrangler.toml`:

- `PHONE_NUMBER_ID` — from Meta App Dashboard > WhatsApp > API Setup

## Deploy — via GitHub Actions (wrangler doesn't run in Termux)

This repo deploys itself on every push to `main` via
`.github/workflows/deploy.yml`. You never run wrangler locally.

One-time setup, in the GitHub repo (Settings > Secrets and variables > Actions
> New repository secret):

- `CLOUDFLARE_API_TOKEN` — Cloudflare dashboard > My Profile > API Tokens >
  Create Token > "Edit Cloudflare Workers" template
- `WHATSAPP_TOKEN` — Meta permanent/system-user access token
- `VERIFY_TOKEN` — any string you invent (must match what you enter in
  Meta App Dashboard > WhatsApp > Configuration > Webhook)

Once those three secrets exist, every `git push` to `main` deploys the
Worker and pushes the two Worker secrets automatically.

## Push from Termux

```bash
cd ~/thanzi-coach-whatsapp
git add .
git commit -m "Add GitHub Actions deploy workflow"
git push
```

Then watch the deploy under the repo's **Actions** tab on GitHub.

## Register the webhook with Meta

1. Meta App Dashboard > WhatsApp > Configuration
2. Callback URL: `https://thanzi-coach-whatsapp.<your-subdomain>.workers.dev/webhook`
3. Verify token: the same string you set as `VERIFY_TOKEN`
4. Subscribe to the `messages` webhook field

## Test

Send a WhatsApp message to +265 886 29 53 24 asking a nutrition question —
it should route through Chakudya's RAG and reply in the chat.

## Watch logs

Cloudflare dashboard > Workers & Pages > thanzi-coach-whatsapp > Logs
(real-time `wrangler tail` isn't available without local wrangler, but the
dashboard's live log view covers the same need).
