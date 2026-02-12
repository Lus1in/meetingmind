# MeetingMind — Deployment Checklist

## Required Environment Variables

Set all of these in your Render dashboard under **Environment > Environment Variables**:

### Core

| Variable | Example | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Enables secure cookies, trust proxy, hides debug logs |
| `PORT` | `3000` | Render sets this automatically |
| `SESSION_SECRET` | (random 32+ char string) | Generate with `openssl rand -hex 32`. **Fatal if missing.** |
| `ADMIN_SECRET` | (random 32+ char string) | Must be 16+ chars. Protects `/api/admin/*` |
| `APP_URL` | `https://meetingmind.onrender.com` | Full URL, no trailing slash. Used for OAuth callbacks + reset emails |
| `MOCK_MODE` | `false` | **Must be `false` for beta.** Controls AI + transcription |
| `DATABASE_PATH` | `/var/data/data.db` | Persistent disk path on Render. Local: leave unset (defaults to `./data.db`) |
| `ADMIN_EMAIL` | `you@example.com` | Your login email. Grants access to `/admin/feedback` inbox. |

### AI / Transcription

| Variable | Example | Notes |
|---|---|---|
| `CLAUDE_API_KEY` | `sk-ant-api03-...` | Anthropic API key for action item extraction |
| `OPENAI_API_KEY` | `sk-...` | OpenAI API key for Whisper transcription |

### Stripe (use **Test** keys for staging, **Live** for beta)

| Variable | Example | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_...` | From Stripe Dashboard > API keys |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | From Stripe Dashboard webhook endpoint |
| `STRIPE_PRICE_BASIC_MONTHLY` | `price_...` | Price ID for Basic Monthly plan |
| `STRIPE_PRICE_PRO_MONTHLY` | `price_...` | Price ID for Pro Monthly plan |

### OAuth (optional but recommended for beta)

| Variable | Example | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID` | `...apps.googleusercontent.com` | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | `GOCSPX-...` | Same project |
| `APPLE_CLIENT_ID` | `com.meetingmind.auth` | Apple Services ID |
| `APPLE_TEAM_ID` | `XXXXXXXXXX` | Apple Developer Team ID |
| `APPLE_KEY_ID` | `YYYYYYYYYY` | Key ID for Sign In with Apple |
| `APPLE_PRIVATE_KEY` | `-----BEGIN PRIVATE KEY-----\n...` | .p8 contents, `\n` for newlines |

### Email (required for password reset in production)

| Variable | Example | Notes |
|---|---|---|
| `RESEND_API_KEY` | `re_...` | From resend.com dashboard |
| `EMAIL_FROM` | `MeetingMind <no-reply@yourdomain.com>` | Must match a verified Resend domain |

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

## OAuth Callback URLs

### Google (Google Cloud Console > Credentials > OAuth 2.0 Client)
- **Authorized redirect URI**: `https://<your-render-url>/api/oauth/google/callback`

### Apple (Apple Developer Console > Services ID)
- **Return URL**: `https://<your-render-url>/api/oauth/apple/callback`
- **Domain**: `<your-render-url>` (no protocol)

## Switching from Test to Live

1. Create new **live** API keys in Stripe Dashboard > API keys
2. Create new **live** Price IDs (or copy existing test products to live mode)
3. Create a new **live** webhook endpoint (same URL, same events)
4. Update all Render env vars:
   - `STRIPE_SECRET_KEY` → `sk_live_...`
   - `STRIPE_WEBHOOK_SECRET` → new `whsec_...` from live endpoint
   - `STRIPE_PRICE_*` → live price IDs
5. Set `MOCK_MODE=false`
6. Set `APP_URL` to your production URL
7. Deploy

## Beta Smoke Test Checklist

Run through this after every deploy. Each item should pass before sharing with beta users.

### 1. Infrastructure

- [ ] `curl https://<url>/api/health` → `{"ok":true, "mock_mode":false, "oauth":true, "email":true, "stripe":true, "transcription":true}`
- [ ] Server starts without FATAL errors in logs
- [ ] Optional warnings appear for any unconfigured services (expected if intentional)

### 2. Auth — Email/Password

- [ ] **Signup**: Create account with email + password → lands on dashboard
- [ ] **Duplicate signup**: Same email again → "Email already registered" error
- [ ] **Logout**: Click logout → redirected to login page
- [ ] **Login**: Log in with the account → lands on dashboard
- [ ] **Wrong password**: Bad password → "Invalid credentials" error
- [ ] **Session persistence**: Refresh browser → still logged in (SQLite store working)

### 3. Auth — OAuth

- [ ] **Google login**: Click "Continue with Google" → consent screen → dashboard
- [ ] **Google account linking**: Log in with Google using same email as existing account → linked, not duplicate
- [ ] **Apple login** (if configured): Click "Continue with Apple" → consent → dashboard
- [ ] **OAuth cancel**: Cancel at Google consent → redirected to login with error message

### 4. Password Reset

- [ ] **Forgot password**: Enter email → "If an account exists..." message (no email leak)
- [ ] **Email arrives**: Check inbox (or Resend dashboard) → reset email received
- [ ] **Reset link works**: Click link → reset form loads
- [ ] **New password works**: Set new password → can log in with it
- [ ] **Old password fails**: Old password no longer works
- [ ] **Expired/reused token**: Click same link again → "Invalid or expired" error

### 5. Meetings — Upload & Transcribe

- [ ] **Upload .mp3**: Upload short audio file → transcript appears
- [ ] **Upload .wav**: Upload .wav file → transcript appears
- [ ] **Record audio**: Record 5+ seconds → transcript saved
- [ ] **Meeting listed**: New meeting appears in sidebar/list
- [ ] **View meeting**: Click meeting → notes + action items displayed
- [ ] **Delete meeting**: Delete a meeting → removed from list

### 6. Meetings — Extract Action Items

- [ ] **Paste notes**: Paste raw meeting notes → action items extracted by AI
- [ ] **Result quality**: Action items are relevant and well-formatted
- [ ] **Meeting saved**: Extracted meeting appears in list with title

### 7. Free Plan Limits

- [ ] **Extract limit**: Free user sees limit after 5 extracts (lifetime)
- [ ] **Limit message**: Banner shows "You've used all 5 free extractions" with Upgrade link
- [ ] **Meeting limit**: Free user can store up to 3 meetings
- [ ] **Storage message**: Clear message when meeting storage limit reached

### 8. Billing — Stripe

- [ ] **Checkout**: Click upgrade → Stripe Checkout loads with correct price
- [ ] **Payment succeeds**: Complete payment → plan upgrades immediately
- [ ] **Webhook fires**: Check Stripe Dashboard > Webhooks > recent events → 2xx
- [ ] **Limits raised**: After upgrade, extract/storage limits increase
- [ ] **Billing portal**: Manage subscription link → Stripe Customer Portal loads
- [ ] **Lifetime deal**: If configured, one-time payment → `is_lifetime=1`, permanent access

### 9. Rate Limiting

- [ ] **Signup spam**: 11th signup attempt within 15 min → 429 error
- [ ] **Login spam**: 11th login attempt within 15 min → 429 error
- [ ] **Forgot spam**: 6th forgot-password within 15 min → 429 error
- [ ] **Extract spam**: 21st extract within 15 min → 429 error

### 10. Security Basics

- [ ] **No secrets in /health**: Health endpoint shows booleans only, never keys
- [ ] **Cookie flags**: In production: `httpOnly=true`, `secure=true`, `sameSite=lax`
- [ ] **HTTPS only**: HTTP redirects to HTTPS (Render handles this)
- [ ] **Password hashed**: Passwords stored as bcrypt hashes (check DB if needed)

## Render Staging Deploy — Step by Step

Follow these steps exactly to get MeetingMind running on Render.

### 1. Create Web Service

1. Go to [Render Dashboard](https://dashboard.render.com) → **New** → **Web Service**
2. Connect your GitHub repo
3. Configure:
   - **Name**: `meetingmind-staging` (or your choice)
   - **Region**: Oregon (US West) or nearest
   - **Branch**: `main`
   - **Runtime**: Node
   - **Build command**: `npm install`
   - **Start command**: `node server.js`
   - **Plan**: Free or Starter

### 2. Add Persistent Disk

1. In the web service settings → **Disks** → **Add Disk**
2. Configure:
   - **Name**: `data`
   - **Mount path**: `/var/data`
   - **Size**: 1 GB (plenty for beta)
3. Set env var: `DATABASE_PATH=/var/data/data.db`

### 3. Set Environment Variables

Copy-paste these into **Environment > Environment Variables**:

```
NODE_ENV=production
MOCK_MODE=false
SESSION_SECRET=<run: openssl rand -hex 32>
ADMIN_SECRET=<run: openssl rand -hex 32>
APP_URL=https://meetingmind-staging.onrender.com
DATABASE_PATH=/var/data/data.db

CLAUDE_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-...

STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_BASIC_MONTHLY=price_...
STRIPE_PRICE_PRO_MONTHLY=price_...

GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...

RESEND_API_KEY=re_...
EMAIL_FROM=MeetingMind <no-reply@yourdomain.com>
```

> Apple OAuth vars are optional for staging. Add them when ready.

### 4. Configure OAuth Callbacks

**Google Cloud Console** → Credentials → OAuth 2.0 Client:
- Add Authorized redirect URI: `https://<your-render-url>/api/oauth/google/callback`

**Apple Developer Console** → Services ID (if using):
- Return URL: `https://<your-render-url>/api/oauth/apple/callback`
- Domain: `<your-render-url>` (no `https://`)

### 5. Configure Stripe Webhook

1. Stripe Dashboard → Developers → Webhooks → **Add endpoint**
2. URL: `https://<your-render-url>/api/billing/webhook`
3. Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
4. Copy the `whsec_...` signing secret → set as `STRIPE_WEBHOOK_SECRET` in Render

### 6. Deploy & Verify

1. Click **Manual Deploy** or push to `main`
2. Watch logs for:
   - `[startup] WARN: ...` (optional features) — expected if some aren't configured
   - `Server running on http://localhost:... [production]` — success
   - Any `[startup] FATAL:` — fix the missing env var and redeploy
3. Test: `curl https://<your-render-url>/api/health`
   - Expected: `{"ok":true,"mock_mode":false,"oauth":true,"email":true,"stripe":true,"transcription":true}`
   - Any `false` value means that feature's env var is missing

### Common Mistakes

| Problem | Fix |
|---|---|
| `FATAL: SESSION_SECRET is not set` | Add SESSION_SECRET env var |
| `FATAL: MOCK_MODE is false but missing: CLAUDE_API_KEY` | Add the key, or set `MOCK_MODE=true` for testing |
| Sessions lost on redeploy | Ensure persistent disk is attached and `DATABASE_PATH` points to it |
| OAuth redirect mismatch | `APP_URL` must exactly match your Render URL (no trailing slash) |
| Stripe webhook 400/401 | Use the `whsec_...` from Stripe Dashboard, not from `stripe listen` CLI |
| Cookies not setting | `NODE_ENV=production` must be set (enables `secure: true`) |
| Forgot-password email not sending | Check `RESEND_API_KEY` is set and domain is verified in Resend |

## Environment: Local vs Render

| Variable | Local (.env file) | Render (Environment tab) |
|---|---|---|
| `NODE_ENV` | `development` (or unset) | `production` |
| `MOCK_MODE` | `true` | `false` |
| `SESSION_SECRET` | Any string (required) | `openssl rand -hex 32` |
| `DATABASE_PATH` | Unset (uses `./data.db`) | `/var/data/data.db` (persistent disk) |
| `APP_URL` | Unset (defaults `http://localhost:3000`) | `https://your-app.onrender.com` |
| AI / Stripe / OAuth / Email | Optional (mocked/disabled) | Set real keys |

**Key difference**: On Render, the persistent disk (`DATABASE_PATH`) ensures SQLite data and sessions survive redeploys. Locally, `data.db` lives in the project root.

## Minimum Viable Local Dev

When `MOCK_MODE=true`, most features work with just two env vars:

```
SESSION_SECRET=any-dev-secret-here
MOCK_MODE=true
```

**What works in MOCK_MODE**:
- Signup, login, logout, session management
- Extract action items (returns mock data)
- Upload/transcribe (returns mock transcript)
- All UI flows and navigation

**What is disabled in MOCK_MODE**:
- Real AI extraction (Claude API)
- Real transcription (OpenAI Whisper)
- Real email sending (console-logged instead)
- OAuth buttons appear but redirect fails without OAuth keys

**Expected `/api/health` in local dev**:
```json
{"ok":true,"mock_mode":true,"oauth":false,"email":false,"stripe":false,"transcription":true}
```

> `transcription: true` because MOCK_MODE counts as having transcription available.

## Local Development

```bash
# Install dependencies
npm install

# Start the server
node server.js

# If port 3000 is occupied (Windows):
taskkill //F //IM node.exe
node server.js

# Forward Stripe events locally (separate terminal):
stripe listen --forward-to localhost:3000/api/billing/webhook
# Copy whsec_... into .env as STRIPE_WEBHOOK_SECRET, restart server
```

## Known Limitations (Beta)

| Area | Limitation | Impact | Fix When |
|---|---|---|---|
| Rate limiting | In-memory, resets on server restart | Attacker can retry after deploy | Replace with Redis if horizontal scaling needed |
| Sessions | SQLite-backed, single-instance only | Fine for beta traffic | Migrate to Redis/Postgres for multi-instance |
| File uploads | Stored in `/tmp`, cleaned after processing | Large files may hit memory limits | Add file size validation (already has multer limits) |
| Email | Resend free tier: 100 emails/day | Enough for beta | Upgrade Resend plan for launch |
| Pricing page | References `/pricing.html` in upgrade CTA | Page must exist or link 404s | Create pricing page before beta launch |
| Apple OAuth | Requires paid Apple Developer account | Can skip for staging | Configure when ready for App Store |
| AI JSON parsing | Model may return markdown fences or trailing commas | `safeJsonParse` strips fences/commas automatically | Stable — no action needed |
| Feedback screenshots | Stored in `uploads/feedback/`; ephemeral on Render free tier | Screenshots lost on redeploy without persistent disk | Mount persistent disk or use S3 for launch |

## Rate Limits (in-memory, resets on restart)

| Endpoint | Limit |
|---|---|
| POST /api/auth/signup | 10 / 15 min / IP |
| POST /api/auth/login | 10 / 15 min / IP |
| POST /api/auth/forgot-password | 5 / 15 min / IP |
| POST /api/meetings/extract | 20 / 15 min / IP |
