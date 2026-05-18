interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

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

async function handleMessage(
  session: UserSession,
  userPrompt: string,
): Promise<AgentResult> {
  // Embedclub bot: basic responses without Groq/AI
  // Can be extended with domain-specific logic for Embedclub

  const normalizedPrompt = (userPrompt || "").toLowerCase();

  // Basic question routing
  if (normalizedPrompt.includes("hello") || normalizedPrompt.includes("hi")) {
    return {
      reply: "👋 Hello! Welcome to Embedclub. How can I assist you today?",
      usedAI: false,
    };
  }

  if (normalizedPrompt.includes("help") || normalizedPrompt.includes("?")) {
    return {
      reply: [
        "I'm here to help with Embedclub-related questions and information.",
        "Ask me about:",
        "• Embedclub events and activities",
        "• Community guidelines",
        "• Getting started with Embedclub",
        "• General questions about the club",
      ].join("\n"),
      usedAI: false,
    };
  }

  // Default response for Embedclub
  return {
    reply:
      "Thanks for reaching out to Embedclub! I'm here to help with any questions. Feel free to ask about events, activities, or how to get involved.",
    usedAI: false,
  };
}

export default {
  handleMessage,
};
