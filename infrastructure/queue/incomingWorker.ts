import { Worker } from "bullmq";
import Redis from "ioredis";
import { getActiveSocket } from "../../bot";
import { handleMessageUpsert } from "../../core/messageRouter";

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.error("FATAL: REDIS_URL is required for incoming worker.");
  process.exit(1);
}

const connectionOpts = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const incomingWorker = new Worker(
  "incoming-messages",
  async (job) => {
    console.log(`[QueueWorker] Processing job ${job.id} of type ${job.name}`);
    const { messages, type } = job.data;
    const sock = getActiveSocket();
    if (!sock) {
      console.warn(`[QueueWorker] Active WhatsApp socket is not available yet. Re-queueing job.`);
      throw new Error("Active socket not available");
    }
    
    await handleMessageUpsert(sock, messages, type);
  },
  {
    connection: connectionOpts,
    concurrency: 5, // Process up to 5 upserts in parallel
  }
);

incomingWorker.on("completed", (job) => {
  console.log(`[QueueWorker] Job ${job.id} completed successfully!`);
});

incomingWorker.on("failed", (job, err) => {
  console.error(`[QueueWorker] Job ${job?.id} failed:`, err);
});
