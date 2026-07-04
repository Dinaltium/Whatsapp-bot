import { getClubs } from "../../storage/DKB/communityRepository";
import { cleanRole } from "../../utils/normalization";
import {
  paginate,
  pageFooter,
  PAGINATION_MAX_VIEW,
  DirectorySession,
} from "./pagination";

// Specific keywords: match on their own (club/community names, DK24 branding)
const COMMUNITY_SPECIFIC = [
  "community",
  "kommunity",
  "dk24",
  "dkb",
  "daik",
  "sosc",
  "sahyadri",
  "devnation",
  "finiteloop",
  "sceptix",
  "techbots",
  "embed",
  "acm",
  "canara",
  "cosc",
  "hacktofuture",
  "hackfest",
  "openloop",
];

// Contextual keywords: only match when combined with a DK24-specific anchor
const COMMUNITY_CONTEXTUAL = [
  "meetup",
  "event",
  "events",
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
  "core",
];

// Anchor words that confirm DK24 context when combined with contextual keywords
const DK24_ANCHORS = [
  "dk24",
  "dkb",
  "daik",
  "kommunity",
  "community",
  "club",
  "clubs",
  "member",
  "mangalore", // DK24 is Mangalore-based
  "mangaluru",
];

export function isCommunityQuery(query: string | null | undefined): boolean {
  if (!query) return false;
  const normalized = query.toLowerCase();

  // Tier 1: Specific keywords always match
  if (COMMUNITY_SPECIFIC.some((kw) => normalized.includes(kw))) {
    return true;
  }

  // Tier 2: Contextual keywords only match if a DK24 anchor is also present
  const hasContextual = COMMUNITY_CONTEXTUAL.some((kw) =>
    normalized.includes(kw),
  );
  const hasAnchor = DK24_ANCHORS.some((anchor) => normalized.includes(anchor));
  return hasContextual && hasAnchor;
}

export async function handleClubsCommand(
  session?: DirectorySession,
  page: number = 1,
): Promise<string> {
  try {
    const clubs = await getClubs();
    if (clubs.length === 0) {
      return "No official member communities found yet. Please try again later.";
    }

    const { pageItems, page: p, totalPages, total } = paginate(clubs, page);
    if (session) session.lastQuery = { type: "clubs", page: p };

    const lines: string[] = [];
    lines.push("Welcome to DK24 (Developer Kommunity 24)!");
    lines.push(`Official member communities (Total: ${total}):\n`);

    const offset = (p - 1) * PAGINATION_MAX_VIEW;
    pageItems.forEach((c, idx) => {
      lines.push(`${offset + idx + 1}. *${c.name}*`);
      lines.push(`   College: ${c.college}`);
      if (c.website && c.website.toLowerCase().startsWith("http")) {
        lines.push(`   Website: ${c.website}`);
      }
      lines.push("");
    });

    lines.push(
      "Tip: Type `!club <name>` (e.g. `!club sosc`) for a club's contacts and reps.",
    );
    const footer = pageFooter("clubs", p, totalPages);
    if (footer) lines.push(footer);

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
