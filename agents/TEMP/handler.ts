import { getGroqReply } from "./prompt";

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
    return "";
  }
  
  const r = Math.random();
  if (r < 0.70) {
    return cleanedText;
  } else {
    return `*TEMP*\n\n${cleanedText}`;
  }
}

export async function handleMessage(
  session: UserSession,
  userPrompt: string,
  groqApiKey: string | undefined,
  groqModel: string,
  isAdmin: boolean = false,
): Promise<AgentResult> {
  // CRITICAL REQUIREMENT: This bot is strictly for the admin's use alone
  if (!isAdmin) {
    return {
      reply: "",
      usedAI: false,
    };
  }

  const aiReply = await getGroqReply(session.messages, groqApiKey, groqModel);
  return {
    reply: formatBotReply(aiReply),
    usedAI: true,
  };
}
