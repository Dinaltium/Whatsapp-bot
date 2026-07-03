import { getGroqReply } from "../../ai/groqClient";
import { GENERIC_SYSTEM_PROMPT } from "./intro";

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
  return String(text || "").trim();
}

/**
 * Generic responder for chats/groups with no specialised bot assigned. Gives a
 * neutral, useful answer with no persona or domain restriction.
 */
export async function handleMessage(
  session: UserSession,
  userPrompt: string,
  groqApiKey: string | undefined,
  groqModel: string,
): Promise<AgentResult> {
  if (!groqApiKey) {
    return {
      reply: formatBotReply(
        "Hi! I'm the assistant bot. Ask me anything, or type !help for commands.",
      ),
      usedAI: false,
    };
  }

  try {
    const aiReply = await getGroqReply(
      session.messages,
      groqApiKey,
      groqModel,
      GENERIC_SYSTEM_PROMPT,
    );
    return { reply: formatBotReply(aiReply), usedAI: true };
  } catch (err) {
    console.error(
      "[Generic] AI reply failed:",
      err instanceof Error ? err.message : err,
    );
    return {
      reply: formatBotReply(
        "I'm having trouble answering right now. Please try again shortly.",
      ),
      usedAI: false,
    };
  }
}
