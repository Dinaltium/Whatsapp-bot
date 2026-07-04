import type { SearchResponse, SearchResult } from "../searchService";

/**
 * Exa neural search (exa.ai), env EXA_API_KEY.
 *
 * Exa's embedding-based index gives strong semantic recall for niche/technical
 * topics (obscure tech, anime, games) that keyword engines miss, and returns
 * page text inline so we get content without a second fetch. One provider in
 * the fan-out — never used alone.
 */
export interface ExaOptions {
  numResults?: number;
  /** Restrict to pages published within this many days (recency). */
  days?: number;
}

export function isExaConfigured(): boolean {
  return !!process.env.EXA_API_KEY;
}

export async function searchWithExa(
  query: string,
  opts: ExaOptions = {},
): Promise<SearchResponse | null> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) return null;
  try {
    const body: Record<string, any> = {
      query,
      numResults: opts.numResults ?? 6,
      type: "auto",
      contents: { text: { maxCharacters: 1200 } },
    };
    if (opts.days && opts.days > 0) {
      const since = new Date(Date.now() - opts.days * 86400000);
      body.startPublishedDate = since.toISOString();
    }

    const fetchFn = (globalThis as any).fetch ?? (await import("node-fetch")).default;
    const res = await fetchFn("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn("[Exa] HTTP", res.status, (await res.text()).slice(0, 160));
      return null;
    }
    const data = await res.json();
    const results: SearchResult[] = (data.results || []).map((r: any) => ({
      title: r.title || r.url || "",
      url: r.url || "",
      content: r.text || r.summary || "",
      score: typeof r.score === "number" ? r.score : undefined,
      publishedDate: r.publishedDate || undefined,
    }));
    return { provider: "tavily", results }; // provider tag reused; results are what matter
  } catch (err) {
    console.warn("[Exa] Search failed:", err);
    return null;
  }
}
