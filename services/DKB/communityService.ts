import { getClubs } from "../../storage/DKB/communityRepository";
import { cleanRole } from "../../utils/normalization";

const COMMUNITY_KEYWORDS = [
  "community",
  "kommunity",
  "dk24",
  "dkb",
  "daik",
  "meetup",
  "event",
  "collab",
  "collaboration",
  "partner",
  "team",
  "project",
  "build",
  "share",
  "learn",
  "ai",
  "developer",
  "ml",
  "coding",
  "chat",
  "help",
  "hello",
  "hi",
  "sosc",
  "sahyadri",
  "devnation",
  "finiteloop",
  "sceptix",
  "techbots",
  "core",
  "embed",
  "acm",
  "canara",
  "cosc",
  "hacktofuture",
  "hackfest",
  "openloop",
];

export function isCommunityQuery(query: string | null | undefined): boolean {
  if (!query) return false;
  const normalized = query.toLowerCase();
  return COMMUNITY_KEYWORDS.some((kw) => normalized.includes(kw));
}

export async function handleClubsCommand(): Promise<string> {
  try {
    const clubs = await getClubs();
    const lines: string[] = [];
    lines.push("Welcome to DK24 (Developer Kommunity 24)!");
    lines.push("Here are our official member communities:\n");

    clubs.forEach((c, idx) => {
      lines.push(`${idx + 1}. *${c.name}*`);
      lines.push(`   College: ${c.college}`);
      if (c.website && c.website.toLowerCase().startsWith("http")) {
        lines.push(`   Website: ${c.website}`);
      }
      lines.push("");
    });

    lines.push(
      "Tip: Type `!club <name>` (e.g. `!club sosc` or `!club sceptix`) to get detailed contact information and representatives for a specific club!",
    );

    return lines.join("\n");
  } catch (error) {
    console.error("Error handling clubs command:", error);
    return "Failed to fetch communities. Please try again later.";
  }
}

export async function handleClubDetailCommand(query: string): Promise<string> {
  const trimmedQuery = (query || "").trim();
  if (!trimmedQuery) {
    return [
      "Please specify a community name.",
      "Example: `!club sosc` or `!club sceptix`",
      "Type `!clubs` to see all official member communities.",
    ].join("\n");
  }

  try {
    const clubs = await getClubs();
    const normQuery = trimmedQuery.toLowerCase();

    // Match by id, name, college
    const match = clubs.find(
      (c) =>
        c.id.toLowerCase() === normQuery ||
        c.name.toLowerCase().includes(normQuery) ||
        c.college.toLowerCase().includes(normQuery),
    );

    if (!match) {
      return `No community found matching "${trimmedQuery}".\nType \`!clubs\` to see all official member communities!`;
    }

    const lines: string[] = [];
    lines.push(`Member Community Spotlight: *${match.name}*`);
    lines.push(`College: ${match.college}`);
    if (match.website && match.website.toLowerCase().startsWith("http")) {
      lines.push(`Website: ${match.website}`);
    }
    lines.push("");
    lines.push(`Description:\n${match.description}`);
    lines.push("");

    if (match.representatives && match.representatives.length > 0) {
      lines.push("Representatives:");
      match.representatives.forEach((rep) => {
        const cleanedRole = cleanRole(rep.role, rep.email);
        lines.push(
          `• *${rep.name}* (${cleanedRole})${rep.email ? ` - ${rep.email}` : ""}`,
        );
      });
      lines.push("");
    }

    if (match.pocs && match.pocs.length > 0) {
      lines.push("Points of Contact (POCs):");
      match.pocs.forEach((poc) => {
        const cleanedRole = cleanRole(poc.role, poc.email);
        lines.push(
          `• *${poc.name}* (${cleanedRole})${poc.email ? ` - ${poc.email}` : ""}`,
        );
      });
    }

    return lines.join("\n");
  } catch (error) {
    console.error(`Error handling club detail for "${trimmedQuery}":`, error);
    return "Failed to fetch community details. Please try again later.";
  }
}
