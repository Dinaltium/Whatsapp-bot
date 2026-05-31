import { UserSession } from "../../core/state";

export type { UserSession };

export interface AgentResult {
  reply: string;
  usedAI: boolean;
  domainLocked?: boolean;
}

export interface BotContext {
  session: UserSession;
  prompt: string;
  groqApiKey: string | undefined;
  groqModel: string;
  isAdmin: boolean;
  senderJid?: string;
}

export interface BotHandler {
  botId: number;
  name: string;
  requiresAllowlist: true;
  isInDomain: (prompt: string) => boolean;
  handleMessage: (ctx: BotContext) => Promise<AgentResult>;
  getHelpText: () => string;
}
