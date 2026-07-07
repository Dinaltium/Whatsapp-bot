# laptop-notifier

Runs on your laptop. Subscribes to the bot's Redis pub/sub channel and pops a
native Windows toast whenever the generic auto-responder replies to someone on
your behalf (because you weren't looking at WhatsApp). Includes a severity tag
(low/medium/high) so you can triage at a glance.

Idle between events — effectively 0% CPU, a few MB RAM.

## Connecting to Redis (Upstash)

The bot uses [Upstash](https://upstash.com) Redis — a managed, password
protected, TLS endpoint that's already safe to reach from the internet. So
this connects **directly**, no SSH tunnel needed.

1. Get the connection string: Upstash dashboard → your database → **Details**
   tab → copy the `REDIS_URL` / "ioredis" connection string (starts with
   `rediss://`, note the double "s" — that means TLS). This is the **same**
   `REDIS_URL` the bot uses on Dokploy.
2. Copy `.env.example` to `.env` and paste it into `REDIS_URL`.

> If you ever move to a self-hosted Redis on the VPS instead of Upstash, that
> instance should stay bound to localhost (never exposed publicly) — in that
> case connect through an SSH tunnel instead:
> `ssh -N -L 6380:localhost:6379 <ssh-user>@<vps-ip>`, then set
> `REDIS_HOST=127.0.0.1`, `REDIS_PORT=6380`, `REDIS_TLS=false` in `.env`
> (leave `REDIS_URL` blank so those discrete vars are used).

## Setup

1. Install deps:
   ```
   cd laptop-notifier
   npm install
   ```
2. Configure `.env` (see above).
3. Start the notifier:
   ```
   npm start
   ```
   You should see `[notifier] connected to Redis` then `[notifier] listening
   on "laptop:notify" — waiting for messages...`. Trigger a test message (any
   number the generic bot handles) and a toast should appear.

## Run automatically (Windows)

Simplest: a `.bat` file + Task Scheduler entry that runs at logon:

```bat
@echo off
cd /d "C:\Projects\Whatsapp-bot\laptop-notifier"
npm start
```

Register it in Task Scheduler → "At log on" → run this `.bat` (Start action,
"Start in" set to the folder). No SSH/tunnel setup needed with Upstash.

## Desk presence (fixes "bot replies while I'm online")

This client also reports whether you're **at your computer** (based on OS idle
time) to a Redis key the bot reads. While you're active, the bot won't
auto-reply on your behalf — it only steps in once you've been idle/away. This
solves the case the send-based proxy can't catch: WhatsApp open but you're just
reading.

Needs the `desktop-idle` dependency (installed by `npm install`; it's a small
native module and may need Windows build tools — if it fails to build, presence
is simply skipped and the bot falls back to send-based detection). Set
`DESK_PRESENCE=false` to opt out.

## Config (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `REDIS_URL` | (unset) | Full connection string — set this and skip the rest |
| `REDIS_HOST` / `PORT` / `PASSWORD` / `TLS` | — | Only used if `REDIS_URL` is blank (e.g. tunneled self-hosted Redis) |
| `NOTIFY_CHANNEL` | `laptop:notify` | Must match the bot's `LAPTOP_NOTIFY_CHANNEL` |
| `MIN_SEVERITIES` | `low,medium,high` | Comma list — drop `low` to only be pinged for things worth replying to soon |
| `DESK_PRESENCE` | `true` | Report at-desk presence so the bot stays quiet while you're active |
| `IDLE_THRESHOLD_SEC` | `120` | Considered "at desk" if last input was under this many seconds ago |
| `DESK_PING_SEC` | `30` | How often to report presence |

> The bot side has a matching `OWNER_DESK_WINDOW_MS` (default 90s) — it treats
> the presence signal as valid only if reported within that window.

## Disabling

Set `NOTIFY_ENABLED=false` on the **bot** (server-side) to stop publishing
entirely, or just close this client / lower `MIN_SEVERITIES` to `high` if
you only want interruptions for urgent messages.
