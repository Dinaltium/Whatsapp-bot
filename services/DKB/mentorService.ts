import {
  getMentors,
  countMentors,
} from "../../storage/DKB/mentorRepository";
import { PAGINATION_MAX_VIEW } from "./pagination";

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
}

export function parseMentorFlags(text: string): Record<string, string> {
  const flags: Record<string, string> = {};
  // `-@` (email) is included alongside letter flags; no more @-detection.
  const regex = /(?:\s|^)(-[@a-zA-Z]+)(?=\s|$)/g;
  const tokens: { flag: string; index: number; length: number }[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    tokens.push({
      flag: match[1].toLowerCase(),
      index: match.index,
      length: match[0].length,
    });
  }
  for (let i = 0; i < tokens.length; i++) {
    const current = tokens[i];
    const next = tokens[i + 1];
    const valStart = current.index + current.length;
    const valEnd = next ? next.index : text.length;
    const value = text.substring(valStart, valEnd).trim();

    // Normalise to canonical keys: -@ = email, -e/-ex/-s = expertise.
    if (current.flag === "-@") {
      flags["-email"] = value;
    } else if (
      current.flag === "-e" ||
      current.flag === "-ex" ||
      current.flag === "-s"
    ) {
      flags["-expertise"] = value;
    } else {
      flags[current.flag] = value;
    }
  }
  return flags;
}

interface MentorQueryArgs {
  filter?: string;
  page: number;
}

export function parseMentorCommandArgs(argsStr: string): MentorQueryArgs {
  const trimmedArgs = argsStr.trim();
  if (!trimmedArgs) {
    return { page: 1 };
  }

  const fIndex = trimmedArgs.toLowerCase().indexOf("-f");
  if (fIndex !== -1) {
    const afterF = trimmedArgs.slice(fIndex + 2).trim();
    const tokens = afterF.split(/\s+/);
    if (tokens.length > 1) {
      const lastToken = tokens[tokens.length - 1];
      const pageNum = parseInt(lastToken, 10);
      if (!isNaN(pageNum) && pageNum > 0) {
        const filterVal = tokens.slice(0, tokens.length - 1).join(" ");
        return { filter: filterVal, page: pageNum };
      }
    }
    return { filter: afterF, page: 1 };
  } else {
    const pageNum = parseInt(trimmedArgs, 10);
    if (!isNaN(pageNum) && pageNum > 0) {
      return { page: pageNum };
    }
    return { page: 1 };
  }
}

export async function handleMentorsQuery(
  session: UserSession,
  filter: string | undefined,
  page: number,
): Promise<string> {
  const limit = PAGINATION_MAX_VIEW;
  const total = await countMentors(filter);
  if (total === 0) {
    if (filter) {
      return `No mentors found matching "${filter}".`;
    } else {
      return "No mentors found in the directory.";
    }
  }

  const totalPages = Math.ceil(total / limit);

  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  // Paginate at the DB layer (LIMIT/OFFSET) instead of fetching every mentor
  // and slicing in memory.
  const offset = (page - 1) * limit;
  const pageMentors = await getMentors(filter, limit, offset);

  const lines: string[] = [];
  lines.push("Mentors Directory");
  if (filter) {
    lines.push(`Filter: "${filter}"`);
  }
  lines.push(`Page ${page} of ${totalPages} (Total: ${total})\n`);

  pageMentors.forEach((m: any) => {
    lines.push(`ID: ${m.id} | *${m.name}*`);
    lines.push(`Expertise: ${m.expertise}`);
    if (m.organization) {
      lines.push(`Organization: ${m.organization}`);
    }
    if (m.linkedin) {
      lines.push(`LinkedIn: ${m.linkedin}`);
    }
    lines.push("");
  });

  if (page < totalPages) {
    lines.push(
      `Tip: Type \`!next\` or \`!page ${page + 1}\` to view the next page!`,
    );
  }

  session.lastQuery = {
    type: "mentors",
    filter,
    page,
  };

  return lines.join("\n").trim();
}
