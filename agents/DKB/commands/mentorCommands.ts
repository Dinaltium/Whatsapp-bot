/**
 * DKB Mentor Commands
 *
 * Handles: mentors, mentor, next, page, addmentor, editmentor, delmentor
 * Also handles multi-turn dialogs: pendingDelete, pendingMentor, pendingEdit
 */

import { getMentorById, addMentor, deleteMentor, updateMentorField } from "../../../storage/DKB/mentorRepository";
import { userHasPermission } from "../../../storage/core/rbacRepository";
import { logAction } from "../../../storage/core/auditRepository";
import {
  popUserMessage,
  combineCountryCodeAndNumber,
  formatWithCountryCode,
} from "../../../utils/normalization";
import {
  formatBotReply,
  formatMentorDetail,
} from "../../../utils/formatter";
import {
  parseMentorCommandArgs,
  parseMentorFlags,
  handleMentorsQuery,
} from "../../../services/DKB/mentorService";
import {
  validateMentorContactFields,
  isValidEmail,
} from "../../../utils/validators";

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

/**
 * Handles multi-turn dialog states (pending delete/add/edit confirmations).
 * Returns a result if handled, null otherwise.
 */
export async function handleMentorDialogs(
  session: UserSession,
  userPrompt: string,
  trimmed: string,
  isAdmin: boolean,
  senderJid?: string,
): Promise<AgentResult | null> {
  // Resolve pending delete confirmation
  if (session.pendingDelete) {
    popUserMessage(session, userPrompt);
    const pending = session.pendingDelete;
    const isYes = /^!?yes$/i.test(trimmed);
    delete session.pendingDelete;

    if (isYes) {
      const ok = await deleteMentor(String(pending.mentorId));
      if (ok) {
        await logAction(
          senderJid || "unknown",
          "delete_mentor",
          String(pending.mentorId),
          pending.name,
          JSON.stringify({ deleted: true }),
        );
      }
      return {
        reply: formatBotReply(
          ok
            ? `Successfully deleted Mentor ID: ${pending.mentorId} | Name: ${pending.name}.`
            : `Failed to delete Mentor ID: ${pending.mentorId}.`,
        ),
        usedAI: false,
      };
    } else {
      return {
        reply: formatBotReply(
          `Deletion of Mentor ID: ${pending.mentorId} | Name: ${pending.name} has been cancelled.`,
        ),
        usedAI: false,
      };
    }
  }

  // Resolve pending country code for !addmentor
  if (session.pendingMentor) {
    popUserMessage(session, userPrompt);
    const pending = session.pendingMentor;
    const ccInput = trimmed.replace(/[^0-9]/g, "");
    if (!ccInput || ccInput.length < 1 || ccInput.length > 4) {
      return {
        reply: formatBotReply(
          `Invalid country code "${trimmed}". Please enter only the numeric country code (e.g. 91, 971, 1):`,
        ),
        usedAI: false,
      };
    }
    const formattedPhone = combineCountryCodeAndNumber(
      ccInput,
      pending.phoneNoCountryCode,
    );
    delete session.pendingMentor;
    const isAuthorized =
      isAdmin ||
      (senderJid && (await userHasPermission(senderJid, "mentor.manage")));
    if (!isAuthorized) {
      return {
        reply: formatBotReply(
          "Unauthorized: you do not have permission to manage mentors.",
        ),
        usedAI: false,
      };
    }
    const ok = await addMentor(
      pending.name,
      pending.organization,
      pending.expertise,
      pending.description,
      pending.linkedin,
      pending.instagram,
      pending.github,
      pending.email,
      formattedPhone,
      senderJid,
    );
    if (ok) {
      return {
        reply: formatBotReply(
          `Phone formatted as "${formattedPhone}". Mentor "${pending.name}" successfully added to the directory.`,
        ),
        usedAI: false,
      };
    } else {
      return {
        reply: formatBotReply(
          "Failed to add mentor. Please ensure database connection is healthy.",
        ),
        usedAI: false,
      };
    }
  }

  // Resolve pending country code for !editmentor -p
  if (session.pendingEdit) {
    popUserMessage(session, userPrompt);
    const pending = session.pendingEdit;
    const ccInput = trimmed.replace(/[^0-9]/g, "");
    if (!ccInput || ccInput.length < 1 || ccInput.length > 4) {
      return {
        reply: formatBotReply(
          `Invalid country code "${trimmed}". Please enter only the numeric country code (e.g. 91, 971, 1):`,
        ),
        usedAI: false,
      };
    }
    const formattedPhone = combineCountryCodeAndNumber(
      ccInput,
      pending.phoneNoCountryCode,
    );
    delete session.pendingEdit;
    const isAuthorized =
      isAdmin ||
      (senderJid && (await userHasPermission(senderJid, "mentor.manage")));
    if (!isAuthorized) {
      return {
        reply: formatBotReply(
          "Unauthorized: you do not have permission to manage mentors.",
        ),
        usedAI: false,
      };
    }
    const ok = await updateMentorField(
      pending.mentorId,
      pending.flag,
      formattedPhone,
    );
    if (ok) {
      return {
        reply: formatBotReply(
          `Phone formatted as "${formattedPhone}" and updated for mentor ID ${pending.mentorId}.`,
        ),
        usedAI: false,
      };
    } else {
      return {
        reply: formatBotReply(
          `Failed to update phone for mentor ID ${pending.mentorId}.`,
        ),
        usedAI: false,
      };
    }
  }

  return null;
}

/**
 * Handles mentor directory commands. Returns a result if handled, null otherwise.
 */
export async function handleMentorCommand(
  session: UserSession,
  userPrompt: string,
  trimmed: string,
  lowerPrompt: string,
  isAdmin: boolean,
  senderJid?: string,
): Promise<AgentResult | null> {
  // MENTOR DIRECTORY
  const isMentorsCmd = lowerPrompt.startsWith("mentors");
  const isMentorCmd = !isMentorsCmd && lowerPrompt.startsWith("mentor");

  if (isMentorsCmd || isMentorCmd) {
    popUserMessage(session, userPrompt);
    const argsStr = trimmed.slice(isMentorsCmd ? 7 : 6).trim();

    // ID lookup
    const idMatch = argsStr.match(/^-id\s+(\d+)$/i);
    if (idMatch) {
      const mentorId = parseInt(idMatch[1], 10);
      const mentor = await getMentorById(mentorId);
      if (!mentor) {
        return {
          reply: formatBotReply(`No mentor found with ID ${mentorId}.`),
          usedAI: false,
        };
      }
      return {
        reply: formatBotReply(formatMentorDetail(mentor)),
        usedAI: false,
      };
    }

    const { filter, page } = parseMentorCommandArgs(argsStr);
    return {
      reply: formatBotReply(await handleMentorsQuery(session, filter, page)),
      usedAI: false,
    };
  }

  if (lowerPrompt === "next") {
    popUserMessage(session, userPrompt);
    if (!session.lastQuery || session.lastQuery.type !== "mentors") {
      return {
        reply: formatBotReply(
          "No active mentor directory query to paginate. Type !mentors to view the directory first.",
        ),
        usedAI: false,
      };
    }
    return {
      reply: formatBotReply(
        await handleMentorsQuery(
          session,
          session.lastQuery.filter,
          session.lastQuery.page + 1,
        ),
      ),
      usedAI: false,
    };
  }

  if (lowerPrompt.startsWith("page")) {
    popUserMessage(session, userPrompt);
    if (!session.lastQuery || session.lastQuery.type !== "mentors") {
      return {
        reply: formatBotReply(
          "No active mentor directory query to paginate. Type !mentors to view the directory first.",
        ),
        usedAI: false,
      };
    }
    const pageNum = parseInt(trimmed.slice(4).trim(), 10);
    if (isNaN(pageNum) || pageNum <= 0) {
      return { reply: formatBotReply("Usage: !page <number>"), usedAI: false };
    }
    return {
      reply: formatBotReply(
        await handleMentorsQuery(session, session.lastQuery.filter, pageNum),
      ),
      usedAI: false,
    };
  }

  // ADD MENTOR
  if (lowerPrompt.startsWith("addmentor")) {
    popUserMessage(session, userPrompt);
    const isAuthorized =
      isAdmin ||
      (senderJid && (await userHasPermission(senderJid, "mentor.manage")));
    if (!isAuthorized) {
      return {
        reply: formatBotReply(
          "Unauthorized: you do not have permission to manage mentors.",
        ),
        usedAI: false,
      };
    }

    const argsRaw = trimmed.slice(9);
    if (!argsRaw.trim()) {
      return {
        reply: formatBotReply(
          [
            "Usage: !addmentor <flags>",
            "",
            "Required flags:",
            "  -n  Name",
            "  -o  Organization",
            "",
            "Optional flags:",
            "  -d  Description",
            "  -ex Expertise",
            "  -l  LinkedIn URL",
            "  -i  Instagram handle/URL",
            "  -g  GitHub handle/URL",
            "  -e  Email (value must contain @)",
            "  -p  Phone number",
            "",
            "Flags can be on separate lines. Example:",
            "  !addmentor",
            "  -n Rafan Ahamad Sheik",
            "  -o PA College",
            "  -ex AI/ML, Full Stack",
            "  -p +91 9902849280",
          ].join("\n"),
        ),
        usedAI: false,
      };
    }

    const flags = parseMentorFlags(argsRaw);
    const name = (flags["-n"] || "").trim();
    const organization = (flags["-o"] || "").trim();
    const description = (flags["-d"] || "").trim() || undefined;
    const expertise =
      (flags["-ex"] || flags["-expertise"] || flags["-s"] || "").trim() ||
      undefined;
    const linkedin = (flags["-l"] || "").trim() || undefined;
    const instagram = (flags["-i"] || "").trim() || undefined;
    const github = (flags["-g"] || "").trim() || undefined;
    const email = (flags["-email"] || "").trim() || undefined;
    const rawPhone = (flags["-p"] || "").trim();

    if (!name) {
      return {
        reply: formatBotReply(
          "Error: Name (-n) is required.\nExample: !addmentor -n Rafan Ahamad Sheik -o PA College",
        ),
        usedAI: false,
      };
    }
    if (!organization) {
      return {
        reply: formatBotReply(
          "Error: Organization (-o) is required.\nExample: !addmentor -n Rafan Ahamad Sheik -o PA College",
        ),
        usedAI: false,
      };
    }

    const contactError = validateMentorContactFields({
      linkedin,
      github,
      instagram,
      email,
    });
    if (contactError) {
      return { reply: formatBotReply(`Error: ${contactError}`), usedAI: false };
    }

    if (rawPhone) {
      const phoneResult = formatWithCountryCode(rawPhone);
      if (phoneResult.needsCountryCode && phoneResult.rawNumber) {
        session.pendingMentor = {
          name,
          organization,
          description,
          expertise,
          linkedin,
          instagram,
          github,
          email,
          phoneNoCountryCode: phoneResult.rawNumber,
        };
        return {
          reply: formatBotReply(
            `Phone number "${rawPhone}" is missing a country code.\nPlease enter the country code for this number (e.g., 91, 971, 1):`,
          ),
          usedAI: false,
        };
      }
      const ok = await addMentor(
        name,
        organization,
        expertise,
        description,
        linkedin,
        instagram,
        github,
        email,
        phoneResult.formatted,
        senderJid,
      );
      return {
        reply: formatBotReply(
          ok
            ? `Mentor "${name}" successfully added to the directory.`
            : "Failed to add mentor. Please ensure database connection is healthy.",
        ),
        usedAI: false,
      };
    }

    const ok = await addMentor(
      name,
      organization,
      expertise,
      description,
      linkedin,
      instagram,
      github,
      email,
      undefined,
      senderJid,
    );
    return {
      reply: formatBotReply(
        ok
          ? `Mentor "${name}" successfully added to the directory.`
          : "Failed to add mentor. Please ensure database connection is healthy.",
      ),
      usedAI: false,
    };
  }

  // EDIT MENTOR
  if (lowerPrompt.startsWith("editmentor")) {
    popUserMessage(session, userPrompt);
    const isAuthorized =
      isAdmin ||
      (senderJid && (await userHasPermission(senderJid, "mentor.manage")));
    if (!isAuthorized) {
      return {
        reply: formatBotReply(
          "Unauthorized: you do not have permission to manage mentors.",
        ),
        usedAI: false,
      };
    }

    const argsRaw = trimmed.slice(10).trim();
    const editMatch = argsRaw.match(/^-id\s+(\d+)\s+(-[a-zA-Z]+)\s+([\s\S]+)$/i);
    if (!editMatch) {
      return {
        reply: formatBotReply(
          [
            "Usage: !editmentor -id <id> -<flag> <value>",
            "",
            "Examples:",
            "  !editmentor -id 3 -n New Name",
            "  !editmentor -id 3 -o New Organization",
            "  !editmentor -id 3 -p +91 9902849280",
            "  !editmentor -id 3 -l https://linkedin.com/in/rafan",
            "",
            "Flags: -n (name), -d (description), -o (org), -ex (expertise),",
            "       -l (linkedin), -i (instagram), -g (github), -e (email), -p (phone)",
          ].join("\n"),
        ),
        usedAI: false,
      };
    }

    const mentorId = parseInt(editMatch[1], 10);
    const flag = editMatch[2].toLowerCase();
    const value = editMatch[3].trim();

    // Validate contact-field formats before persisting.
    const contactFlagField: Record<string, "linkedin" | "github" | "instagram"> =
      {
        "-l": "linkedin",
        "-linkedin": "linkedin",
        "-g": "github",
        "-github": "github",
        "-i": "instagram",
        "-instagram": "instagram",
      };
    if (contactFlagField[flag]) {
      const err = validateMentorContactFields({
        [contactFlagField[flag]]: value,
      });
      if (err) {
        return { reply: formatBotReply(`Error: ${err}`), usedAI: false };
      }
    }
    // -e holds email only when the value contains '@' (else it's expertise).
    if (flag === "-e" && value.includes("@") && !isValidEmail(value)) {
      return {
        reply: formatBotReply(
          `Error: Invalid email "${value}". Expected something like name@example.com.`,
        ),
        usedAI: false,
      };
    }

    const existingMentor = await getMentorById(mentorId);
    if (!existingMentor) {
      return {
        reply: formatBotReply(
          `No mentor found with ID ${mentorId}. Use !mentors to view the directory.`,
        ),
        usedAI: false,
      };
    }

    if (flag === "-p") {
      const phoneResult = formatWithCountryCode(value);
      if (phoneResult.needsCountryCode && phoneResult.rawNumber) {
        session.pendingEdit = {
          mentorId,
          flag,
          phoneNoCountryCode: phoneResult.rawNumber,
        };
        return {
          reply: formatBotReply(
            `Phone number "${value}" is missing a country code.\nPlease enter the country code for this number (e.g., 91, 971, 1):`,
          ),
          usedAI: false,
        };
      }
      const ok = await updateMentorField(
        mentorId,
        flag,
        phoneResult.formatted || null,
        senderJid,
      );
      return {
        reply: formatBotReply(
          ok
            ? `Phone updated to "${phoneResult.formatted}" for mentor "${existingMentor.name}" (ID: ${mentorId}).`
            : `Failed to update phone for mentor ID ${mentorId}.`,
        ),
        usedAI: false,
      };
    }

    const ok = await updateMentorField(mentorId, flag, value || null, senderJid);
    return {
      reply: formatBotReply(
        ok
          ? `Field updated successfully for mentor "${existingMentor.name}" (ID: ${mentorId}).`
          : `Failed to update field for mentor ID ${mentorId}. Check that the flag is valid.`,
      ),
      usedAI: false,
    };
  }

  // DELETE MENTOR
  if (lowerPrompt.startsWith("delmentor")) {
    popUserMessage(session, userPrompt);
    const isAuthorized =
      isAdmin ||
      (senderJid && (await userHasPermission(senderJid, "mentor.manage")));
    if (!isAuthorized) {
      return {
        reply: formatBotReply(
          "Unauthorized: you do not have permission to manage mentors.",
        ),
        usedAI: false,
      };
    }

    const argsRaw = trimmed.slice(9).trim();
    const delMatch = argsRaw.match(/^-id\s+(\d+)$/i);
    if (!delMatch) {
      return {
        reply: formatBotReply(
          "Usage: !delmentor -id <id_number>\nExample: !delmentor -id 4",
        ),
        usedAI: false,
      };
    }

    const mentorId = parseInt(delMatch[1], 10);
    const existingMentor = await getMentorById(mentorId);
    if (!existingMentor) {
      return {
        reply: formatBotReply(
          `No mentor found with ID ${mentorId}. Use !mentors to view the directory.`,
        ),
        usedAI: false,
      };
    }

    session.pendingDelete = {
      mentorId,
      name: existingMentor.name,
    };

    return {
      reply: formatBotReply(
        `Are you sure you want to delete Mentor ID: ${mentorId} | Name: ${existingMentor.name}?\n(Enter !YES for confirmation)`,
      ),
      usedAI: false,
    };
  }

  return null;
}
