import { describe, it, expect } from "vitest";
import { classifyIntent } from "../../services/search/intentRouter";

describe("classifyIntent", () => {
  it("routes live cricket queries", () => {
    const i = classifyIntent("what is the current score of the cricket match");
    expect(i.vertical).toBe("cricket");
    expect(i.needsLive).toBe(true);
  });

  it("routes football/soccer queries", () => {
    expect(classifyIntent("premier league live scores today").vertical).toBe(
      "football",
    );
  });

  it("routes crypto price queries with a coin hint", () => {
    const i = classifyIntent("bitcoin price right now");
    expect(i.vertical).toBe("crypto");
    expect(i.hint).toBe("bitcoin");
  });

  it("routes stock price queries with a ticker hint", () => {
    const i = classifyIntent("what's the $AAPL stock price today");
    expect(i.vertical).toBe("stock");
    expect(i.hint).toBe("AAPL");
  });

  it("routes weather queries (web-backed, no provider)", () => {
    expect(classifyIntent("weather in Mangalore today").vertical).toBe("weather");
  });

  it("routes explicit URLs to extraction", () => {
    expect(classifyIntent("summarize https://example.com/post").vertical).toBe(
      "url",
    );
  });

  it("flags recency-sensitive general queries as news", () => {
    const i = classifyIntent("latest news on AI regulation");
    expect(i.vertical).toBe("news");
    expect(i.needsLive).toBe(true);
  });

  it("treats evergreen questions as general, not live", () => {
    const i = classifyIntent("explain how recursion works");
    expect(i.vertical).toBe("general");
    expect(i.needsLive).toBe(false);
  });

  it("does not misroute a bare crypto mention without price/score intent", () => {
    // "ethereum" alone (no price/latest) shouldn't force the crypto vertical.
    expect(classifyIntent("who created ethereum").vertical).not.toBe("crypto");
  });
});
