import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getCricketScore,
  isCricketConfigured,
  isFootballConfigured,
} from "../../services/search/providers/sports";
import {
  getCryptoPrice,
  getStockQuote,
  isStockConfigured,
} from "../../services/search/providers/finance";

const origFetch = (globalThis as any).fetch;
const origEnv = { ...process.env };

function mockFetch(json: any, ok = true) {
  (globalThis as any).fetch = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => json,
    text: async () => JSON.stringify(json),
  }));
}

afterEach(() => {
  (globalThis as any).fetch = origFetch;
  process.env = { ...origEnv };
  vi.restoreAllMocks();
});

describe("sports providers", () => {
  beforeEach(() => {
    delete process.env.CRICKET_API_KEY;
    delete process.env.FOOTBALL_API_KEY;
  });

  it("cricket returns null when unconfigured", async () => {
    expect(isCricketConfigured()).toBe(false);
    expect(await getCricketScore()).toBeNull();
  });

  it("cricket formats current matches when configured", async () => {
    process.env.CRICKET_API_KEY = "k";
    expect(isCricketConfigured()).toBe(true);
    mockFetch({
      data: [
        {
          name: "India vs England",
          status: "England won by 4 wickets",
          teams: ["India", "England"],
          score: [{ inning: "England", r: 191, w: 6, o: 19 }],
        },
      ],
    });
    const out = await getCricketScore();
    expect(out).toContain("India vs England");
    expect(out).toContain("England won by 4 wickets");
    expect(out).toContain("191/6");
  });

  it("football is unconfigured without a key", () => {
    expect(isFootballConfigured()).toBe(false);
  });
});

describe("finance providers", () => {
  beforeEach(() => {
    delete process.env.FINNHUB_API_KEY;
  });

  it("stock needs a key", async () => {
    expect(isStockConfigured()).toBe(false);
    expect(await getStockQuote("AAPL")).toBeNull();
  });

  it("stock formats a Finnhub quote", async () => {
    process.env.FINNHUB_API_KEY = "k";
    mockFetch({ c: 150.5, d: 2.5, dp: 1.69, h: 152, l: 148 });
    const out = await getStockQuote("AAPL");
    expect(out).toContain("AAPL");
    expect(out).toContain("150.5");
  });

  it("crypto works keyless via CoinGecko", async () => {
    mockFetch({ bitcoin: { usd: 65000, usd_24h_change: -1.23 } });
    const out = await getCryptoPrice("bitcoin");
    expect(out).toContain("bitcoin");
    expect(out).toContain("65000");
    expect(out).toContain("▼");
  });

  it("crypto reports when a coin is not found", async () => {
    mockFetch({});
    expect(await getCryptoPrice("notacoin")).toContain("No price found");
  });
});
