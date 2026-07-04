import type { SearchResponse } from "../searchService";

export interface TavilyOptions {
  /** Use the news topic (fresher, source-dated) instead of general search. */
  news?: boolean;
  /** For the news topic, how many days back to look. */
  days?: number;
  includeImages?: boolean;
}

// Domains whose images are ads / betting / low-value — never used for -img.
const IMAGE_DOMAIN_BLOCKLIST = [
  "bet365",
  "betting",
  "casino",
  "gambl",
  "1xbet",
  "parimatch",
  "dafabet",
  "doubleclick",
  "googlesyndication",
  "adservice",
  "/ads/",
  "sponsor",
];

function isJunkImageUrl(url: string): boolean {
  const u = url.toLowerCase();
  return IMAGE_DOMAIN_BLOCKLIST.some((bad) => u.includes(bad));
}

/**
 * Returns the top reference-image URL for a query via Tavily image search,
 * skipping ad/betting/junk domains. Null if none suitable.
 */
export async function fetchTavilyImage(query: string): Promise<string | null> {
  try {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return null;

    const fetchFn = (globalThis as any).fetch ?? (await import("node-fetch")).default;
    const res = await fetchFn("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: 5,
        include_images: true,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const images: any[] = Array.isArray(data.images) ? data.images : [];
    for (const img of images) {
      const url = typeof img === "string" ? img : img?.url;
      if (
        typeof url === "string" &&
        /^https?:\/\//i.test(url) &&
        !isJunkImageUrl(url)
      ) {
        return url;
      }
    }
    return null;
  } catch (err) {
    console.warn("[Tavily] Image search failed:", err);
    return null;
  }
}

export async function searchWithTavily(
  query: string,
  opts: TavilyOptions = {},
): Promise<SearchResponse> {
  const empty: SearchResponse = { provider: "tavily", results: [] };
  try {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return empty;

    const body: Record<string, any> = {
      api_key: apiKey,
      query,
      search_depth: "advanced",
      max_results: opts.news ? 8 : 5,
      include_answer: "advanced",
    };
    if (opts.news) {
      body.topic = "news";
      body.days = opts.days ?? 3;
    }
    if (opts.includeImages) {
      body.include_images = true;
    }

    const fetchFn = (globalThis as any).fetch ?? (await import("node-fetch")).default;
    const res = await fetchFn("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error("[Tavily] HTTP Error:", res.status, await res.text());
      return empty;
    }
    const data = await res.json();

    const results = (data.results || []).map((r: any) => ({
      title: r.title || "",
      url: r.url || "",
      content: r.content || r.snippet || "",
      score: r.score,
      publishedDate: r.published_date || undefined,
    }));

    const images = Array.isArray(data.images)
      ? data.images
          .map((i: any) => (typeof i === "string" ? i : i?.url))
          .filter(
            (u: any) => typeof u === "string" && !isJunkImageUrl(u),
          )
      : undefined;

    return {
      provider: "tavily",
      answer: data.answer || undefined,
      results,
      images,
    };
  } catch (err) {
    console.warn("[Tavily] Search failed:", err);
    return empty;
  }
}
