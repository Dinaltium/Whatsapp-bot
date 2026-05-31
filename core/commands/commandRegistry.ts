import { proto } from "@whiskeysockets/baileys";
import { isAdminAction } from "../../security/rbac";
import { sendBotReply } from "../../bot";

export interface CommandContext {
  sock: any;
  msg: proto.IWebMessageInfo;
  cmdName: string;
  cmdArgs: string[];
  senderId: string;
  from: string;
  session: any;
  majesticMode?: 'private' | 'public_silent' | 'public_shazam';
}

export type CommandHandler = (ctx: CommandContext) => Promise<void>;

export interface CommandConfig {
  name: string;
  requiresAdmin?: boolean;
  requiresPermission?: string;
  handler: CommandHandler;
}

var registry: Map<string, CommandConfig> | null = null;

function getRegistry(): Map<string, CommandConfig> {
  if (!registry) {
    registry = new Map<string, CommandConfig>();
  }
  return registry;
}

export function registerCommand(config: CommandConfig) {
  getRegistry().set(config.name.toLowerCase(), config);
}

export async function dispatchCommand(ctx: CommandContext): Promise<boolean> {
  let lookupName = ctx.cmdName.toLowerCase();
  let majesticMode: 'private' | 'public_silent' | 'public_shazam' = 'private';

  if (lookupName === 'reveal') {
    majesticMode = 'private';
  } else if (/^reveal!+$/.test(lookupName) || /^revealthis!+$/.test(lookupName)) {
    majesticMode = 'public_silent';
    lookupName = 'reveal';
  } else if (/^thepowerofwhatsappinmyhands!+$/.test(lookupName)) {
    majesticMode = 'public_shazam';
    lookupName = 'reveal';
  }

  const config = getRegistry().get(lookupName);
  if (!config) return false;

  ctx.majesticMode = majesticMode;

  // ── MIDDLEWARE ACCESS CHECKS ──
  if (config.requiresAdmin && !isAdminAction(ctx.msg, ctx.senderId)) {
    await sendBotReply(ctx.sock, ctx.from, "Unauthorized: admin privileges required for that command.");
    return true;
  }

  if (config.requiresPermission) {
    try {
      const { userHasPermission } = await import("../../storage/core/rbacRepository");
      const hasPerm = await userHasPermission(ctx.senderId, config.requiresPermission);
      if (!hasPerm) {
        await sendBotReply(ctx.sock, ctx.from, `Unauthorized: permission [${config.requiresPermission}] is required.`);
        return true;
      }
    } catch (err) {
      console.error("RBAC check failed:", err);
      await sendBotReply(ctx.sock, ctx.from, "Error: Authentication system unavailable.");
      return true;
    }
  }

  try {
    await config.handler(ctx);
  } catch (error) {
    console.error(`⚠️ Error running command ${ctx.cmdName}:`, error);
    await sendBotReply(ctx.sock, ctx.from, "An internal error occurred while executing that command.");
  }

  return true;
}

// Auto-boot command controllers registrations
import "./coreController";
import "./admin/index";
import "./directoryController";
