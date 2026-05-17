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

Use a **Background Worker** (not Web Service) because this bot does not expose an HTTP port.

### Option A: Blueprint (recommended)

1. Push this repo to GitHub (already done).
2. In Render: **New +** → **Blueprint**.
3. Select this repository; Render will read [render.yaml](render.yaml).
4. Set secret env values when prompted:
	- `GROQ_API_KEY`
	- `ADMIN_JIDS`
5. Deploy.

### Option B: Manual Worker setup

1. Create a **Background Worker** in Render and connect this repo.
2. Use:
	- Build Command: `npm install`
	- Start Command: `npm start`
3. Add environment variables:
	- `GROQ_API_KEY`
	- `GROQ_MODEL=llama-3.3-70b-versatile`
	- `ALLOW_FROM_ME_MESSAGES=true`
	- `ADMIN_JIDS=<your_jid@s.whatsapp.net>`
	- `ALLOWED_GROUPS_FILE=allowed-groups.json`
	- `ALLOWED_CHATS_FILE=allowed-chats.json`

### First deploy notes

- Open worker logs and scan the QR when prompted.
- Auth state in `auth/` is local and ignored by git; on free/ephemeral environments, session can reset after restart.
- For stable sessions, add persistent storage or move auth state to a persistent database/object store.

### Important note for WhatsApp auth

This bot uses local auth state (`auth/`) which is ignored by git. On Render, ephemeral files may be reset on restart, so WhatsApp sessions can be lost unless you use persistent storage or a remote auth store.
