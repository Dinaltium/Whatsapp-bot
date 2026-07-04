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
const CORE_HELP_TEXT = [
  "DK24 Bot — Help",
  "",
  "Core (everyone, any chat):",
  "• !help — this help",
  "• !help -id <0-3> — a specific bot's commands (0 Generic · 1 ECB · 2 DKB · 3 PARAG)",
  "• !help me — admin/self (!!) commands",
  "• !ping — check the bot is online",
  "• !whoami — show your WhatsApp id",
  "• !getjid — show this chat's id",
  "• !reset — clear your AI conversation context",
  "",
  "Directory (DKB chats): !clubs · !events · !projects · !mentors (with !next / !page <n>)",
  "Admin-only commands manage the allowlist, mentor role, reminders, and utilities.",
].join("\n");

registerCommand({
  name: "help",
  handler: async (ctx) => {
    const arg = (ctx.cmdArgs[0] || "").toLowerCase();

    // !help me → admin/self command list
    if (arg === "me") {
      const { SELF_HELP_TEXT } = await import("../../agents/SELF/intro");
      await sendBotReply(ctx.sock, ctx.from, SELF_HELP_TEXT);
      return;
    }

    const { getBotRegistry } = await import("../../agents/WhatsAppAgent");

    // !help -id <n> → that bot's commands
    const idMatch = ctx.cmdArgs.join(" ").match(/^-id\s+(\d+)$/i);
    if (idMatch) {
      const botId = parseInt(idMatch[1], 10);
      const bot = getBotRegistry().find((b) => b.botId === botId);
      await sendBotReply(
        ctx.sock,
        ctx.from,
        bot
          ? bot.getHelpText()
          : `No bot with id ${botId}. Try !help -id 0/1/2/3.`,
      );
      return;
    }

    // !help → core commands
    await sendBotReply(ctx.sock, ctx.from, CORE_HELP_TEXT);
  },
});
