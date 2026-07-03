import { HELP_TEXT, DEFAULT_TEXT } from "./intro";
import { getProjects, getEvents, getDeadlines } from "../../storage/ECB/ecbRepository";

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

interface UserSession {
  domainUnlocked: boolean;
  lastActiveAt: number;
  messages: ConversationMessage[];
}

interface AgentResult {
  reply: string;
  usedAI: boolean;
  domainLocked?: boolean;
}

function formatBotReply(text: string): string {
  const cleanedText = String(text || "").trim();
  if (!cleanedText) {
    return "";
  }
  return cleanedText;
}

export async function handleMessage(
  session: UserSession,
  userPrompt: string,
): Promise<AgentResult> {
  const normalizedPrompt = (userPrompt || "").toLowerCase();

  if (normalizedPrompt.includes("hello") || normalizedPrompt.includes("hi")) {
    return {
      reply: formatBotReply("Hello! Welcome to ECB (EmbedClub). How can I assist you today?"),
      usedAI: false,
    };
  }

  if (normalizedPrompt.includes("help") || normalizedPrompt.includes("?")) {
    return {
      reply: formatBotReply(HELP_TEXT),
      usedAI: false,
    };
  }

  if (normalizedPrompt.startsWith("!projects")) {
    try {
      const projects = await getProjects();
      const reply = projects.length > 0
        ? `Projects:\n${projects.map(p => `- ${p.name}`).join('\n')}`
        : "No projects found.";
      return { reply: formatBotReply(reply), usedAI: false };
    } catch (err) {
      console.error("[ECB] projects command failed:", err instanceof Error ? err.message : err);
      return { reply: formatBotReply("Couldn't load projects right now. Please try again later."), usedAI: false };
    }
  }

  if (normalizedPrompt.startsWith("!events")) {
    try {
      const events = await getEvents();
      const reply = events.length > 0
        ? `Upcoming Events:\n${events.map(e => `- ${e.title}`).join('\n')}`
        : "No upcoming events found.";
      return { reply: formatBotReply(reply), usedAI: false };
    } catch (err) {
      console.error("[ECB] events command failed:", err instanceof Error ? err.message : err);
      return { reply: formatBotReply("Couldn't load events right now. Please try again later."), usedAI: false };
    }
  }

  if (normalizedPrompt.startsWith("!deadlines")) {
    try {
      const deadlines = await getDeadlines();
      const reply = deadlines.length > 0
        ? `Upcoming Deadlines:\n${deadlines.map(d => `- ${d.title}`).join('\n')}`
        : "No upcoming deadlines found.";
      return { reply: formatBotReply(reply), usedAI: false };
    } catch (err) {
      console.error("[ECB] deadlines command failed:", err instanceof Error ? err.message : err);
      return { reply: formatBotReply("Couldn't load deadlines right now. Please try again later."), usedAI: false };
    }
  }

  return {
    reply: formatBotReply("EmbedClub assistant is under active development. For now, use !help to see available commands."),
    usedAI: false,
  };
}
