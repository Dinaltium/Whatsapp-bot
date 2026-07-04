import { registerCommand } from "./commandRegistry";
import { handleClubsCommand, handleClubDetailCommand } from "../../services/DKB/communityService";
import { handleEventsCommand, handleEventDetailCommand } from "../../services/DKB/eventService";
import { handleProjectsCommand, handleProjectDetailCommand } from "../../services/DKB/projectService";
import { handleMentorsQuery } from "../../services/DKB/mentorService";
import { sendBotReply, buildSessionKey } from "../../bot";
import { saveSession } from "../state";

// A directory detail lookup accepts either a positional name or `-id <value>`.
function detailQuery(cmdArgs: string[]): string {
  return cmdArgs.join(" ").replace(/^-id\s+/i, "").trim();
}

// Trailing numeric token = page number; the rest is the (optional) filter.
function splitPage(cmdArgs: string[]): { rest: string; page: number } {
  const args = cmdArgs.slice();
  let page = 1;
  if (args.length && /^\d+$/.test(args[args.length - 1])) {
    page = parseInt(args.pop() as string, 10) || 1;
  }
  return { rest: args.join(" ").trim(), page };
}

// Register Clubs command
registerCommand({
  name: "clubs",
  handler: async (ctx) => {
    const { page } = splitPage(ctx.cmdArgs);
    const replyText = await handleClubsCommand(ctx.session, page);
    await saveSession(buildSessionKey(ctx.from, ctx.senderId), ctx.session);
    await sendBotReply(ctx.sock, ctx.from, replyText);
  }
});

// Register Club Detail command
registerCommand({
  name: "club",
  handler: async (ctx) => {
    const query = detailQuery(ctx.cmdArgs);
    if (!query) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !club <name-or-id> (or -id <id>)");
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
    const { rest, page } = splitPage(ctx.cmdArgs);
    const replyText = await handleEventsCommand(rest, ctx.session, page);
    await saveSession(buildSessionKey(ctx.from, ctx.senderId), ctx.session);
    await sendBotReply(ctx.sock, ctx.from, replyText);
  }
});

// Register Event Detail command
registerCommand({
  name: "event",
  handler: async (ctx) => {
    const query = detailQuery(ctx.cmdArgs);
    if (!query) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !event <event-name-or-id> (or -id <id>)");
      return;
    }
    const replyText = await handleEventDetailCommand(query);
    await sendBotReply(ctx.sock, ctx.from, replyText);
  }
});

// Register Projects command
registerCommand({
  name: "projects",
  handler: async (ctx) => {
    const { page } = splitPage(ctx.cmdArgs);
    const replyText = await handleProjectsCommand(ctx.session, page);
    await saveSession(buildSessionKey(ctx.from, ctx.senderId), ctx.session);
    await sendBotReply(ctx.sock, ctx.from, replyText);
  }
});

// Register Project Detail command
registerCommand({
  name: "project",
  handler: async (ctx) => {
    const query = detailQuery(ctx.cmdArgs);
    if (!query) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !project <project-name-or-id> (or -id <id>)");
      return;
    }
    const replyText = await handleProjectDetailCommand(query);
    await sendBotReply(ctx.sock, ctx.from, replyText);
  }
});

// Renders a given page of whatever directory the user last listed.
async function renderDirectoryPage(
  session: any,
  page: number,
): Promise<string | null> {
  const lq = session.lastQuery;
  if (!lq) return null;
  switch (lq.type) {
    case "clubs":
      return handleClubsCommand(session, page);
    case "projects":
      return handleProjectsCommand(session, page);
    case "events":
      return handleEventsCommand(lq.filter || "", session, page);
    case "mentors":
      return handleMentorsQuery(session, lq.filter, page);
    default:
      return null;
  }
}

// Shared pagination: !next / !page <n> apply to the last directory listed
// (clubs, events, projects, or mentors).
registerCommand({
  name: "next",
  handler: async (ctx) => {
    const lq = ctx.session.lastQuery;
    if (!lq) {
      await sendBotReply(ctx.sock, ctx.from, "No active directory listing. Try !clubs, !events, !projects, or !mentors first.");
      return;
    }
    const reply = await renderDirectoryPage(ctx.session, (lq.page || 1) + 1);
    await saveSession(buildSessionKey(ctx.from, ctx.senderId), ctx.session);
    if (reply) await sendBotReply(ctx.sock, ctx.from, reply);
  }
});

registerCommand({
  name: "page",
  handler: async (ctx) => {
    const lq = ctx.session.lastQuery;
    if (!lq) {
      await sendBotReply(ctx.sock, ctx.from, "No active directory listing. Try !clubs, !events, !projects, or !mentors first.");
      return;
    }
    const n = parseInt(ctx.cmdArgs[0] || "", 10);
    if (isNaN(n) || n <= 0) {
      await sendBotReply(ctx.sock, ctx.from, "Usage: !page <number>");
      return;
    }
    const reply = await renderDirectoryPage(ctx.session, n);
    await saveSession(buildSessionKey(ctx.from, ctx.senderId), ctx.session);
    if (reply) await sendBotReply(ctx.sock, ctx.from, reply);
  }
});
