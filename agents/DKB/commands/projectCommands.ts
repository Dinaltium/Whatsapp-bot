/**
 * DKB Project Commands
 *
 * Handles: projects, project <query>
 */

import { userHasPermission } from "../../../storage/core/rbacRepository";
import { popUserMessage } from "../../../utils/normalization";
import { formatBotReply } from "../../../utils/formatter";
import {
  handleProjectsCommand,
  handleProjectDetailCommand,
} from "../../../services/DKB/projectService";

interface AgentResult {
  reply: string;
  usedAI: boolean;
  domainLocked?: boolean;
}

/**
 * Returns a result if handled, null otherwise.
 */
export async function handleProjectCommand(
  session: any,
  userPrompt: string,
  trimmed: string,
  lowerPrompt: string,
  isAdmin: boolean,
  senderJid?: string,
): Promise<AgentResult | null> {
  if (lowerPrompt !== "projects" && !lowerPrompt.startsWith("project"))
    return null;

  const isAllowed =
    isAdmin || (senderJid && (await userHasPermission(senderJid, "project.manage")));
  if (!isAllowed) {
    return {
      reply: formatBotReply(
        "Unauthorized: You do not have the required role to access Project Commands.",
      ),
      usedAI: false,
    };
  }

  if (lowerPrompt === "projects") {
    popUserMessage(session, userPrompt);
    return { reply: formatBotReply(await handleProjectsCommand()), usedAI: false };
  }

  const query = trimmed.slice("project".length).trim();
  popUserMessage(session, userPrompt);
  return {
    reply: formatBotReply(await handleProjectDetailCommand(query)),
    usedAI: false,
  };
}
