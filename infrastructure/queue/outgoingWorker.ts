import { Worker } from "bullmq";
import { getActiveSocket } from "../../bot";

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.error("FATAL: REDIS_URL is required for outgoing worker.");
  process.exit(1);
}

// BullMQ v5 accepts a URL string directly — no ioredis import needed.
const connection = { url: REDIS_URL, maxRetriesPerRequest: null };

export const outgoingWorker = new Worker(
  "outgoing-replies",
  async (job) => {
    console.log(`[ReplyWorker] Processing reply job ${job.id}`);
    const { to, text } = job.data;
    const sock = getActiveSocket();
    if (!sock) {
      console.warn(`[ReplyWorker] Active WhatsApp socket is not available yet. Re-queueing.`);
      throw new Error("Active socket not available");
    }

    try {
      // Simulate typing/thinking delay asynchronously inside the worker context
      await sock.sendPresenceUpdate("composing", to);
    } catch (err) {
      console.error("[ReplyWorker] Failed to send typing presence:", err);
    }

    const textLength = String(text || "").length;
    const baseDelay = Math.floor(Math.random() * 1500) + 1200; // 1200ms to 2700ms base reading/thinking delay
    const charDelay = textLength * 20; // 20ms per character of typing
    let totalDelay = baseDelay + charDelay;

    const maxDelayCap = Math.floor(Math.random() * 10000) + 20000; // 20000ms to 30000ms
    if (totalDelay > maxDelayCap) {
      totalDelay = maxDelayCap;
    }

    console.log(`[ReplyWorker] Simulating typing delay of ${totalDelay}ms for ${to}`);
    await new Promise((resolve) => setTimeout(resolve, totalDelay));

    try {
      await sock.sendPresenceUpdate("paused", to);
    } catch (err) {}

    await sock.sendMessage(to, { text: String(text || "").trim() });
    console.log(`[ReplyWorker] Reply dispatched successfully to ${to}`);
  },
  {
    connection,
    concurrency: 5, // Dispatch up to 5 replies in parallel
  }
);

outgoingWorker.on("completed", (job) => {
  console.log(`[ReplyWorker] Job ${job.id} completed successfully!`);
});

outgoingWorker.on("failed", (job, err) => {
  console.error(`[ReplyWorker] Job ${job?.id} failed:`, err);
});
