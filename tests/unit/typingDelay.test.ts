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

  it("result never exceeds 30000ms", () => {
    const veryLong = "word ".repeat(1000);
    expect(calculateTypingDelay(veryLong)).toBeLessThanOrEqual(30000);
  });

  it("has some randomness across multiple runs", () => {
    const text = "A moderately sized message for testing randomness in delay calculation.";
    const results = Array.from({ length: 10 }, () => calculateTypingDelay(text));
    const allIdentical = results.every((v) => v === results[0]);
    expect(allIdentical).toBe(false);
  });
});
