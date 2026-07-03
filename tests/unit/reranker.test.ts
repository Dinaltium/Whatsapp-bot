import { describe, it, expect } from "vitest";
import { domainTrustScore, rerankResults } from "../../services/search/reranker";
import { searchCacheKey } from "../../services/search/searchService";

describe("reranker source trust", () => {
  it("scores gov/edu and known domains high, junk low", () => {
    expect(domainTrustScore("https://en.wikipedia.org/wiki/X")).toBeGreaterThan(0);
    expect(domainTrustScore("https://nic.gov.in/page")).toBeGreaterThan(0);
    expect(domainTrustScore("https://mit.edu/x")).toBeGreaterThan(0);
    expect(domainTrustScore("https://www.pinterest.com/x")).toBeLessThan(0);
    expect(domainTrustScore("https://random-blog.xyz/x")).toBe(0);
    expect(domainTrustScore(undefined)).toBe(0);
    expect(domainTrustScore("not a url")).toBe(0);
  });

  it("ranks a trusted source above a junk source at equal text overlap", () => {
    const results = [
      { title: "Cricket score", url: "https://www.pinterest.com/a", content: "cricket score" },
      { title: "Cricket score", url: "https://www.espncricinfo.com/b", content: "cricket score" },
    ];
    const ranked = rerankResults("cricket score", results);
    expect(ranked[0].url).toContain("espncricinfo.com");
  });
});

describe("search cache key", () => {
  it("is stable across whitespace/case, differs by content", () => {
    expect(searchCacheKey("Who is the CEO")).toBe(searchCacheKey("  who   is the ceo "));
    expect(searchCacheKey("a")).not.toBe(searchCacheKey("b"));
    expect(searchCacheKey("x").startsWith("websearch:")).toBe(true);
  });
});
