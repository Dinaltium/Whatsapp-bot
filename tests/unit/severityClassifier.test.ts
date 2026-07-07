import { describe, it, expect, afterEach, vi } from "vitest";
import { classifySeverity } from "../../services/notify/severityClassifier";

const origFetch = (globalThis as any).fetch;

afterEach(() => {
  (globalThis as any).fetch = origFetch;
  vi.restoreAllMocks();
});

function mockGroq(content: string) {
  (globalThis as any).fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  }));
}

describe("classifySeverity", () => {
  it("falls back to medium with no API key (never silently drops)", async () => {
    const r = await classifySeverity("hey", undefined);
    expect(r.severity).toBe("medium");
  });

  it("falls back to medium on empty text", async () => {
    const r = await classifySeverity("", "key");
    expect(r.severity).toBe("medium");
  });

  it("parses a valid low classification", async () => {
    mockGroq('{"severity":"low","reason":"just a greeting"}');
    const r = await classifySeverity("hey what's up", "key");
    expect(r).toEqual({ severity: "low", reason: "just a greeting" });
  });

  it("parses a valid high classification", async () => {
    mockGroq('{"severity":"high","reason":"urgent emergency ask"}');
    const r = await classifySeverity("I need help NOW, emergency", "key");
    expect(r.severity).toBe("high");
  });

  it("tolerates prose wrapped around the JSON", async () => {
    mockGroq('Sure! {"severity":"low","reason":"small talk"} — done.');
    const r = await classifySeverity("hi", "key");
    expect(r.severity).toBe("low");
  });

  it("falls back to medium on malformed output", async () => {
    mockGroq("not json at all");
    const r = await classifySeverity("hi", "key");
    expect(r.severity).toBe("medium");
  });

  it("falls back to medium on an unknown severity value", async () => {
    mockGroq('{"severity":"critical","reason":"x"}');
    const r = await classifySeverity("hi", "key");
    expect(r.severity).toBe("medium");
  });

  it("falls back to medium on HTTP failure", async () => {
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    const r = await classifySeverity("hi", "key");
    expect(r.severity).toBe("medium");
  });
});
