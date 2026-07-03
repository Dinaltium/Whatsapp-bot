import { BotContext, AgentResult } from "./core/BotHandler";
import { createAgent } from "./core/createAgent";
import { handleMessage } from "./Generic/handler";
import { GENERIC_HELP_TEXT } from "./Generic/intro";

const GenericAgent = createAgent({
  botId: 0,
  name: "Generic",
  handleMessage: (ctx: BotContext): Promise<AgentResult> =>
    handleMessage(ctx.session, ctx.prompt, ctx.groqApiKey, ctx.groqModel),
  getHelpText: () => GENERIC_HELP_TEXT,
});

export default GenericAgent;
