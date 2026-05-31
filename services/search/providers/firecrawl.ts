import type { SearchResponse } from "../searchService";

export async function searchWithFirecrawl(query: string): Promise<SearchResponse | null> {
  try {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) return null;

    const fetchFn = (globalThis as any).fetch ?? (await import("node-fetch")).default;
    const res = await fetchFn("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        limit: 5,
        scrapeOptions: { formats: ["markdown"] },
      }),
    });

    if (res.status === 402 || res.status === 429 || res.status >= 500) {
      console.warn(`[Firecrawl] Unavailable (${res.status}), falling back to Tavily`);
      return null;
    }
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.success) return null;

    const results = (data.data || []).map((r: any) => ({
      title: r.metadata?.title || r.url || "",
      url: r.url || "",
      content: r.markdown || r.metadata?.description || "",
      score: undefined,
    }));

    return { provider: "firecrawl", results };
  } catch (err) {
    console.warn("[Firecrawl] Search failed:", err);
    return null;
  }
}

export async function extractWithFirecrawl(url: string): Promise<SearchResponse | null> {
  try {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) return null;

    const fetchFn = (globalThis as any).fetch ?? (await import("node-fetch")).default;
    const res = await fetchFn("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });

    if (res.status === 402 || res.status === 429 || res.status >= 500) return null;
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.success) return null;

    return {
      provider: "firecrawl",
      results: [{
        title: data.data?.metadata?.title || url,
        url,
        content: data.data?.markdown || "",
      }],
    };
  } catch (err) {
    console.warn("[Firecrawl] Extract failed:", err);
    return null;
  }
}
