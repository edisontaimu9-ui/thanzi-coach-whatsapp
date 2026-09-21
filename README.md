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

## Malnutrition screening flows

Four guided WhatsApp flows call the Chakudya MCP server (service binding
`CHAKUDYA_MCP` + secret `CHAKUDYA_MCP_AUTH_TOKEN`, already set up for the
under-5 flow — nothing new to configure):

| Say | Flow | MCP tool |
|---|---|---|
| "screen a child for malnutrition" | under 5 years | `under5_integrated_screen` |
| "screen a school child" / "check BMI for a 9 year old" | 5–17 years | `school_age_integrated_screen` |
| "screen a pregnant woman" | pregnant / postpartum | `pregnant_postpartum_integrated_screen` |
| "screen an adult" / "check muac for an elderly patient" | adults 18+ | `adult_integrated_screen` |

Sample prompts (also reachable by tapping **Malnutrition Screening** in the
greeting list, which opens a who-to-screen menu — typing "malnutrition
screening" or "screen for malnutrition" opens the same menu):

- Under 5: "Screen a child for malnutrition", "check muac for my baby"
- 5–17: "Screen a school child for malnutrition", "Screen an adolescent for malnutrition", "check BMI for a 9 year old"
- Adults: "Screen an adult for malnutrition", "check muac for an elderly patient", "screen a man for malnutrition"
- Pregnant / postpartum: "Screen a pregnant woman for malnutrition", "postpartum malnutrition screening"

In the adult flow, if the person was weighed but not measured standing (bedridden,
frail), the bot offers one extra question — ULNA length in cm — and the result is
clearly labelled as based on an estimated height.

The flows hand people to each other from what they are told: "screen a child"
moves to the 5–17 flow when the age is 5 or more, the 5–17 flow moves to the
adult flow at 18, and a girl/woman who is pregnant or recently gave birth is
moved to the maternal flow. Saying a new screening phrase discards any
half-finished screening. Shared code for the two newer flows is in
`src/screeningShared.js`.

## Quick calculators

Four standalone calculators for a patient who can't be weighed or measured
directly, or for a quick BMI or weight-change check outside a full screen —
none of their results are ever used for malnutrition classification (the
adult screening flow above has its own, narrower ulna-only height estimate
and its own BMI, computed as part of that flow). Tap **Quick Calculators**
in the greeting list to open a picker (`src/estimateMenu.js`, say "quick
calculators" to open it by typing), or go straight to any flow by name:

**Weight estimate** (ages 6 and up) — say "estimate weight for a patient" or
"patient can't be weighed". The bot asks sex, age and arm circumference, then:

- under 65: knee height, then race (the knee-height equations exist for black and
  white only) — the only equation at those ages;
- 65–80: calf circumference, and optionally knee height (+ race) and a
  subscapular skinfold (needs a caliper);
- over 80: calf circumference.

It calls `weight_estimate_persons_65_and_older` and/or
`weight_from_knee_height_and_mac` and headlines the equation with the lowest
standard error. **The errors are large** (about 4–5 kg for the 65+ set; 7–14.5 kg,
and 10.6–12 kg for adults 19–59, for the knee-height set), so the reply always
shows the standard error and adds a rough-guide warning when it is large. Race is
used for this session only. See `src/weightEstimate.js`.

In the **adult screening flow**, if weight is skipped and arm circumference was
given, the bot offers (yes/no) to estimate weight with the same questions. The MCP
tool then reports BMI as a labelled estimate with a range, flags it uncertain when
the range crosses a NACS BMI cut-off, and MUST uses that BMI too. MUAC, oedema and
weight-loss findings never depend on an estimated weight. Estimated weight is not
offered in the school-age flow.

**Height estimate** — say "estimate height for a patient" or "patient can't
stand". The bot asks sex and age, then which ONE measurement is available,
offering only the methods with a published equation at that age:

- knee height (ages 6+, plus race — black/white only) — `stature_from_knee_height`
  (Lee & Nieman), returns a standard error;
- demi span (ages 16+, sternal notch to the middle/ring finger web, arm out
  horizontally) — `stature_from_demi_span` (Gibson), no standard error given;
- ulna/forearm length (any age, table covers 18.5–32cm) — `stature_from_ulna_length`,
  a lookup table with no standard error, only a note on the one known
  doubtful table cell (men >65, 30.0cm).

Unlike the weight estimate, only one equation runs per session — a health
worker normally has exactly one of these measurements available for a given
patient. This is a standalone calculator: its result is never used for
malnutrition classification (the adult screening flow has its own, narrower
ulna-only height estimate that feeds into a BMI — see `src/adultScreening.js`).
See `src/heightEstimate.js`.

**BMI check** — say "check my BMI" or "BMI for a patient". A quick
two-question calculator (weight in kg, height in cm) that calls
`bmi_classification`, returning the BMI plus BOTH the WHO 2000 band (with a
comorbidity risk level) and the Malawi NCST 2015 band for the same value,
since the two use different cut-offs. Not attached to any screening — if the
height suggests a child, the reply adds a note pointing to the under-5/school
screening flows instead, since these bands are adult-oriented. See
`src/bmiCheck.js`.

**Percent weight change** — say "check percent weight change" or "how much
weight did I lose". A quick calculator (current weight, usual/baseline
weight, and an optional time frame) that calls
`percent_weight_change_calculator`: % change = [(usual − current) / usual] ×
100, positive = loss. Reply *skip* to the time-frame question to get just the
percent change; give a time frame (1 week/1 month/3 months/6 months) to also
get the significant/severe weight-loss interpretation (Width & Reinhard) for
it, in the same call. See `src/weightChangeCheck.js`.

## Test

Send a WhatsApp message to +265 886 29 53 24 asking a nutrition question —
it should route through Chakudya's RAG and reply in the chat.

## Watch logs

Cloudflare dashboard > Workers & Pages > thanzi-coach-whatsapp > Logs
(real-time `wrangler tail` isn't available without local wrangler, but the
dashboard's live log view covers the same need).
