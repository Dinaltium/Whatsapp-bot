# laptop-notifier

Runs on your laptop. Subscribes to the bot's Redis pub/sub channel and pops a
native Windows toast whenever the generic auto-responder replies to someone on
your behalf (because you weren't looking at WhatsApp). Includes a severity tag
(low/medium/high) so you can triage at a glance.

Idle between events — effectively 0% CPU, a few MB RAM.

## Why an SSH tunnel

Redis on the VPS should stay bound to `localhost`/the internal Docker network
— **never exposed to the internet** (Redis is a common target when opened up).
Instead of opening a port, this connects through an SSH tunnel: your laptop
forwards a local port to the VPS's Redis over the SSH connection you already
have.

```
laptop:6380 --(ssh tunnel)--> vps:127.0.0.1:6379 (Redis)
```

## Setup

1. Copy `.env.example` to `.env`. Defaults already match the bot's
   `LAPTOP_NOTIFY_CHANNEL`.
2. Install deps:
   ```
   cd laptop-notifier
   npm install
   ```
3. Open the tunnel (keep this running — a terminal tab, or see "run at
   startup" below):
   ```
   ssh -N -L 6380:localhost:6379 <ssh-user>@168.144.19.31
   ```
   Replace `<ssh-user>` with your VPS SSH user. If Redis requires a password,
   set `REDIS_PASSWORD` in `.env` (matches `REDIS_URL`'s password on the bot).
4. Start the notifier:
   ```
   npm start
   ```
   You should see `[notifier] listening on "laptop:notify" — waiting for
   messages...`. Trigger a test message (any number the generic bot handles)
   and a toast should appear.

## Run automatically (Windows)

Simplest: a `.bat` file + Task Scheduler entry that runs at logon, e.g.

```bat
@echo off
start "" ssh -N -L 6380:localhost:6379 <ssh-user>@168.144.19.31
timeout /t 3
cd /d "C:\Projects\Whatsapp-bot\laptop-notifier"
npm start
```

Register it in Task Scheduler → "At log on" → run this `.bat`, no window
(`Start` action, "Start in" set to the folder). SSH must be set up for
key-based (no password prompt) login for this to work unattended.

## Config (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `REDIS_HOST` | `127.0.0.1` | Leave as-is — connects through the tunnel |
| `REDIS_PORT` | `6380` | Local tunnel port (must match the `-L` forward) |
| `REDIS_PASSWORD` | (empty) | Only if the bot's Redis requires auth |
| `NOTIFY_CHANNEL` | `laptop:notify` | Must match the bot's `LAPTOP_NOTIFY_CHANNEL` |
| `MIN_SEVERITIES` | `low,medium,high` | Comma list — drop `low` to only be pinged for things worth replying to soon |

## Disabling

Set `NOTIFY_ENABLED=false` on the **bot** (server-side) to stop publishing
entirely, or just close this client / lower `MIN_SEVERITIES` to `high` if
you only want interruptions for urgent messages.
