import { registerCommand } from "../commandRegistry";
import groupConfig from "../../../config/groupAllowlist";
import chatConfig from "../../../config/chatAllowlist";
import { sendBotReply, buildSessionKey } from "../../../bot";
import { normalizeJid, isAdminAction } from "../../../security/rbac";
import { saveSession } from "../../state";

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
    const { userHasPermission } = await import("../../../storage/core/rbacRepository");
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
          const { resolvePhoneJidFromLid } = await import("../../../storage/core/rbacRepository");
          const resolved = await resolvePhoneJidFromLid(targetJid);
          if (resolved) effectiveQueryJid = resolved;
        } catch (_) {}
      }

      try {
        const { getUserRoles } = await import("../../../storage/core/rbacRepository");
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
      const { getUsersWithRole } = await import("../../../storage/core/rbacRepository");
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

    const { addManagedRole } = await import("../../../storage/core/rbacRepository");
    const { storeLidPhoneMapping } = await import("../../../storage/core/rbacRepository");
    let resolvedPhoneJid: string | null = null;
    let resolvedLid: string | null = null;

    if (targetJid.endsWith("@lid")) {
      resolvedLid = targetJid;
      try {
        const { resolvePhoneJidFromLid } = await import("../../../storage/core/rbacRepository");
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
    const { userHasPermission } = await import("../../../storage/core/rbacRepository");
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

    const { handleCreateCommand } = await import("../../../services/core/rbacService");
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
    const registry = (await import("../commandRegistry")).dispatchCommand;
    await registry({ ...ctx, cmdName: "role" });
  }
});
