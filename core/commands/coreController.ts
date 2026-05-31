import { registerCommand } from "./commandRegistry";
import groupConfig from "../../config/groupAllowlist";
import chatConfig from "../../config/chatAllowlist";
import { sendBotReply } from "../../bot";
import { normalizeJid } from "../../security/rbac";
import { saveSession } from "../state";
import { buildSessionKey } from "../../bot";

// ── PING COMMAND ──
registerCommand({
  name: "ping",
  handler: async (ctx) => {
    await sendBotReply(ctx.sock, ctx.from, "pong");
  },
});

// ── HELLO COMMAND ──
registerCommand({
  name: "hello",
  handler: async (ctx) => {
    await sendBotReply(ctx.sock, ctx.from, "PARAG online and operational.");
  },
});

// ── RESET COMMAND ──
registerCommand({
  name: "reset",
  handler: async (ctx) => {
    ctx.session.domainUnlocked = false;
    ctx.session.messages = [];
    ctx.session.lastActiveAt = 0;

    const sessionKey = buildSessionKey(ctx.from, ctx.senderId);
    await saveSession(sessionKey, ctx.session);

    await sendBotReply(
      ctx.sock,
      ctx.from,
      "Context reset for your session. Start with a new !tech or !hackathon question.",
    );
  },
});

// ── GETJID COMMAND ──
registerCommand({
  name: "getjid",
  handler: async (ctx) => {
    if (ctx.from?.endsWith("@g.us")) {
      await sendBotReply(ctx.sock, ctx.from, `Group JID: ${ctx.from}`);
    } else {
      await sendBotReply(ctx.sock, ctx.from, `Chat JID: ${ctx.from}`);
    }
  },
});

// ── WHOAMI COMMAND ──
registerCommand({
  name: "whoami",
  handler: async (ctx) => {
    const normalized = normalizeJid(ctx.senderId);
    await sendBotReply(
      ctx.sock,
      ctx.from,
      `Your JID: ${ctx.senderId}\nNormalized: ${normalized}`,
    );
  },
});

// ── HELP COMMAND (dynamic — Task 4.6) ──
registerCommand({
  name: "help",
  handler: async (ctx) => {
    let botNumber = 0;
    if (ctx.from?.endsWith("@g.us")) {
      const groupBot = groupConfig.getGroupBot(ctx.from);
      botNumber = groupBot?.botNumber || 0;
    } else {
      const chatBot = chatConfig.getChatBot(ctx.from);
      botNumber = chatBot?.botNumber || 0;
    }

    const { getBotRegistry } = await import("../../agents/WhatsAppAgent");
    const bot = getBotRegistry().find((b) => b.botId === botNumber);
    const helpText = bot
      ? bot.getHelpText()
      : "Bot not configured for this chat. Contact an admin.";

    await sendBotReply(ctx.sock, ctx.from, helpText);
  },
});
