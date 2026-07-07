import { registerCommand } from "./commandRegistry";
import groupConfig from "../../config/groupAllowlist";
import chatConfig from "../../config/chatAllowlist";
import { sendBotReply } from "../../bot";
import { normalizeJid } from "../../security/rbac";
import { saveSession } from "../state";
import { buildSessionKey } from "../../bot";

// Management commands shown to the owner on plain `!help` (bot command sets are
// only shown with `!help -bid <n>`).
const ADMIN_HELP_TEXT = [
  "Admin commands (owner only):",
  "",
  "Allowlist (run in the target chat/group, or target by id):",
  "• !add [-g|-c] [jid] [-bid <0-3>] — allow THIS (or a given) chat/group; default Bot 1",
  "• !rm — remove THIS chat/group (or -gid/-cid <id>); confirm with !YES",
  "• !edit -bid <n> — reassign THIS chat/group's bot (or -gid/-cid <id> -bid <n>)",
  "• !enable / !disable — toggle THIS chat/group (or -gid/-cid <id>)",
  "• !listgroups · !listchats — list allowlisted groups/chats",
  "• !findgroups [-f <q>] [-p] · !findchats — search joined groups / known chats",
  "",
  "Roles & ops (DKB):",
  "• !manage mentor -l | -all [-rm] | -jid <phone> [-rm] — mentor role management",
  "• !notify -id <groupId> — set the member-join notify group",
  "• !neonping · !neonconnect — database diagnostics",
  "",
  "Info:",
  "• !help -bid <0-3> — a specific bot's user commands",
  "• !!help — personal (!!) commands",
].join("\n");

/** First configured admin JID, normalized — the owner's own identity. */
function ownerJid(): string | null {
  const first = (process.env.ADMIN_JIDS || "").split(",")[0]?.trim();
  return first ? (normalizeJid(first) as string) || null : null;
}

// ── PING COMMAND (owner-only) ──
registerCommand({
  name: "ping",
  requiresAdmin: true,
  handler: async (ctx) => {
    await sendBotReply(ctx.sock, ctx.from, "pong");
  },
});

// ── HELLO COMMAND ──
registerCommand({
  name: "hello",
  handler: async (ctx) => {
    await sendBotReply(ctx.sock, ctx.from, "Online and operational.");
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

    // Neutral wording — not tied to any one bot's commands.
    await sendBotReply(
      ctx.sock,
      ctx.from,
      "Your conversation context has been cleared.",
    );
  },
});

// ── GETJID COMMAND (owner-only) ──
registerCommand({
  name: "getjid",
  requiresAdmin: true,
  handler: async (ctx) => {
    if (ctx.from?.endsWith("@g.us")) {
      await sendBotReply(ctx.sock, ctx.from, `Group JID: ${ctx.from}`);
    } else {
      await sendBotReply(ctx.sock, ctx.from, `Chat JID: ${ctx.from}`);
    }
  },
});

// ── WHOAMI COMMAND (owner-only, owner's own DM only) ──
// Restricted to the owner AND only inside the owner's own chat — never in a
// group or someone else's DM. Prevents it being used as an account probe.
registerCommand({
  name: "whoami",
  requiresAdmin: true,
  handler: async (ctx) => {
    const owner = ownerJid();
    if (!owner || normalizeJid(ctx.from) !== owner) {
      return; // silent: don't confirm the command exists elsewhere
    }
    // Show the raw key JID and its normalized form (they can legitimately
    // differ — e.g. a device-suffixed or @lid raw id).
    const rawJid =
      ctx.msg.key?.participant || ctx.msg.key?.remoteJid || ctx.senderId;
    const normalized = normalizeJid(rawJid);
    await sendBotReply(
      ctx.sock,
      ctx.from,
      `Your JID: ${rawJid}\nNormalized: ${normalized}`,
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

    // Bot selector flag: `-bid <n>`.
    const idMatch = ctx.cmdArgs.join(" ").match(/^-bid\s+(\d+)$/i);

    // ── Owner: unrestricted, `-bid` points at any bot ──
    if (isAdmin) {
      if (idMatch) {
        const target = parseInt(idMatch[1], 10);
        const bot = getBotRegistry().find((b) => b.botId === target);
        if (!bot) {
          await sendBotReply(
            ctx.sock,
            ctx.from,
            `No bot with id ${target}. Try !help -bid 0/1/2/3.`,
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
      // Plain !help for the owner → management commands (not a bot's command
      // set; those need -bid). PATCHES Fix #1 (#15/#20).
      await sendBotReply(ctx.sock, ctx.from, ADMIN_HELP_TEXT);
      return;
    }

    // ── Non-admin: scoped to this chat's bot, no `-bid`, rate-limited ──
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
