import { describe, it, expect } from "vitest";
import { cleanRole, formatWithCountryCode, combineCountryCodeAndNumber } from "../../utils/normalization";

describe("cleanRole", () => {
  it("removes leading dashes", () => {
    expect(cleanRole("- President")).toBe("President");
    expect(cleanRole("-- Lead Developer")).toBe("Lead Developer");
  });

  it("removes email at end when provided", () => {
    expect(cleanRole("President test@example.com", "test@example.com")).toBe("President");
  });

  it("handles null/undefined gracefully", () => {
    expect(cleanRole(null as any)).toBe("");
    expect(cleanRole(undefined as any)).toBe("");
  });
});

describe("formatWithCountryCode", () => {
  it("handles +91 Indian prefix", () => {
    const result = formatWithCountryCode("+919876543210");
    expect(result.needsCountryCode).toBe(false);
    expect(result.formatted).toContain("91");
  });

  it("handles +971 UAE prefix", () => {
    const result = formatWithCountryCode("+971501234567");
    expect(result.needsCountryCode).toBe(false);
    expect(result.formatted).toContain("971");
  });

  it("handles +1 US prefix", () => {
    const result = formatWithCountryCode("+12125551234");
    expect(result.needsCountryCode).toBe(false);
    expect(result.formatted).toContain("1");
  });

  it("returns needsCountryCode true for ambiguous 10 digits", () => {
    const result = formatWithCountryCode("9876543210");
    expect(result.needsCountryCode).toBe(true);
  });
});

describe("combineCountryCodeAndNumber", () => {
  it("combines +91 with number", () => {
    const result = combineCountryCodeAndNumber("+91", "9876543210");
    expect(result).toBe("+91 9876543210");
  });

  it("strips non-digit characters from country code", () => {
    const result = combineCountryCodeAndNumber("971", "501234567");
    expect(result).toBe("+971 501234567");
  });
});
