import type { SearchResponse } from "../searchService";

/**
 * Returns the top reference-image URL for a query via Tavily's image search,
 * or null if unavailable. Used by the SELF `-img` flag.
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
        max_results: 3,
        include_images: true,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const images = data.images;
    if (Array.isArray(images) && images.length > 0) {
      const first = images[0];
      const url = typeof first === "string" ? first : first?.url;
      return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
    }
    return null;
  } catch (err) {
    console.warn("[Tavily] Image search failed:", err);
    return null;
  }
}

export async function searchWithTavily(query: string): Promise<SearchResponse> {
  const empty: SearchResponse = { provider: "tavily", results: [] };
  try {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return empty;

    const fetchFn = (globalThis as any).fetch ?? (await import("node-fetch")).default;
    const res = await fetchFn("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "advanced",
        max_results: 5,
        include_answer: true,
      }),
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
    }));

    return {
      provider: "tavily",
      answer: data.answer || undefined,
      results,
    };
  } catch (err) {
    console.warn("[Tavily] Search failed:", err);
    return empty;
  }
}
