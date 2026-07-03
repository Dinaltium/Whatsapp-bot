import { searchWeb as searchWebService, requiresCurrentInfo, CURRENT_INFO_PATTERNS } from "../services/search/searchService";
import { buildSearchContext } from "../services/search/contextBuilder";

export { requiresCurrentInfo, CURRENT_INFO_PATTERNS };

/** Returns a reference-image URL for a query, or null. Backs the `-img` flag. */
export async function fetchReferenceImage(query: string): Promise<string | null> {
  try {
    const { fetchTavilyImage } = await import("../services/search/providers/tavily");
    return await fetchTavilyImage(query);
  } catch {
    return null;
  }
}

export async function searchWeb(query: string): Promise<string> {
  try {
    const response = await searchWebService(query);
    if (!response.results.length && !response.answer) return "";
    return buildSearchContext(response, 5);
  } catch {
    return "";
  }
}
