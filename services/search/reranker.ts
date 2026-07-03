import type { SearchResult } from "./searchService";

/**
 * Domain reputation weights. Reranking should prefer results the answer can be
 * trusted from, not just ones whose text overlaps the query. Positive = more
 * trustworthy, negative = user-generated / low-signal for factual questions.
 */
const TRUSTED_DOMAINS: Record<string, number> = {
  "wikipedia.org": 6,
  "britannica.com": 5,
  "reuters.com": 5,
  "apnews.com": 5,
  "bbc.com": 4,
  "bbc.co.uk": 4,
  "nytimes.com": 4,
  "theguardian.com": 4,
  "npr.org": 4,
  "nature.com": 5,
  "github.com": 4,
  "stackoverflow.com": 4,
  "developer.mozilla.org": 5,
  "espncricinfo.com": 5,
  "cricbuzz.com": 4,
  "espn.com": 4,
};

const LOW_TRUST_PATTERNS: RegExp[] = [
  /(^|\.)pinterest\./i,
  /(^|\.)quora\.com$/i,
  /(^|\.)answers\.com$/i,
  /(^|\.)blogspot\./i,
  /(^|\.)medium\.com$/i,
];

/** Reputation score for a result URL's host. 0 when unknown/neutral. */
export function domainTrustScore(url: string | undefined): number {
  if (!url) return 0;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 0;
  }

  // Government / education TLDs are high-trust for factual queries.
  if (/\.gov(\.[a-z]{2})?$/.test(host)) return 6;
  if (/\.edu(\.[a-z]{2})?$/.test(host)) return 5;

  for (const [domain, weight] of Object.entries(TRUSTED_DOMAINS)) {
    if (host === domain || host.endsWith(`.${domain}`)) return weight;
  }

  for (const pattern of LOW_TRUST_PATTERNS) {
    if (pattern.test(host)) return -3;
  }

  return 0;
}

export function rerankResults(
  query: string,
  results: SearchResult[],
): SearchResult[] {
  if (!results.length) return results;
  const queryWords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const queryLower = query.toLowerCase();

  const scored = results.map((r) => {
    let score = r.score || 0;
    const title = (r.title || "").toLowerCase();
    const content = (r.content || "").toLowerCase();

    for (const word of queryWords) {
      if (title.includes(word)) score += 3;
      if (content.includes(word)) score += 1;
    }

    // Phrase match bonus
    if (title.includes(queryLower)) score += 5;
    if (content.includes(queryLower)) score += 2;

    // Source trust bonus/penalty
    score += domainTrustScore(r.url);

    return { ...r, score };
  });

  return scored.sort((a, b) => (b.score || 0) - (a.score || 0));
}
