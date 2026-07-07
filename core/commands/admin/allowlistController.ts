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

// Resolves which allowlisted group/chat a command targets: an explicit
// -gid/-cid id, else the current chat/group the command was sent in.
type ResolvedTarget =
  | { ok: true; type: "group" | "chat"; entry: { id: number; jid: string; botNumber: number } }
  | { ok: false; msg: string };

function resolveTarget(ctx: any): ResolvedTarget {
  const joined = ctx.cmdArgs.join(" ");
  const g = joined.match(/-gid\s+(\d+)/i);
  const c = joined.match(/-cid\s+(\d+)/i);
  if (g && c) return { ok: false, msg: "Specify only one of -gid / -cid." };
  if (g) {
    const id = parseInt(g[1], 10);
    const entry = groupConfig.getGroupEntryById(id);
    return entry
      ? { ok: true, type: "group", entry }
      : { ok: false, msg: `No group found with ID ${id}.` };
  }
  if (c) {
    const id = parseInt(c[1], 10);
    const entry = chatConfig.getChatEntryById(id);
    return entry
      ? { ok: true, type: "chat", entry }
      : { ok: false, msg: `No chat found with ID ${id}.` };
  }
  // Infer the current chat/group.
  if (ctx.from.endsWith("@g.us")) {
    const entry = groupConfig.getGroupEntryByJid(ctx.from);
    return entry
      ? { ok: true, type: "group", entry }
      : { ok: false, msg: "This group isn't in the allowlist. Add it with !add, or target one with -gid <id>." };
  }
  const entry = chatConfig.getChatEntryByJid(ctx.from);
  return entry
    ? { ok: true, type: "chat", entry }
    : { ok: false, msg: "This chat isn't in the allowlist. Add it with !add, or target one with -cid <id>." };
}

// ── ADD (!add [-g|-c] [jid] [-bid <0-3>]) ──
// Omit -g/-c and the jid to add THIS chat/group. Default Bot 1 when no -bid.
// Examples: !add · !add -bid 2 · !add -g 12036...@g.us -bid 2
registerCommand({
  name: "add",
  requiresAdmin: true,
  handler: async (ctx) => {
    const toks = [...ctx.cmdArgs];

    // -bid <n> (optional; default Bot 1 when adding without one).
    let botNumber = 1;
    const bi = toks.findIndex((t) => t.toLowerCase() === "-bid");
    if (bi !== -1) {
      botNumber = parseInt(toks[bi + 1] || "", 10);
      toks.splice(bi, 2);
    }
    if (isNaN(botNumber) || botNumber < 0 || botNumber > 3) botNumber = 1;

    const wantGroup = toks.some((t) => t.toLowerCase() === "-g");
    const wantChat = toks.some((t) => t.toLowerCase() === "-c");
    if (wantGroup && wantChat) {
      await sendBotReply(ctx.sock, ctx.from, "Use only one of -g / -c.");
      return;
    }
    const rest = toks.filter((t) => !/^-(g|c)$/i.test(t));
    const explicit = rest[0] ? (normalizeJid(rest[0]) as string) : "";

    // Type: explicit -g/-c, else inferred from the current chat/group.
    const type: "group" | "chat" = wantGroup
      ? "group"
      : wantChat
        ? "chat"
        : ctx.from.endsWith("@g.us")
          ? "group"
          : "chat";
    const jid = explicit || ctx.from;

    if (type === "group" && !jid.endsWith("@g.us")) {
      await sendBotReply(ctx.sock, ctx.from, "Run !add -g inside the group, or pass a group JID (…@g.us).");
      return;
    }
    if (type === "chat" && jid.endsWith("@g.us")) {
      await sendBotReply(ctx.sock, ctx.from, "Run !add -c inside the chat, or pass a chat JID (…@s.whatsapp.net).");
      return;
    }

    const logAdd = async (id: number | null) => {
      try {
        const { logAction } = await import("../../../storage/core/auditRepository");
        await logAction(ctx.senderId || "unknown", `add_${type}`, id != null ? String(id) : null, jid, JSON.stringify({ botNumber }));
      } catch {}
    };

    if (type === "group") {
      const ok = await groupConfig.addGroup(jid, botNumber);
      if (!ok) { await sendBotReply(ctx.sock, ctx.from, `Failed to add ${jid}.`); return; }
      const entry = groupConfig.getGroupEntryByJid(jid);
      await logAdd(entry ? entry.id : null);
      const name = await safeGetGroupName(ctx.sock, jid);
      await sendBotReply(ctx.sock, ctx.from, `Added group ${name} (${jid})${entry ? ` (ID: ${entry.id})` : ""} | Bot ${botNumber} (${botLabel(botNumber)}).`);
      return;
    }

    const ok = await chatConfig.addChat(jid, botNumber);
    if (!ok) { await sendBotReply(ctx.sock, ctx.from, `Failed to add ${jid}.`); return; }
    const entry = chatConfig.getChatEntryByJid(jid);
    await logAdd(entry ? entry.id : null);
    const name = await safeGetContactName(jid);
    await sendBotReply(ctx.sock, ctx.from, `Added chat ${name} (${jid})${entry ? ` (ID: ${entry.id})` : ""} | Bot ${botNumber} (${botLabel(botNumber)}).`);
  },
});

// ── RM (!rm — this chat/group, or -gid/-cid <id>) — confirm via !YES ──
registerCommand({
  name: "rm",
  requiresAdmin: true,
  handler: async (ctx) => {
    const t = resolveTarget(ctx);
    if (!t.ok) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `${t.msg}\nUsage: !rm (in the chat/group) | !rm -gid <id> | !rm -cid <id>`,
      );
      return;
    }
    const { id, jid, botNumber } = t.entry;
    if (t.type === "group") {
      const name = await safeGetGroupName(ctx.sock, jid);
      ctx.session.pendingDeleteGroup = { id, jid, botNumber };
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `Remove Group ID: ${id} | Name: ${name} | JID: ${jid} | Bot: ${botNumber} (${botLabel(botNumber)})?\n(Enter !YES to confirm)`,
      );
    } else {
      const name = await safeGetContactName(jid);
      ctx.session.pendingDeleteChat = { id, jid, botNumber };
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `Remove Chat ID: ${id} | Name: ${name} | JID: ${jid} | Bot: ${botNumber} (${botLabel(botNumber)})?\n(Enter !YES to confirm)`,
      );
    }
    await saveSession(buildSessionKey(ctx.from, ctx.senderId), ctx.session);
  },
});

// ── EDIT (!edit -bid <n> — this chat/group, or -gid/-cid <id> -bid <n>) ──
// Reassigns the bot for an allowlisted group/chat (confirm via !YES).
registerCommand({
  name: "edit",
  requiresAdmin: true,
  handler: async (ctx) => {
    const b = ctx.cmdArgs.join(" ").match(/-bid\s+(\d+)/i);
    if (!b) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !edit -bid <0-3> (in the chat/group) | !edit -gid <id> -bid <n> | !edit -cid <id> -bid <n>",
      );
      return;
    }
    const newBot = parseInt(b[1], 10);
    const t = resolveTarget(ctx);
    if (!t.ok) {
      await sendBotReply(ctx.sock, ctx.from, t.msg);
      return;
    }
    const label = t.type === "group" ? "Group" : "Chat";
    if (t.entry.botNumber === newBot) {
      await sendBotReply(ctx.sock, ctx.from, `${label} is already using bot ${newBot}.`);
      return;
    }
    const { id, jid, botNumber } = t.entry;
    const name = t.type === "group" ? await safeGetGroupName(ctx.sock, jid) : await safeGetContactName(jid);
    if (t.type === "group") {
      ctx.session.pendingEditGroup = { id, jid, botNumber: newBot };
    } else {
      ctx.session.pendingEditChat = { id, jid, botNumber: newBot };
    }
    await sendBotReply(
      ctx.sock,
      ctx.from,
      `Change ${label} ID: ${id} | Name: ${name} | JID: ${jid} to Bot ${newBot} (${botLabel(newBot)}) from Bot ${botNumber} (${botLabel(botNumber)})?\n(Enter !YES to confirm)`,
    );
    await saveSession(buildSessionKey(ctx.from, ctx.senderId), ctx.session);
  },
});

// ── ENABLE / DISABLE (this chat/group, or -gid/-cid <id>) ──
async function setAllowlistEnabled(ctx: any, enabled: boolean): Promise<void> {
  const verb = enabled ? "enable" : "disable";
  const t = resolveTarget(ctx);
  if (!t.ok) {
    await sendBotReply(
      ctx.sock,
      ctx.from,
      `${t.msg}\nUsage: !${verb} (in the chat/group) | !${verb} -gid <id> | !${verb} -cid <id>`,
    );
    return;
  }
  const { id, jid } = t.entry;
  const label = t.type === "group" ? "Group" : "Chat";
  const ok =
    t.type === "group"
      ? await groupConfig.setGroupEnabled(id, enabled)
      : await chatConfig.setChatEnabled(id, enabled);
  if (!ok) {
    await sendBotReply(ctx.sock, ctx.from, `Failed to ${verb} ${label} ID: ${id}.`);
    return;
  }
  try {
    const { logAction } = await import("../../../storage/core/auditRepository");
    await logAction(ctx.senderId || "unknown", `${verb}_${t.type}`, String(id), jid, JSON.stringify({ enabled }));
  } catch {}
  await sendBotReply(
    ctx.sock,
    ctx.from,
    `${enabled ? "Enabled" : "Disabled"} ${label} ID: ${id} | JID: ${jid}.`,
  );
}

registerCommand({
  name: "disable",
  requiresAdmin: true,
  handler: (ctx) => setAllowlistEnabled(ctx, false),
});

registerCommand({
  name: "enable",
  requiresAdmin: true,
  handler: (ctx) => setAllowlistEnabled(ctx, true),
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
