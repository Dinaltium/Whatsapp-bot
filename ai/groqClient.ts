export class GroqRateLimitError extends Error {
  constructor() {
    super("Groq API rate limited (429)");
    this.name = "GroqRateLimitError";
  }
}
export class GroqServerError extends Error {
  constructor(status: number) {
    super(`Groq server error (${status})`);
    this.name = "GroqServerError";
  }
}
export class GroqKeyMissingError extends Error {
  constructor() {
    super("Groq API key missing");
    this.name = "GroqKeyMissingError";
  }
}

import Groq from "groq-sdk";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export type GroqMessageParam = {
  role: "user" | "assistant";
  content: string;
};

// Emergency-only fallback model, used solely when the primary model is
// rate-limited (429) or hits a server error (5xx). Kept rare by design.
const GROQ_MODEL_SCOUT =
  process.env.GROQ_MODEL_SCOUT || "meta-llama/llama-4-scout-17b-16e-instruct";

async function callGroqOnce(
  model: string,
  groqApiKey: string,
  client: Groq,
  messages: GroqMessageParam[],
  systemPrompt: string,
): Promise<string> {
  if ((client as any)?.messages?.create) {
    const response = (await (client as any).messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    })) as any;

    const aiText = response?.content?.[0];
    if (!aiText || aiText.type !== "text") {
      throw new Error("Unexpected response type from Groq SDK");
    }
    const trimmedText = aiText.text?.trim();
    if (!trimmedText) throw new Error("Groq returned an empty response.");
    return trimmedText;
  }

  const fetchFn = (globalThis as any).fetch ?? (await import("node-fetch")).default;
  const res = await fetchFn("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
    }),
  });

  if (!res.ok) {
    if (res.status === 429) throw new GroqRateLimitError();
    if (res.status >= 500) throw new GroqServerError(res.status);
    const errorBody = await res.text();
    throw new Error(`Groq API ${res.status}: ${errorBody}`);
  }

  const data = await res.json();
  const aiText = data?.choices?.[0]?.message?.content?.trim();
  if (!aiText) throw new Error("Groq returned an empty response.");
  return aiText;
}

export async function getGroqReply(
  conversationMessages: ConversationMessage[],
  groqApiKey: string | undefined,
  groqModel: string,
  systemPrompt: string,
): Promise<string> {
  if (!groqApiKey) {
    throw new GroqKeyMissingError();
  }

  const client = new Groq({ apiKey: groqApiKey });
  const messages: GroqMessageParam[] = conversationMessages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

  try {
    return await callGroqOnce(groqModel, groqApiKey, client, messages, systemPrompt);
  } catch (error) {
    // Emergency fallback: only for transient failures (rate limit / 5xx), and
    // only when the scout model actually differs from the one that just failed.
    const isTransient =
      error instanceof GroqRateLimitError || error instanceof GroqServerError;
    if (isTransient && GROQ_MODEL_SCOUT && GROQ_MODEL_SCOUT !== groqModel) {
      console.warn(
        `[Groq] Primary model "${groqModel}" failed (${(error as Error).name}); retrying once with scout model "${GROQ_MODEL_SCOUT}".`,
      );
      try {
        return await callGroqOnce(
          GROQ_MODEL_SCOUT,
          groqApiKey,
          client,
          messages,
          systemPrompt,
        );
      } catch (fallbackErr) {
        const m =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        throw new Error(`Groq API error (primary + scout failed): ${m}`);
      }
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Groq API error: ${errorMessage}`);
  }
}
