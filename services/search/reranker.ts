import type { SearchResult } from "./searchService";

export function rerankResults(query: string, results: SearchResult[]): SearchResult[] {
  if (!results.length) return results;
  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

  const scored = results.map((r) => {
    let score = r.score || 0;
    const title = (r.title || "").toLowerCase();
    const content = (r.content || "").toLowerCase();

    for (const word of queryWords) {
      if (title.includes(word)) score += 3;
      if (content.includes(word)) score += 1;
    }

    // Phrase match bonus
    const queryLower = query.toLowerCase();
    if (title.includes(queryLower)) score += 5;
    if (content.includes(queryLower)) score += 2;

    return { ...r, score };
  });

  return scored.sort((a, b) => (b.score || 0) - (a.score || 0));
}
