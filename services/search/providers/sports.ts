/**
 * Live sports score providers (env-gated).
 *
 *   Cricket  → CricAPI (cricapi.com), env CRICKET_API_KEY. Free ~100 req/day.
 *   Football → API-FOOTBALL (api-sports.io), env FOOTBALL_API_KEY. Free 100/day.
 *
 * Each returns a compact, model-ready text block of live/current matches, or
 * null when unconfigured or on any error. Structured data in → no hallucinated
 * scores out. These are what web search cannot do reliably.
 */
function fetchFn(): (url: string, init?: any) => Promise<any> {
  return (globalThis as any).fetch;
}

export function isCricketConfigured(): boolean {
  return !!process.env.CRICKET_API_KEY;
}

export function isFootballConfigured(): boolean {
  return !!process.env.FOOTBALL_API_KEY;
}

/**
 * Returns current/live cricket matches with scores. `filter` (e.g. a team or
 * series name) narrows the list when provided.
 */
export async function getCricketScore(filter?: string): Promise<string | null> {
  const key = process.env.CRICKET_API_KEY;
  if (!key) return null;
  try {
    const f = fetchFn();
    const res = await f(
      `https://api.cricapi.com/v1/currentMatches?apikey=${encodeURIComponent(key)}&offset=0`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    let matches: any[] = Array.isArray(data?.data) ? data.data : [];
    if (!matches.length) return "No current cricket matches are listed right now.";

    if (filter && filter.trim()) {
      const needle = filter.trim().toLowerCase();
      const narrowed = matches.filter(
        (m) =>
          String(m.name || "").toLowerCase().includes(needle) ||
          (Array.isArray(m.teams) &&
            m.teams.some((t: string) => t.toLowerCase().includes(needle))),
      );
      if (narrowed.length) matches = narrowed;
    }

    const lines = matches.slice(0, 6).map((m) => {
      const name = m.name || "Match";
      const status = m.status || "";
      const scores = Array.isArray(m.score)
        ? m.score
            .map(
              (s: any) =>
                `${s.inning || ""}: ${s.r ?? "?"}/${s.w ?? "?"} (${s.o ?? "?"} ov)`,
            )
            .join(" | ")
        : "";
      return `- ${name}\n  ${status}${scores ? `\n  ${scores}` : ""}`;
    });
    return `Live/current cricket (CricAPI):\n${lines.join("\n")}`;
  } catch (err) {
    console.warn("[sports] cricket fetch failed:", err);
    return null;
  }
}

/** Returns live football fixtures with scores; `filter` narrows by team/league. */
export async function getFootballScore(filter?: string): Promise<string | null> {
  const key = process.env.FOOTBALL_API_KEY;
  if (!key) return null;
  try {
    const f = fetchFn();
    const res = await f("https://v3.football.api-sports.io/fixtures?live=all", {
      headers: { "x-apisports-key": key },
    });
    if (!res.ok) return null;
    const data = await res.json();
    let fixtures: any[] = Array.isArray(data?.response) ? data.response : [];
    if (!fixtures.length) return "No live football matches right now.";

    if (filter && filter.trim()) {
      const needle = filter.trim().toLowerCase();
      const narrowed = fixtures.filter((fx) => {
        const home = fx.teams?.home?.name?.toLowerCase() || "";
        const away = fx.teams?.away?.name?.toLowerCase() || "";
        const league = fx.league?.name?.toLowerCase() || "";
        return (
          home.includes(needle) ||
          away.includes(needle) ||
          league.includes(needle)
        );
      });
      if (narrowed.length) fixtures = narrowed;
    }

    const lines = fixtures.slice(0, 8).map((fx) => {
      const home = fx.teams?.home?.name || "Home";
      const away = fx.teams?.away?.name || "Away";
      const gh = fx.goals?.home ?? 0;
      const ga = fx.goals?.away ?? 0;
      const elapsed = fx.fixture?.status?.elapsed;
      const league = fx.league?.name || "";
      return `- ${home} ${gh}-${ga} ${away}${elapsed ? ` (${elapsed}')` : ""}${league ? ` — ${league}` : ""}`;
    });
    return `Live football (API-FOOTBALL):\n${lines.join("\n")}`;
  } catch (err) {
    console.warn("[sports] football fetch failed:", err);
    return null;
  }
}
