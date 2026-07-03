/**
 * Outbound secret scrubber.
 *
 * Modeled on the policy `secret_patterns` engine from Agent Defender
 * (C:\Projects\VoidHackJune26 — the "check what the agent does" firewall). That
 * project's core blocks disallowed *tool calls*, which this bot has none of (it
 * does plain chat completions), and its PII redaction masks emails/phones —
 * which the DK24 mentor directory shows on purpose. So the applicable slice for
 * this bot is secret-only scrubbing: ensure the bot can never echo an API key,
 * DB URL, JWT, or token that slipped into a reply or a web-search result.
 */

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "GROQ_KEY", re: /\bgsk_[A-Za-z0-9]{20,}\b/g },
  { name: "OPENAI_KEY", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: "TAVILY_KEY", re: /\btvly-[A-Za-z0-9]{10,}\b/g },
  { name: "FIRECRAWL_KEY", re: /\bfc-[A-Za-z0-9]{10,}\b/g },
  {
    name: "JWT",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  { name: "POSTGRES_URL", re: /\bpostgres(?:ql)?:\/\/\S+/gi },
  { name: "REDIS_URL", re: /\brediss?:\/\/\S+/gi },
  { name: "BEARER", re: /\bBearer\s+[A-Za-z0-9._-]{20,}/gi },
  { name: "AWS_KEY", re: /\bAKIA[0-9A-Z]{16}\b/g },
];

/**
 * Replaces secret-shaped substrings with a labelled placeholder. Returns the
 * scrubbed text and the list of secret types that were found.
 */
export function scrubSecrets(text: string): {
  scrubbed: string;
  hits: string[];
} {
  if (!text) return { scrubbed: text, hits: [] };
  let out = text;
  const hits: string[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(out)) {
      re.lastIndex = 0;
      out = out.replace(re, `[REDACTED:${name}]`);
      hits.push(name);
    }
  }
  return { scrubbed: out, hits };
}
