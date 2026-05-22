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

const ECB_HEADER = "[ECB - EmbedClub]";

function formatBotReply(text: string): string {
  const cleanedText = String(text || "").trim();
  if (!cleanedText) {
    return ECB_HEADER;
  }
  return `${ECB_HEADER}\n\n${cleanedText}`;
}

async function handleMessage(
  session: UserSession,
  userPrompt: string,
): Promise<AgentResult> {
  const normalizedPrompt = (userPrompt || "").toLowerCase();

  if (normalizedPrompt.includes("hello") || normalizedPrompt.includes("hi")) {
    return {
      reply: formatBotReply("Hello! Welcome to ECB (EmbedClub). How can I assist you today?"),
      usedAI: false,
    };
  }

  if (normalizedPrompt.includes("help") || normalizedPrompt.includes("?")) {
    const helpText = [
      "I'm here to help with ECB (EmbedClub) related questions and information.",
      "Ask me about:",
      "• ECB events and hardware/embedded activities",
      "• Community guidelines",
      "• Getting started with ECB",
      "• General questions about the club",
    ].join("\n");

    return {
      reply: formatBotReply(helpText),
      usedAI: false,
    };
  }

  const defaultText = "Thanks for reaching out to ECB (EmbedClub)! I'm here to help with any questions. Feel free to ask about events, activities, or how to get involved.";
  return {
    reply: formatBotReply(defaultText),
    usedAI: false,
  };
}

export default {
  handleMessage,
};
