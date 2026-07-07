import { registerCommand } from "../commandRegistry";
import groupConfig from "../../../config/groupAllowlist";
import chatConfig from "../../../config/chatAllowlist";
import { sendBotReply } from "../../../bot";
import { normalizeJid, isAdminAction } from "../../../security/rbac";

// Cooldown on bulk (-all) role changes to prevent mass spam/abuse.
const BULK_COOLDOWN_SEC = Number(process.env.MENTOR_MANAGE_COOLDOWN_SEC) || 300;
const BULK_CAP = Number(process.env.MENTOR_BULK_CAP) || 200;

const USAGE = [
  "Usage (DKB group):",
  "• !manage mentor -l — list everyone with the role",
  "• !manage mentor -all — grant to everyone in THIS group",
  "• !manage mentor -all -rm — remove from everyone in THIS group",
  "• !manage mentor -jid <phone> — grant to one person",
  "• !manage mentor -jid <phone> -rm — remove from one person",
].join("\n");

/** Resolves a group participant to their best (phone) JID + any LID pair. */
function participantJids(p: any): { target: string | null; lid: string | null; phone: string | null } {
  const pid = p?.id ? normalizeJid(p.id) : null;
  const plid = p?.lid ? normalizeJid(p.lid) : null;
  const ppn = p?.phoneNumber ? normalizeJid(p.phoneNumber) : null;
  const phone =
    pid && pid.endsWith("@s.whatsapp.net")
      ? pid
      : ppn && ppn.endsWith("@s.whatsapp.net")
        ? ppn
        : null;
  const lid = (pid && pid.endsWith("@lid") ? pid : plid) || null;
  return { target: phone || pid || plid || null, lid, phone: phone || null };
}

/** Parses a `-jid` argument (phone number or JID/LID) into a canonical JID. */
function parseJidArg(input: string): string | null {
  const inp = (input || "").trim();
  if (inp.includes("@")) {
    const n = normalizeJid(inp);
    if (n && (n.endsWith("@s.whatsapp.net") || n.endsWith("@lid"))) return n;
  }
  const m = inp.match(/^\+?(\d{7,15})$/);
  if (m) return `${m[1]}@s.whatsapp.net`;
  return null;
}

// ── MANAGE ROLES (mentor) ──
// Bulk/manual grant + removal of the mentor role. Bot 2 (DKB) only.
registerCommand({
  name: "manage",
  handler: async (ctx) => {
    const botNumber = ctx.from?.endsWith("@g.us")
      ? groupConfig.getGroupBot(ctx.from)?.botNumber || 0
      : chatConfig.getChatBot(ctx.from)?.botNumber || 0;
    if (botNumber !== 2) {
      await sendBotReply(ctx.sock, ctx.from, "This command is only available for Bot 2 (DKB).");
      return;
    }

    const isAdmin = isAdminAction(ctx.msg, ctx.senderId);
    const rbac = await import("../../../storage/core/rbacRepository");
    const authorized = isAdmin || (ctx.senderId && (await rbac.userHasPermission(ctx.senderId, "role.manage")));
    if (!authorized) {
      await sendBotReply(ctx.sock, ctx.from, "Unauthorized: admin privileges or the role.manage permission are required.");
      return;
    }

    const role = (ctx.cmdArgs[0] || "").trim().toLowerCase();
    if (!role) {
      await sendBotReply(ctx.sock, ctx.from, USAGE);
      return;
    }
    const flags = ctx.cmdArgs.slice(1);
    const lower = flags.map((f) => f.toLowerCase());
    const isRemove = lower.includes("-rm");
    const wantAll = lower.includes("-all");
    const wantList = lower.includes("-l");
    const jidIdx = lower.indexOf("-jid");
    const jidArg = jidIdx !== -1 ? flags[jidIdx + 1] : undefined;

    // ── LIST ── (admin or role.manage; read-only)
    if (wantList) {
      const users = await rbac.getUsersWithRole(role);
      if (!users.length) {
        await sendBotReply(ctx.sock, ctx.from, `No users have the role "${role}".`);
        return;
      }
      const lines = users
        .map((j) => (j.endsWith("@lid") ? `${j.split("@")[0]} (LID)` : `+${j.split("@")[0]}`))
        .join("\n");
      await sendBotReply(ctx.sock, ctx.from, `Users with role "${role}" (${users.length}):\n${lines}`);
      return;
    }

    // Privilege guard: assigning/removing a role that carries admin-level
    // permissions (e.g. mentor.manage) is owner-only — never propagatable via
    // a role.manage holder.
    if (!isAdmin && (await rbac.roleHasPrivilegedPermission(role))) {
      await sendBotReply(ctx.sock, ctx.from, `Only the owner can manage the privileged role "${role}".`);
      return;
    }

    // ── BULK (-all) ── group only, cooldown-guarded
    if (wantAll) {
      if (!ctx.from?.endsWith("@g.us")) {
        await sendBotReply(ctx.sock, ctx.from, "Use -all inside a group.");
        return;
      }
      try {
        const { redis } = await import("../../../storage/redisClient");
        const cd = await redis.set(`manage:cd:${ctx.senderId}`, "1", "EX", BULK_COOLDOWN_SEC, "NX");
        if (cd !== "OK") {
          await sendBotReply(ctx.sock, ctx.from, `Please wait a few minutes before another bulk role change.`);
          return;
        }
      } catch {
        /* if Redis is down, proceed without the cooldown rather than block ops */
      }

      let meta: any;
      try {
        meta = await ctx.sock.groupMetadata(ctx.from);
      } catch {
        await sendBotReply(ctx.sock, ctx.from, "Couldn't read this group's members.");
        return;
      }
      const participants = (meta?.participants || []).slice(0, BULK_CAP);
      let done = 0;
      for (const p of participants) {
        const { target, lid, phone } = participantJids(p);
        if (!target) continue;
        if (lid && phone) await rbac.storeLidPhoneMapping(lid, phone).catch(() => {});
        const ok = isRemove
          ? await rbac.revokeManagedRole(target, role)
          : await rbac.addManagedRole(target, role);
        if (ok) done++;
      }
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `${isRemove ? "Removed" : "Assigned"} role "${role}" ${isRemove ? "from" : "to"} ${done} of ${participants.length} member(s).`,
      );
      return;
    }

    // ── SINGLE (-jid <phone|jid>) ──
    if (jidArg) {
      const target = parseJidArg(jidArg);
      if (!target) {
        await sendBotReply(ctx.sock, ctx.from, "Provide -jid <phone number or JID>. Example: !manage mentor -jid +919902849280");
        return;
      }
      const ok = isRemove
        ? await rbac.revokeManagedRole(target, role)
        : await rbac.addManagedRole(target, role);
      if (ok) {
        await sendBotReply(ctx.sock, ctx.from, `${isRemove ? "Removed" : "Assigned"} role "${role}" ${isRemove ? "from" : "to"} ${jidArg}.`);
      } else {
        await sendBotReply(ctx.sock, ctx.from, `Failed. Ensure the database is healthy and the role "${role}" exists.`);
      }
      return;
    }

    await sendBotReply(ctx.sock, ctx.from, USAGE);
  },
});
