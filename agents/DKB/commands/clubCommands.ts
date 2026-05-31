/**
 * DKB Club Commands
 *
 * Handles: clubs, club <query>
 */

import { userHasPermission } from "../../../storage/core/rbacRepository";
import { popUserMessage } from "../../../utils/normalization";
import { formatBotReply } from "../../../utils/formatter";
import {
  handleClubsCommand,
  handleClubDetailCommand,
} from "../../../services/DKB/communityService";

interface AgentResult {
  reply: string;
  usedAI: boolean;
  domainLocked?: boolean;
}

/**
 * Returns a result if handled, null otherwise.
 */
export async function handleClubCommand(
  session: any,
  userPrompt: string,
  trimmed: string,
  lowerPrompt: string,
  isAdmin: boolean,
  senderJid?: string,
): Promise<AgentResult | null> {
  if (lowerPrompt !== "clubs" && !lowerPrompt.startsWith("club")) return null;

  const isAllowed = isAdmin || (senderJid && (await userHasPermission(senderJid, "club.manage")));
  if (!isAllowed) {
    return {
      reply: formatBotReply("Unauthorized: You do not have the required role to access Club Commands."),
      usedAI: false,
    };
  }

  if (lowerPrompt === "clubs") {
    popUserMessage(session, userPrompt);
    return { reply: formatBotReply(await handleClubsCommand()), usedAI: false };
  } else {
    const query = trimmed.slice(4).trim();
    popUserMessage(session, userPrompt);
    return {
      reply: formatBotReply(await handleClubDetailCommand(query)),
      usedAI: false,
    };
  }
}
