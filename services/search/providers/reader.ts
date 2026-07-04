/**
 * Deep-read: fetch the FULL text of a page (not just a snippet) so the model
 * answers from real content. Firecrawl scrape when configured, else the keyless
 * Jina Reader (r.jina.ai). Returns clipped markdown/plaintext, or null.
 *
 * This is the biggest accuracy lever in the pipeline — snippets lag and mislead;
 * the actual page carries the recipe steps, the episode count, the live figure.
 */
const READ_CAP = 6000; // chars fed back per page

export async function deepRead(url: string): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;

  // Prefer Firecrawl (clean markdown) when a key is present.
  if (process.env.FIRECRAWL_API_KEY) {
    try {
      const { extractWithFirecrawl } = await import("./firecrawl");
      const resp = await extractWithFirecrawl(url);
      const text = resp?.results?.[0]?.content?.trim();
      if (text) return clip(text);
    } catch {
      /* fall through to Jina */
    }
  }

  // Keyless fallback: Jina Reader returns clean text for any URL.
  try {
    const fetchFn = (globalThis as any).fetch ?? (await import("node-fetch")).default;
    const res = await fetchFn(`https://r.jina.ai/${url}`, {
      headers: { "X-Return-Format": "text" },
    });
    if (!res.ok) return null;
    const text = (await res.text())?.trim();
    return text ? clip(text) : null;
  } catch (err) {
    console.warn("[reader] deepRead failed:", err);
    return null;
  }
}

function clip(s: string): string {
  return s.length > READ_CAP ? s.slice(0, READ_CAP) + " …[truncated]" : s;
}
