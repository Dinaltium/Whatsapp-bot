import { describe, it, expect } from "vitest";
import {
  parseWhen,
  addHours,
  isCalendarConfigured,
} from "../../services/calendar/googleCalendar";

describe("googleCalendar date parsing", () => {
  it("parses date-only as 09:00", () => {
    expect(parseWhen("2026-07-10")).toBe("2026-07-10T09:00:00");
  });

  it("parses date + time (space or T)", () => {
    expect(parseWhen("2026-07-10 15:30")).toBe("2026-07-10T15:30:00");
    expect(parseWhen("2026-07-10T15:30")).toBe("2026-07-10T15:30:00");
  });

  it("pads single-digit month/day", () => {
    expect(parseWhen("2026-7-5 9:00")).toBe("2026-07-05T09:00:00");
  });

  it("rejects garbage and out-of-range", () => {
    expect(parseWhen("next tuesday")).toBeNull();
    expect(parseWhen("2026-13-01")).toBeNull();
    expect(parseWhen("")).toBeNull();
  });

  it("addHours advances wall-clock, rolls the day over", () => {
    expect(addHours("2026-07-10T15:00:00", 1)).toBe("2026-07-10T16:00:00");
    expect(addHours("2026-07-10T23:30:00", 1)).toBe("2026-07-11T00:30:00");
  });

  it("is not configured without env creds", () => {
    // No GOOGLE_SERVICE_ACCOUNT_JSON in test env.
    expect(isCalendarConfigured()).toBe(false);
  });
});
