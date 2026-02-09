# MeetingMind — Deployment Checklist

## Required Environment Variables

Set all of these in your Render dashboard under **Environment > Environment Variables**:

| Variable | Example | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Enables secure cookies, trust proxy, hides debug logs |
| `PORT` | `3000` | Render sets this automatically |
| `SESSION_SECRET` | (random 32+ char string) | Generate with `openssl rand -hex 32` |
| `ADMIN_SECRET` | (random 32+ char string) | Must be 16+ chars. Protects `/api/admin/*` |
| `CLAUDE_API_KEY` | `sk-ant-api03-...` | Anthropic API key for action item extraction |
| `MOCK_MODE` | `false` | Set to `false` in production to use real Claude API |
| `STRIPE_SECRET_KEY` | `sk_live_...` | **Live** key from Stripe Dashboard > API keys |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | From Stripe Dashboard webhook endpoint (NOT Stripe CLI) |
| `STRIPE_PRICE_BASIC_MONTHLY` | `price_...` | Live Price ID for Basic Monthly plan |
| `STRIPE_PRICE_PRO_MONTHLY` | `price_...` | Live Price ID for Pro Monthly plan |
| `STRIPE_PRICE_LIFETIME` | `price_...` | Live Price ID for Lifetime plan |

## Stripe Webhook Setup (Production)

1. Go to **Stripe Dashboard > Developers > Webhooks**
2. Click **Add endpoint**
3. Endpoint URL: `https://<your-render-url>/api/billing/webhook`
4. Select these events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
5. After creating the endpoint, copy the **Signing secret** (`whsec_...`)
6. Set that as `STRIPE_WEBHOOK_SECRET` in Render env vars

**Important**: The `whsec_...` value from `stripe listen` (CLI) is only for local development. Production requires a separate webhook secret from the Stripe Dashboard.

## Switching from Test to Live

1. Create new **live** API keys in Stripe Dashboard > API keys
2. Create new **live** Price IDs (or copy existing test products to live mode)
3. Create a new **live** webhook endpoint (same URL, same events)
4. Update all Render env vars:
   - `STRIPE_SECRET_KEY` → `sk_live_...`
   - `STRIPE_WEBHOOK_SECRET` → new `whsec_...` from live endpoint
   - `STRIPE_PRICE_BASIC_MONTHLY` → live price ID
   - `STRIPE_PRICE_PRO_MONTHLY` → live price ID
   - `STRIPE_PRICE_LIFETIME` → live price ID
5. Set `MOCK_MODE=false`
6. Deploy

## Local Development (Stripe CLI)

```bash
# Terminal 1: Start the server
npm run dev

# Terminal 2: Forward Stripe events locally
stripe listen --forward-to localhost:3000/api/billing/webhook
# Copy the whsec_... value into .env as STRIPE_WEBHOOK_SECRET
# Restart the server after updating .env
```
