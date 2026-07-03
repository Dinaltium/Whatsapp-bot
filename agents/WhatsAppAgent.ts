import { BotHandler, BotContext, AgentResult } from "./core/BotHandler";
import GenericAgent from "./GenericAgent";
import ParagAgent from "./ParagAgent";
import EmbedclubAgent from "./EmbedclubAgent";
import DKBAgent from "./DKBAgent";

// SELF bot is NOT in this registry — it is handled separately in messageRouter.ts
// Bot 0 = Generic (default for unassigned chats), 1 = ECB, 2 = DKB, 3 = PARAG.
const BOTS_REGISTRY: BotHandler[] = [
  GenericAgent,
  EmbedclubAgent,
  DKBAgent,
  ParagAgent,
];

export function getBotRegistry(): BotHandler[] {
  return BOTS_REGISTRY;
}

export async function handleAgentMessage(
  ctx: BotContext,
  botNumber: number = 0,
): Promise<AgentResult> {
  const bot = BOTS_REGISTRY.find((b) => b.botId === botNumber);

  if (!bot) {
    console.warn(`[WhatsAppAgent] Bot ID ${botNumber} not found in registry.`);
    return {
      reply: `Error: Bot ${botNumber} is not configured or currently unavailable.`,
      usedAI: false,
    };
  }

  try {
    return await bot.handleMessage(ctx);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[WhatsAppAgent] Bot '${bot.name}' failed:`, msg);
    return {
      reply: `The bot ${bot.name} is temporarily unavailable. Please try again.`,
      usedAI: false,
    };
  }
}

export function getActiveBots(): { id: number; name: string }[] {
  return BOTS_REGISTRY.map((b) => ({ id: b.botId, name: b.name }));
}

export default {
  handleAgentMessage,
  getActiveBots,
  getBotRegistry,
};
