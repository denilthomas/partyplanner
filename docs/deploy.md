# Deploying Utsav on Render

## Environment variables

| Name | Required | What it's for |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Chat assistant, theme designer, shopper agent |
| `GEMINI_API_KEY` | yes | Theme images + spotting items in them. Image models are **paid-tier only**: enable billing in Google AI Studio. |
| `SERPER_API_KEY` | yes | Product search (Google Shopping) |
| `ANTHROPIC_MODEL` | no | Override the Claude model (default `claude-sonnet-4-6`) |
| `GEMINI_VISION_MODEL` | no | Override the vision model (default `gemini-3.6-flash`) |
| `GEMINI_IMAGE_MODEL` | no | Override the image model (default `gemini-3.1-flash-image`) |

Gemini calls fall back automatically if a model is retired
(`mcp-servers/gemini-client.js`). The fallback order is: vision
3.6-flash → 3.5-flash → 2.5-flash, and image 3.1-flash-image →
3.1-flash-lite-image → 2.5-flash-image.

## Render settings

- **Service type:** Web Service
- **Repo:** `denilthomas/partyplanner`
- **Branch:** `claude/explicit-state-machines`
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Instance:** Free is fine for testing (it sleeps after 15 minutes idle and
  takes about a minute to wake). Use Starter ($7/month) for real users.
- **Environment:** the three required keys above. Never commit them to the repo.

## Check it worked

Open `https://<your-app>.onrender.com/api/health`. All three `services` should
be `true`. `models` lists what will be tried, in order.

If something fails, Render → your service → **Logs**. Gemini errors are
tagged `[gemini…]`, and a retired model shows up as "unavailable; trying next".
