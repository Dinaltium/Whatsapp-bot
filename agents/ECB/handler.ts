import { ECB_HEADER, HELP_TEXT, DEFAULT_TEXT } from "./intro";

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

function formatBotReply(text: string): string {
  const cleanedText = String(text || "").trim();
  if (!cleanedText) {
    return ECB_HEADER;
  }
  return `${ECB_HEADER}\n\n${cleanedText}`;
}

export async function handleMessage(
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
    return {
      reply: formatBotReply(HELP_TEXT),
      usedAI: false,
    };
  }

  return {
    reply: formatBotReply(DEFAULT_TEXT),
    usedAI: false,
  };
}
