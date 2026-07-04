/**
 * Lightweight query-intent classifier for the agentic search layer.
 *
 * It does NOT answer anything — it decides which structured tools are worth
 * offering the model (live scores, prices) and whether a query needs live data
 * at all. The model still makes the final tool choice; this just narrows the
 * toolset and nudges it, so a "cricket score" query reaches a cricket API
 * instead of a generic news page.
 */
export type SearchVertical =
  | "cricket"
  | "football"
  | "crypto"
  | "stock"
  | "weather"
  | "url"
  | "news"
  | "general";

export interface QueryIntent {
  vertical: SearchVertical;
  /** True when the query wants fresh/live data (route through search/tools). */
  needsLive: boolean;
  /** A ticker symbol / coin id / team hint extracted from the query, if any. */
  hint?: string;
}

const CRICKET = /\b(cricket|test match|odi|t20|t20i|ipl|bbl|psl|wicket|batting|bowling|scorecard|innings|run rate|ind\s*vs|vs\s*(ind|eng|aus|pak|sl|nz|sa|wi|ban)|world cup)\b/i;
const FOOTBALL = /\b(football|soccer|premier league|epl|la\s?liga|serie a|bundesliga|ucl|champions league|world cup|fifa|matchday|fixture|kick[- ]?off|goal|full[- ]?time)\b/i;
const CRYPTO = /\b(bitcoin|btc|ethereum|eth|solana|sol|dogecoin|doge|crypto|altcoin|binance coin|bnb|ripple|xrp|cardano|ada)\b/i;
const STOCK = /\b(stock|share price|shares|nasdaq|nyse|sensex|nifty|ticker|market cap|\$[A-Z]{1,5}\b)\b/i;
const WEATHER = /\b(weather|temperature|forecast|humidity|rain|snow|climate today)\b/i;
const PRICEY = /\b(price|worth|value|quote|rate|how much)\b/i;
const SCOREY = /\b(score|live|result|won|winning|latest|current|now|today|standings|points table|ranking)\b/i;

// Recency words that mean "go to the live web", independent of vertical.
const RECENCY = /\b(latest|current|now|today|recent|live|news|breaking|this week|right now|score|update|released?|version)\b/i;
const YEARS = /\b(202[4-9]|20[3-9]\d)\b/;

/** Extracts a `$TICKER` or bare uppercase ticker hint from a stock query. */
function stockHint(q: string): string | undefined {
  const dollar = q.match(/\$([A-Za-z]{1,5})\b/);
  if (dollar) return dollar[1].toUpperCase();
  const bare = q.match(/\b([A-Z]{2,5})\b/);
  return bare ? bare[1] : undefined;
}

const CRYPTO_IDS: Record<string, string> = {
  bitcoin: "bitcoin",
  btc: "bitcoin",
  ethereum: "ethereum",
  eth: "ethereum",
  solana: "solana",
  sol: "solana",
  dogecoin: "dogecoin",
  doge: "dogecoin",
  bnb: "binancecoin",
  "binance coin": "binancecoin",
  ripple: "ripple",
  xrp: "ripple",
  cardano: "cardano",
  ada: "cardano",
};

function cryptoHint(q: string): string | undefined {
  const lower = q.toLowerCase();
  for (const [k, id] of Object.entries(CRYPTO_IDS)) {
    if (new RegExp(`\\b${k}\\b`, "i").test(lower)) return id;
  }
  return undefined;
}

export function classifyIntent(query: string): QueryIntent {
  const q = (query || "").trim();

  if (/https?:\/\/\S+/i.test(q)) {
    return { vertical: "url", needsLive: true };
  }
  if (CRICKET.test(q)) {
    return { vertical: "cricket", needsLive: true };
  }
  if (FOOTBALL.test(q)) {
    return { vertical: "football", needsLive: true };
  }
  if (CRYPTO.test(q) && (PRICEY.test(q) || SCOREY.test(q))) {
    return { vertical: "crypto", needsLive: true, hint: cryptoHint(q) };
  }
  if (STOCK.test(q) && (PRICEY.test(q) || SCOREY.test(q))) {
    return { vertical: "stock", needsLive: true, hint: stockHint(q) };
  }
  if (WEATHER.test(q)) {
    // No dedicated weather provider yet → live web search handles it.
    return { vertical: "weather", needsLive: true };
  }

  const needsLive = RECENCY.test(q) || YEARS.test(q);
  return { vertical: needsLive ? "news" : "general", needsLive };
}
