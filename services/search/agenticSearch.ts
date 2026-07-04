/**
 * Agentic search: a bounded Groq tool-calling loop.
 *
 * Instead of always dumping web-search text into the prompt (which lets the
 * model confabulate live scores), we hand the model a set of TOOLS and let it
 * plan: pick a live-data API for scores/prices, fall back to web search for
 * news, extract a URL, refine, then answer — or ABSTAIN if the tools didn't
 * return the fact. Only tools whose providers are configured are offered.
 *
 * Returns null on hard failure so the caller can fall back to the legacy
 * single-shot search path.
 */
import { classifyIntent } from "./intentRouter";
import {
  getCricketScore,
  getFootballScore,
  isCricketConfigured,
  isFootballConfigured,
} from "./providers/sports";
import { getStockQuote, getCryptoPrice, isStockConfigured } from "./providers/finance";
import { searchWeb as searchWebService } from "./searchService";
import { buildSearchContext } from "./contextBuilder";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_ROUNDS = 4;
const TOOL_RESULT_CAP = 3500; // chars per tool result fed back to the model

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
  /** Allow the model to fetch a reference image (only for explicit -img). */
  wantImage?: boolean;
}

const ABSTAIN_RULES = [
  "",
  "TOOL USE RULES:",
  "- You have tools for live data. Use get_cricket_score / get_football_score for match scores, get_stock_quote / get_crypto_price for prices, web_search for news/facts, extract_url for a specific link.",
  "- Prefer a dedicated live-data tool over web_search for scores and prices.",
  "- Ground every fact in tool output. NEVER invent scores, prices, names, dates, or numbers.",
  "- If the tools do not return the requested fact, say plainly that you couldn't fetch it right now — do not guess or fill it in from memory.",
  "- When you have enough, answer concisely and state the time/date the data is from.",
].join("\n");

function toolSpecs(available: Set<string>): any[] {
  const all: Record<string, any> = {
    web_search: {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the live web for news, facts, or recent info. Returns sourced snippets with published dates.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query." },
          },
          required: ["query"],
        },
      },
    },
    extract_url: {
      type: "function",
      function: {
        name: "extract_url",
        description: "Fetch and read the contents of a specific URL.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to read." },
          },
          required: ["url"],
        },
      },
    },
    get_cricket_score: {
      type: "function",
      function: {
        name: "get_cricket_score",
        description:
          "Get current/live cricket match scores. Optionally filter by team or series name.",
        parameters: {
          type: "object",
          properties: {
            team: { type: "string", description: "Team or series filter (optional)." },
          },
        },
      },
    },
    get_football_score: {
      type: "function",
      function: {
        name: "get_football_score",
        description:
          "Get live football (soccer) match scores. Optionally filter by team or league.",
        parameters: {
          type: "object",
          properties: {
            team: { type: "string", description: "Team or league filter (optional)." },
          },
        },
      },
    },
    get_stock_quote: {
      type: "function",
      function: {
        name: "get_stock_quote",
        description: "Get the current quote for a stock ticker symbol (e.g. AAPL).",
        parameters: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "Ticker symbol." },
          },
          required: ["symbol"],
        },
      },
    },
    get_crypto_price: {
      type: "function",
      function: {
        name: "get_crypto_price",
        description:
          "Get the current price and 24h change for a cryptocurrency (e.g. bitcoin, ethereum).",
        parameters: {
          type: "object",
          properties: {
            coin: {
              type: "string",
              description: "Coin id or name, e.g. bitcoin, ethereum, solana.",
            },
          },
          required: ["coin"],
        },
      },
    },
  };
  return [...available].map((n) => all[n]).filter(Boolean);
}

/** Which tools are usable, given configured providers + web search availability. */
function availableTools(): Set<string> {
  const s = new Set<string>();
  if (process.env.TAVILY_API_KEY || process.env.FIRECRAWL_API_KEY) {
    s.add("web_search");
    s.add("extract_url");
  }
  if (isCricketConfigured()) s.add("get_cricket_score");
  if (isFootballConfigured()) s.add("get_football_score");
  if (isStockConfigured()) s.add("get_stock_quote");
  s.add("get_crypto_price"); // CoinGecko is keyless
  return s;
}

export function isAgenticAvailable(): boolean {
  return availableTools().size > 0;
}

function clip(s: string): string {
  return s.length > TOOL_RESULT_CAP ? s.slice(0, TOOL_RESULT_CAP) + " …[truncated]" : s;
}

export async function agenticAnswer(
  opts: AgenticOptions,
): Promise<AgenticAnswer | null> {
  const available = availableTools();
  if (available.size === 0) return null;

  const usedTools: string[] = [];
  const citations: string[] = [];
  let imageUrl: string | undefined;

  // Run one tool call, returning a string result for the model.
  async function runTool(name: string, args: any): Promise<string> {
    usedTools.push(name);
    try {
      if (name === "web_search" || name === "extract_url") {
        const q = String(args?.query || args?.url || opts.query);
        const resp = await searchWebService(q);
        for (const r of resp.results || []) if (r.url) citations.push(r.url);
        if (!imageUrl && Array.isArray(resp.images) && resp.images[0]) {
          imageUrl = resp.images[0];
        }
        if (!resp.results?.length && !resp.answer) return "No results found.";
        return clip(buildSearchContext(resp, 5));
      }
      if (name === "get_cricket_score") {
        return (await getCricketScore(args?.team)) ?? "Cricket data unavailable.";
      }
      if (name === "get_football_score") {
        return (await getFootballScore(args?.team)) ?? "Football data unavailable.";
      }
      if (name === "get_stock_quote") {
        return (await getStockQuote(String(args?.symbol || ""))) ?? "Stock data unavailable.";
      }
      if (name === "get_crypto_price") {
        return (await getCryptoPrice(String(args?.coin || ""))) ?? "Crypto data unavailable.";
      }
      return `Unknown tool: ${name}`;
    } catch (err) {
      return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Nudge the model toward the right first tool for obvious verticals.
  const intent = classifyIntent(opts.query);
  const nudge =
    intent.vertical === "cricket" && available.has("get_cricket_score")
      ? "\nThis looks like a live cricket query — start with get_cricket_score."
      : intent.vertical === "football" && available.has("get_football_score")
        ? "\nThis looks like a live football query — start with get_football_score."
        : intent.vertical === "crypto"
          ? "\nThis looks like a crypto price query — start with get_crypto_price."
          : intent.vertical === "stock" && available.has("get_stock_quote")
            ? "\nThis looks like a stock price query — start with get_stock_quote."
            : "";

  const messages: any[] = [
    { role: "system", content: opts.baseSystemPrompt + ABSTAIN_RULES + nudge },
    ...(opts.history || []).slice(-6),
    { role: "user", content: opts.query },
  ];
  const tools = toolSpecs(available);

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
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result,
          });
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
