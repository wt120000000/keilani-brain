# Keilani Brain (API)

Netlify Functions powering keilani.ai — chat, RAG, billing, and privacy utilities.

## What’s here

- `/api/chat` — main chat endpoint (CORS, entitlements, burst rate-limit, RAG)
- `/api/health` — env health
- `/api/forget` — delete user data or RAG chunks
- `/api/billing-checkout` — Stripe subscription checkout
- `/api/webhooks-stripe` — Stripe webhooks (plan updates)
- `/api/purge-old` — scheduled 90-day deletion (Netlify cron)

## Environment variables

- `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4o-mini`)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `CORS_ALLOWED_ORIGINS` — space/comma list (e.g. `https://keilani.ai https://framer.com`)
- `RATE_LIMIT_PER_MIN` — default 15

## Local dev

```bash
npm i
netlify dev

```
