import { Mentor } from "../storage/DKB/mentorRepository";

const DKB_COMPACT_PREFIXES = [
  "*DKB*",
  "[DKB]",
  "*DK24*",
  "[DK24]",
  "*[DK24]*",
  "*[DKB]*"
];

export function generateRandomPrefix(): string {
  const names = ["DKB", "DK24", "DK-Bot", "DKB-Agent", "Developer Kommunity"];
  const brackets = [
    ["*", "*"],
    ["[", "]"],
    ["~ ", " ~"],
    ["• ", " •"],
    ["", ""],
    ["*[", "]*"],
    ["*~", "~*"]
  ];
  
  const name = names[Math.floor(Math.random() * names.length)];
  const bracket = brackets[Math.floor(Math.random() * brackets.length)];
  
  const withSuffix = Math.random() < 0.6;
  const suffix = withSuffix ? `-${Math.floor(Math.random() * 999)}` : "";
  
  return `${bracket[0]}${name}${suffix}${bracket[1]}`;
}

export function formatBotReply(text: string): string {
  const cleanedText = String(text || "").trim();
  if (!cleanedText) {
    return "";
  }
  
  const r = Math.random();
  if (r < 0.70) {
    // 70% Plain
    return cleanedText;
  } else if (r < 0.95) {
    // 25% Small Variation
    const prefix = DKB_COMPACT_PREFIXES[Math.floor(Math.random() * DKB_COMPACT_PREFIXES.length)];
    return `${prefix}\n\n${cleanedText}`;
  } else {
    // 5% Stylized
    // Stylized Randomized Suffix Prefix
    const prefix = generateRandomPrefix();
    return `${prefix}\n\n${cleanedText}`;
  }
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
