/**
 * Agentic search: a bounded Groq tool-calling loop over a GENERAL, provider-
 * agnostic toolset — no per-domain APIs. The model rewrites the query (by
 * choosing the search terms), reads fused multi-provider results plus the FULL
 * text of the top page, can read another page or search again if unsatisfied,
 * then answers grounded + cited, or ABSTAINS. Works for any topic: sports,
 * anime, games, recipes, tech, whatever.
 *
 * Tools:
 *   web_search(query) — Exa + Tavily + Firecrawl fan-out, RRF-fused, and the
 *                       top result's full page auto-read in for grounding.
 *   read_page(url)    — deep-read a specific URL's full text.
 *
 * Returns null on hard failure so callers fall back to the legacy path.
 */
import { searchWeb as searchWebService } from "./searchService";
import { buildSearchContext } from "./contextBuilder";
import { deepRead } from "./providers/reader";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_ROUNDS = 4;
const TOOL_RESULT_CAP = 6000; // chars per tool result fed back to the model

export interface AgenticAnswer {
  answer: string;
  usedTools: string[];
  citations: string[];
  imageUrl?: string;
}

export interface AgenticOptions {
  query: string;
  groqApiKey: string;
  model: string;
  /** Base system prompt (persona + current date). Tool/abstain rules appended. */
  baseSystemPrompt: string;
  history?: { role: "user" | "assistant"; content: string }[];
  /** Allow returning a reference image the search surfaced (only for -img). */
  wantImage?: boolean;
}

const TOOL_RULES = [
  "",
  "SEARCH RULES:",
  "- Use web_search for anything you don't reliably know or that could have changed (news, scores, releases, prices, facts). Choose sharp search terms; add the year/date when recency matters.",
  "- web_search returns fused results from multiple engines plus the full text of the top page. If that isn't enough, call read_page on the most relevant URL, or search again with better terms.",
  "- Ground every fact in tool output. NEVER invent scores, prices, names, dates, or numbers.",
  "- If the tools don't contain the answer, say plainly you couldn't find it right now — do not guess or fill from memory.",
  "- Answer concisely. State the date/source the data is from. At most one short caveat.",
].join("\n");

function toolSpecs(): any[] {
  return [
    {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the live web (multiple engines fused) for news, facts, or recent info. Returns sourced snippets with dates plus the full text of the top result.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query." },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_page",
        description: "Fetch and read the full text of a specific URL.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to read." },
          },
          required: ["url"],
        },
      },
    },
  ];
}

/** True when at least one search backend is configured. */
export function isAgenticAvailable(): boolean {
  return !!(
    process.env.TAVILY_API_KEY ||
    process.env.FIRECRAWL_API_KEY ||
    process.env.EXA_API_KEY
  );
}

function clip(s: string): string {
  return s.length > TOOL_RESULT_CAP ? s.slice(0, TOOL_RESULT_CAP) + " …[truncated]" : s;
}

export async function agenticAnswer(
  opts: AgenticOptions,
): Promise<AgenticAnswer | null> {
  if (!isAgenticAvailable()) return null;

  const usedTools: string[] = [];
  const citations: string[] = [];
  let imageUrl: string | undefined;

  async function runTool(name: string, args: any): Promise<string> {
    usedTools.push(name);
    try {
      if (name === "web_search") {
        const q = String(args?.query || opts.query);
        const resp = await searchWebService(q);
        for (const r of resp.results || []) if (r.url) citations.push(r.url);
        if (!imageUrl && Array.isArray(resp.images) && resp.images[0]) {
          imageUrl = resp.images[0];
        }
        if (!resp.results?.length && !resp.answer) return "No results found.";

        let ctx = buildSearchContext(resp, 5);
        // Auto-read the top result's full page — the accuracy multiplier.
        const topUrl = resp.results?.[0]?.url;
        if (topUrl) {
          const full = await deepRead(topUrl);
          if (full) ctx += `\n\n[Full text of top result — ${topUrl}]\n${full}`;
        }
        return clip(ctx);
      }
      if (name === "read_page") {
        const url = String(args?.url || "");
        if (url) citations.push(url);
        const full = await deepRead(url);
        return full ? clip(`[Full text — ${url}]\n${full}`) : "Could not read that page.";
      }
      return `Unknown tool: ${name}`;
    } catch (err) {
      return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const messages: any[] = [
    { role: "system", content: opts.baseSystemPrompt + TOOL_RULES },
    ...(opts.history || []).slice(-6),
    { role: "user", content: opts.query },
  ];
  const tools = toolSpecs();

  async function callGroq(forceNoTools: boolean): Promise<any> {
    const f = (globalThis as any).fetch ?? (await import("node-fetch")).default;
    const res = await f(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.groqApiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0.3,
        messages,
        ...(forceNoTools ? {} : { tools, tool_choice: "auto" }),
      }),
    });
    if (!res.ok) {
      throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const data = await callGroq(false);
      const msg = data?.choices?.[0]?.message;
      if (!msg) return null;

      const calls = msg.tool_calls;
      if (Array.isArray(calls) && calls.length > 0) {
        messages.push(msg); // echo assistant turn (with tool_calls)
        for (const tc of calls) {
          let parsed: any = {};
          try {
            parsed = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            /* leave empty on malformed args */
          }
          const result = await runTool(tc.function?.name || "", parsed);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
        continue;
      }

      const answer = (msg.content || "").trim();
      if (answer) {
        return {
          answer,
          usedTools,
          citations: [...new Set(citations)],
          imageUrl: opts.wantImage ? imageUrl : undefined,
        };
      }
    }

    // Rounds exhausted → force a final tool-free answer from gathered context.
    const finalData = await callGroq(true);
    const finalMsg = (finalData?.choices?.[0]?.message?.content || "").trim();
    if (!finalMsg) return null;
    return {
      answer: finalMsg,
      usedTools,
      citations: [...new Set(citations)],
      imageUrl: opts.wantImage ? imageUrl : undefined,
    };
  } catch (err) {
    console.warn("[agenticSearch] failed, caller should fall back:", err);
    return null;
  }
}
