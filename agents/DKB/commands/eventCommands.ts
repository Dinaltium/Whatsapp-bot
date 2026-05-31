/**
 * DKB Event Commands
 *
 * Handles: events, event <query>
 */

import { userHasPermission } from "../../../storage/core/rbacRepository";
import { popUserMessage } from "../../../utils/normalization";
import { formatBotReply } from "../../../utils/formatter";
import {
  handleEventsCommand,
  handleEventDetailCommand,
} from "../../../services/DKB/eventService";

interface AgentResult {
  reply: string;
  usedAI: boolean;
  domainLocked?: boolean;
}

/**
 * Returns a result if handled, null otherwise.
 */
export async function handleEventCommand(
  session: any,
  userPrompt: string,
  trimmed: string,
  lowerPrompt: string,
  isAdmin: boolean,
  senderJid?: string,
): Promise<AgentResult | null> {
  if (!lowerPrompt.startsWith("events") && !lowerPrompt.startsWith("event")) return null;

  const isAllowed = isAdmin || (senderJid && (await userHasPermission(senderJid, "event.manage")));
  if (!isAllowed) {
    return {
      reply: formatBotReply("Unauthorized: You do not have the required role to access Event Commands."),
      usedAI: false,
    };
  }

  if (lowerPrompt.startsWith("events")) {
    const query = trimmed.slice(6).trim();
    popUserMessage(session, userPrompt);
    return {
      reply: formatBotReply(await handleEventsCommand(query)),
      usedAI: false,
    };
  } else {
    const query = trimmed.slice(5).trim();
    popUserMessage(session, userPrompt);
    return {
      reply: formatBotReply(await handleEventDetailCommand(query)),
      usedAI: false,
    };
  }
}
