import { registerCommand } from "./commandRegistry";
import { handleClubsCommand, handleClubDetailCommand } from "../../services/DKB/communityService";
import { handleEventsCommand, handleEventDetailCommand } from "../../services/DKB/eventService";
import { sendBotReply } from "../../bot";

// Register Clubs command
registerCommand({
  name: "clubs",
  handler: async (ctx) => {
    const replyText = await handleClubsCommand();
    await sendBotReply(ctx.sock, ctx.from, replyText);
  }
});

// Register Club Detail command
registerCommand({
  name: "club",
  handler: async (ctx) => {
    const query = ctx.cmdArgs.join(" ");
    if (!query) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !club <name-or-college>");
      return;
    }
    const replyText = await handleClubDetailCommand(query);
    await sendBotReply(ctx.sock, ctx.from, replyText);
  }
});

// Register Events command
registerCommand({
  name: "events",
  handler: async (ctx) => {
    const query = ctx.cmdArgs.join(" ");
    const replyText = await handleEventsCommand(query);
    await sendBotReply(ctx.sock, ctx.from, replyText);
  }
});

// Register Event Detail command
registerCommand({
  name: "event",
  handler: async (ctx) => {
    const query = ctx.cmdArgs.join(" ");
    if (!query) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !event <event-name>");
      return;
    }
    const replyText = await handleEventDetailCommand(query);
    await sendBotReply(ctx.sock, ctx.from, replyText);
  }
});
