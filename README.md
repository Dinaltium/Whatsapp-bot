# PARAG WhatsApp Bot

## Setup

1. Install dependencies:

```bash
npm install
```

2. Open .env and paste your Groq key:

```env
GROQ_API_KEY=PASTE_YOUR_GROQ_API_KEY_HERE
GROQ_MODEL=llama-3.3-70b-versatile
ALLOW_FROM_ME_MESSAGES=true

# Admin + allowlists
ADMIN_JIDS=1234567890@s.whatsapp.net
ALLOWED_GROUPS_FILE=allowed-groups.json
ALLOWED_CHATS_FILE=allowed-chats.json

# Optional: Neon PostgreSQL auth-state storage (recommended for cloud deploy)
DATABASE_URL=postgresql://<user>:<password>@<host>/<db>?sslmode=require

# Optional security hardening for DB auth payloads (JWT wrapped at rest)
AUTH_STATE_JWT_SECRET=replace_with_a_long_random_secret
```

3. Run bot:

```bash
node bot.js
```

## Message behavior

- Bot responds only to messages that start with !
- Your own !messages are processed when ALLOW_FROM_ME_MESSAGES=true
- Built-in commands: !ping, !hello
- Any other !message is sent to Groq
- AI replies are restricted to tech/hackathon topics
- AI rate limit per user per group: 1 request every 8 seconds, max 5 requests per 60 seconds

## Push to GitHub

```bash
git init
git add .
git commit -m "feat: WhatsApp bot with allowlists and admin controls"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

If the remote already exists, use:

```bash
git remote set-url origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## Deploy on Render

This project can run as a **Web Service** with a minimal health endpoint.

### Option A: Blueprint (recommended)

1. Push this repo to GitHub (already done).
2. In Render: **New +** → **Blueprint**.
3. Select this repository; Render will read [render.yaml](render.yaml).
4. Set secret env values when prompted:
	- `GROQ_API_KEY`
	- `ADMIN_JIDS`
5. Deploy.

### Option B: Manual Web Service setup

1. Create a **Web Service** in Render and connect this repo.
2. Use:
	- Build Command: `npm install`
	- Start Command: `npm start`
 	- Health Check Path: `/health`
3. Add environment variables:
	- `GROQ_API_KEY`
	- `GROQ_MODEL=llama-3.3-70b-versatile`
	- `ALLOW_FROM_ME_MESSAGES=true`
	- `ADMIN_JIDS=<your_jid@s.whatsapp.net>`
	- `ALLOWED_GROUPS_FILE=allowed-groups.json`
	- `ALLOWED_CHATS_FILE=allowed-chats.json`

### First deploy notes

- Open worker logs and scan the QR when prompted.
- The service now exposes `GET /health` for uptime checks.
- If `DATABASE_URL` is set, auth state is stored in Neon PostgreSQL (recommended for persistence).
- If `DATABASE_URL` is not set, auth state falls back to local `auth/` files and can be lost on ephemeral environments.
- Set `AUTH_STATE_JWT_SECRET` to JWT-wrap stored auth payloads for integrity and tamper resistance.

### Security notes

- Keep `.env` private and never commit it.
- Rotate `GROQ_API_KEY` and `AUTH_STATE_JWT_SECRET` if exposure is suspected.
- Use Render environment variables (secrets), not hardcoded keys.
