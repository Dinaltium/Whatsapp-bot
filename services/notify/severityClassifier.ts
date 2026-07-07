/**
 * Classifies how urgently the owner should look at a message the generic
 * auto-responder just handled on their behalf. Cheap/fast model, short output,
 * fails to "medium" (never silently drops a notification, never over-alarms).
 */
const GROQ_MODEL_SCOUT =
  process.env.GROQ_MODEL_SCOUT || "meta-llama/llama-4-scout-17b-16e-instruct";

export type Severity = "low" | "medium" | "high";

export interface SeverityResult {
  severity: Severity;
  reason: string;
}

const CLASSIFY_PROMPT = [
  "Classify how urgently the recipient needs to personally reply to this WhatsApp",
  "message. Respond with STRICT JSON only: {\"severity\":\"low|medium|high\",\"reason\":\"<=8 words\"}.",
  "high = time-sensitive, urgent, emergency, or an explicit ask needing a fast reply.",
  "medium = a real question or request but no urgency (can wait hours/a day).",
  "low = greeting, small talk, spam/promo, or something that can wait indefinitely.",
  "No extra text, no markdown, JSON only.",
].join(" ");

function fallback(reason: string): SeverityResult {
  return { severity: "medium", reason };
}

export async function classifySeverity(
  text: string,
  groqApiKey: string | undefined,
): Promise<SeverityResult> {
  const trimmed = (text || "").trim();
  if (!trimmed) return fallback("empty message");
  if (!groqApiKey) return fallback("classifier unavailable");

  try {
    const fetchFn = (globalThis as any).fetch ?? (await import("node-fetch")).default;
    const res = await fetchFn("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL_SCOUT,
        temperature: 0,
        max_tokens: 60,
        messages: [
          { role: "system", content: CLASSIFY_PROMPT },
          { role: "user", content: trimmed.slice(0, 500) },
        ],
      }),
    });
    if (!res.ok) return fallback("classifier error");

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback("unparseable classification");

    const parsed = JSON.parse(jsonMatch[0]);
    const severity: Severity =
      parsed.severity === "high" || parsed.severity === "low"
        ? parsed.severity
        : "medium";
    const reason = String(parsed.reason || "").slice(0, 80) || "no reason given";
    return { severity, reason };
  } catch {
    return fallback("classification failed");
  }
}
