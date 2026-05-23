import {
  getMentors,
  addMentor,
} from "../storage/dk24Store";
import { cleanRole } from "../utils/normalization";
import { getJidHash, logStructured } from "../utils/logger";

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
}

export function parseMentorFlags(text: string): Record<string, string> {
  const flags: Record<string, string> = {};
  const regex = /(?:\s|^)(-[a-zA-Z]+)(?=\s|$)/g;
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

    if (current.flag === "-e") {
      if (value.includes("@")) {
        flags["-email"] = value;
      } else {
        flags["-expertise"] = value;
      }
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
  const mentors = await getMentors(filter);
  if (mentors.length === 0) {
    if (filter) {
      return `No mentors found matching "${filter}".`;
    } else {
      return "No mentors found in the directory.";
    }
  }

  const limit = 10;
  const total = mentors.length;
  const totalPages = Math.ceil(total / limit);

  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const startIdx = (page - 1) * limit;
  const pageMentors = mentors.slice(startIdx, startIdx + limit);

  const lines: string[] = [];
  lines.push("Mentors Directory");
  if (filter) {
    lines.push(`Filter: "${filter}"`);
  }
  lines.push(`Page ${page} of ${totalPages} (Total: ${total})\n`);

  pageMentors.forEach((m) => {
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

export async function classifyIntroduction(
  introText: string,
  groqApiKey: string | undefined,
  groqModel: string,
): Promise<{
  isMentor: boolean;
  name: string;
  organization: string;
  expertise: string;
  description: string;
  linkedin: string;
  email: string;
} | null> {
  if (!groqApiKey || !introText.trim()) return null;

  const prompt = `You are classifying a WhatsApp group introduction message sent to a developer community network in Mangalore, India called DK24.

Determine if the sender is a MENTOR or a STUDENT:
- MENTOR: working professional, founder, co-founder, software engineer at a company, alumni now in industry, someone with a professional role or running a startup
- STUDENT: current college/university student with no professional role yet, someone primarily learning or seeking internships

Introduction message:
"""
${introText}
"""

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "classification": "mentor" or "student",
  "name": "full name or empty string",
  "organization": "company or startup name or empty string",
  "expertise": "technologies, skills, or domain or empty string",
  "description": "one sentence summary of who they are",
  "linkedin": "linkedin URL if mentioned else empty string",
  "email": "email address if mentioned else empty string"
}`;

  try {
    const fetchFn =
      (globalThis as any).fetch ?? (await import("node-fetch")).default;
    const res = await fetchFn(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqApiKey}`,
        },
        body: JSON.stringify({
          model: groqModel,
          temperature: 0.1,
          messages: [{ role: "user", content: prompt }],
        }),
      },
    );

    if (!res.ok) throw new Error(`Groq API ${res.status}`);
    const data = await res.json();
    let raw = (data?.choices?.[0]?.message?.content || "").trim();
    // Strip markdown fences if model wraps the JSON
    raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(raw);
    return {
      isMentor: parsed.classification === "mentor",
      name: String(parsed.name || ""),
      organization: String(parsed.organization || ""),
      expertise: String(parsed.expertise || ""),
      description: String(parsed.description || ""),
      linkedin: String(parsed.linkedin || ""),
      email: String(parsed.email || ""),
    };
  } catch (error) {
    console.error("[IntroClassifier] Classification error:", error);
    return null;
  }
}

export async function classifyAndAutoAddMentor(
  introText: string,
  senderJid: string,
  senderPhone: string,
  groqApiKey: string | undefined,
  groqModel: string,
): Promise<{ isMentor: boolean; mentorName?: string }> {
  const result = await classifyIntroduction(introText, groqApiKey, groqModel);
  if (!result || !result.isMentor) return { isMentor: false };

  logStructured({
    event: "mentor_identified",
    organization: result.organization,
    userHash: getJidHash(senderJid),
  });

  const phone = senderPhone ? `+${senderPhone}` : "";
  try {
    await addMentor(
      result.name || "Unknown",
      result.organization,
      result.expertise,
      result.description,
      result.linkedin,
      "", // instagram — not typically in intros
      "", // github   — not typically in intros
      result.email,
      phone,
      senderJid,
    );
    return { isMentor: true, mentorName: result.name || undefined };
  } catch (error) {
    console.error("[IntroClassifier] Failed to save mentor to DB:", error);
    return { isMentor: false };
  }
}
