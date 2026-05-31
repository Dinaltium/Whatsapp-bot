import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Redis
const mockRedisStore: Record<string, number> = {};
vi.mock("../../storage/redisClient", () => ({
  redis: {
    incr: vi.fn(async (key: string) => {
      mockRedisStore[key] = (mockRedisStore[key] || 0) + 1;
      return mockRedisStore[key];
    }),
    expire: vi.fn(async () => "OK"),
  },
}));

// Mock env
const originalEnv = process.env;

describe("checkGlobalUserLimit", () => {
  beforeEach(() => {
    Object.keys(mockRedisStore).forEach((k) => delete mockRedisStore[k]);
    process.env = {
      ...originalEnv,
      ADMIN_JIDS: "9199028@s.whatsapp.net",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("allows first 20 requests", async () => {
    const { checkGlobalUserLimit } = await import("../../security/rateLimiter");
    const userId = "999@s.whatsapp.net";
    for (let i = 0; i < 20; i++) {
      const result = await checkGlobalUserLimit(userId);
      expect(result.allowed).toBe(true);
    }
  });

  it("blocks 21st request", async () => {
    const { checkGlobalUserLimit } = await import("../../security/rateLimiter");
    const userId = "888@s.whatsapp.net";
    // Fill up
    for (let i = 0; i < 20; i++) {
      await checkGlobalUserLimit(userId);
    }
    const result = await checkGlobalUserLimit(userId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("global_hourly");
  });

  it("admin JID bypasses limit entirely", async () => {
    const { checkGlobalUserLimit } = await import("../../security/rateLimiter");
    const adminJid = "9199028@s.whatsapp.net";
    // Even after many calls, admin should always be allowed
    for (let i = 0; i < 25; i++) {
      const result = await checkGlobalUserLimit(adminJid);
      expect(result.allowed).toBe(true);
    }
  });
});
