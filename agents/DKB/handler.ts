import { formatBotReply } from "../../utils/formatter";
import { isCommunityQuery } from "../../services/DKB/communityService";
import { getGroqReply } from "./prompt";
import { handleMentorDialogs, handleMentorCommand } from "./commands/mentorCommands";
import { handleClubCommand } from "./commands/clubCommands";
import { handleEventCommand } from "./commands/eventCommands";
import { handleProjectCommand } from "./commands/projectCommands";

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

interface UserSession {
  domainUnlocked: boolean;
  lastActiveAt: number;
  messages: ConversationMessage[];
  lastQuery?: { type: "mentors" | "clubs" | "events" | "projects"; filter?: string; page: number };
  pendingMentor?: {
    name: string;
    organization: string;
    description?: string;
    expertise?: string;
    linkedin?: string;
    instagram?: string;
    github?: string;
    email?: string;
    phoneNoCountryCode: string;
  };
  pendingEdit?: {
    mentorId: number;
    flag: string;
    phoneNoCountryCode: string;
  };
  pendingDelete?: {
    mentorId: number;
    name: string;
  };
}

interface AgentResult {
  reply: string;
  usedAI: boolean;
  domainLocked?: boolean;
}

/**
 * Runs one sub-command step in isolation. A throw is logged and turned into a
 * graceful, specific error reply for that command instead of bubbling up and
 * taking down the whole handler (and every other command path with it).
 */
async function runStep(
  label: string,
  fn: () => Promise<AgentResult | null>,
): Promise<AgentResult | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(
      `[DKB] ${label} command failed:`,
      err instanceof Error ? err.message : err,
    );
    return {
      reply: formatBotReply(
        `The ${label} command hit an error. Please try again in a moment.`,
      ),
      usedAI: false,
    };
  }
}

export async function handleMessage(
  session: UserSession,
  userPrompt: string,
  groqApiKey: string | undefined,
  groqModel: string,
  isAdmin: boolean = false,
  senderJid?: string,
): Promise<AgentResult> {
  const trimmed = (userPrompt || "").trim();
  const lowerPrompt = trimmed.toLowerCase();

  // 1. Resolve multi-turn mentor dialogs
  const dialogResult = await runStep("mentor dialog", () =>
    handleMentorDialogs(session, userPrompt, trimmed, isAdmin, senderJid),
  );
  if (dialogResult) return dialogResult;

  // 2. Club commands
  const clubResult = await runStep("club", () =>
    handleClubCommand(session, userPrompt, trimmed, lowerPrompt, isAdmin, senderJid),
  );
  if (clubResult) return clubResult;

  // 3. Event commands
  const eventResult = await runStep("event", () =>
    handleEventCommand(session, userPrompt, trimmed, lowerPrompt, isAdmin, senderJid),
  );
  if (eventResult) return eventResult;

  // 3b. Project commands
  const projectResult = await runStep("project", () =>
    handleProjectCommand(session, userPrompt, trimmed, lowerPrompt, isAdmin, senderJid),
  );
  if (projectResult) return projectResult;

  // 4. Mentor commands
  const mentorResult = await runStep("mentor", () =>
    handleMentorCommand(session, userPrompt, trimmed, lowerPrompt, isAdmin, senderJid),
  );
  if (mentorResult) return mentorResult;

  // 5. AI FALLBACK
  const isCommunity = isCommunityQuery(userPrompt);

  if (!isCommunity && !session.domainUnlocked && !isAdmin) {
    return {
      reply: formatBotReply(
        [
          "I support DK24 (Developer Kommunity 24)!",
          "Ask me about AI application building, community meetups, collaboration partners, or coding challenges.",
          "Example: !What is a good way to host a local AI developer meetup?",
        ].join("\n"),
      ),
      usedAI: false,
      domainLocked: true,
    };
  }

  try {
    const aiReply = await getGroqReply(
      session.messages,
      groqApiKey,
      groqModel,
      userPrompt,
    );
    return { reply: formatBotReply(aiReply), usedAI: true };
  } catch (err) {
    console.error(
      "[DKB] AI reply failed:",
      err instanceof Error ? err.message : err,
    );
    return {
      reply: formatBotReply(
        "I'm having trouble answering right now. Please try again shortly.",
      ),
      usedAI: false,
    };
  }
}
