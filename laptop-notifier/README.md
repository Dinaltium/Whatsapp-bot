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

## Run silently in the background + start at logon + auto-restart

Three helper files make this turnkey:

- `run-forever.bat` — supervisor loop; if `node` ever exits (crash, force-stop,
  Redis blip), it relaunches after 5s. So the notifier is self-healing.
- `start-hidden.vbs` — launches that loop with **no visible window**.
- `install-startup.ps1` — registers a Scheduled Task that runs the hidden
  launcher **at every logon** (and restarts the task if it fails).

Install once, from an **Administrator PowerShell**:

```powershell
cd C:\Projects\Whatsapp-bot\laptop-notifier
powershell -ExecutionPolicy Bypass -File install-startup.ps1
```

Then start it immediately without logging out:

```powershell
Start-ScheduledTask -TaskName "LaptopNotifier"
```

It now runs hidden in the background, starts automatically every time you log
in, and relaunches itself if it stops or is force-killed.

Check it's running: `Get-Process node` (you'll see a node process), or watch
for a test toast. Stop it: `Stop-ScheduledTask -TaskName "LaptopNotifier"` then
kill the node process. Uninstall from startup:

```powershell
Unregister-ScheduledTask -TaskName "LaptopNotifier" -Confirm:$false
```

> Prefer a process manager? `npm i -g pm2 pm2-windows-startup`, then
> `pm2 start index.js --name laptop-notifier && pm2 save && pm2-startup install`.
> Works too, but pm2 must run in your user session for desk-presence idle
> detection to work — the scheduled-task approach above already does.

## WhatsApp presence (controls when the bot steps in)

This client reports "online" to the bot **only while WhatsApp is the focused
window**. So if you're at the computer but in another app (Claude, a browser,
etc.), you count as **away** — the bot replies on your behalf and sends you a
toast. The moment WhatsApp is focused, the bot goes quiet. When you switch away
from WhatsApp, the bot treats you as away again within ~20s (the bot's
`OWNER_DESK_WINDOW_MS`).

Needs the `active-win` dependency (installed by `npm install`). Set
`WA_PRESENCE=false` to opt out (the bot then falls back to send-based presence:
online only for 30s after you send a WhatsApp message).

## Config (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `REDIS_URL` | (unset) | Full connection string — set this and skip the rest |
| `REDIS_HOST` / `PORT` / `PASSWORD` / `TLS` | — | Only used if `REDIS_URL` is blank (e.g. tunneled self-hosted Redis) |
| `NOTIFY_CHANNEL` | `laptop:notify` | Must match the bot's `LAPTOP_NOTIFY_CHANNEL` |
| `MIN_SEVERITIES` | `low,medium,high` | Comma list — drop `low` to only be pinged for things worth replying to soon |
| `WA_PRESENCE` | `true` | Report "online" only while WhatsApp is the focused window |
| `PRESENCE_PING_SEC` | `7` | How often to check the focused window |
| `WHATSAPP_MATCH` | `whatsapp` | Case-insensitive match against the focused window title/app |

> The bot side has a matching `OWNER_DESK_WINDOW_MS` (default 20s) — it treats
> the presence signal as valid only if reported within that window, so switching
> away from WhatsApp flips you to "away" within ~20s.

## Disabling

Set `NOTIFY_ENABLED=false` on the **bot** (server-side) to stop publishing
entirely, or just close this client / lower `MIN_SEVERITIES` to `high` if
you only want interruptions for urgent messages.
