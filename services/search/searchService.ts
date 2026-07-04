import crypto from "crypto";

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  publishedDate?: string;
}

export interface SearchResponse {
  provider: "firecrawl" | "tavily";
  answer?: string;
  results: SearchResult[];
  images?: string[];
}

// Patterns that indicate URL-based or document extraction needs (use Firecrawl)
const FIRECRAWL_PATTERNS = [
  /https?:\/\//i,
  /summarize\s+(this\s+)?(website|page|url|link|article)/i,
  /read\s+this\s+(page|url|link|article)/i,
  /extract\s+(content|text|info)/i,
  /documentation\s+analysis/i,
];

// Patterns that indicate current info needs (use Tavily)
export const CURRENT_INFO_PATTERNS = [
  /\bcurrent\b/i,
  /\blatest\b/i,
  /\brecent\b/i,
  /\btoday\b/i,
  /\bnow\b/i,
  /\bnews\b/i,
  /\bprice\b/i,
  /\bstock\b/i,
  /\bmarket\b/i,
  /\brelease\b/i,
  /\bupdate\b/i,
  /\bversion\b/i,
  /\bwho is\b/i,
  /\bwho's\b/i,
  /\bwhat happened\b/i,
  /\bis .* still\b/i,
  /\b2025\b/i,
  /\b2026\b/i,
  /\b2027\b/i,
  /\bscore\b/i,
  /\blive\b/i,
  /\branking(s)?\b/i,
  /\bstandings\b/i,
  /\bpoints table\b/i,
  /\bmatch\b/i,
];

// Patterns that require absolute latest live data
export const RECENCY_SENSITIVE_PATTERNS = [
  /\blatest\b/i,
  /\bcurrent\b/i,
  /\bnewest\b/i,
  /\bjust released\b/i,
  /\bthis week\b/i,
  /\blive\b/i,
  /\bscore\b/i,
  /\bmatch\b/i,
  /\bpoints table\b/i,
  /\bstandings\b/i,
];

export function requiresCurrentInfo(prompt: string): boolean {
  return CURRENT_INFO_PATTERNS.some((p) => p.test(prompt));
}

// Cache results for repeat questions to cut API cost + latency. Recency-
// sensitive queries (live scores, "latest", etc.) are never cached so they
// stay fresh. Env-tunable TTL.
const SEARCH_CACHE_TTL_SEC =
  Number(process.env.SEARCH_CACHE_TTL_SEC) || 6 * 60 * 60;

export function searchCacheKey(query: string): string {
  const norm = query.trim().toLowerCase().replace(/\s+/g, " ");
  return `websearch:${crypto.createHash("sha1").update(norm).digest("hex")}`;
}

function preferFirecrawl(prompt: string): boolean {
  return FIRECRAWL_PATTERNS.some((p) => p.test(prompt));
}

export async function searchWeb(query: string): Promise<SearchResponse> {
  const empty: SearchResponse = { provider: "tavily", results: [] };

  const needsLiveData = RECENCY_SENSITIVE_PATTERNS.some((p) => p.test(query));
  const urlMatch = query.match(/https?:\/\/\S+/i);
  // Recency-sensitive or single-URL extraction requests are always fetched
  // live; everything else is cacheable.
  const cacheable = !needsLiveData && !urlMatch;
  const cacheKey = searchCacheKey(query);

  if (cacheable) {
    try {
      const { redis } = await import("../../storage/redisClient");
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.info("[SearchService] cache hit for query");
        return JSON.parse(cached) as SearchResponse;
      }
    } catch {
      /* fail open — never block search on Redis error */
    }
  }

  try {
    const { rerankResults } = await import("./reranker");

    let result: SearchResponse | null = null;

    if (urlMatch) {
      const { extractWithFirecrawl } = await import("./providers/firecrawl");
      result = await extractWithFirecrawl(urlMatch[0]);
    } else if (needsLiveData) {
      // Live/recent info (scores, "latest", news) — use Tavily's news topic
      // with a short recency window so results are same-week, not stale pages.
      console.info(`[SearchService] Recency-sensitive query — using Tavily news topic.`);
      const { searchWithTavily } = await import("./providers/tavily");
      result = await searchWithTavily(query, {
        news: true,
        days: 3,
        includeImages: true,
      });
      if (!result || !result.results || result.results.length === 0) {
        console.info(`[SearchService] Tavily news empty, falling back to general Tavily.`);
        result = await searchWithTavily(query, { includeImages: true });
      }
    } else if (preferFirecrawl(query)) {
      console.info(`[SearchService] Extraction query — using Firecrawl.`);
      const { searchWithFirecrawl } = await import("./providers/firecrawl");
      result = await searchWithFirecrawl(query);
      if (!result || !result.results || result.results.length === 0) {
        const { searchWithTavily } = await import("./providers/tavily");
        result = await searchWithTavily(query, { includeImages: true });
      }
    } else {
      console.info(`[SearchService] Using Tavily for general knowledge search.`);
      const { searchWithTavily } = await import("./providers/tavily");
      result = await searchWithTavily(query, { includeImages: true });
      if (!result || !result.results || result.results.length === 0) {
        console.info(`[SearchService] Tavily returned no results, falling back to Firecrawl.`);
        const { searchWithFirecrawl } = await import("./providers/firecrawl");
        result = await searchWithFirecrawl(query);
      }
    }
    
    if (result && result.results && result.results.length > 0) {
      result.results = rerankResults(query, result.results);
      if (cacheable) {
        try {
          const { redis } = await import("../../storage/redisClient");
          await redis.setex(
            cacheKey,
            SEARCH_CACHE_TTL_SEC,
            JSON.stringify(result),
          );
        } catch {
          /* fail open — caching is best-effort */
        }
      }
      return result;
    }
    return empty;
  } catch (err) {
    console.warn("[SearchService] searchWeb failed:", err);
    return empty;
  }
}
