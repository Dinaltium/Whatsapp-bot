import ParagAgent from "./ParagAgent";
import EmbedclubAgent from "./EmbedclubAgent";
import DKBAgent from "./DKBAgent";
import TempAgent from "./TempAgent";

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

interface UserSession {
  domainUnlocked: boolean;
  lastActiveAt: number;
  messages: ConversationMessage[];
  lastQuery?: { type: "mentors"; filter?: string; page: number };
  pendingMentor?: {
    name: string;
    organization: string;
    description?: string;
    expertise?: string;
    linkedin?: string;
    instagram?: string;
    github?: string;
    email?: string;
    phoneNoCountryCode: string;
  };
  pendingEdit?: {
    mentorId: number;
    flag: string;
    phoneNoCountryCode: string;
  };
}

interface AgentResult {
  reply: string;
  usedAI: boolean;
  domainLocked?: boolean;
}

interface BotConfig {
  id: number;
  name: string;
  description: string;
  handler: (
    session: UserSession,
    userPrompt: string,
    groqApiKey: string | undefined,
    groqModel: string,
    isAdmin: boolean,
    senderJid?: string,
  ) => Promise<AgentResult>;
}

// Centrally managed registry of deployable bots
const BOTS_REGISTRY: BotConfig[] = [
  {
    id: 0,
    name: "PARAG",
    description: "Concise assistant for technology and hackathon support",
    handler: (session, userPrompt, groqApiKey, groqModel, isAdmin) =>
      ParagAgent.handleMessage(session, userPrompt, groqApiKey, groqModel, isAdmin),
  },
  {
    id: 1,
    name: "ECB",
    description: "Hardware and embedded systems community assistant",
    handler: (session, userPrompt, _groqApiKey, _groqModel, _isAdmin) =>
      EmbedclubAgent.handleMessage(session, userPrompt),
  },
  {
    id: 2,
    name: "DKB",
    description: "DK24 (Developer Kommunity 24) assistant for collaborative coding and events",
    handler: (session, userPrompt, groqApiKey, groqModel, isAdmin, senderJid) =>
      DKBAgent.handleMessage(session, userPrompt, groqApiKey, groqModel, isAdmin, senderJid),
  },
  {
    id: 3,
    name: "Sajige Bajil",
    description: "Cry about it",
    handler: (session, userPrompt, groqApiKey, groqModel, isAdmin) =>
      TempAgent.handleMessage(session, userPrompt, groqApiKey, groqModel, isAdmin),
  },
];

/**
 * Centrally routes and handles messages for registered bots.
 * Acts as the deployer and administrative firewall: catches errors and returns
 * generic safety/unavailability messages rather than breaking the client connection.
 */
async function handleAgentMessage(
  session: UserSession,
  userPrompt: string,
  groqApiKey: string | undefined,
  groqModel: string,
  botNumber: number = 0,
  isAdmin: boolean = false,
  senderJid?: string,
): Promise<AgentResult> {
  const bot = BOTS_REGISTRY.find((b) => b.id === botNumber);

  if (!bot) {
    console.warn(`⚠️ Configuration mismatch: Bot ID ${botNumber} was requested but is not registered.`);
    return {
      reply: `Error: Bot ${botNumber} is not configured or is currently not available.`,
      usedAI: false,
    };
  }

  try {
    // Coordinate execution through the secure boundary
    return await bot.handler(session, userPrompt, groqApiKey, groqModel, isAdmin, senderJid);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`🚨 Administration Panel - Bot '${bot.name}' failed to execute:`, errorMessage);

    return {
      reply: `The bot ${bot.name} is temporarily not available. Please try again in a moment.`,
      usedAI: false,
    };
  }
}

/**
 * Returns a list of active bots for admin inspection
 */
function getActiveBots(): Omit<BotConfig, "handler">[] {
  return BOTS_REGISTRY.map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
  }));
}

export default {
  handleAgentMessage,
  getActiveBots,
};
