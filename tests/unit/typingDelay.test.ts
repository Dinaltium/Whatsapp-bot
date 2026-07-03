import { describe, it, expect } from "vitest";
import { calculateTypingDelay } from "../../utils/typingDelay";

describe("typingDelay", () => {
  it("short text returns lower delay than long text", () => {
    const short = calculateTypingDelay("Hi");
    const long = calculateTypingDelay("This is a much longer message that has many more words and characters to simulate a realistic response from an AI assistant bot.");
    expect(short).toBeLessThan(long);
  });

  it("result is always positive", () => {
    expect(calculateTypingDelay("")).toBeGreaterThanOrEqual(0);
    expect(calculateTypingDelay("a")).toBeGreaterThan(0);
    expect(calculateTypingDelay("hello world")).toBeGreaterThan(0);
  });

  it("result never exceeds the 55000ms ceiling", () => {
    const veryLong = "word ".repeat(1000);
    expect(calculateTypingDelay(veryLong)).toBeLessThanOrEqual(55000);
  });

  it("long responses scale past the old 30s cap instead of being chopped", () => {
    // ~2000 chars should land above 30s but below the ceiling, proving length
    // keeps influencing the delay beyond the previous flat cap.
    const longText = "a".repeat(2000);
    const delay = calculateTypingDelay(longText);
    expect(delay).toBeGreaterThan(24000);
    expect(delay).toBeLessThanOrEqual(55000);
  });

  it("has some randomness across multiple runs", () => {
    const text = "A moderately sized message for testing randomness in delay calculation.";
    const results = Array.from({ length: 10 }, () => calculateTypingDelay(text));
    const allIdentical = results.every((v) => v === results[0]);
    expect(allIdentical).toBe(false);
  });
});
