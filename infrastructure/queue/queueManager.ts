import { Queue } from "bullmq";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.error("FATAL: REDIS_URL is required for queue manager.");
  process.exit(1);
}

// Dedicated connection for the queues to avoid sharing blocks
export const connectionOpts = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const incomingQueue = new Queue("incoming-messages", {
  connection: connectionOpts,
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
  connection: connectionOpts,
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
    await connectionOpts.quit();
    console.log("BullMQ queues and connection closed successfully.");
  } catch (e) {
    console.error("Error closing BullMQ queues:", e);
  }
}
