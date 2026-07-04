import type { SearchResponse } from "./searchService";

export function buildSearchContext(response: SearchResponse, maxResults = 5): string {
  const lines: string[] = [];
  lines.push(`[Search Provider]\n${response.provider.charAt(0).toUpperCase() + response.provider.slice(1)}`);

  if (response.answer) {
    lines.push(`\n[Direct Answer]\n${response.answer}`);
  }

  const limited = response.results.slice(0, maxResults);
  limited.forEach((r, i) => {
    lines.push(`\n[Result ${i + 1}]`);
    lines.push(`Title: ${r.title}`);
    lines.push(`URL: ${r.url}`);
    if (r.publishedDate) lines.push(`Published: ${r.publishedDate}`);
    lines.push(`Content: ${r.content.slice(0, 600)}`);
  });

  return lines.join("\n");
}
