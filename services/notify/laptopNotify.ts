/**
 * Publishes a "someone messaged the owner while they were away" event over
 * Redis pub/sub for a laptop-side subscriber (see laptop-notifier/) to render
 * as a native toast. Fire-and-forget — never blocks or fails the reply path.
 */
const NOTIFY_ENABLED = (process.env.NOTIFY_ENABLED ?? "true").toLowerCase() !== "false";
const NOTIFY_CHANNEL = process.env.LAPTOP_NOTIFY_CHANNEL || "laptop:notify";

export interface LaptopNotification {
  senderName: string;
  preview: string;
  severity: "low" | "medium" | "high";
  reason: string;
  timestamp: number;
}

export async function publishLaptopNotification(
  n: Omit<LaptopNotification, "timestamp">,
): Promise<void> {
  if (!NOTIFY_ENABLED) return;
  try {
    const { redis } = await import("../../storage/redisClient");
    const payload: LaptopNotification = { ...n, timestamp: Date.now() };
    await redis.publish(NOTIFY_CHANNEL, JSON.stringify(payload));
  } catch (err) {
    console.warn("[laptopNotify] publish failed:", err);
  }
}
