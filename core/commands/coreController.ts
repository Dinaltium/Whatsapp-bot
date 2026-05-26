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
      "Context reset for your session. Start with a new !tech or !hackathon question."
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
      `Your JID: ${ctx.senderId}\nNormalized: ${normalized}`
    );
  },
});

// ── HELP COMMAND ──
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

    let helpText = "";
    if (botNumber === 1) {
      helpText = [
        "ECB - EmbedClub Assistant",
        "Available Commands:",
        "• !ping - Check bot response and status",
        "• !hello - Check bot availability",
        "• !reset - Reset your conversation context",
        "• !<question> - Ask about ECB events, hardware/embedded activities, and community guidelines",
      ].join("\n");
    } else if (botNumber === 2) {
      helpText = [
        "DKB - DK24 (Developer Kommunity 24) Assistant",
        "Available Commands:",
        "• !ping - Check bot response and status",
        "• !hello - Check bot availability",
        "• !reset - Reset your conversation context",
        "• !clubs - List all official member communities in the DK24 network",
        "• !club <name> - Get detailed spotlight card for a specific member community",
        "• !events [monthYear] - List chronological events (e.g. !events may-2026)",
        "• !event <name> - Get details, timeline, and registration links for an event",
        "• !mentors [page] - List mentors in alphabetical order (10 per page)",
        "• !mentor -id <id> - View full details for a specific mentor by ID",
        "• !mentor -f <letter_or_query> [page] - Filter mentors by name",
        "• !next - View the next page of mentors from your active query",
        "• !page <number> - View a specific page of mentors from your active query",
        "• !addmentor -n <name> -o <org> [-d <desc>] [-ex <expertise>] [-l <linkedin>] [-i <instagram>] [-g <github>] [-e <email>] [-p <phone>] - Add a mentor (Authorized only)",
        "• !editmentor -id <id> -<flag> <value> - Update a single field on a mentor (Authorized only)",
        "• !delmentor -id <id> - Remove a mentor (Authorized only)",
        "• !<question> - Chat directly with DKB (e.g. !What is a good way to host an AI meetup?)",
      ].join("\n");
    } else {
      // Default to Bot 0 (PARAG)
      helpText = [
        "PARAG - Technology and Hackathon Assistant",
        "Available Commands:",
        "• !ping - Check bot response and status",
        "• !hello - Check bot availability",
        "• !reset - Reset your conversation context",
        "• !<question> - Chat directly with PARAG (e.g. !How do I optimize API latency?)",
      ].join("\n");
    }

    await sendBotReply(ctx.sock, ctx.from, helpText);
  },
});
