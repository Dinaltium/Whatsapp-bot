import { describe, it, expect } from "vitest";
import { isCommunityQuery } from "../../services/DKB/communityService";

describe("isCommunityQuery", () => {
  it("returns false for generic greetings", () => {
    expect(isCommunityQuery("hi how are you")).toBe(false);
  });

  it("returns false for 'help me' generic", () => {
    expect(isCommunityQuery("help me")).toBe(false);
  });

  it("returns true for clubs query", () => {
    expect(isCommunityQuery("what clubs are in dk24")).toBe(true);
  });

  it("returns true for specific club name", () => {
    expect(isCommunityQuery("tell me about sosc")).toBe(true);
  });

  it("returns true for events query with location", () => {
    expect(isCommunityQuery("any events in mangalore")).toBe(true);
  });

  it("returns true for hackathon registration", () => {
    expect(isCommunityQuery("hacktofuture registration")).toBe(true);
  });

  it("returns false for general ML question", () => {
    expect(isCommunityQuery("what is machine learning")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isCommunityQuery(null as any)).toBe(false);
    expect(isCommunityQuery(undefined as any)).toBe(false);
  });
});
