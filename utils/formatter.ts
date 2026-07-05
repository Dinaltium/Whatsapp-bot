import { Mentor } from "../storage/DKB/mentorRepository";

/**
 * Returns the reply text as-is. Bot name/header prefixes (e.g. "DK-Bot-692")
 * were removed — every bot now replies with clean text and no persona header.
 */
export function formatBotReply(text: string): string {
  return String(text || "").trim();
}

export function formatMentorDetail(m: Mentor): string {
  const lines: string[] = [];
  lines.push(`Mentor Spotlight: *${m.name}* (ID: ${m.id})`);
  lines.push(`Organization: ${m.organization}`);
  if (m.description) {
    lines.push("");
    lines.push(`Description:\n${m.description}`);
  }
  if (m.expertise) {
    lines.push(`Expertise: ${m.expertise}`);
  }
  if (m.linkedin) {
    lines.push(`LinkedIn: ${m.linkedin}`);
  }
  if (m.github) {
    lines.push(`GitHub: ${m.github}`);
  }
  if (m.instagram) {
    lines.push(`Instagram: ${m.instagram}`);
  }
  if (m.email) {
    lines.push(`Email: ${m.email}`);
  }
  if (m.phone) {
    lines.push(`Phone: ${m.phone}`);
  }
  return lines.join("\n").trim();
}
