/**
 * Live finance providers.
 *
 *   Stocks → Finnhub (finnhub.io), env FINNHUB_API_KEY. Free tier.
 *   Crypto → CoinGecko public API — keyless.
 *
 * Return compact model-ready text, or null when unconfigured / on error.
 */
function fetchFn(): (url: string, init?: any) => Promise<any> {
  return (globalThis as any).fetch;
}

export function isStockConfigured(): boolean {
  return !!process.env.FINNHUB_API_KEY;
}

/** Crypto is always available (CoinGecko needs no key). */
export function isCryptoConfigured(): boolean {
  return true;
}

/** Current quote for a stock symbol via Finnhub, or null. */
export async function getStockQuote(symbol: string): Promise<string | null> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || !symbol) return null;
  const sym = symbol.trim().toUpperCase();
  try {
    const f = fetchFn();
    const res = await f(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`,
    );
    if (!res.ok) return null;
    const d = await res.json();
    // Finnhub: c=current, d=change, dp=percent, h/l=day high/low. c=0 → unknown.
    if (d == null || typeof d.c !== "number" || d.c === 0) {
      return `No quote found for "${sym}".`;
    }
    const arrow = (d.d ?? 0) >= 0 ? "▲" : "▼";
    const pct = typeof d.dp === "number" ? `${d.dp.toFixed(2)}%` : "";
    return `${sym}: $${d.c} ${arrow} ${d.d ?? ""} (${pct}) — day H $${d.h} / L $${d.l}`;
  } catch (err) {
    console.warn("[finance] stock fetch failed:", err);
    return null;
  }
}

/** Current price + 24h change for a CoinGecko coin id (e.g. "bitcoin"), or null. */
export async function getCryptoPrice(coinId: string): Promise<string | null> {
  if (!coinId) return null;
  const id = coinId.trim().toLowerCase();
  try {
    const f = fetchFn();
    const res = await f(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true`,
    );
    if (!res.ok) return null;
    const d = await res.json();
    const row = d?.[id];
    if (!row || typeof row.usd !== "number") {
      return `No price found for "${id}".`;
    }
    const chg = row.usd_24h_change;
    const arrow = (chg ?? 0) >= 0 ? "▲" : "▼";
    const pct = typeof chg === "number" ? `${chg.toFixed(2)}%` : "";
    return `${id}: $${row.usd} ${arrow} ${pct} (24h)`;
  } catch (err) {
    console.warn("[finance] crypto fetch failed:", err);
    return null;
  }
}
