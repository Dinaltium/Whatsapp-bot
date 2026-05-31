import { searchWeb as searchWebService, requiresCurrentInfo, CURRENT_INFO_PATTERNS } from "../services/search/searchService";
import { buildSearchContext } from "../services/search/contextBuilder";

export { requiresCurrentInfo, CURRENT_INFO_PATTERNS };

export async function searchWeb(query: string): Promise<string> {
  try {
    const response = await searchWebService(query);
    if (!response.results.length && !response.answer) return "";
    return buildSearchContext(response, 5);
  } catch {
    return "";
  }
}
