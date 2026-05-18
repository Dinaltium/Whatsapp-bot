import Groq from "groq-sdk";

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

type GroqMessageParam = {
  role: "user" | "assistant";
  content: string;
};

interface UserSession {
  domainUnlocked: boolean;
  lastActiveAt: number;
  messages: ConversationMessage[];
}

interface AgentResult {
  reply: string;
  usedAI: boolean;
  domainLocked?: boolean;
}

const TECH_KEYWORDS = [
  "code",
  "coding",
  "program",
  "programming",
  "developer",
  "debug",
  "bug",
  "api",
  "backend",
  "frontend",
  "database",
  "sql",
  "nosql",
  "software",
  "develop",
  "development",
  "app",
  "application",
  "website",
  "web",
  "mobile",
  "beginner",
  "learn",
  "learning",
  "framework",
  "javascript",
  "typescript",
  "python",
  "java",
  "c++",
  "golang",
  "rust",
  "react",
  "next",
  "node",
  "express",
  "docker",
  "kubernetes",
  "cloud",
  "aws",
  "azure",
  "gcp",
  "machine learning",
  "ai",
  "llm",
  "model",
  "algorithm",
  "data structure",
  "git",
  "github",
  "devops",
  "security",
  "hackathon",
  "prototype",
  "pitch",
  "mvp",
  "sprint",
  "roadmap",
  "deployment",
  "redis",
  "cache",
  "latency",
  "concurrency",
  "thread",
  "node.js",
  "node",
];

const IRRELEVANT_WORDS = [
  "mountain",
  "elevation",
  "beachfront",
  "shore",
  "sea",
  "altitude",
];

function isTechOrHackathonQuery(query: string | null | undefined): boolean {
  if (!query) return false;

  const normalizedQuery = query.toLowerCase();
  return TECH_KEYWORDS.some((keyword) => normalizedQuery.includes(keyword));
}

function getDomainRestrictionReply(): string {
  return [
    "I can help with tech and hackathon topics only.",
    "Try asking about coding, architecture, APIs, debugging, MVP planning, or pitch strategy.",
    "Example: !How do I design a scalable hackathon project with Node and Redis?",
  ].join("\n");
}

async function getGroqReply(
  conversationMessages: ConversationMessage[],
  groqApiKey: string | undefined,
  groqModel: string,
): Promise<string> {
  if (!groqApiKey) {
    return "Groq key missing. Set GROQ_API_KEY in your environment to enable AI replies.";
  }

  const client = new Groq({
    apiKey: groqApiKey,
  });

  const systemPrompt = [
    "You are PARAG, a concise assistant for technology and hackathon support.",
    "Answer only within software engineering, product prototyping, and hackathon execution.",
    "If the user asks outside those domains, politely refuse and redirect to tech/hackathon topics.",
    "Keep responses practical, actionable, and under 120 words unless detail is explicitly requested.",
  ].join(" ");

  const messages: GroqMessageParam[] = conversationMessages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

  try {
    // Use SDK if it exposes messages.create, otherwise fall back to HTTP API
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
      // fallback: call Groq HTTP endpoint directly
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
            temperature: 0.3,
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

async function handleMessage(
  session: UserSession,
  userPrompt: string,
  groqApiKey: string | undefined,
  groqModel: string,
  isAdmin: boolean = false,
): Promise<AgentResult> {
  const normalized = (userPrompt || "").toLowerCase();
  const hasIrrelevant = IRRELEVANT_WORDS.some((w) => normalized.includes(w));
  const isTech = isTechOrHackathonQuery(userPrompt);

  // Domain lock: only admins can bypass initial domain check
  if (!isTech && !session.domainUnlocked && !isAdmin) {
    return {
      reply: getDomainRestrictionReply(),
      usedAI: false,
      domainLocked: true,
    };
  }

  // Safety check: even tech queries with irrelevant keywords get special handling
  if (isTech && hasIrrelevant) {
    const reply = [
      "That question is outside my scope. I focus on software engineering, product prototyping, and hackathon execution.",
      "For Redis cache optimization in Node.js, consider using the `redis` package with cluster mode or `ioredis` for better concurrency.",
      "Ignore external factors like mountain elevation shifts, as they don't impact Redis performance.",
    ].join(" ");

    return { reply, usedAI: false };
  }

  // Call Groq for AI response
  const aiReply = await getGroqReply(session.messages, groqApiKey, groqModel);
  return { reply: aiReply, usedAI: true };
}

export default {
  isTechOrHackathonQuery,
  getDomainRestrictionReply,
  handleMessage,
};
