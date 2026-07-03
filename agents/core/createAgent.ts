import { BotHandler, BotContext, AgentResult } from "./BotHandler";

/**
 * Shared factory for persona bots. Fills in the common BotHandler shape
 * (requiresAllowlist, default isInDomain) so each persona only supplies what
 * actually differs: its id, name, message handler, and help text.
 */
export function createAgent(config: {
  botId: number;
  name: string;
  isInDomain?: (prompt: string) => boolean;
  handleMessage: (ctx: BotContext) => Promise<AgentResult>;
  getHelpText: () => string;
}): BotHandler {
  return {
    botId: config.botId,
    name: config.name,
    requiresAllowlist: true as const,
    isInDomain: config.isInDomain || (() => true),
    handleMessage: config.handleMessage,
    getHelpText: config.getHelpText,
  };
}
