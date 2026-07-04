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

// ── HELP COMMAND ──
// Owner (admin): unrestricted, any chat, may point at any bot with `!help -id`.
// Group/chat member (non-admin): scoped to THIS chat's bot (no bot number),
//   rate-limited per chat + per bot (see helpService.checkHelpGate), and
//   role-gated (mentors additionally see the mentor command block).
registerCommand({
  name: "help",
  handler: async (ctx) => {
    const { isAdminAction } = await import("../../security/rbac");
    const { getBotRegistry } = await import("../../agents/WhatsAppAgent");
    const { buildHelpText, checkHelpGate } = await import("./helpService");

    const isAdmin = isAdminAction(ctx.msg, ctx.senderId);

    // Resolve the bot assigned to THIS chat (group or DM); default Generic (0).
    let botNumber = 0;
    if (ctx.from?.endsWith("@g.us")) {
      botNumber = groupConfig.getGroupBot(ctx.from)?.botNumber ?? 0;
    } else {
      botNumber = chatConfig.getChatBot(ctx.from)?.botNumber ?? 0;
    }

    const idMatch = ctx.cmdArgs.join(" ").match(/^-id\s+(\d+)$/i);

    // ── Owner: unrestricted, `-id` points at any bot ──
    if (isAdmin) {
      if (idMatch) {
        const target = parseInt(idMatch[1], 10);
        const bot = getBotRegistry().find((b) => b.botId === target);
        if (!bot) {
          await sendBotReply(
            ctx.sock,
            ctx.from,
            `No bot with id ${target}. Try !help -id 0/1/2/3.`,
          );
          return;
        }
        await sendBotReply(
          ctx.sock,
          ctx.from,
          buildHelpText(target, { isMentor: true }),
        );
        return;
      }
      await sendBotReply(
        ctx.sock,
        ctx.from,
        buildHelpText(botNumber, { isMentor: true }) +
          "\n\nAdmin: !help -id <0-3> for any bot · !!help for personal (!!) commands",
      );
      return;
    }

    // ── Non-admin: scoped to this chat's bot, no `-id`, rate-limited ──
    if (idMatch) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Just send !help — it shows the commands for this chat's bot.",
      );
      return;
    }

    const gate = await checkHelpGate(botNumber, ctx.from);
    if (!gate.allowed) {
      const msg =
        gate.reason === "busy"
          ? `Help was just shown for this bot in other chats. Try again in ~${gate.waitMin} min.`
          : `Help was already shown here recently. Try again in ~${gate.waitMin} min.`;
      await sendBotReply(ctx.sock, ctx.from, msg);
      return;
    }

    let isMentor = false;
    if (ctx.senderId) {
      try {
        const { userHasPermission } = await import(
          "../../storage/core/rbacRepository"
        );
        isMentor = await userHasPermission(ctx.senderId, "mentor.manage");
      } catch {
        /* treat as non-mentor on lookup failure */
      }
    }

    await sendBotReply(
      ctx.sock,
      ctx.from,
      buildHelpText(botNumber, { isMentor }),
    );
  },
});
