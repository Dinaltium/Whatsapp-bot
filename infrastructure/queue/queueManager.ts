import { Queue } from "bullmq";

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.error("FATAL: REDIS_URL is required for queue manager.");
  process.exit(1);
}

// BullMQ v5 accepts a URL string as ConnectionOptions directly.
// This avoids the ioredis type collision between bullmq's bundled ioredis
// and the root-level ioredis package.
const connection = { url: REDIS_URL, maxRetriesPerRequest: null };

export const incomingQueue = new Queue("incoming-messages", {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 100, // Keep last 100 failures for auditing/debugging
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000, // 2s, 4s, 8s retries
    },
  },
});

export const outgoingQueue = new Queue("outgoing-replies", {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 100,
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  },
});

export async function closeQueues(): Promise<void> {
  try {
    await incomingQueue.close();
    await outgoingQueue.close();
    console.log("BullMQ queues closed successfully.");
  } catch (e) {
    console.error("Error closing BullMQ queues:", e);
  }
}
