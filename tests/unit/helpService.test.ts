import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory Redis sorted-set stub so the gate can be exercised without a server.
const store = new Map<string, Map<string, number>>();
vi.mock("../../storage/redisClient", () => ({
  redis: {
    async zremrangebyscore(key: string, min: number, max: number) {
      const m = store.get(key);
      if (!m) return;
      for (const [mem, score] of [...m]) {
        if (score >= min && score <= max) m.delete(mem);
      }
    },
    async zscore(key: string, mem: string) {
      return store.get(key)?.get(mem) ?? null;
    },
    async zcard(key: string) {
      return store.get(key)?.size ?? 0;
    },
    async zrange(key: string, start: number, stop: number, withscores?: string) {
      const m = store.get(key);
      if (!m) return [];
      const sorted = [...m.entries()].sort((a, b) => a[1] - b[1]);
      const slice = sorted.slice(start, stop + 1);
      return withscores
        ? slice.flatMap(([mem, score]) => [mem, String(score)])
        : slice.map(([mem]) => mem);
    },
    async zadd(key: string, score: number, mem: string) {
      if (!store.has(key)) store.set(key, new Map());
      store.get(key)!.set(mem, score);
    },
    async pexpire() {},
  },
}));

vi.mock("../../agents/WhatsAppAgent", () => ({
  getBotRegistry: () => [
    { botId: 0, name: "Generic", getHelpText: () => "GENERIC" },
    { botId: 2, name: "DKB", getHelpText: () => "DKB BASE" },
  ],
}));
vi.mock("../../agents/DKB/intro", () => ({
  DKB_MENTOR_HELP_TEXT: "MENTOR BLOCK",
}));

import {
  buildHelpText,
  checkHelpGate,
  HELP_BOT_BUDGET,
} from "../../core/commands/helpService";

describe("buildHelpText role gating", () => {
  it("bot 2 non-mentor sees base + locked note, not the mentor block", () => {
    const t = buildHelpText(2, { isMentor: false });
    expect(t).toContain("DKB BASE");
    expect(t).toContain("don't have access");
    expect(t).not.toContain("MENTOR BLOCK");
  });

  it("bot 2 mentor sees base + full mentor block", () => {
    const t = buildHelpText(2, { isMentor: true });
    expect(t).toContain("DKB BASE");
    expect(t).toContain("MENTOR BLOCK");
  });

  it("non-DKB bot has no mentor section", () => {
    expect(buildHelpText(0, { isMentor: true })).toBe("GENERIC");
  });

  it("unknown bot id falls back to the first registry entry", () => {
    expect(buildHelpText(9, { isMentor: false })).toBe("GENERIC");
  });
});

describe("checkHelpGate cooldown + per-bot budget", () => {
  beforeEach(() => store.clear());

  it("HELP_BOT_BUDGET is 2 distinct chats per bot", () => {
    expect(HELP_BOT_BUDGET).toBe(2);
  });

  it("allows first view, blocks the same chat on cooldown", async () => {
    expect((await checkHelpGate(2, "A@g.us")).allowed).toBe(true);
    const again = await checkHelpGate(2, "A@g.us");
    expect(again.allowed).toBe(false);
    expect(again.reason).toBe("cooldown");
  });

  it("serves 2 distinct chats, blocks the 3rd as busy", async () => {
    expect((await checkHelpGate(2, "A@g.us")).allowed).toBe(true);
    expect((await checkHelpGate(2, "B@g.us")).allowed).toBe(true);
    const third = await checkHelpGate(2, "C@g.us");
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe("busy");
  });

  it("budgets are independent per bot", async () => {
    await checkHelpGate(2, "A@g.us");
    await checkHelpGate(2, "B@g.us");
    // Bot 3 has its own budget — a fresh chat is still allowed.
    expect((await checkHelpGate(3, "A@g.us")).allowed).toBe(true);
  });
});
