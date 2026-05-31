import { formatBotReply } from "../../utils/formatter";
import { isCommunityQuery } from "../../services/DKB/communityService";
import { getGroqReply } from "./prompt";
import { handleMentorDialogs, handleMentorCommand } from "./commands/mentorCommands";
import { handleClubCommand } from "./commands/clubCommands";
import { handleEventCommand } from "./commands/eventCommands";

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

interface UserSession {
  domainUnlocked: boolean;
  lastActiveAt: number;
  messages: ConversationMessage[];
  lastQuery?: { type: "mentors"; filter?: string; page: number };
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
  const dialogResult = await handleMentorDialogs(session, userPrompt, trimmed, isAdmin, senderJid);
  if (dialogResult) return dialogResult;

  // 2. Club commands
  const clubResult = await handleClubCommand(session, userPrompt, trimmed, lowerPrompt, isAdmin, senderJid);
  if (clubResult) return clubResult;

  // 3. Event commands
  const eventResult = await handleEventCommand(session, userPrompt, trimmed, lowerPrompt, isAdmin, senderJid);
  if (eventResult) return eventResult;

  // 4. Mentor commands
  const mentorResult = await handleMentorCommand(session, userPrompt, trimmed, lowerPrompt, isAdmin, senderJid);
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

  const aiReply = await getGroqReply(
    session.messages,
    groqApiKey,
    groqModel,
    userPrompt,
  );
  return { reply: formatBotReply(aiReply), usedAI: true };
}
