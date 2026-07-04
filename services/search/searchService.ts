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

// (Provider selection is now a parallel fan-out; no per-query engine routing.)

/** Canonical URL key for dedup (drops protocol, www, trailing slash). */
function urlKey(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "")).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Reciprocal Rank Fusion: merge ranked lists from multiple engines so a result
 * ranked well by SEVERAL providers rises to the top. Keyless — no reranker API.
 * Keeps the richest content variant when a URL appears in more than one list.
 */
export function rrfMerge(lists: SearchResult[][], k = 60): SearchResult[] {
  const acc = new Map<string, { r: SearchResult; s: number }>();
  for (const list of lists) {
    list.forEach((r, i) => {
      const key = urlKey(r.url);
      if (!key) return;
      const add = 1 / (k + i + 1);
      const prev = acc.get(key);
      if (prev) {
        prev.s += add;
        if ((r.content?.length || 0) > (prev.r.content?.length || 0)) prev.r = r;
      } else {
        acc.set(key, { r, s: add });
      }
    });
  }
  return [...acc.values()]
    .sort((a, b) => b.s - a.s)
    .map((x) => ({ ...x.r, score: x.s }));
}

/**
 * Multi-provider fan-out search. Fires Exa + Tavily + Firecrawl in PARALLEL,
 * fuses their rankings with RRF, dedups, and reranks by domain trust + query
 * overlap. The union of independent indexes beats any one engine, and no result
 * depends on a single provider being up. A single-URL query is an extraction.
 */
export async function searchWeb(query: string): Promise<SearchResponse> {
  const empty: SearchResponse = { provider: "tavily", results: [] };

  const needsLiveData = RECENCY_SENSITIVE_PATTERNS.some((p) => p.test(query));
  const urlMatch = query.match(/https?:\/\/\S+/i);
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
    // A single-URL request is an extraction, not a search.
    if (urlMatch) {
      const { extractWithFirecrawl } = await import("./providers/firecrawl");
      const extracted = await extractWithFirecrawl(urlMatch[0]);
      if (extracted && extracted.results.length) return extracted;
    }

    const { searchWithTavily } = await import("./providers/tavily");
    const { searchWithExa } = await import("./providers/exa");
    const { searchWithFirecrawl } = await import("./providers/firecrawl");
    const { rerankResults } = await import("./reranker");
    const days = needsLiveData ? 4 : undefined;

    // Fan out — each provider is independent; a failure just yields null.
    const [tav, exa, fc] = await Promise.all([
      searchWithTavily(query, {
        news: needsLiveData,
        days,
        includeImages: true,
      }).catch(() => null),
      searchWithExa(query, { days }).catch(() => null),
      searchWithFirecrawl(query).catch(() => null),
    ]);

    const lists = [tav?.results, exa?.results, fc?.results].filter(
      (l): l is SearchResult[] => Array.isArray(l) && l.length > 0,
    );
    const providersHit = [
      tav?.results?.length ? "tavily" : null,
      exa?.results?.length ? "exa" : null,
      fc?.results?.length ? "firecrawl" : null,
    ].filter(Boolean);
    console.info(`[SearchService] fan-out hit: [${providersHit.join(", ") || "none"}]`);

    const fused = rrfMerge(lists);
    const reranked = rerankResults(query, fused).slice(0, 8);
    const answer = tav?.answer;
    const images = tav?.images;

    if (reranked.length || answer) {
      const result: SearchResponse = {
        provider: "tavily",
        answer,
        results: reranked,
        images,
      };
      if (cacheable) {
        try {
          const { redis } = await import("../../storage/redisClient");
          await redis.setex(cacheKey, SEARCH_CACHE_TTL_SEC, JSON.stringify(result));
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
