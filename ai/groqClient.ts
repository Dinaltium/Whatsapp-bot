import Groq from "groq-sdk";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export type GroqMessageParam = {
  role: "user" | "assistant";
  content: string;
};

export async function getGroqReply(
  conversationMessages: ConversationMessage[],
  groqApiKey: string | undefined,
  groqModel: string,
  systemPrompt: string,
): Promise<string> {
  if (!groqApiKey) {
    return "Groq key missing. Set GROQ_API_KEY in your environment to enable AI replies.";
  }

  const client = new Groq({
    apiKey: groqApiKey,
  });

  const messages: GroqMessageParam[] = conversationMessages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

  try {
    if ((client as any)?.messages?.create) {
      const response = (await (client as any).messages.create({
        model: groqModel,
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages,
      })) as any;

      const aiText = response?.content?.[0];
      if (!aiText || aiText.type !== "text") {
        throw new Error("Unexpected response type from Groq SDK");
      }

      const trimmedText = aiText.text?.trim();
      if (!trimmedText) throw new Error("Groq returned an empty response.");
      return trimmedText;
    } else {
      const fetchFn =
        (globalThis as any).fetch ?? (await import("node-fetch")).default;
      const res = await fetchFn(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${groqApiKey}`,
          },
          body: JSON.stringify({
            model: groqModel,
            temperature: 0.4,
            messages: [{ role: "system", content: systemPrompt }, ...messages],
          }),
        },
      );

      if (!res.ok) {
        const errorBody = await res.text();
        throw new Error(`Groq API ${res.status}: ${errorBody}`);
      }

      const data = await res.json();
      const aiText = data?.choices?.[0]?.message?.content?.trim();
      if (!aiText) throw new Error("Groq returned an empty response.");
      return aiText;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Groq API error: ${errorMessage}`);
  }
}
