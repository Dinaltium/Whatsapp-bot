import { BotHandler, BotContext, AgentResult } from "./core/BotHandler";
import { handleMessage } from "./PARAG/handler";
import { PARAG_HELP_TEXT } from "./PARAG/intro";

const ParagAgent: BotHandler = {
  botId: 0,
  name: "PARAG",
  requiresAllowlist: true as const,
  isInDomain: (_prompt) => true, // PARAG handles all prompts, domain restriction is inside handler
  handleMessage: (ctx: BotContext): Promise<AgentResult> =>
    handleMessage(
      ctx.session,
      ctx.prompt,
      ctx.groqApiKey,
      ctx.groqModel,
      ctx.isAdmin,
    ),
  getHelpText: () => PARAG_HELP_TEXT,
};

export default ParagAgent;
