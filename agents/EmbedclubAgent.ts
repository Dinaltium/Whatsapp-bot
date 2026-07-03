import { BotContext, AgentResult } from "./core/BotHandler";
import { createAgent } from "./core/createAgent";
import { handleMessage } from "./ECB/handler";
import { ECB_HELP_TEXT } from "./ECB/intro";

const EmbedclubAgent = createAgent({
  botId: 1,
  name: "ECB",
  handleMessage: (ctx: BotContext): Promise<AgentResult> =>
    handleMessage(ctx.session, ctx.prompt),
  getHelpText: () => ECB_HELP_TEXT,
});

export default EmbedclubAgent;
