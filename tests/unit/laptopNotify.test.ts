import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const publishMock = vi.fn(async () => 1);
vi.mock("../../storage/redisClient", () => ({
  redis: { publish: (...args: any[]) => publishMock(...args) },
}));

describe("publishLaptopNotification", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    publishMock.mockClear();
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("publishes to the default channel with a timestamp", async () => {
    delete process.env.NOTIFY_ENABLED;
    delete process.env.LAPTOP_NOTIFY_CHANNEL;
    const { publishLaptopNotification } = await import("../../services/notify/laptopNotify");
    await publishLaptopNotification({
      senderName: "Dad",
      preview: "hey",
      severity: "medium",
      reason: "question",
    });
    expect(publishMock).toHaveBeenCalledTimes(1);
    const [channel, payload] = publishMock.mock.calls[0];
    expect(channel).toBe("laptop:notify");
    const parsed = JSON.parse(payload);
    expect(parsed.senderName).toBe("Dad");
    expect(typeof parsed.timestamp).toBe("number");
  });

  it("respects a custom channel name", async () => {
    process.env.LAPTOP_NOTIFY_CHANNEL = "custom:chan";
    const { publishLaptopNotification } = await import("../../services/notify/laptopNotify");
    await publishLaptopNotification({
      senderName: "X",
      preview: "y",
      severity: "low",
      reason: "z",
    });
    expect(publishMock.mock.calls[0][0]).toBe("custom:chan");
  });

  it("does not publish when NOTIFY_ENABLED=false", async () => {
    process.env.NOTIFY_ENABLED = "false";
    const { publishLaptopNotification } = await import("../../services/notify/laptopNotify");
    await publishLaptopNotification({
      senderName: "X",
      preview: "y",
      severity: "low",
      reason: "z",
    });
    expect(publishMock).not.toHaveBeenCalled();
  });
});
