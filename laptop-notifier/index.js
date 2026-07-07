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
const Redis = require("ioredis");
const notifier = require("node-notifier");

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
});

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
