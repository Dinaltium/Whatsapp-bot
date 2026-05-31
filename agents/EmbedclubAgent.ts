import { BotHandler, BotContext, AgentResult } from "./core/BotHandler";
import { handleMessage } from "./ECB/handler";
import { ECB_HELP_TEXT } from "./ECB/intro";

const EmbedclubAgent: BotHandler = {
  botId: 1,
  name: "ECB",
  requiresAllowlist: true as const,
  isInDomain: (_prompt) => true,
  handleMessage: (ctx: BotContext): Promise<AgentResult> =>
    handleMessage(ctx.session, ctx.prompt),
  getHelpText: () => ECB_HELP_TEXT,
};

export default EmbedclubAgent;
