/**
 * Shared Puppeteer Queue
 *
 * Serializes all Puppeteer browser executions across the entire application
 * to prevent concurrent browser launches from exhausting system resources.
 * Previously duplicated in communityRepository.ts and eventRepository.ts.
 */

let sharedPuppeteerQueue: Promise<any> = Promise.resolve();

/**
 * Enqueues a Puppeteer task so only one browser instance runs at a time.
 * @param taskName - A label for logging (e.g. "scrape-clubs", "scrape-events-may-2026")
 * @param task - The async function that launches and uses Puppeteer
 */
export async function serializePuppeteer<T>(
  taskName: string,
  task: () => Promise<T>,
): Promise<T> {
  const currentQueue = sharedPuppeteerQueue;
  let resolveQueue: () => void;
  const nextInQueue = new Promise<void>((resolve) => {
    resolveQueue = resolve;
  });
  sharedPuppeteerQueue = nextInQueue;

  try {
    await currentQueue;
  } catch (_err) {
    // Ignore errors from previous tasks in the queue to prevent deadlocking
  }

  console.log(`[PuppeteerQueue] Starting task: ${taskName}`);
  try {
    const result = await task();
    console.log(`[PuppeteerQueue] Completed task: ${taskName}`);
    return result;
  } finally {
    resolveQueue!();
  }
}
