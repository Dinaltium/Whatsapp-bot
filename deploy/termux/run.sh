#!/usr/bin/env bash
# Runs the bot INSIDE Debian and restarts it the way Render used to.
#
# The bot already signals intent through its exit code:
#   exit 1  watchdog, /admin restart or relink, fatal startup error -> restart
#   exit 0  Ctrl-C, SIGTERM, or another device took the WhatsApp session -> stay down
# Staying down on 0 matters: if Render is still running, the two instances
# would otherwise keep kicking each other off the session.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${LOG_DIR:-$HOME/whatsapp-bot-logs}"
LOG_FILE="$LOG_DIR/bot.log"
MAX_LOG_BYTES=$((20 * 1024 * 1024))

cd "$REPO_DIR"
mkdir -p "$LOG_DIR"

# Render ran in UTC; keep reminders firing at the same times.
export TZ="${TZ:-UTC}"
export NODE_ENV=production
# A phone has less RAM than it seems once Android takes its share.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=512}"
# Use Debian's ffmpeg rather than the binary ffmpeg-static downloads.
if [ -z "${FFMPEG_BIN:-}" ] && command -v ffmpeg >/dev/null; then
  export FFMPEG_BIN="$(command -v ffmpeg)"
fi

if [ ! -f dist/bot.js ]; then
  echo "dist/bot.js missing - run: bash deploy/termux/setup-debian.sh" >&2
  exit 1
fi

rotate_log() {
  if [ -f "$LOG_FILE" ] && [ "$(stat -c %s "$LOG_FILE")" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.1"
  fi
}

child=0
stop() {
  echo "[run.sh] stopping" | tee -a "$LOG_FILE"
  [ "$child" -ne 0 ] && kill -TERM "$child" 2>/dev/null && wait "$child"
  exit 0
}
trap stop INT TERM

backoff=5
while true; do
  rotate_log
  started=$(date +%s)
  echo "[run.sh] $(date -u +%FT%TZ) starting bot" | tee -a "$LOG_FILE"
  # Process substitution, not a pipe: $! must be node's pid so that `wait`
  # returns node's exit code rather than tee's.
  node dist/bot.js > >(tee -a "$LOG_FILE") 2>&1 &
  child=$!
  wait "$child"
  code=$?
  child=0

  if [ "$code" -eq 0 ]; then
    echo "[run.sh] bot exited cleanly (0); not restarting" | tee -a "$LOG_FILE"
    exit 0
  fi

  # A run that lasted 10+ minutes was healthy; restart quickly again.
  if [ $(( $(date +%s) - started )) -ge 600 ]; then backoff=5; fi
  echo "[run.sh] bot exited ($code); restarting in ${backoff}s" | tee -a "$LOG_FILE"
  sleep "$backoff"
  backoff=$(( backoff * 2 > 300 ? 300 : backoff * 2 ))
done
