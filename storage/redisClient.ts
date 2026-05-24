import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.error("FATAL: REDIS_URL environment variable is missing.");
  console.error("Please provide a valid REDIS_URL (e.g. redis://127.0.0.1:6379 for local or your Render redis url).");
  process.exit(1);
}

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on("connect", () => {
  console.log("Connected to Redis successfully!");
});

redis.on("error", (err) => {
  console.error("Redis Connection Error:", err);
});
