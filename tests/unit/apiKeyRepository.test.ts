import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKey, looksLikeApiKey } from "../../storage/core/apiKeyRepository";

describe("api key primitives", () => {
  it("generates mhk_-prefixed 52-char keys that pass the shape check", () => {
    const k = generateApiKey();
    expect(k).toMatch(/^mhk_[0-9a-f]{48}$/);
    expect(looksLikeApiKey(k)).toBe(true);
  });
  it("rejects malformed keys before touching the database", () => {
    expect(looksLikeApiKey("")).toBe(false);
    expect(looksLikeApiKey("mhk_short")).toBe(false);
    expect(looksLikeApiKey("abc_" + "a".repeat(48))).toBe(false);
  });
  it("hashes deterministically and never stores the raw key", () => {
    const k = generateApiKey();
    expect(hashApiKey(k)).toBe(hashApiKey(k));
    expect(hashApiKey(k)).toHaveLength(64);
    expect(hashApiKey(k)).not.toContain(k.slice(4, 20));
  });
  it("two generated keys never collide", () => {
    expect(generateApiKey()).not.toBe(generateApiKey());
  });
});
