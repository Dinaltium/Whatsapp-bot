/**
 * Laptop-side notifier: subscribes to the bot's Redis pub/sub channel and
 * shows a native Windows toast when the generic auto-responder replies for
 * you on WhatsApp. Idle process — near-zero CPU/RAM between events.
 *
 * Connect via an SSH tunnel to the VPS (see README.md) — never point this at
 * an internet-exposed Redis port.
 */
require("dotenv").config();
const Redis = require("ioredis");
const notifier = require("node-notifier");

const HOST = process.env.REDIS_HOST || "127.0.0.1";
const PORT = Number(process.env.REDIS_PORT || 6380);
const PASSWORD = process.env.REDIS_PASSWORD || undefined;
const CHANNEL = process.env.NOTIFY_CHANNEL || "laptop:notify";
const MIN_SEVERITIES = new Set(
  (process.env.MIN_SEVERITIES || "low,medium,high")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const SEVERITY_LABEL = { high: "🔴 HIGH", medium: "🟡 Medium", low: "🟢 Low" };

const redis = new Redis({
  host: HOST,
  port: PORT,
  password: PASSWORD,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});

redis.on("connect", () => console.log(`[notifier] connected to ${HOST}:${PORT}`));
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
