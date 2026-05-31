export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface SearchResponse {
  provider: "firecrawl" | "tavily";
  answer?: string;
  results: SearchResult[];
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
];

export function requiresCurrentInfo(prompt: string): boolean {
  return CURRENT_INFO_PATTERNS.some((p) => p.test(prompt));
}

function preferFirecrawl(prompt: string): boolean {
  return FIRECRAWL_PATTERNS.some((p) => p.test(prompt));
}

export async function searchWeb(query: string): Promise<SearchResponse> {
  const empty: SearchResponse = { provider: "tavily", results: [] };
  try {
    const { rerankResults } = await import("./reranker");

    const urlMatch = query.match(/https?:\\/\\/\\S+/i);
    let result: SearchResponse | null = null;
    
    if (urlMatch) {
      const { extractWithFirecrawl } = await import("./providers/firecrawl");
      result = await extractWithFirecrawl(urlMatch[0]);
    } else if (preferFirecrawl(query)) {
      const { searchWithFirecrawl } = await import("./providers/firecrawl");
      result = await searchWithFirecrawl(query);
    } else {
      const { searchWithTavily } = await import("./providers/tavily");
      result = await searchWithTavily(query);
      if (!result || !result.results || result.results.length === 0) {
        console.info(`[SearchService] Tavily returned no results, falling back to Firecrawl.`);
        const { searchWithFirecrawl } = await import("./providers/firecrawl");
        result = await searchWithFirecrawl(query);
      }
    }
    
    if (result && result.results && result.results.length > 0) {
      result.results = rerankResults(query, result.results);
      return result;
    }
  } catch (err) {
    console.warn("[SearchService] searchWeb failed:", err);
    return empty;
  }
}
