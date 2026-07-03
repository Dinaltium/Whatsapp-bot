import { BotContext, AgentResult } from "./core/BotHandler";
import { createAgent } from "./core/createAgent";
import { handleMessage } from "./DKB/handler";
import { DKB_HELP_TEXT } from "./DKB/intro";

const DKBAgent = createAgent({
  botId: 2,
  name: "DKB",
  handleMessage: (ctx: BotContext): Promise<AgentResult> =>
    handleMessage(
      ctx.session,
      ctx.prompt,
      ctx.groqApiKey,
      ctx.groqModel,
      ctx.isAdmin,
      ctx.senderJid,
    ),
  getHelpText: () => DKB_HELP_TEXT,
});

export default DKBAgent;
