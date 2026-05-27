import { registerCommand } from "./commandRegistry";
import groupConfig from "../../config/groupAllowlist";
import chatConfig from "../../config/chatAllowlist";
import { sendBotReply, safeGetGroupName, buildSessionKey } from "../../bot";
import { normalizeJid, isAdminAction } from "../../security/rbac";
import { saveSession } from "../state";
import { redis } from "../../storage/redisClient";
import { downloadMediaMessage } from "@whiskeysockets/baileys";

// ── UTILITY: UNWRAP EPHEMERAL MESSAGES ──
function unwrapMessage(message: any): any {
  if (!message) return null;
  if (message.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  return message;
}

// ── LIST GROUPS ──
registerCommand({
  name: "listgroups",
  requiresAdmin: true,
  handler: async (ctx) => {
    const list = groupConfig.listGroups();
    if (!list || list.length === 0) {
      await sendBotReply(ctx.sock, ctx.from, "No groups configured (allowlist is empty).");
    } else {
      const formattedPromises = list.map(async (entry) => {
        const botLabel =
          entry.botNumber === 1
            ? "ECB"
            : entry.botNumber === 2
              ? "DKB"
              : "PARAG";
        const statusLabel = entry.enabled ? "Enabled" : "Disabled";
        const groupName = await safeGetGroupName(ctx.sock, entry.jid);
        return `${entry.id}. ${groupName} (${entry.jid}) | Bot ${entry.botNumber} (${botLabel}) | [${statusLabel}]`;
      });
      const formatted = await Promise.all(formattedPromises);
      await sendBotReply(ctx.sock, ctx.from, `Allowed groups:\n${formatted.join("\n")}`);
    }
  }
});

// ── LIST CHATS ──
registerCommand({
  name: "listchats",
  requiresAdmin: true,
  handler: async (ctx) => {
    const list = chatConfig.listChats();
    if (!list || list.length === 0) {
      await sendBotReply(ctx.sock, ctx.from, "No chats configured (allowlist is empty).");
    } else {
      const formatted = list.map((entry) => {
        const botLabel =
          entry.botNumber === 1
            ? "ECB"
            : entry.botNumber === 2
              ? "DKB"
              : "PARAG";
        const statusLabel = entry.enabled ? "Enabled" : "Disabled";
        return `${entry.id}. ${entry.jid} | Bot ${entry.botNumber} (${botLabel}) | [${statusLabel}]`;
      });
      await sendBotReply(ctx.sock, ctx.from, `Allowed chats:\n${formatted.join("\n")}`);
    }
  }
});

// ── ADD GROUP ──
registerCommand({
  name: "addgroup",
  requiresAdmin: true,
  handler: async (ctx) => {
    let target = ctx.cmdArgs[0];
    const botNumber = ctx.cmdArgs[1] ? parseInt(ctx.cmdArgs[1], 10) : 0;

    if (!target) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !addgroup <group-jid> [bot-number]\nBot 0: PARAG | Bot 1: ECB | Bot 2: DKB"
      );
      return;
    }

    target = normalizeJid(target) as string;
    const ok = await groupConfig.addGroup(target, isNaN(botNumber) ? 0 : botNumber);
    if (ok) {
      const groupEntry = groupConfig.getGroupEntryByJid(target);
      const idLabel = groupEntry ? ` (ID: ${groupEntry.id})` : "";
      const groupName = await safeGetGroupName(ctx.sock, target);
      try {
        const { logAction } = await import("../../storage/core/auditRepository");
        await logAction(
          ctx.senderId || "unknown",
          "add_group",
          groupEntry ? String(groupEntry.id) : null,
          target,
          JSON.stringify({ botNumber: isNaN(botNumber) ? 0 : botNumber })
        );
      } catch (e) {}
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `Added group ${groupName} (${target}) to group allowlist${idLabel} (Bot ${isNaN(botNumber) ? 0 : botNumber}).`
      );
    } else {
      await sendBotReply(ctx.sock, ctx.from, `Failed to add ${target}. Ensure it's a valid group JID.`);
    }
  }
});

// ── ADD CHAT ──
registerCommand({
  name: "addchat",
  requiresAdmin: true,
  handler: async (ctx) => {
    let target = ctx.cmdArgs[0];
    const botNumber = ctx.cmdArgs[1] ? parseInt(ctx.cmdArgs[1], 10) : 0;

    if (!target) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !addchat <chat-jid> [bot-number]\nBot 0: PARAG | Bot 1: ECB | Bot 2: DKB"
      );
      return;
    }

    target = normalizeJid(target) as string;
    const ok = await chatConfig.addChat(target, isNaN(botNumber) ? 0 : botNumber);
    if (ok) {
      const chatEntry = chatConfig.getChatEntryByJid(target);
      const idLabel = chatEntry ? ` (ID: ${chatEntry.id})` : "";
      try {
        const { logAction } = await import("../../storage/core/auditRepository");
        await logAction(
          ctx.senderId || "unknown",
          "add_chat",
          chatEntry ? String(chatEntry.id) : null,
          target,
          JSON.stringify({ botNumber: isNaN(botNumber) ? 0 : botNumber })
        );
      } catch (e) {}
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `Added chat (${target}) to chat allowlist${idLabel} (Bot ${isNaN(botNumber) ? 0 : botNumber}).`
      );
    } else {
      await sendBotReply(ctx.sock, ctx.from, `Failed to add ${target}. Ensure it's a valid chat JID.`);
    }
  }
});

// ── RM GROUP (WITH DIALOG CONFIRMATION INTERCEPT) ──
registerCommand({
  name: "rmgroup",
  requiresAdmin: true,
  handler: async (ctx) => {
    const rawArgs = ctx.cmdArgs.join(" ").trim();
    const match = rawArgs.match(/^-id\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !rmgroup -id <id_number>\nExample: !rmgroup -id 4"
      );
      return;
    }

    const groupId = parseInt(match[1], 10);
    const groupEntry = groupConfig.getGroupEntryById(groupId);
    if (!groupEntry) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `No group found in the allowlist with ID ${groupId}.`
      );
      return;
    }

    const groupName = await safeGetGroupName(ctx.sock, groupEntry.jid);

    ctx.session.pendingDeleteGroup = {
      id: groupId,
      jid: groupEntry.jid,
      botNumber: groupEntry.botNumber,
    };

    const botLabel = groupEntry.botNumber === 1 ? "ECB" : groupEntry.botNumber === 2 ? "DKB" : "PARAG";

    await sendBotReply(
      ctx.sock,
      ctx.from,
      `Are you sure you want to remove Group ID: ${groupId} | Name: ${groupName} | JID: ${groupEntry.jid} | Bot: ${groupEntry.botNumber} (${botLabel}) from the allowlist?\n(Enter !YES for confirmation)`
    );

    const sessionKey = buildSessionKey(ctx.from, ctx.senderId);
    await saveSession(sessionKey, ctx.session);
  }
});

// ── RM CHAT (WITH DIALOG CONFIRMATION INTERCEPT) ──
registerCommand({
  name: "rmchat",
  requiresAdmin: true,
  handler: async (ctx) => {
    const rawArgs = ctx.cmdArgs.join(" ").trim();
    const match = rawArgs.match(/^-id\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !rmchat -id <id_number>\nExample: !rmchat -id 4"
      );
      return;
    }

    const chatId = parseInt(match[1], 10);
    const chatEntry = chatConfig.getChatEntryById(chatId);
    if (!chatEntry) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `No chat found in the allowlist with ID ${chatId}.`
      );
      return;
    }

    ctx.session.pendingDeleteChat = {
      id: chatId,
      jid: chatEntry.jid,
      botNumber: chatEntry.botNumber,
    };

    const botLabel = chatEntry.botNumber === 1 ? "ECB" : chatEntry.botNumber === 2 ? "DKB" : "PARAG";

    await sendBotReply(
      ctx.sock,
      ctx.from,
      `Are you sure you want to remove Chat ID: ${chatId} | JID: ${chatEntry.jid} | Bot: ${chatEntry.botNumber} (${botLabel}) from the allowlist?\n(Enter !YES for confirmation)`
    );

    const sessionKey = buildSessionKey(ctx.from, ctx.senderId);
    await saveSession(sessionKey, ctx.session);
  }
});

// ── EDIT GROUP (WITH DIALOG CONFIRMATION INTERCEPT) ──
registerCommand({
  name: "editgroup",
  requiresAdmin: true,
  handler: async (ctx) => {
    const rawArgs = ctx.cmdArgs.join(" ").trim();
    const match = rawArgs.match(/^-id\s+(\d+)\s+-b\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !editgroup -id <id_number> -b <bot_number>\nExample: !editgroup -id 4 -b 2"
      );
      return;
    }

    const groupId = parseInt(match[1], 10);
    const newBotNumber = parseInt(match[2], 10);

    const groupEntry = groupConfig.getGroupEntryById(groupId);
    if (!groupEntry) {
      await sendBotReply(ctx.sock, ctx.from, `No group found in the allowlist with ID ${groupId}.`);
      return;
    }

    if (groupEntry.botNumber === newBotNumber) {
      await sendBotReply(ctx.sock, ctx.from, `Group is already using bot ${newBotNumber}.`);
      return;
    }

    const groupName = await safeGetGroupName(ctx.sock, groupEntry.jid);

    ctx.session.pendingEditGroup = {
      id: groupId,
      jid: groupEntry.jid,
      botNumber: newBotNumber,
    };

    const oldBotLabel = groupEntry.botNumber === 1 ? "ECB" : groupEntry.botNumber === 2 ? "DKB" : "PARAG";
    const newBotLabel = newBotNumber === 1 ? "ECB" : newBotNumber === 2 ? "DKB" : "PARAG";

    await sendBotReply(
      ctx.sock,
      ctx.from,
      `Are you sure you want to change Group ID: ${groupId} | Name: ${groupName} | JID: ${groupEntry.jid} to use Bot ${newBotNumber} (${newBotLabel}) instead of Bot ${groupEntry.botNumber} (${oldBotLabel})?\n(Enter !YES for confirmation)`
    );

    const sessionKey = buildSessionKey(ctx.from, ctx.senderId);
    await saveSession(sessionKey, ctx.session);
  }
});

// ── EDIT CHAT (WITH DIALOG CONFIRMATION INTERCEPT) ──
registerCommand({
  name: "editchat",
  requiresAdmin: true,
  handler: async (ctx) => {
    const rawArgs = ctx.cmdArgs.join(" ").trim();
    const match = rawArgs.match(/^-id\s+(\d+)\s+-b\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !editchat -id <id_number> -b <bot_number>\nExample: !editchat -id 4 -b 2"
      );
      return;
    }

    const chatId = parseInt(match[1], 10);
    const newBotNumber = parseInt(match[2], 10);

    const chatEntry = chatConfig.getChatEntryById(chatId);
    if (!chatEntry) {
      await sendBotReply(ctx.sock, ctx.from, `No chat found in the allowlist with ID ${chatId}.`);
      return;
    }

    if (chatEntry.botNumber === newBotNumber) {
      await sendBotReply(ctx.sock, ctx.from, `Chat is already using bot ${newBotNumber}.`);
      return;
    }

    ctx.session.pendingEditChat = {
      id: chatId,
      jid: chatEntry.jid,
      botNumber: newBotNumber,
    };

    const oldBotLabel = chatEntry.botNumber === 1 ? "ECB" : chatEntry.botNumber === 2 ? "DKB" : "PARAG";
    const newBotLabel = newBotNumber === 1 ? "ECB" : newBotNumber === 2 ? "DKB" : "PARAG";

    await sendBotReply(
      ctx.sock,
      ctx.from,
      `Are you sure you want to change Chat ID: ${chatId} | JID: ${chatEntry.jid} to use Bot ${newBotNumber} (${newBotLabel}) instead of Bot ${chatEntry.botNumber} (${oldBotLabel})?\n(Enter !YES for confirmation)`
    );

    const sessionKey = buildSessionKey(ctx.from, ctx.senderId);
    await saveSession(sessionKey, ctx.session);
  }
});

// ── DISABLE GROUP ──
registerCommand({
  name: "disablegroup",
  requiresAdmin: true,
  handler: async (ctx) => {
    const rawArgs = ctx.cmdArgs.join(" ").trim();
    const match = rawArgs.match(/^-id\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !disablegroup -id <id_number>\nExample: !disablegroup -id 4");
      return;
    }

    const groupId = parseInt(match[1], 10);
    const groupEntry = groupConfig.getGroupEntryById(groupId);
    if (!groupEntry) {
      await sendBotReply(ctx.sock, ctx.from, `No group found in the allowlist with ID ${groupId}.`);
      return;
    }

    const ok = await groupConfig.setGroupEnabled(groupId, false);
    if (ok) {
      try {
        const { logAction } = await import("../../storage/core/auditRepository");
        await logAction(ctx.senderId || "unknown", "disable_group", String(groupId), groupEntry.jid, JSON.stringify({ enabled: false }));
      } catch (e) {}
      await sendBotReply(ctx.sock, ctx.from, `Disabled Group ID: ${groupId} | JID: ${groupEntry.jid}. The bot will not respond in this group.`);
    } else {
      await sendBotReply(ctx.sock, ctx.from, `Failed to disable Group ID: ${groupId}.`);
    }
  }
});

// ── DISABLE CHAT ──
registerCommand({
  name: "disablechat",
  requiresAdmin: true,
  handler: async (ctx) => {
    const rawArgs = ctx.cmdArgs.join(" ").trim();
    const match = rawArgs.match(/^-id\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !disablechat -id <id_number>\nExample: !disablechat -id 4");
      return;
    }

    const chatId = parseInt(match[1], 10);
    const chatEntry = chatConfig.getChatEntryById(chatId);
    if (!chatEntry) {
      await sendBotReply(ctx.sock, ctx.from, `No chat found in the allowlist with ID ${chatId}.`);
      return;
    }

    const ok = await chatConfig.setChatEnabled(chatId, false);
    if (ok) {
      try {
        const { logAction } = await import("../../storage/core/auditRepository");
        await logAction(ctx.senderId || "unknown", "disable_chat", String(chatId), chatEntry.jid, JSON.stringify({ enabled: false }));
      } catch (e) {}
      await sendBotReply(ctx.sock, ctx.from, `Disabled Chat ID: ${chatId} | JID: ${chatEntry.jid}. The bot will not respond in this chat.`);
    } else {
      await sendBotReply(ctx.sock, ctx.from, `Failed to disable Chat ID: ${chatId}.`);
    }
  }
});

// ── ENABLE GROUP ──
registerCommand({
  name: "enablegroup",
  requiresAdmin: true,
  handler: async (ctx) => {
    const rawArgs = ctx.cmdArgs.join(" ").trim();
    const match = rawArgs.match(/^-id\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !enablegroup -id <id_number>\nExample: !enablegroup -id 4");
      return;
    }

    const groupId = parseInt(match[1], 10);
    const groupEntry = groupConfig.getGroupEntryById(groupId);
    if (!groupEntry) {
      await sendBotReply(ctx.sock, ctx.from, `No group found in the allowlist with ID ${groupId}.`);
      return;
    }

    const ok = await groupConfig.setGroupEnabled(groupId, true);
    if (ok) {
      try {
        const { logAction } = await import("../../storage/core/auditRepository");
        await logAction(ctx.senderId || "unknown", "enable_group", String(groupId), groupEntry.jid, JSON.stringify({ enabled: true }));
      } catch (e) {}
      await sendBotReply(ctx.sock, ctx.from, `Enabled Group ID: ${groupId} | JID: ${groupEntry.jid}. The bot is now active in this group.`);
    } else {
      await sendBotReply(ctx.sock, ctx.from, `Failed to enable Group ID: ${groupId}.`);
    }
  }
});

// ── ENABLE CHAT ──
registerCommand({
  name: "enablechat",
  requiresAdmin: true,
  handler: async (ctx) => {
    const rawArgs = ctx.cmdArgs.join(" ").trim();
    const match = rawArgs.match(/^-id\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !enablechat -id <id_number>\nExample: !enablechat -id 4");
      return;
    }

    const chatId = parseInt(match[1], 10);
    const chatEntry = chatConfig.getChatEntryById(chatId);
    if (!chatEntry) {
      await sendBotReply(ctx.sock, ctx.from, `No chat found in the allowlist with ID ${chatId}.`);
      return;
    }

    const ok = await chatConfig.setChatEnabled(chatId, true);
    if (ok) {
      try {
        const { logAction } = await import("../../storage/core/auditRepository");
        await logAction(ctx.senderId || "unknown", "enable_chat", String(chatId), chatEntry.jid, JSON.stringify({ enabled: true }));
      } catch (e) {}
      await sendBotReply(ctx.sock, ctx.from, `Enabled Chat ID: ${chatId} | JID: ${chatEntry.jid}. The bot is now active in this chat.`);
    } else {
      await sendBotReply(ctx.sock, ctx.from, `Failed to enable Chat ID: ${chatId}.`);
    }
  }
});

// ── FIND GROUPS ──
registerCommand({
  name: "findgroups",
  requiresAdmin: true,
  handler: async (ctx) => {
    try {
      const groups = await ctx.sock.groupFetchAllParticipating();
      const list = Object.values(groups);
      if (list.length === 0) {
        await sendBotReply(ctx.sock, ctx.from, "The bot is not currently in any groups.");
      } else {
        const listWithTime = await Promise.all(list.map(async (g: any) => {
          const lastTimeStr = await redis.get(`last_group_interaction:${g.id}`);
          const lastTime = lastTimeStr ? parseInt(lastTimeStr, 10) : 0;
          return { g, lastTime };
        }));
        listWithTime.sort((a, b) => b.lastTime - a.lastTime);
        const top30 = listWithTime.slice(0, 30).map(item => item.g);
        const formatted = top30.map((g: any, idx) => `${idx + 1}. ${g.subject} | JID: ${g.id}`);
        await sendBotReply(ctx.sock, ctx.from, `Groups the bot is in:\n${formatted.join("\n")}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sendBotReply(ctx.sock, ctx.from, `Failed to fetch groups:\n${msg}`);
    }
  }
});

// ── DEPRECATED CHANGEBOT ──
registerCommand({
  name: "changebot",
  requiresAdmin: true,
  handler: async (ctx) => {
    await sendBotReply(
      ctx.sock,
      ctx.from,
      "The !changebot command has been deprecated. Please use !editgroup or !editchat instead.\nExample: !editgroup -id 4 -b 2"
    );
  }
});

// ── NEON PING ──
registerCommand({
  name: "neonping",
  requiresAdmin: true,
  handler: async (ctx) => {
    try {
      const { getDatabaseUrl } = await import("../../storage/neonAuthStateStore");
      const dbUrl = getDatabaseUrl();
      if (!dbUrl) {
        await sendBotReply(ctx.sock, ctx.from, "Neon is NOT configured (DATABASE_URL is missing in environment variables).");
        return;
      }

      const { Pool } = await import("pg");
      const tempPool = new Pool({
        connectionString: dbUrl,
        connectionTimeoutMillis: 5000,
        ssl: { rejectUnauthorized: false },
      });
      const start = Date.now();
      await tempPool.query("SELECT 1;");
      const duration = Date.now() - start;
      await tempPool.end();

      await sendBotReply(ctx.sock, ctx.from, `✅ Neon database is currently reachable! Timestamp: ${duration}ms.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sendBotReply(ctx.sock, ctx.from, `❌ Neon database query failed:\n${msg}`);
    }
  }
});

// ── NEON RECONNECT ──
registerCommand({
  name: "neonconnect",
  requiresAdmin: true,
  handler: async (ctx) => {
    await sendBotReply(
      ctx.sock,
      ctx.from,
      "⏳ Initiating hard reconnect. The bot will exit and allow the environment manager (e.g. Render) to restart it cleanly with Neon connection..."
    );
    setTimeout(() => {
      process.exit(1);
    }, 2000);
  }
});

// ── MANAGE ROLE ──
registerCommand({
  name: "manage",
  handler: async (ctx) => {
    let botNumber = 0;
    if (ctx.from?.endsWith("@g.us")) {
      const groupBot = groupConfig.getGroupBot(ctx.from);
      botNumber = groupBot?.botNumber || 0;
    } else {
      const chatBot = chatConfig.getChatBot(ctx.from);
      botNumber = chatBot?.botNumber || 0;
    }

    if (botNumber !== 2) {
      await sendBotReply(ctx.sock, ctx.from, "Error: This command is only available for Bot 2 (DKB).");
      return;
    }

    const isManageAdmin = isAdminAction(ctx.msg, ctx.senderId);
    const { userHasPermission } = await import("../../storage/core/rbacRepository");
    const isManageAuthorized = isManageAdmin || (ctx.senderId && await userHasPermission(ctx.senderId, "role.manage"));

    if (!isManageAuthorized) {
      await sendBotReply(ctx.sock, ctx.from, "Unauthorized: you need admin privileges or the role.manage permission to use this command.");
      return;
    }

    const arg1 = ctx.cmdArgs[0];
    const arg2 = ctx.cmdArgs[1];

    if (!arg1 || !arg2) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: \n!manage <work> <+phone_number>\n!manage <work> -l\n!manage <+phone_number> -p\nExample: !manage mentor +919902849280\nExample: !manage mentor -l\nExample: !manage +919902849280 -p"
      );
      return;
    }

    if (arg2 === "-p") {
      let targetJid = "";
      const inputLabel = arg1.trim();

      if (inputLabel.includes("@")) {
        const normalized = normalizeJid(inputLabel);
        if (normalized && (normalized.endsWith("@s.whatsapp.net") || normalized.endsWith("@lid"))) {
          targetJid = normalized;
        }
      }

      if (!targetJid && /^\d{7,20}$/.test(inputLabel)) {
        targetJid = `${inputLabel}@s.whatsapp.net`;
      }

      if (!targetJid) {
        const numberMatch = inputLabel.match(/^\+(\d{7,15})$/);
        if (!numberMatch) {
          await sendBotReply(
            ctx.sock,
            ctx.from,
            "Error: Target must be a JID/LID (e.g. 123@s.whatsapp.net, 456@lid) or a phone number starting with + (e.g. +919902849280)."
          );
          return;
        }
        const rawPhone = numberMatch[1];
        targetJid = `${rawPhone}@s.whatsapp.net`;
        try {
          const waResult = await ctx.sock.onWhatsApp(rawPhone);
          if (waResult && waResult.length > 0 && waResult[0].exists) {
            targetJid = waResult[0].jid;
          } else {
            await sendBotReply(ctx.sock, ctx.from, `Number +${rawPhone} is not registered on WhatsApp.`);
            return;
          }
        } catch(err) {
          console.error("onWhatsApp error:", err);
        }
      }

      let effectiveQueryJid = targetJid;
      if (targetJid.endsWith("@lid")) {
        try {
          const { resolvePhoneJidFromLid } = await import("../../storage/core/rbacRepository");
          const resolved = await resolvePhoneJidFromLid(targetJid);
          if (resolved) effectiveQueryJid = resolved;
        } catch (_) {}
      }

      try {
        const { getUserRoles } = await import("../../storage/core/rbacRepository");
        let roles = await getUserRoles(effectiveQueryJid);
        if (roles.length === 0 && effectiveQueryJid !== targetJid) {
          roles = await getUserRoles(targetJid);
        }

        if (roles.length === 0) {
          await ctx.sock.sendMessage(targetJid, {
            text: "You currently have no special roles assigned.",
          });
        } else if (roles.length === 1) {
          await ctx.sock.sendMessage(targetJid, {
            text: `You have received the role of ${roles[0]}`
          });
        } else {
          const formattedRoles = roles.slice(0, -1).join(", ") + " & " + roles[roles.length - 1];
          await ctx.sock.sendMessage(targetJid, {
            text: `You have received the role of ${roles[roles.length - 1]}! You now have ${formattedRoles}`
          });
        }
        await sendBotReply(ctx.sock, ctx.from, `Successfully sent role notification check to ${arg1}.`);
      } catch (e) {
        await sendBotReply(ctx.sock, ctx.from, `Failed to send role notification to ${arg1}.`);
      }
      return;
    }

    const normalizedWork = arg1.trim().toLowerCase();

    if (arg2 === "-l") {
      const { getUsersWithRole } = await import("../../storage/core/rbacRepository");
      const users = await getUsersWithRole(normalizedWork);
      if (users.length === 0) {
        await sendBotReply(ctx.sock, ctx.from, `No users found with role "${normalizedWork}".`);
      } else {
        const formattedUsers = users
          .map((j) => {
            if (j.endsWith("@lid")) {
              return `${j.split("@")[0]} (LID)`;
            }
            return `+${j.split("@")[0]}`;
          })
          .join("\n");
        await sendBotReply(ctx.sock, ctx.from, `Users with role "${normalizedWork}":\n${formattedUsers}`);
      }
      return;
    }

    let targetJid = "";
    const inputLabel = arg2.trim();

    if (inputLabel.includes("@")) {
      const normalized = normalizeJid(inputLabel);
      if (normalized && (normalized.endsWith("@s.whatsapp.net") || normalized.endsWith("@lid"))) {
        targetJid = normalized;
      }
    }

    if (!targetJid && /^\d{7,20}$/.test(inputLabel)) {
      targetJid = `${inputLabel}@s.whatsapp.net`;
    }

    if (!targetJid) {
      const numberMatch = inputLabel.match(/^\+(\d{7,15})$/);
      if (!numberMatch) {
        await sendBotReply(
          ctx.sock,
          ctx.from,
          "Error: Target must be a JID/LID (e.g. 123@s.whatsapp.net, 456@lid) or a phone number starting with + (e.g. +919902849280)."
        );
        return;
      }
      const rawPhone = numberMatch[1];
      targetJid = `${rawPhone}@s.whatsapp.net`;

      try {
        const waResult = await ctx.sock.onWhatsApp(rawPhone);
        if (waResult && waResult.length > 0 && waResult[0].exists) {
          targetJid = waResult[0].jid;
        } else {
          await sendBotReply(ctx.sock, ctx.from, `Warning: Number +${rawPhone} does not appear to be registered on WhatsApp. Cannot assign role.`);
          return;
        }
      } catch(err) {
        console.error("onWhatsApp error:", err);
      }
    }

    const { addManagedRole } = await import("../../storage/core/rbacRepository");
    const { storeLidPhoneMapping } = await import("../../storage/core/rbacRepository");
    let resolvedPhoneJid: string | null = null;
    let resolvedLid: string | null = null;

    if (targetJid.endsWith("@lid")) {
      resolvedLid = targetJid;
      try {
        const { resolvePhoneJidFromLid } = await import("../../storage/core/rbacRepository");
        resolvedPhoneJid = await resolvePhoneJidFromLid(resolvedLid);
      } catch (_) {}

      if (!resolvedPhoneJid && ctx.from?.endsWith("@g.us")) {
        try {
          const meta = await ctx.sock.groupMetadata(ctx.from);
          const match = meta.participants.find((p: any) => {
            const pid = p.id ? (normalizeJid(p.id) ?? "").toLowerCase() : "";
            const plid = p.lid ? (normalizeJid(p.lid) ?? "").toLowerCase() : "";
            const targetLower = resolvedLid!.toLowerCase();
            return pid === targetLower || plid === targetLower;
          });
          if (match) {
            const pid = match.id ? normalizeJid(match.id) : null;
            const ppn = match.phoneNumber ? normalizeJid(match.phoneNumber) : null;
            if (pid && pid.endsWith("@s.whatsapp.net")) {
              resolvedPhoneJid = pid;
            } else if (ppn && ppn.endsWith("@s.whatsapp.net")) {
              resolvedPhoneJid = ppn;
            }
          }
        } catch (_) {}
      }
    } else if (targetJid.endsWith("@s.whatsapp.net")) {
      resolvedPhoneJid = targetJid;
      if (ctx.from?.endsWith("@g.us")) {
        try {
          const meta = await ctx.sock.groupMetadata(ctx.from);
          const match = meta.participants.find((p: any) => {
            const pid = p.id ? (normalizeJid(p.id) ?? "").toLowerCase() : "";
            const ppn = p.phoneNumber ? (normalizeJid(p.phoneNumber) ?? "").toLowerCase() : "";
            const targetLower = resolvedPhoneJid!.toLowerCase();
            return pid === targetLower || ppn === targetLower;
          });
          if (match) {
            const pid = match.id ? normalizeJid(match.id) : null;
            const plid = match.lid ? normalizeJid(match.lid) : null;
            if (pid && pid.endsWith("@lid")) {
              resolvedLid = pid;
            } else if (plid && plid.endsWith("@lid")) {
              resolvedLid = plid;
            }
          }
        } catch (_) {}
      }
    }

    if (resolvedLid && resolvedPhoneJid) {
      await storeLidPhoneMapping(resolvedLid, resolvedPhoneJid);
    }

    const roleJid = resolvedPhoneJid || targetJid;
    const ok = await addManagedRole(roleJid, normalizedWork);

    if (ok) {
      await sendBotReply(ctx.sock, ctx.from, `Successfully assigned role "${normalizedWork}" to ${arg2}.`);
    } else {
      await sendBotReply(ctx.sock, ctx.from, "Failed to assign role. Ensure the database connection is healthy and the role is valid.");
    }
  }
});

// ── CREATE ROLE / ACCESS ROLE DIALOG ──
registerCommand({
  name: "role",
  handler: async (ctx) => {
    let botNumber = 0;
    if (ctx.from?.endsWith("@g.us")) {
      const groupBot = groupConfig.getGroupBot(ctx.from);
      botNumber = groupBot?.botNumber || 0;
    } else {
      const chatBot = chatConfig.getChatBot(ctx.from);
      botNumber = chatBot?.botNumber || 0;
    }

    if (botNumber !== 2) {
      await sendBotReply(ctx.sock, ctx.from, "Error: This command is only available for Bot 2 (DKB).");
      return;
    }

    const isRoleAdmin = isAdminAction(ctx.msg, ctx.senderId);
    const { userHasPermission } = await import("../../storage/core/rbacRepository");
    const isRoleAuthorized = isRoleAdmin || (ctx.senderId && await userHasPermission(ctx.senderId, "role.manage"));

    if (!isRoleAuthorized) {
      await sendBotReply(ctx.sock, ctx.from, "Unauthorized: you need admin privileges or the role.manage permission to use this command.");
      return;
    }

    const roleArg = ctx.cmdArgs.join(" ").trim();
    if (!roleArg) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !role <role_name>\nExample: !role organizer");
      return;
    }

    const { handleCreateCommand } = await import("../../services/core/rbacService");
    await handleCreateCommand(roleArg, ctx.session, async (replyText) => {
      await sendBotReply(ctx.sock, ctx.from, replyText);
    });

    const sessionKey = buildSessionKey(ctx.from, ctx.senderId);
    await saveSession(sessionKey, ctx.session);
  }
});

registerCommand({
  name: "createrole",
  handler: async (ctx) => {
    // Delegate createrole to same handler
    const registry = (await import("./commandRegistry")).dispatchCommand;
    await registry({ ...ctx, cmdName: "role" });
  }
});

// ── REVEAL VIEW-ONCE MEDIA ──
registerCommand({
  name: "reveal",
  handler: async (ctx) => {
    const isRevealAuthorized = isAdminAction(ctx.msg, ctx.senderId);
    if (!isRevealAuthorized) {
      await sendBotReply(ctx.sock, ctx.from, "Unauthorized: admin privileges required for this command.");
      return;
    }

    const contextInfo = ctx.msg.message?.extendedTextMessage?.contextInfo;
    let targetMsg: any = null;
    let sourceLabel = "";

    if (contextInfo && contextInfo.quotedMessage) {
      targetMsg = {
        key: {
          remoteJid: ctx.from,
          id: contextInfo.stanzaId,
          participant: contextInfo.participant
        },
        message: contextInfo.quotedMessage
      };
      sourceLabel = "quoted message";
    } else {
      const cachedJson = await redis.get(`latest_view_once:${ctx.from}`);
      if (cachedJson) {
        try {
          targetMsg = JSON.parse(cachedJson);
          sourceLabel = "latest cached view-once message";
        } catch (e) {
          console.error("Failed to parse cached view-once message:", e);
        }
      }
    }

    if (!targetMsg || !targetMsg.message) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Error: No quoted message provided, and no recent view-once media was found in this chat."
      );
      return;
    }

    const unwrapped = unwrapMessage(targetMsg.message);
    if (!unwrapped) {
      await sendBotReply(ctx.sock, ctx.from, "Error: Decrypted message has invalid structure.");
      return;
    }

    const viewOnceContainer = unwrapped.viewOnceMessage 
      || unwrapped.viewOnceMessageV2 
      || unwrapped.viewOnceMessageV2Lid;

    let mediaMsg = unwrapped;
    let isViewOnce = false;
    if (viewOnceContainer && viewOnceContainer.message) {
      mediaMsg = viewOnceContainer.message;
      isViewOnce = true;
    }

    const imageInfo = mediaMsg.imageMessage;
    const videoInfo = mediaMsg.videoMessage;
    const audioInfo = mediaMsg.audioMessage;
    const docInfo = mediaMsg.documentMessage;

    if (!imageInfo && !videoInfo && !audioInfo && !docInfo) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `Error: The ${sourceLabel} does not contain decryptable media (image, video, audio, or document).`
      );
      return;
    }

    const targetPrivateJid = ctx.senderId || ctx.from || "";

    try {
      const buffer = await downloadMediaMessage(
        targetMsg,
        "buffer",
        {}
      ) as Buffer;

      if (imageInfo) {
        await ctx.sock.sendMessage(targetPrivateJid, {
          image: buffer,
          caption: isViewOnce ? "🔓 Revealed View Once Photo!" : "Decrypted Photo!"
        });
      } else if (videoInfo) {
        await ctx.sock.sendMessage(targetPrivateJid, {
          video: buffer,
          caption: isViewOnce ? "🔓 Revealed View Once Video!" : "Decrypted Video!"
        });
      } else if (audioInfo) {
        await ctx.sock.sendMessage(targetPrivateJid, {
          audio: buffer,
          mimetype: audioInfo.mimetype || "audio/mp4",
          ptt: audioInfo.ptt || false
        });
      } else if (docInfo) {
        await ctx.sock.sendMessage(targetPrivateJid, {
          document: buffer,
          mimetype: docInfo.mimetype || "application/octet-stream",
          fileName: docInfo.fileName || "revealed_file"
        });
      }

      await sendBotReply(
        ctx.sock,
        ctx.from,
        `🔓 Decrypted and sent the ${sourceLabel} privately to your DM. Check your private chat!`
      );

    } catch (err) {
      console.error("Failed to decrypt view-once media:", err);
      try {
        await ctx.sock.sendMessage(targetPrivateJid, {
          text: `⚠️ Error: The view-once media could not be decrypted or downloaded. It may have expired, already been viewed, or been deleted from the WhatsApp servers.`
        });
      } catch (_) {}

      await sendBotReply(
        ctx.sock,
        ctx.from,
        "⚠️ Failed to reveal media. A direct message explaining the error has been sent to your private chat."
      );
    }
  }
});
