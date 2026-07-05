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

// ── ADD (unified: !add -g|-c [jid] [-b <0-3>]) ──
// -g group, -c chat. Omit the jid to add the CURRENT group/chat; default Bot 0.
// Examples: !add -c -b 2  ·  !add -g 12036...@g.us -b 2
registerCommand({
  name: "add",
  requiresAdmin: true,
  handler: async (ctx) => {
    const toks = [...ctx.cmdArgs];

    // -b <n> (optional bot number, 0-3, default 0)
    let botNumber = 0;
    const bi = toks.findIndex((t) => t.toLowerCase() === "-b");
    if (bi !== -1) {
      botNumber = parseInt(toks[bi + 1] || "", 10);
      toks.splice(bi, 2);
    }
    if (isNaN(botNumber) || botNumber < 0 || botNumber > 3) botNumber = 0;

    const wantGroup = toks.some((t) => t.toLowerCase() === "-g");
    const wantChat = toks.some((t) => t.toLowerCase() === "-c");
    const rest = toks.filter(
      (t) => t.toLowerCase() !== "-g" && t.toLowerCase() !== "-c",
    );
    const explicit = rest[0] ? (normalizeJid(rest[0]) as string) : "";

    if (wantGroup === wantChat) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !add -g|-c [jid] [-b <0-3>]\n-g group, -c chat. Omit the jid to add THIS chat/group. Default Bot 0.\nExamples: !add -c -b 2  |  !add -g 12036...@g.us -b 2",
      );
      return;
    }

    if (wantGroup) {
      const jid = explicit || (ctx.from.endsWith("@g.us") ? ctx.from : "");
      if (!jid || !jid.endsWith("@g.us")) {
        await sendBotReply(
          ctx.sock,
          ctx.from,
          "Run !add -g inside the group, or pass a group JID (…@g.us).",
        );
        return;
      }
      const ok = await groupConfig.addGroup(jid, botNumber);
      if (!ok) {
        await sendBotReply(ctx.sock, ctx.from, `Failed to add ${jid}.`);
        return;
      }
      const entry = groupConfig.getGroupEntryByJid(jid);
      const idLabel = entry ? ` (ID: ${entry.id})` : "";
      const name = await safeGetGroupName(ctx.sock, jid);
      try {
        const { logAction } = await import("../../../storage/core/auditRepository");
        await logAction(
          ctx.senderId || "unknown",
          "add_group",
          entry ? String(entry.id) : null,
          jid,
          JSON.stringify({ botNumber }),
        );
      } catch {}
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `Added group ${name} (${jid})${idLabel} | Bot ${botNumber} (${botLabel(botNumber)}).`,
      );
      return;
    }

    // chat
    const jid = explicit || ctx.from;
    if (!jid || jid.endsWith("@g.us")) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Run !add -c inside the chat, or pass a chat JID (…@s.whatsapp.net).",
      );
      return;
    }
    const ok = await chatConfig.addChat(jid, botNumber);
    if (!ok) {
      await sendBotReply(ctx.sock, ctx.from, `Failed to add ${jid}.`);
      return;
    }
    const entry = chatConfig.getChatEntryByJid(jid);
    const idLabel = entry ? ` (ID: ${entry.id})` : "";
    const name = await safeGetContactName(jid);
    try {
      const { logAction } = await import("../../../storage/core/auditRepository");
      await logAction(
        ctx.senderId || "unknown",
        "add_chat",
        entry ? String(entry.id) : null,
        jid,
        JSON.stringify({ botNumber }),
      );
    } catch {}
    await sendBotReply(
      ctx.sock,
      ctx.from,
      `Added chat ${name} (${jid})${idLabel} | Bot ${botNumber} (${botLabel(botNumber)}).`,
    );
  },
});

// ── RM (unified: !rm -g|-c <id>) — confirmation via !YES ──
registerCommand({
  name: "rm",
  requiresAdmin: true,
  handler: async (ctx) => {
    const toks = [...ctx.cmdArgs];
    const wantGroup = toks.some((t) => /^-g(id)?$/i.test(t));
    const wantChat = toks.some((t) => /^-c(id)?$/i.test(t));
    const rest = toks.filter((t) => !/^-(g|c)(id)?$/i.test(t));
    const id = parseInt(rest[0] || "", 10);

    if (wantGroup === wantChat || isNaN(id)) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !rm -g <group_id> | !rm -c <chat_id>\nUse !listgroups / !listchats to find the id.",
      );
      return;
    }

    if (wantGroup) {
      const entry = groupConfig.getGroupEntryById(id);
      if (!entry) {
        await sendBotReply(ctx.sock, ctx.from, `No group found with ID ${id}.`);
        return;
      }
      const name = await safeGetGroupName(ctx.sock, entry.jid);
      ctx.session.pendingDeleteGroup = {
        id,
        jid: entry.jid,
        botNumber: entry.botNumber,
      };
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `Remove Group ID: ${id} | Name: ${name} | JID: ${entry.jid} | Bot: ${entry.botNumber} (${botLabel(entry.botNumber)})?\n(Enter !YES to confirm)`,
      );
      await saveSession(buildSessionKey(ctx.from, ctx.senderId), ctx.session);
      return;
    }

    const entry = chatConfig.getChatEntryById(id);
    if (!entry) {
      await sendBotReply(ctx.sock, ctx.from, `No chat found with ID ${id}.`);
      return;
    }
    const name = await safeGetContactName(entry.jid);
    ctx.session.pendingDeleteChat = {
      id,
      jid: entry.jid,
      botNumber: entry.botNumber,
    };
    await sendBotReply(
      ctx.sock,
      ctx.from,
      `Remove Chat ID: ${id} | Name: ${name} | JID: ${entry.jid} | Bot: ${entry.botNumber} (${botLabel(entry.botNumber)})?\n(Enter !YES to confirm)`,
    );
    await saveSession(buildSessionKey(ctx.from, ctx.senderId), ctx.session);
  },
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
// Lists every group the bot participates in, most-recently-active first.
// Supports -f <filter> (name/JID) and -p <page>, paginated at the shared size.
registerCommand({
  name: "findgroups",
  requiresAdmin: true,
  handler: async (ctx) => {
    try {
      const rawArgs = ctx.cmdArgs.join(" ").trim();
      let filter = "";
      const filterMatch = rawArgs.match(/-f\s+([^\-]+)/i);
      if (filterMatch) {
        filter = filterMatch[1].trim().toLowerCase();
      } else {
        const noFlags = rawArgs.match(/^[^\-]*$/);
        if (noFlags && rawArgs.length > 0) filter = rawArgs.toLowerCase();
      }
      let page = 1;
      const pageMatch = rawArgs.match(/-p\s+(\d+)/i);
      if (pageMatch) {
        page = parseInt(pageMatch[1], 10);
        if (isNaN(page) || page < 1) page = 1;
      }

      const groups = await ctx.sock.groupFetchAllParticipating();
      let list = Object.values(groups) as any[];
      if (list.length === 0) {
        await sendBotReply(ctx.sock, ctx.from, "The bot is not currently in any groups.");
        return;
      }

      // Sort by most-recent bot interaction (0 = never seen).
      const withTime = await Promise.all(
        list.map(async (g: any) => {
          const t = await redis.get(`last_group_interaction:${g.id}`);
          return { g, lastTime: t ? parseInt(t, 10) : 0 };
        }),
      );
      withTime.sort((a, b) => b.lastTime - a.lastTime);
      let sorted = withTime.map((x) => x.g);

      if (filter) {
        sorted = sorted.filter(
          (g: any) =>
            (g.subject || "").toLowerCase().includes(filter) ||
            String(g.id).toLowerCase().includes(filter),
        );
      }
      if (sorted.length === 0) {
        await sendBotReply(ctx.sock, ctx.from, `No groups match "${filter}".`);
        return;
      }

      const { paginate, PAGINATION_MAX_VIEW } = await import(
        "../../../services/DKB/pagination"
      );
      const { pageItems, page: p, totalPages, total } = paginate(sorted, page);
      const offset = (p - 1) * PAGINATION_MAX_VIEW;
      const formatted = pageItems.map(
        (g: any, idx) => `${offset + idx + 1}. ${g.subject} | JID: ${g.id}`,
      );
      const header = filter
        ? `Groups matching "${filter}" (${total}):`
        : `Groups the bot is in (${total}, recent first):`;
      const footer =
        totalPages > 1
          ? `\n\nPage ${p}/${totalPages}${p < totalPages ? ` — !findgroups -p ${p + 1} for more.` : ""}`
          : "";
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `${header}\n${formatted.join("\n")}${footer}`,
      );
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

      const { PAGINATION_MAX_VIEW: PAGE_SIZE } = await import(
        "../../../services/DKB/pagination"
      );
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
