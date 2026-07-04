import { registerCommand } from "../commandRegistry";
import groupConfig from "../../../config/groupAllowlist";
import chatConfig from "../../../config/chatAllowlist";
import { sendBotReply, safeGetGroupName, safeGetContactName, buildSessionKey } from "../../../bot";
import { normalizeJid } from "../../../security/rbac";
import { saveSession } from "../../state";
import { redis } from "../../../storage/redisClient";
import { botLabel } from "../../../agents/core/botLabels";

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
        const statusLabel = entry.enabled ? "Enabled" : "Disabled";
        const groupName = await safeGetGroupName(ctx.sock, entry.jid);
        return `${entry.id}. ${groupName} (${entry.jid}) | Bot ${entry.botNumber} (${botLabel(entry.botNumber)}) | [${statusLabel}]`;
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
      const formattedPromises = list.map(async (entry) => {
        const statusLabel = entry.enabled ? "Enabled" : "Disabled";
        const name = await safeGetContactName(entry.jid);
        return `${entry.id}. ${name} (${entry.jid}) | Bot ${entry.botNumber} (${botLabel(entry.botNumber)}) | [${statusLabel}]`;
      });
      const formatted = await Promise.all(formattedPromises);
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
        "Usage: !addgroup <group-jid> [bot-number]\nBot 0: Generic | Bot 1: ECB | Bot 2: DKB | Bot 3: PARAG"
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
        const { logAction } = await import("../../../storage/core/auditRepository");
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
        "Usage: !addchat <chat-jid> [bot-number]\nBot 0: Generic | Bot 1: ECB | Bot 2: DKB | Bot 3: PARAG"
      );
      return;
    }

    target = normalizeJid(target) as string;
    const ok = await chatConfig.addChat(target, isNaN(botNumber) ? 0 : botNumber);
    if (ok) {
      const chatEntry = chatConfig.getChatEntryByJid(target);
      const idLabel = chatEntry ? ` (ID: ${chatEntry.id})` : "";
      try {
        const { logAction } = await import("../../../storage/core/auditRepository");
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
    const match = rawArgs.match(/^-gid\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !rmgroup -gid <group_id>\nExample: !rmgroup -gid 4"
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

    await sendBotReply(
      ctx.sock,
      ctx.from,
      `Are you sure you want to remove Group ID: ${groupId} | Name: ${groupName} | JID: ${groupEntry.jid} | Bot: ${groupEntry.botNumber} (${botLabel(groupEntry.botNumber)}) from the allowlist?\n(Enter !YES for confirmation)`
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
    const match = rawArgs.match(/^-cid\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !rmchat -cid <chat_id>\nExample: !rmchat -cid 4"
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

    const name = await safeGetContactName(chatEntry.jid);

    await sendBotReply(
      ctx.sock,
      ctx.from,
      `Are you sure you want to remove Chat ID: ${chatId} | Name: ${name} | JID: ${chatEntry.jid} | Bot: ${chatEntry.botNumber} (${botLabel(chatEntry.botNumber)}) from the allowlist?\n(Enter !YES for confirmation)`
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
    const match = rawArgs.match(/^-gid\s+(\d+)\s+-b\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !editgroup -gid <group_id> -b <bot_number>\nExample: !editgroup -gid 4 -b 2"
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

    const oldBotLabel = botLabel(groupEntry.botNumber);
    const newBotLabel = botLabel(newBotNumber);

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
    const match = rawArgs.match(/^-cid\s+(\d+)\s+-b\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !editchat -cid <chat_id> -b <bot_number>\nExample: !editchat -cid 4 -b 2"
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

    const name = await safeGetContactName(chatEntry.jid);
    const oldBotLabel = botLabel(chatEntry.botNumber);
    const newBotLabel = botLabel(newBotNumber);

    await sendBotReply(
      ctx.sock,
      ctx.from,
      `Are you sure you want to change Chat ID: ${chatId} | Name: ${name} | JID: ${chatEntry.jid} to use Bot ${newBotNumber} (${newBotLabel}) instead of Bot ${chatEntry.botNumber} (${oldBotLabel})?\n(Enter !YES for confirmation)`
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
    const match = rawArgs.match(/^-gid\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !disablegroup -gid <group_id>\nExample: !disablegroup -gid 4");
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
        const { logAction } = await import("../../../storage/core/auditRepository");
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
    const match = rawArgs.match(/^-cid\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !disablechat -cid <chat_id>\nExample: !disablechat -cid 4");
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
        const { logAction } = await import("../../../storage/core/auditRepository");
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
    const match = rawArgs.match(/^-gid\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !enablegroup -gid <group_id>\nExample: !enablegroup -gid 4");
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
        const { logAction } = await import("../../../storage/core/auditRepository");
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
    const match = rawArgs.match(/^-cid\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !enablechat -cid <chat_id>\nExample: !enablechat -cid 4");
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
        const { logAction } = await import("../../../storage/core/auditRepository");
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

// ── FIND CHATS ──
registerCommand({
  name: "findchats",
  requiresAdmin: true,
  handler: async (ctx) => {
    try {
      const rawArgs = ctx.cmdArgs.join(" ").trim();
      let filter = "";
      let page = 1;

      // Extract -f filter
      const filterMatch = rawArgs.match(/-f\s+([^\-]+)/i);
      if (filterMatch) {
        filter = filterMatch[1].trim().toLowerCase();
      } else {
        // Fallback: If they just typed "!findchats keyword" without -f or -p, use the whole string as filter
        const noFlagsMatch = rawArgs.match(/^[^\-]*$/);
        if (noFlagsMatch && rawArgs.length > 0) {
          filter = rawArgs.toLowerCase();
        }
      }

      // Extract -p page
      const pageMatch = rawArgs.match(/-p\s+(\d+)/i);
      if (pageMatch) {
        page = parseInt(pageMatch[1], 10);
        if (isNaN(page) || page < 1) page = 1;
      }

      const allContacts = await redis.hgetall("contact_names");
      if (!allContacts || Object.keys(allContacts).length === 0) {
        await sendBotReply(ctx.sock, ctx.from, "No cached contacts found in the database yet.");
        return;
      }

      let entries = Object.entries(allContacts);

      if (filter) {
        entries = entries.filter(([jid, name]) => {
          return jid.toLowerCase().includes(filter) || name.toLowerCase().includes(filter);
        });
      }

      if (entries.length === 0) {
        const msg = filter ? `No cached contacts matched your query: "${filter}"` : "No contacts found.";
        await sendBotReply(ctx.sock, ctx.from, msg);
        return;
      }

      const PAGE_SIZE = 20;
      const totalItems = entries.length;
      const totalPages = Math.ceil(totalItems / PAGE_SIZE);

      if (page > totalPages) page = totalPages;

      const startIndex = (page - 1) * PAGE_SIZE;
      const paginatedEntries = entries.slice(startIndex, startIndex + PAGE_SIZE);

      const formatted = paginatedEntries.map(([jid, name], idx) => {
        return `${startIndex + idx + 1}. ${name} | JID: ${jid}`;
      });

      let header = filter
        ? `*Chats Matching: "${filter}"*\n`
        : `*All Cached Chats*\n`;
      header += `Page ${page} of ${totalPages} (${totalItems} total contacts)\n\n`;

      const footer = `\n\nUse !findchats ${filter ? `-f ${filter} ` : ""}-p ${page + 1} for the next page.`;

      await sendBotReply(ctx.sock, ctx.from, `${header}${formatted.join("\n")}${page < totalPages ? footer : ""}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sendBotReply(ctx.sock, ctx.from, `Failed to search chats:\n${msg}`);
    }
  }
});

registerCommand({
  name: "findchat",
  requiresAdmin: true,
  handler: async (ctx) => {
    const registry = (await import("../commandRegistry")).dispatchCommand;
    await registry({ ...ctx, cmdName: "findchats" });
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
