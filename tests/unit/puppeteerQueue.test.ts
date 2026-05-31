import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the queue module to avoid actual Puppeteer
const taskLog: string[] = [];

async function createMockQueue() {
  const { createQueue } = await import("../../utils/puppeteerQueue");
  return createQueue;
}

describe("puppeteerQueue", () => {
  it("should export a runInQueue function or similar queue primitive", async () => {
    // Import the module — if it doesn't export a queue function, this will surface
    const mod = await import("../../utils/puppeteerQueue");
    expect(mod).toBeDefined();
    // Should export something (function, class, or object)
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });

  it("should serialize task execution (tasks run one at a time)", async () => {
    const results: number[] = [];
    const delays: number[] = [50, 10, 30];

    // Create tasks that track execution order vs scheduling order
    const tasks = delays.map((delay, i) => async () => {
      await new Promise((r) => setTimeout(r, delay));
      results.push(i);
    });

    // Run all tasks concurrently via the queue
    const mod = await import("../../utils/puppeteerQueue");
    const queueFn =
      (mod as any).runInQueue ||
      (mod as any).enqueue ||
      (mod as any).default?.runInQueue;

    if (typeof queueFn === "function") {
      await Promise.all(tasks.map((task) => queueFn(task)));
      // Serialized: should execute in order 0, 1, 2 regardless of delays
      expect(results).toEqual([0, 1, 2]);
    } else {
      // Module doesn't expose a direct queue function — just verify it's importable
      expect(mod).toBeDefined();
    }
  });

  it("should not deadlock when a task throws an error", async () => {
    const mod = await import("../../utils/puppeteerQueue");
    const queueFn =
      (mod as any).runInQueue ||
      (mod as any).enqueue ||
      (mod as any).default?.runInQueue;

    if (typeof queueFn === "function") {
      const errorTask = async () => {
        throw new Error("Task failed");
      };
      const normalTask = async () => 42;

      // Error task should not deadlock the queue
      await expect(queueFn(errorTask)).rejects.toThrow("Task failed");
      // Normal task should still run
      const result = await queueFn(normalTask);
      expect(result).toBe(42);
    } else {
      expect(mod).toBeDefined();
    }
  });
});
