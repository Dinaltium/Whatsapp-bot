# Running on an Android phone (Termux + Debian)

Replaces the Render service. The bot runs in Debian under `proot-distro`
inside Termux; Postgres stays on Neon and Redis on Upstash, so the WhatsApp
session carries over and **no new QR scan is needed**.

```
Termux (Android app)
 ├─ ~/botctl.sh          start / stop / logs, tmux session "wabot", wake-lock
 └─ proot-distro: Debian
     └─ /root/Whatsapp-bot
         └─ deploy/termux/run.sh   restarts the bot on exit 1, stops on exit 0
```

## 0. Before you start

- **Stop the Render service first** (Render → service → Suspend). Two
  instances on one WhatsApp session kick each other off (close code 440).
  `run.sh` stays down after that rather than fighting, but Render restarts
  automatically, so Render has to go.
- Phone: Android 7+, 64-bit (arm64) preferred, ~2 GB free storage, and on
  charger if it is meant to run 24/7.
- Install **Termux** and **Termux:Boot** from **F-Droid** (or their GitHub
  releases). The Play Store Termux is outdated and breaks `pkg`. Both apps
  must come from the same source.

## 1. Android settings (do these once, they are the difference between hours and weeks of uptime)

1. Settings → Apps → Termux → Battery → **Unrestricted** (disable battery
   optimisation). Same for Termux:Boot.
2. Open **Termux:Boot** once so Android registers it.
3. **Android 12+: phantom process killer.** Android kills background
   child processes (which is exactly what proot + node are). Either:
   - Android 14+: Developer options → **Disable child process restrictions**, or
   - Android 12/13, from a PC with USB debugging:
     ```bash
     adb shell "settings put global settings_enable_monitor_phantom_procs false"
     ```
     (older 12 builds: `adb shell device_config put activity_manager max_phantom_processes 2147483647`)
4. Some brands (Xiaomi, Oppo, Vivo, Samsung) also need Termux allowed to
   **autostart** and **locked in the recent-apps screen**.

## 2. Termux: install Debian

In Termux:

```bash
pkg update -y && pkg upgrade -y
pkg install -y proot-distro tmux git
proot-distro install debian
```

## 3. Debian: get the code and build

```bash
proot-distro login debian
```

Now inside Debian (prompt changes to `root@localhost`):

```bash
apt update && apt install -y git
cd ~
git clone https://github.com/Dinaltium/Whatsapp-bot.git
cd Whatsapp-bot
bash deploy/termux/setup-debian.sh
```

The repo is private: when git asks for a password, paste a GitHub
**personal access token** (GitHub → Settings → Developer settings → Tokens,
`repo` read access), not your GitHub password.

`setup-debian.sh` installs Node 24, ffmpeg, runs `npm ci` and builds. First
run takes 5–15 minutes on a phone.

## 4. Debian: configure `.env`

```bash
nano ~/Whatsapp-bot/.env
```

Copy **every** variable from Render → Environment. The ones that matter:

| Variable | Value |
|---|---|
| `DATABASE_URL` | same Neon URL as Render (holds the WhatsApp session) |
| `REDIS_URL` | same Upstash URL as Render (`rediss://…`) |
| `AUTH_STATE_KEY` / `AUTH_STATE_JWT_SECRET` | **exactly** as on Render, or the stored session can't be decrypted and you'll need a new QR |
| `GROQ_API_KEY`, `ADMIN_JIDS`, `ADMIN_TOKEN`, … | as on Render |
| `GENERIC_AUTORESPONDER_ENABLED` | `false` (the away auto-reply is off pending optimisation) |
| `DB_POOL_MAX` | `3` — a phone doesn't need 10 Postgres connections |

Save with Ctrl-O, Enter, Ctrl-X.

## 5. First run, in the foreground

Still in Debian:

```bash
cd ~/Whatsapp-bot && bash deploy/termux/run.sh
```

Wait for the connection-open log line. If a QR code appears instead, the
session keys didn't match (check `AUTH_STATE_KEY`); scan it from WhatsApp →
Linked devices. Stop with Ctrl-C, then leave Debian:

```bash
exit
```

## 6. Termux: run in the background + start on boot

Back in plain Termux:

```bash
bash $PREFIX/var/lib/proot-distro/installed-rootfs/debian/root/Whatsapp-bot/deploy/termux/botctl.sh install
bash ~/botctl.sh start
```

`install` copies the control script to `~/botctl.sh` and creates
`~/.termux/boot/start-wabot`, so the bot comes back after a reboot.

Day to day:

```bash
bash ~/botctl.sh status     # running / stopped
bash ~/botctl.sh logs       # follow the log (Ctrl-C stops following, not the bot)
bash ~/botctl.sh attach     # live console; detach with Ctrl-b then d
bash ~/botctl.sh restart
bash ~/botctl.sh stop
```

A persistent Termux notification with "wake lock held" means the CPU is kept
awake with the screen off — that's intended.

## 7. Updating

```bash
proot-distro login debian -- bash -c "cd ~/Whatsapp-bot && git pull && npm ci --no-audit --no-fund && npm run build"
bash ~/botctl.sh restart
```

## What changes compared to Render

| | Render | Phone |
|---|---|---|
| Restart on crash / watchdog | platform | `deploy/termux/run.sh` (exit 1 → restart with backoff up to 5 min; exit 0 → stay down) |
| ffmpeg | apt in Dockerfile | apt in Debian, used via `FFMPEG_BIN` |
| Time zone | UTC | UTC (forced in `run.sh`, so reminders fire at the same times) |
| Logs | Render dashboard | `/root/whatsapp-bot-logs/bot.log` in Debian, rotated at 20 MB |
| Health / `/admin` | public URL | `http://<phone-ip>:3000` on the same Wi-Fi only |

`/admin` is no longer reachable from the internet. If you need it remotely,
put the phone on Tailscale (there is an Android app) rather than exposing the
port.

## Troubleshooting

- **Bot stops when the screen turns off** → step 1 wasn't fully applied
  (battery optimisation or phantom process killer).
- **`uv_interface_addresses returned Unknown system error 13`** → already
  handled by `utils/platformShims.ts`; if it appears, the build is stale —
  rebuild.
- **`bash\r: No such file or directory`** → the scripts were checked out with
  Windows line endings. `.gitattributes` prevents that for a fresh clone; fix
  an existing one with `sed -i 's/\r$//' deploy/termux/*.sh`.
- **Exit code 440 / "connection_replaced" in the log** → another instance
  (Render?) is using the session. Suspend it, then `bash ~/botctl.sh start`.
