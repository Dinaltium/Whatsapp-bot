import { registerCommand } from "../commandRegistry";
import { sendBotReply } from "../../../bot";
import { createReminder } from "../../../storage/core/reminderRepository";

registerCommand({
  name: "remindme",
  requiresAdmin: true,
  handler: async (ctx) => {
    const args = ctx.cmdArgs;
    if (args.length < 2) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !remindme <time> <message>\nTime format: <number>[m|h|d]\nExample: !remindme 30m Check servers"
      );
      return;
    }

    const timeStr = args[0].toLowerCase();
    const message = args.slice(1).join(" ");

    let minutes = 0;
    const value = parseInt(timeStr.slice(0, -1), 10);
    const unit = timeStr.slice(-1);

    if (isNaN(value) || value <= 0) {
      await sendBotReply(ctx.sock, ctx.from, "Invalid time value. Use something like 10m, 2h, or 1d.");
      return;
    }

    if (unit === 'm') minutes = value;
    else if (unit === 'h') minutes = value * 60;
    else if (unit === 'd') minutes = value * 60 * 24;
    else {
      await sendBotReply(ctx.sock, ctx.from, "Invalid time unit. Use m (minutes), h (hours), or d (days).");
      return;
    }

    const remindAt = new Date(Date.now() + minutes * 60000);

    const reminder = await createReminder(ctx.from, ctx.senderId || "unknown", message, remindAt);

    if (reminder) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `✅ Reminder set for ${remindAt.toLocaleString()}.\nI'll remind you: "${message}"`
      );
    } else {
      await sendBotReply(ctx.sock, ctx.from, "Failed to save the reminder in the database.");
    }
  }
});
