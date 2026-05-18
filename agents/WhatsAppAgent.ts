import TechHackathonAgent from "./TechHackathonAgent";
import EmbedclubAgent from "./EmbedclubAgent";

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

async function handleAgentMessage(
  session: UserSession,
  userPrompt: string,
  groqApiKey: string | undefined,
  groqModel: string,
  botNumber: number = 0,
  isAdmin: boolean = false,
): Promise<AgentResult> {
  // Bot 0: Tech and Hackathon (Groq-powered)
  if (botNumber === 0) {
    return TechHackathonAgent.handleMessage(
      session,
      userPrompt,
      groqApiKey,
      groqModel,
      isAdmin,
    );
  }

  // Bot 1: Embedclub (basic responses, no Groq)
  if (botNumber === 1) {
    return EmbedclubAgent.handleMessage(session, userPrompt);
  }

  // Fallback to Tech/Hackathon for unknown bot numbers
  return TechHackathonAgent.handleMessage(
    session,
    userPrompt,
    groqApiKey,
    groqModel,
    isAdmin,
  );
}

export default {
  handleAgentMessage,
};
