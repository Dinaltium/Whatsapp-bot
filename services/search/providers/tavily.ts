import type { SearchResponse } from "../searchService";

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
