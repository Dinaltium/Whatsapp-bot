import { proto } from "@whiskeysockets/baileys";
import { UserSession } from "../../core/state";

export interface AgentResult {
  reply: string;
  usedAI: boolean;
  domainLocked?: boolean;
}

export interface BotContext {
  session: UserSession;
  prompt: string;
  isAdmin: boolean;
  senderJid: string;
  from: string;
  sock: any;
  msg: proto.IWebMessageInfo;
  groqApiKey?: string;
  groqModel: string;
}

export interface BotHandler {
  readonly botId: number;
  readonly name: string;
  readonly requiresAllowlist: true;

  isInDomain(prompt: string): boolean;
  handleMessage(ctx: BotContext): Promise<AgentResult>;
  getHelpText(): string;
}
