import { describe, it, expect } from "vitest";
import { parseReminderTime } from "../../utils/timeParser";

function approxEqual(a: Date, b: Date, toleranceMs = 5000): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= toleranceMs;
}

describe("timeParser - parseReminderTime", () => {
  it("parses 'in 5 minutes' correctly", () => {
    const result = parseReminderTime("in 5 minutes");
    expect(result).not.toBeNull();
    expect(approxEqual(result!, new Date(Date.now() + 5 * 60 * 1000))).toBe(true);
  });

  it("parses 'in 2 hours' correctly", () => {
    const result = parseReminderTime("in 2 hours");
    expect(result).not.toBeNull();
    expect(approxEqual(result!, new Date(Date.now() + 2 * 60 * 60 * 1000), 10000)).toBe(true);
  });

  it("parses 'in 1 day' correctly", () => {
    const result = parseReminderTime("in 1 day");
    expect(result).not.toBeNull();
    expect(approxEqual(result!, new Date(Date.now() + 24 * 60 * 60 * 1000), 10000)).toBe(true);
  });

  it("parses 'in 30m' abbreviated form", () => {
    const result = parseReminderTime("in 30m");
    expect(result).not.toBeNull();
    expect(approxEqual(result!, new Date(Date.now() + 30 * 60 * 1000))).toBe(true);
  });

  it("returns null for 'banana' (invalid input)", () => {
    expect(parseReminderTime("banana")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseReminderTime("")).toBeNull();
  });
});
