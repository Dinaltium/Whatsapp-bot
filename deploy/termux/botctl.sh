#!/data/data/com.termux/files/usr/bin/bash
# Control the bot from TERMUX (not from inside Debian).
#
#   bash botctl.sh install      copy this script to ~/botctl.sh + set up auto-start on boot
#   bash ~/botctl.sh start      start in the background (tmux session "wabot")
#   bash ~/botctl.sh stop
#   bash ~/botctl.sh restart    e.g. after `git pull` + build
#   bash ~/botctl.sh status
#   bash ~/botctl.sh logs       follow the log (Ctrl-C to stop following; the bot keeps running)
#   bash ~/botctl.sh attach     live console (detach: Ctrl-b then d)
set -euo pipefail

DISTRO="${DISTRO:-debian}"
REPO="${REPO:-/root/Whatsapp-bot}"
SESSION="wabot"
ROOTFS="$PREFIX/var/lib/proot-distro/installed-rootfs/$DISTRO"
LOG="$ROOTFS/root/whatsapp-bot-logs/bot.log"

need() { command -v "$1" >/dev/null || { echo "Missing $1: pkg install $2" >&2; exit 1; }; }
need tmux tmux
need proot-distro proot-distro

running() { tmux has-session -t "$SESSION" 2>/dev/null; }

start() {
  if running; then echo "already running (bash ~/botctl.sh attach)"; return; fi
  # Keep the CPU awake with the screen off. Without this Android dozes Termux
  # and the WhatsApp socket drops within minutes.
  termux-wake-lock 2>/dev/null || true
  tmux new-session -d -s "$SESSION" \
    "proot-distro login $DISTRO -- bash $REPO/deploy/termux/run.sh"
  echo "started. logs: bash ~/botctl.sh logs"
}

stop() {
  if ! running; then echo "not running"; return; fi
  tmux send-keys -t "$SESSION" C-c
  for _ in $(seq 1 15); do running || break; sleep 1; done
  running && tmux kill-session -t "$SESSION"
  echo "stopped."
}

install() {
  cp -f "$0" "$HOME/botctl.sh"
  chmod +x "$HOME/botctl.sh"
  mkdir -p "$HOME/.termux/boot"
  cat > "$HOME/.termux/boot/start-wabot" <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
sleep 20   # let networking come up after boot
bash "$HOME/botctl.sh" start
EOF
  chmod +x "$HOME/.termux/boot/start-wabot"
  echo "installed ~/botctl.sh and ~/.termux/boot/start-wabot"
  echo "auto-start on boot needs the Termux:Boot app (F-Droid), opened once."
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 2; start ;;
  status) running && echo "running" || echo "stopped" ;;
  logs) tail -n 100 -F "$LOG" ;;
  attach) tmux attach -t "$SESSION" ;;
  install) install ;;
  *) sed -n '2,11p' "$0"; exit 1 ;;
esac
