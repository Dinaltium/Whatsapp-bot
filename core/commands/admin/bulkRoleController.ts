import { registerCommand } from "../commandRegistry";
import { sendBotReply, extractMentionedJids, buildSessionKey } from "../../../bot";
import { getSenderId } from "../../../security/rbac";
import { getSession } from "../../state";

registerCommand({
  name: "bulkrole",
  requiresAdmin: true,
  handler: async (ctx) => {
    const args = ctx.cmdArgs;
    if (args.length < 1) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !bulkrole <role_name> @user1 @user2\nExample: !bulkrole mentor @John @Jane"
      );
      return;
    }

    const roleName = args[0].toLowerCase();
    const mentionedJids = extractMentionedJids(ctx.msg);

    if (mentionedJids.length === 0) {
      await sendBotReply(ctx.sock, ctx.from, "Please mention at least one user to assign the role to.");
      return;
    }

    const results = [];
    const { addManagedRole } = await import("../../../storage/core/rbacRepository");

    for (const jid of mentionedJids) {
      try {
        const ok = await addManagedRole(jid, roleName);
        if (ok) {
          results.push(`✅ @${jid.split("@")[0]}`);
          try {
            const { logAction } = await import("../../../storage/core/auditRepository");
            await logAction(ctx.senderId || "unknown", "assign_role_bulk", jid, roleName, "bulk assignment");
          } catch (e) {}
        } else {
          results.push(`❌ @${jid.split("@")[0]} (Failed)`);
        }
      } catch (err) {
        results.push(`❌ @${jid.split("@")[0]} (Error)`);
      }
    }

    await sendBotReply(
      ctx.sock,
      ctx.from,
      `*Bulk Role Assignment for '${roleName}':*\n\n${results.join("\n")}`
    );
  }
});
