import { BotHandler, BotContext, AgentResult } from "./core/BotHandler";
import { handleMessage } from "./DKB/handler";
import { classifyAndAutoAddMentor } from "../services/DKB/mentorService";
import { DKB_HELP_TEXT } from "./DKB/intro";

const DKBAgent: BotHandler = {
  botId: 2,
  name: "DKB",
  requiresAllowlist: true as const,
  isInDomain: (_prompt) => true,
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
};

export { classifyAndAutoAddMentor };
export default DKBAgent;
