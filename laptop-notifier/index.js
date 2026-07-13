/**
 * Laptop-side notifier: subscribes to the bot's Redis pub/sub channel and
 * shows a native Windows toast when the generic auto-responder replies for
 * you on WhatsApp. Idle process — near-zero CPU/RAM between events.
 *
 * Connects directly to Upstash Redis over TLS (Upstash is already a managed,
 * password-protected, internet-facing endpoint — no SSH tunnel needed). If you
 * later move to a self-hosted VPS Redis instead, tunnel it (see README) and
 * set REDIS_TLS=false.
 */
require("dotenv").config();
const net = require("net");
const Redis = require("ioredis");
const notifier = require("node-notifier");

// ── Single-instance lock ────────────────────────────────────────────────────
// Bind a loopback port; if it's taken, another notifier is already running, so
// exit with code 3 (run-forever.bat treats 3 as "don't restart"). This kills
// the duplicate-toast bug and makes it safe for the scheduled task to relaunch
// us periodically without ever stacking instances.
const LOCK_PORT = Number(process.env.NOTIFIER_LOCK_PORT || 47615);
const lock = net.createServer();
lock.once("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.log("[notifier] another instance is already running — exiting.");
    process.exit(3);
  }
  // Any other lock error: carry on without the lock rather than refuse to run.
});
lock.listen(LOCK_PORT, "127.0.0.1");

const CHANNEL = process.env.NOTIFY_CHANNEL || "laptop:notify";
const MIN_SEVERITIES = new Set(
  (process.env.MIN_SEVERITIES || "low,medium,high")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const SEVERITY_LABEL = { high: "🔴 HIGH", medium: "🟡 Medium", low: "🟢 Low" };

// Prefer a full REDIS_URL (rediss://default:PASS@host:6379) if given; else
// build the connection from discrete host/port/password/tls vars.
const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      retryStrategy: (times) => Math.min(times * 500, 5000),
    })
  : new Redis({
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      tls: (process.env.REDIS_TLS ?? "true").toLowerCase() !== "false" ? {} : undefined,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });

redis.on("connect", () => console.log("[notifier] connected to Redis"));
redis.on("error", (err) => console.error("[notifier] redis error:", err.message));

redis.subscribe(CHANNEL, (err) => {
  if (err) {
    console.error("[notifier] subscribe failed:", err.message);
    process.exit(1);
  }
  console.log(`[notifier] listening on "${CHANNEL}" — waiting for messages...`);
  startPresence();
});

// ── Desk presence ──────────────────────────────────────────────────────────
// Reports "owner is at the computer" (based on OS idle time) so the bot doesn't
// auto-reply while you're online-but-idle. Uses a SECOND connection because a
// subscribed ioredis connection can't issue other commands.
// Presence = "is WhatsApp the focused window right now". This is what the bot
// treats as "owner online" — so being at the computer in another app (Claude,
// a browser, etc.) counts as AWAY, and you get notified. Reports to the same
// owner:desk_active key the bot already reads.
const WA_PRESENCE = (process.env.WA_PRESENCE ?? "true").toLowerCase() !== "false";
const PRESENCE_PING_SEC = Number(process.env.PRESENCE_PING_SEC || 7);
// Optional override: if set, treat the window as WhatsApp when this regex
// matches the title/app. Leave unset to use the smart owner-based detection
// below (which avoids false hits from windows that merely mention "whatsapp",
// e.g. this repo "Whatsapp-bot", an editor, or a terminal in that folder).
const WA_MATCH = process.env.WHATSAPP_MATCH ? new RegExp(process.env.WHATSAPP_MATCH, "i") : null;

// STRICT: the window title must *be* WhatsApp Web, i.e. exactly "WhatsApp",
// "(N) WhatsApp", or "WhatsApp Web" — optionally followed by a browser suffix
// like " - Google Chrome" / " — Personal — Microsoft Edge". This deliberately
// rejects titles that merely CONTAIN "whatsapp" (e.g. "...Whatsapp Bot |
// Dokploy...", this repo, editors), which is what caused false "online".
const WA_STRICT = /^(\(\d+\)\s*)?whatsapp(\s+web)?(\s+[-–—|]\s+.*)?$/i;

function isWhatsAppFocused(win) {
  const title = ((win && win.title) || "").trim();
  const owner = ((win && win.owner && win.owner.name) || "").trim();
  if (WA_MATCH) return WA_MATCH.test(title) || WA_MATCH.test(owner);
  if (/^whatsapp$/i.test(owner)) return true; // WhatsApp desktop app
  return WA_STRICT.test(title);
}

const pub = redis.duplicate();
pub.on("error", () => {});

let activeWin = null;
async function loadActiveWin() {
  try {
    const mod = await import("active-win"); // ESM-only → dynamic import
    activeWin = mod.activeWindow || mod.default || mod;
  } catch {
    console.warn(
      "[notifier] active-win not installed — WhatsApp presence off. Run `npm install`. The bot falls back to send-based presence.",
    );
  }
}

async function startPresence() {
  if (!WA_PRESENCE) return;
  await loadActiveWin();
  if (!activeWin) return;
  const DEBUG = (process.env.PRESENCE_DEBUG || "").toLowerCase() === "true";
  let lastFocused = null;
  const tick = async () => {
    try {
      const win = await activeWin();
      const owner = (win && win.owner && win.owner.name) || "?";
      const title = ((win && win.title) || "").slice(0, 60);
      const focused = isWhatsAppFocused(win);
      if (DEBUG) console.log(`[notifier] tick: focused=${focused} | ${owner} — "${title}"`);
      if (focused !== lastFocused) {
        lastFocused = focused;
        console.log(`[notifier] WhatsApp focused = ${focused} (active window: ${owner} — "${title}")`);
      }
      if (focused) {
        // Only publish while WhatsApp is focused; when it isn't, the key ages
        // out within the bot's OWNER_DESK_WINDOW_MS and the owner reads as away.
        await pub.set("owner:desk_active", Date.now().toString(), "EX", 120);
      }
    } catch (err) {
      if (DEBUG) console.warn("[notifier] presence tick error:", (err && err.message) || err);
    }
  };
  tick();
  setInterval(tick, PRESENCE_PING_SEC * 1000);
  console.log(`[notifier] WhatsApp-focus presence on (checking every ${PRESENCE_PING_SEC}s)`);
}

// Belt-and-suspenders de-dupe: skip a toast we already showed in the last 15s
// (guards against a double publish or a reconnect redelivery).
const recentToasts = new Map();
function alreadyShown(payload) {
  const key = `${payload.timestamp || ""}|${payload.senderName || ""}|${payload.preview || ""}`;
  const now = Date.now();
  for (const [k, t] of recentToasts) if (now - t > 15000) recentToasts.delete(k);
  if (recentToasts.has(key)) return true;
  recentToasts.set(key, now);
  return false;
}

redis.on("message", (_channel, raw) => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const { senderName, preview, severity, reason } = payload;
  const sev = (severity || "medium").toLowerCase();
  if (!MIN_SEVERITIES.has(sev)) return;
  if (alreadyShown(payload)) return;

  notifier.notify({
    title: `WhatsApp — ${senderName || "Unknown"} [${SEVERITY_LABEL[sev] || sev}]`,
    message: `${preview || ""}${reason ? `\n(${reason})` : ""}`,
    sound: sev === "high",
    wait: false,
  });
  console.log(`[notifier] toast: ${senderName} (${sev}) — ${preview}`);
});

process.on("SIGINT", () => {
  redis.disconnect();
  process.exit(0);
});
