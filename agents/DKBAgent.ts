import Groq from "groq-sdk";
import {
  getClubs,
  getEventsForMonth,
  normalizeMonthYear,
  ensureSchema,
  Club,
  Event,
  addMentor,
  deleteMentor,
  getMentors,
  isWorkerAuthorized,
  Mentor,
  getMentorById,
  updateMentorField,
  searchEventsGlobally,
} from "../storage/dk24Store";

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

type GroqMessageParam = {
  role: "user" | "assistant";
  content: string;
};

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

interface AgentResult {
  reply: string;
  usedAI: boolean;
  domainLocked?: boolean;
}

const DKB_HEADER = "```\n"+
"██████╗ ██╗  ██╗██████╗\n" +
"██╔══██╗██║ ██╔╝██╔══██╗\n" +
"██║  ██║█████╔╝ ██████╔╝\n" +
"██║  ██║██╔═██╗ ██╔══██╗\n" +
"██████╔╝██║  ██╗██████╔╝\n" +
"╚═════╝ ╚═╝  ╚═╝╚═════╝\n" +
"```";

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

function formatBotReply(text: string): string {
  const cleanedText = String(text || "").trim();
  if (!cleanedText) {
    return DKB_HEADER;
  }
  return `${DKB_HEADER}\n\n${cleanedText}`;
}

function isCommunityQuery(query: string | null | undefined): boolean {
  if (!query) return false;
  const normalized = query.toLowerCase();
  return COMMUNITY_KEYWORDS.some((kw) => normalized.includes(kw));
}

function cleanRole(role: string, email?: string): string {
  let cleaned = (role || "").trim();
  if (email && email.trim()) {
    const trimmedEmail = email.trim();
    if (cleaned.endsWith(trimmedEmail)) {
      cleaned = cleaned.slice(0, -trimmedEmail.length).trim();
    }
  }
  return cleaned
    .replace(/^[-\s]+/, "")
    .replace(/[-\s]+$/, "")
    .trim();
}

async function handleClubsCommand(): Promise<string> {
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

async function handleClubDetailCommand(query: string): Promise<string> {
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

async function handleEventsCommand(monthArg: string): Promise<string> {
  try {
    const normalized = normalizeMonthYear(monthArg);
    const eventsList = await getEventsForMonth(normalized);

    const lines: string[] = [];
    lines.push(
      `Developer Kommunity Events Catalog (${normalized.toUpperCase()})`,
    );
    lines.push(
      `We track and power awesome developer events! Here is the ${normalized} calendar:\n`,
    );

    if (eventsList.length === 0) {
      lines.push("No events scheduled for this month on the calendar.");
    } else {
      eventsList.forEach((evt, idx) => {
        lines.push(`${idx + 1}. *${evt.title}*`);
        if (evt.host) lines.push(`   • Host: ${evt.host}`);
        if (evt.date) lines.push(`   • Date: ${evt.date}`);
        if (evt.location) lines.push(`   • Location: ${evt.location}`);
        if (evt.stage) lines.push(`   • Current Stage: ${evt.stage}`);
        lines.push("");
      });
    }

    lines.push(
      `Tip: Type \`!event <name>\` (e.g. \`!event hackfest\`) to get full details of a specific event!`,
    );
    lines.push(
      `Tip: You can view other months by typing \`!events <monthYear>\` (e.g. \`!events may-2026\` or \`!events jun26\`).`,
    );

    return lines.join("\n");
  } catch (error) {
    console.error("Error handling events command:", error);
    return "Failed to fetch calendar events. Please try again later.";
  }
}

async function handleEventDetailCommand(query: string): Promise<string> {
  const trimmedQuery = (query || "").trim();
  if (!trimmedQuery) {
    return [
      "Please specify an event name.",
      "Example: `!event hackfest` or `!event hackfest apr-2026`",
      "Type `!events` to see the complete calendar.",
    ].join("\n");
  }

  try {
    // Parse for optional monthYear in the query (e.g. "hackfest apr-2026")
    let targetMonth = normalizeMonthYear(""); // default to current
    let searchName = trimmedQuery;
    let explicitMonth = false;

    const monthRegex = /\b([a-z]{3,9})[\s-]*(\d{2,4})\b/i;
    const matchMonth = trimmedQuery.match(monthRegex);
    if (matchMonth) {
      // A month-year was specified in the command
      targetMonth = normalizeMonthYear(matchMonth[0]);
      // Remove the month-year from the search term
      searchName = trimmedQuery.replace(matchMonth[0], "").trim();
      explicitMonth = true;
    }

    // If searchName is empty (e.g. user just typed `!event apr-2026`), treat it as `!events apr-2026`
    if (!searchName) {
      return await handleEventsCommand(targetMonth);
    }

    let match: Event | undefined;
    const otherMatchingTitles: string[] = [];

    // Prioritize global cached database search if no month was explicitly requested
    if (!explicitMonth) {
      const globalMatches = await searchEventsGlobally(searchName);
      if (globalMatches.length > 0) {
        // Prioritize case-insensitive exact title match
        const exactMatch = globalMatches.find(
          (e) => e.title.toLowerCase() === searchName.toLowerCase(),
        );
        if (exactMatch) {
          match = exactMatch;
          globalMatches.forEach((e) => {
            if (e.id !== exactMatch.id) {
              otherMatchingTitles.push(e.title);
            }
          });
        } else if (globalMatches.length > 1) {
          // Multiple matches found! Present a choice list to the user
          const lines: string[] = [];
          lines.push(`Multiple events found matching "${searchName}":\n`);
          globalMatches.forEach((e, idx) => {
            const dateStr = e.date ? ` (${e.date})` : "";
            lines.push(`${idx + 1}. *${e.title}*${dateStr}`);
          });
          lines.push(
            "\nTip: Type `!event <full-name>` to see details of a specific event!",
          );
          return lines.join("\n");
        } else {
          match = globalMatches[0];
        }
      }
    }

    // Fall back to target/current/apr-26 month search/scrapes if not matched globally or if month was explicit
    if (!match) {
      // Fetch events for target month
      let eventsList = await getEventsForMonth(targetMonth);

      let normQuery = searchName.toLowerCase();
      const localMatches = eventsList.filter(
        (e) =>
          e.title.toLowerCase().includes(normQuery) ||
          (e.host && e.host.toLowerCase().includes(normQuery)),
      );

      if (localMatches.length > 0) {
        const exactMatch = localMatches.find(
          (e) => e.title.toLowerCase() === normQuery,
        );
        if (exactMatch) {
          match = exactMatch;
          localMatches.forEach((e) => {
            if (e.id !== exactMatch.id) {
              otherMatchingTitles.push(e.title);
            }
          });
        } else if (localMatches.length > 1) {
          // Multiple local matches
          const lines: string[] = [];
          lines.push(
            `Multiple events found matching "${searchName}" in ${targetMonth}:\n`,
          );
          localMatches.forEach((e, idx) => {
            const dateStr = e.date ? ` (${e.date})` : "";
            lines.push(`${idx + 1}. *${e.title}*${dateStr}`);
          });
          lines.push(
            "\nTip: Type `!event <full-name>` to see details of a specific event!",
          );
          return lines.join("\n");
        } else {
          match = localMatches[0];
        }
      }

      // If not found in targetMonth, let's search current month (if different)
      if (!match) {
        const currentMonth = normalizeMonthYear("");
        if (targetMonth !== currentMonth) {
          eventsList = await getEventsForMonth(currentMonth, false);
          const currentMatches = eventsList.filter(
            (e) =>
              e.title.toLowerCase().includes(normQuery) ||
              (e.host && e.host.toLowerCase().includes(normQuery)),
          );
          if (currentMatches.length > 0) {
            const exactMatch = currentMatches.find(
              (e) => e.title.toLowerCase() === normQuery,
            );
            if (exactMatch) {
              match = exactMatch;
              currentMatches.forEach((e) => {
                if (e.id !== exactMatch.id) {
                  otherMatchingTitles.push(e.title);
                }
              });
            } else if (currentMatches.length > 1) {
              const lines: string[] = [];
              lines.push(
                `Multiple events found matching "${searchName}" in ${currentMonth}:\n`,
              );
              currentMatches.forEach((e, idx) => {
                const dateStr = e.date ? ` (${e.date})` : "";
                lines.push(`${idx + 1}. *${e.title}*${dateStr}`);
              });
              lines.push(
                "\nTip: Type `!event <full-name>` to see details of a specific event!",
              );
              return lines.join("\n");
            } else {
              match = currentMatches[0];
            }
          }
        }
      }

      // Fallback search to "apr-2026"
      if (!match && targetMonth !== "apr-2026") {
        eventsList = await getEventsForMonth("apr-2026", false);
        const fallbackMatches = eventsList.filter(
          (e) =>
            e.title.toLowerCase().includes(normQuery) ||
            (e.host && e.host.toLowerCase().includes(normQuery)),
        );
        if (fallbackMatches.length > 0) {
          const exactMatch = fallbackMatches.find(
            (e) => e.title.toLowerCase() === normQuery,
          );
          if (exactMatch) {
            match = exactMatch;
            fallbackMatches.forEach((e) => {
              if (e.id !== exactMatch.id) {
                otherMatchingTitles.push(e.title);
              }
            });
          } else if (fallbackMatches.length > 1) {
            const lines: string[] = [];
            lines.push(
              `Multiple events found matching "${searchName}" in April 2026:\n`,
            );
            fallbackMatches.forEach((e, idx) => {
              const dateStr = e.date ? ` (${e.date})` : "";
              lines.push(`${idx + 1}. *${e.title}*${dateStr}`);
            });
            lines.push(
              "\nTip: Type `!event <full-name>` to see details of a specific event!",
            );
            return lines.join("\n");
          } else {
            match = fallbackMatches[0];
          }
        }
      }
    }

    if (!match) {
      return `No event found matching "${searchName}" in the target month calendar.\nType \`!events\` to see the complete calendar!`;
    }

    const lines: string[] = [];
    lines.push(`Event Spotlight: *${match.title}*`);
    if (match.host) lines.push(`Hosting Club: ${match.host}`);
    if (match.date) lines.push(`Dates: ${match.date}`);
    if (match.location) lines.push(`Location: ${match.location}`);
    if (match.stage) lines.push(`Stage Status: ${match.stage}`);
    if (match.registration_deadline) {
      lines.push(`Registration Deadline: ${match.registration_deadline}`);
    }
    if (match.prize_pool) {
      lines.push(`Prize Pool: ${match.prize_pool}`);
    }

    if (match.description) {
      lines.push("");
      lines.push(`About the Event:\n${match.description}`);
    }

    if (match.tracks && match.tracks.length > 0) {
      lines.push("");
      lines.push("Event Tracks:");
      match.tracks.forEach((track) => {
        lines.push(`• ${track}`);
      });
    }

    if (match.registration_link) {
      lines.push("");
      lines.push(`Registration Link: ${match.registration_link}`);
    }
    if (match.join_link) {
      lines.push("");
      lines.push(`Website Link: ${match.join_link}`);
    }
    if (match.youtube_link) {
      lines.push("");
      lines.push(`Recording Link: ${match.youtube_link}`);
    }

    if (otherMatchingTitles.length > 0) {
      lines.push("");
      lines.push(
        `💡 Other matching events found: ${otherMatchingTitles.map((t) => `*${t}*`).join(", ")}`,
      );
      lines.push(
        "Type `!event <full-name>` to see details of a specific event!",
      );
    }

    return lines.join("\n");
  } catch (error) {
    console.error(`Error handling event detail for "${trimmedQuery}":`, error);
    return "Failed to fetch event details. Please try again later.";
  }
}

async function buildDynamicContextPrompt(userPrompt: string): Promise<string> {
  try {
    const clubs = await getClubs(false);

    // Always include current month
    const currentMonthYear = normalizeMonthYear("");
    const monthsToFetch = new Set<string>();
    monthsToFetch.add(currentMonthYear);

    // Extract explicitly requested months from user prompt
    const regex =
      /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s-]*(\d{2,4})/gi;
    let m;
    while ((m = regex.exec(userPrompt))) {
      monthsToFetch.add(normalizeMonthYear(m[0]));
    }

    const allEvents: { month: string; events: Event[] }[] = [];
    for (const m of monthsToFetch) {
      const evts = await getEventsForMonth(m, false);
      if (evts.length > 0) {
        allEvents.push({ month: m, events: evts });
      } else {
        // Just push empty to show there are 0 events
        allEvents.push({ month: m, events: [] });
      }
    }

    const seenEventIds = new Set<string>();
    for (const item of allEvents) {
      for (const e of item.events) {
        seenEventIds.add(e.id);
      }
    }

    // Extract search keywords from user prompt (filter out stop words)
    const stopWords = new Set([
      "what",
      "is",
      "about",
      "event",
      "events",
      "the",
      "there",
      "in",
      "on",
      "at",
      "for",
      "of",
      "and",
      "to",
      "a",
      "an",
      "this",
      "that",
      "these",
      "those",
      "which",
      "who",
      "how",
      "why",
      "where",
      "when",
      "details",
      "detail",
      "info",
      "information",
      "can",
      "you",
      "me",
      "show",
      "list",
      "get",
      "any",
      "find",
      "search",
      "with",
      "from",
      "are",
      "here",
      "there",
      "is",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "but",
      "by",
      "or",
      "as",
      "if",
      "then",
      "else",
      "so",
      "than",
      "too",
      "very",
      "s",
      "t",
    ]);

    const words = userPrompt
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2 && !stopWords.has(w));

    const globalMatches: Event[] = [];
    const uniqueWords = Array.from(new Set(words));
    for (const word of uniqueWords) {
      const matches = await searchEventsGlobally(word);
      for (const match of matches) {
        if (!seenEventIds.has(match.id)) {
          seenEventIds.add(match.id);
          globalMatches.push(match);
        }
      }
    }

    let eventsStr = allEvents
      .map(({ month, events }) => {
        let str = `CALENDAR EVENTS FOR ${month.toUpperCase()} (from https://dk24.org/calendar?date=${month}):\n`;
        if (events.length === 0) {
          str += `  (No events found for ${month})\n`;
        } else {
          str += events
            .map(
              (e) => `
  - ${e.title} (id: ${e.id})
    Host: ${e.host || "N/A"}
    Date: ${e.date || "N/A"}
    Location: ${e.location || "N/A"}
    Current Stage: ${e.stage || "Upcoming"}
    Registration Deadline: ${e.registration_deadline || "N/A"}
    Prize Pool: ${e.prize_pool || "N/A"}
    Description: ${e.description || "N/A"}
    Tracks: ${e.tracks ? e.tracks.join(", ") : "N/A"}
  `,
            )
            .join("\n");
        }
        return str;
      })
      .join("\n");

    if (globalMatches.length > 0) {
      eventsStr +=
        `\n\nRELEVANT MATCHING EVENTS FOUND FOR USER QUERY:\n` +
        globalMatches
          .map(
            (e) => `
  - ${e.title} (id: ${e.id})
    Host: ${e.host || "N/A"}
    Date: ${e.date || "N/A"}
    Location: ${e.location || "N/A"}
    Current Stage: ${e.stage || "Upcoming"}
    Registration Deadline: ${e.registration_deadline || "N/A"}
    Prize Pool: ${e.prize_pool || "N/A"}
    Description: ${e.description || "N/A"}
    Tracks: ${e.tracks ? e.tracks.join(", ") : "N/A"}
  `,
          )
          .join("\n");
    }

    const mentors = await getMentors();

    return `
Here is the official community and events database for DK24 (Developer Kommunity 24) — a unified tech community network based in Mangalore, India, connecting college tech clubs and developers across institutions (website: https://dk24.org). Use this data to answer any questions about member communities, their representatives, points of contact, websites, and our events calendar:

MEMBER COMMUNITIES (from https://dk24.org/communities):
${clubs
  .map(
    (c) => `
- ${c.name} (id: ${c.id})
  College: ${c.college}
  Website: ${c.website && c.website.toLowerCase().startsWith("http") ? c.website : "None"}
  Description: ${c.description}
  Representatives: ${c.representatives.map((r) => `${r.name} (${cleanRole(r.role, r.email)})${r.email ? ` - ${r.email}` : ""}`).join(", ")}
  POCs: ${c.pocs.map((p) => `${p.name} (${cleanRole(p.role, p.email)})${p.email ? ` - ${p.email}` : ""}`).join(", ")}
`,
  )
  .join("\n")}

${eventsStr}

MENTORS DIRECTORY:
${
  mentors.length > 0
    ? mentors
        .map(
          (m) => `
- ${m.name} (ID: ${m.id})
  Expertise: ${m.expertise}
  Organization: ${m.organization || "None"}
  LinkedIn: ${m.linkedin || "None"}
`,
        )
        .join("\n")
    : "No mentors listed yet."
}
`;
  } catch (error) {
    console.error("⚠️ Failed to build dynamic context prompt:", error);
    return "Error loading dynamic context.";
  }
}

async function getGroqReply(
  conversationMessages: ConversationMessage[],
  groqApiKey: string | undefined,
  groqModel: string,
  userPrompt: string,
): Promise<string> {
  if (!groqApiKey) {
    return "Groq key missing. Set GROQ_API_KEY in your environment to enable AI replies.";
  }

  const client = new Groq({
    apiKey: groqApiKey,
  });

  const baseSystem = [
    "You are DKB, the primary AI assistant for DK24 (Developer Kommunity 24).",
    "ABOUT DK24: DK24 stands for Developer Kommunity 24. It was inspired by Bangalore's thriving tech community scene — the founders decided to create a similar unified tech community for Mangalore. The name 'DK' can stand for both 'Dakshina Kannada' (the district) and 'Developer Kommunity', though the latter is the preferred meaning. The '24' comes from the DK24 Summit 2024 — a landmark event on November 8th, 2024 where Mangaluru's foremost technical communities (SOSC, GDG SJEC, The Sceptix Club, Finite Loop Club, GLUG PACE, CORE, SSOSC, Team Challengers, DevNation, Kudla Builders, and GDG AJ) came together for a transformative day of collaboration, innovation, and shared vision. The number '24' was kept unchanged even as the years progressed as a tribute to this founding event. DK24 also has a long-term goal of reaching out to 24 colleges in Mangalore; currently around 12-16 colleges are connected, including 10 core member colleges.",
    "DK24 STRUCTURE: DK24 has two types of groups — Core and Cluster. Core represents each member club from their respective college; from each college a club is selected and members from that club serve as POCs (Points of Contact) and representatives. Cluster is where all developers across colleges are connected — students and mentors communicate, discuss tech, and build relationships across institutions.",
    "DK24 VISION: To create a thriving tech ecosystem in Mangalore where students with ideas can access the best resources in the city, fostering innovation and collaboration across college boundaries.",
    "DK24 MISSION: To connect college tech communities to learn and build together in public, breaking down silos between institutions and creating a unified tech community that empowers students to grow through collaborative projects and knowledge sharing.",
    "DK24 LONG-TERM GOALS: Establish Mangalore as a recognized tech hub in India. Create pathways for students to transition from education to industry. Foster 100+ open-source projects with real-world impact. Build a mentor network of 500+ industry professionals. Develop a self-sustaining community model replicable in other regions.",
    "Your focus is to support developer collaboration, building AI-powered products, sharing cool hacks, learning machine learning, hosting meetups, and forming teams.",
    "Keep responses extremely positive, supportive of open-source and developer community building, practical, and under 150 words unless requested.",
    "Do NOT use any emojis or emoticons in your responses under any circumstances. Keep responses in plain text.",
    "CRITICAL REQUIREMENT FOR AMBIGUOUS EVENT QUERIES: If the user asks about an event (e.g., 'devfest' or 'dev') but the provided context has multiple matching events with similar names (e.g., 'devfest 2025', 'devfest Kommunity', 'devops'), you MUST NOT pick just one or describe all of them in detail. Instead, you must respond by politely listing the names of all the matching events found in the context and asking the user explicitly: 'Which event do you want to know about?' or something similar.",
  ].join(" ");

  const dynamicContext = await buildDynamicContextPrompt(userPrompt);
  const systemPrompt = `${baseSystem}\n\n${dynamicContext}`;

  const messages: GroqMessageParam[] = conversationMessages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

  try {
    if ((client as any)?.messages?.create) {
      const response = (await (client as any).messages.create({
        model: groqModel,
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages,
      })) as any;

      const aiText = response?.content?.[0];
      if (!aiText || aiText.type !== "text") {
        throw new Error("Unexpected response type from Groq SDK");
      }

      const trimmedText = aiText.text?.trim();
      if (!trimmedText) throw new Error("Groq returned an empty response.");
      return trimmedText;
    } else {
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
            temperature: 0.4,
            messages: [{ role: "system", content: systemPrompt }, ...messages],
          }),
        },
      );

      if (!res.ok) {
        const errorBody = await res.text();
        throw new Error(`Groq API ${res.status}: ${errorBody}`);
      }

      const data = await res.json();
      const aiText = data?.choices?.[0]?.message?.content?.trim();
      if (!aiText) throw new Error("Groq returned an empty response.");
      return aiText;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Groq API error: ${errorMessage}`);
  }
}

function popUserMessage(session: UserSession, userPrompt: string): void {
  if (
    session.messages.length > 0 &&
    session.messages[session.messages.length - 1].content === userPrompt
  ) {
    session.messages.pop();
  }
}

function combineCountryCodeAndNumber(
  countryCode: string,
  rawNumber: string,
): string {
  const ccDigits = countryCode.replace(/\D/g, "");
  const numDigits = rawNumber.replace(/\D/g, "");
  return `+${ccDigits} ${numDigits}`;
}

function parseMentorFlags(text: string): Record<string, string> {
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

function formatWithCountryCode(rawPhone: string): {
  formatted?: string;
  needsCountryCode: boolean;
  rawNumber?: string;
} {
  const cleaned = rawPhone.trim();
  if (!cleaned) return { needsCountryCode: false };
  const startsWithPlus = cleaned.startsWith("+");
  const digits = cleaned.replace(/\D/g, "");
  if (startsWithPlus) {
    if (digits.startsWith("1")) {
      return {
        formatted: `+1 ${digits.substring(1)}`,
        needsCountryCode: false,
      };
    }
    if (digits.startsWith("7")) {
      return {
        formatted: `+7 ${digits.substring(1)}`,
        needsCountryCode: false,
      };
    }
    const threeDigitCountryCodes = [
      "971",
      "966",
      "965",
      "968",
      "973",
      "974",
      "353",
      "370",
      "371",
      "372",
      "380",
      "506",
      "507",
      "509",
    ];
    const prefix3 = digits.substring(0, 3);
    if (threeDigitCountryCodes.includes(prefix3)) {
      return {
        formatted: `+${prefix3} ${digits.substring(3)}`,
        needsCountryCode: false,
      };
    }
    const prefix2 = digits.substring(0, 2);
    return {
      formatted: `+${prefix2} ${digits.substring(2)}`,
      needsCountryCode: false,
    };
  }
  if (digits.length <= 10) {
    return { needsCountryCode: true, rawNumber: digits };
  }
  if (digits.startsWith("91") && digits.length === 12) {
    return { formatted: `+91 ${digits.substring(2)}`, needsCountryCode: false };
  }
  if (digits.startsWith("971") && digits.length === 12) {
    return {
      formatted: `+971 ${digits.substring(3)}`,
      needsCountryCode: false,
    };
  }
  return { needsCountryCode: true, rawNumber: digits };
}

function formatMentorDetail(m: Mentor): string {
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

interface MentorQueryArgs {
  filter?: string;
  page: number;
}

function parseMentorCommandArgs(argsStr: string): MentorQueryArgs {
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

async function handleMentorsQuery(
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

async function handleMessage(
  session: UserSession,
  userPrompt: string,
  groqApiKey: string | undefined,
  groqModel: string,
  isAdmin: boolean = false,
  senderJid?: string,
): Promise<AgentResult> {
  const trimmed = (userPrompt || "").trim();
  const lowerPrompt = trimmed.toLowerCase();

  // ──────────────────────────────────────────────────────────────────────────
  // MULTI-TURN: Resolve pending country code for !addmentor
  // ──────────────────────────────────────────────────────────────────────────
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
      isAdmin || (senderJid && (await isWorkerAuthorized(senderJid, "mentor")));
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

  // ──────────────────────────────────────────────────────────────────────────
  // MULTI-TURN: Resolve pending country code for !editmentor -p
  // ──────────────────────────────────────────────────────────────────────────
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
      isAdmin || (senderJid && (await isWorkerAuthorized(senderJid, "mentor")));
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

  // ──────────────────────────────────────────────────────────────────────────
  // CLUBS COMMANDS
  // ──────────────────────────────────────────────────────────────────────────
  if (lowerPrompt === "clubs") {
    popUserMessage(session, userPrompt);
    return { reply: formatBotReply(await handleClubsCommand()), usedAI: false };
  }

  if (lowerPrompt.startsWith("club")) {
    const query = trimmed.slice(4).trim();
    popUserMessage(session, userPrompt);
    return {
      reply: formatBotReply(await handleClubDetailCommand(query)),
      usedAI: false,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // EVENTS COMMANDS
  // ──────────────────────────────────────────────────────────────────────────
  if (lowerPrompt.startsWith("events")) {
    const query = trimmed.slice(6).trim();
    popUserMessage(session, userPrompt);
    return {
      reply: formatBotReply(await handleEventsCommand(query)),
      usedAI: false,
    };
  }

  if (lowerPrompt.startsWith("event")) {
    const query = trimmed.slice(5).trim();
    popUserMessage(session, userPrompt);
    return {
      reply: formatBotReply(await handleEventDetailCommand(query)),
      usedAI: false,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MENTOR DIRECTORY - List / Paginate / ID Lookup
  // ──────────────────────────────────────────────────────────────────────────
  const isMentorsCmd = lowerPrompt.startsWith("mentors");
  const isMentorCmd = !isMentorsCmd && lowerPrompt.startsWith("mentor");

  if (isMentorsCmd || isMentorCmd) {
    popUserMessage(session, userPrompt);
    const argsStr = trimmed.slice(isMentorsCmd ? 7 : 6).trim();

    // ID lookup: !mentor -id <number>
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

  // ──────────────────────────────────────────────────────────────────────────
  // ADD MENTOR - Flag-based, multiline, order-independent
  // !addmentor -n Name -o Org [-d Desc] [-ex Expertise] [-l LinkedIn]
  //            [-i Instagram] [-g GitHub] [-e email@x.com] [-p Phone]
  // ──────────────────────────────────────────────────────────────────────────
  if (lowerPrompt.startsWith("addmentor")) {
    popUserMessage(session, userPrompt);
    const isAuthorized =
      isAdmin || (senderJid && (await isWorkerAuthorized(senderJid, "mentor")));
    if (!isAuthorized) {
      return {
        reply: formatBotReply(
          "Unauthorized: you do not have permission to manage mentors.",
        ),
        usedAI: false,
      };
    }

    const argsRaw = trimmed.slice(9); // strip "addmentor"
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

  // ──────────────────────────────────────────────────────────────────────────
  // EDIT MENTOR - Update a single field on an existing mentor
  // Usage: !editmentor <id> -<flag> <value>
  // ──────────────────────────────────────────────────────────────────────────
  if (lowerPrompt.startsWith("editmentor")) {
    popUserMessage(session, userPrompt);
    const isAuthorized =
      isAdmin || (senderJid && (await isWorkerAuthorized(senderJid, "mentor")));
    if (!isAuthorized) {
      return {
        reply: formatBotReply(
          "Unauthorized: you do not have permission to manage mentors.",
        ),
        usedAI: false,
      };
    }

    const argsRaw = trimmed.slice(10).trim();
    const editMatch = argsRaw.match(/^(\d+)\s+(-[a-zA-Z]+)\s+([\s\S]+)$/);
    if (!editMatch) {
      return {
        reply: formatBotReply(
          [
            "Usage: !editmentor <id> -<flag> <value>",
            "",
            "Examples:",
            "  !editmentor 3 -n New Name",
            "  !editmentor 3 -o New Organization",
            "  !editmentor 3 -p +91 9902849280",
            "  !editmentor 3 -l https://linkedin.com/in/rafan",
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

    const ok = await updateMentorField(mentorId, flag, value || null);
    return {
      reply: formatBotReply(
        ok
          ? `Field updated successfully for mentor "${existingMentor.name}" (ID: ${mentorId}).`
          : `Failed to update field for mentor ID ${mentorId}. Check that the flag is valid.`,
      ),
      usedAI: false,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE MENTOR
  // ──────────────────────────────────────────────────────────────────────────
  if (lowerPrompt.startsWith("delmentor")) {
    popUserMessage(session, userPrompt);
    const isAuthorized =
      isAdmin || (senderJid && (await isWorkerAuthorized(senderJid, "mentor")));
    if (!isAuthorized) {
      return {
        reply: formatBotReply(
          "Unauthorized: you do not have permission to manage mentors.",
        ),
        usedAI: false,
      };
    }

    const query = trimmed.slice(9).trim();
    if (!query) {
      return {
        reply: formatBotReply("Usage: !delmentor <id_or_name>"),
        usedAI: false,
      };
    }

    const ok = await deleteMentor(query);
    return {
      reply: formatBotReply(
        ok
          ? `Successfully deleted mentor "${query}".`
          : `Mentor "${query}" not found or failed to delete.`,
      ),
      usedAI: false,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // AI FALLBACK
  // ──────────────────────────────────────────────────────────────────────────
  const isCommunity = isCommunityQuery(userPrompt);

  if (!isCommunity && !session.domainUnlocked && !isAdmin) {
    return {
      reply: formatBotReply(
        [
          "I support DK24 (Developer Kommunity 24)!",
          "Ask me about AI application building, community meetups, collaboration partners, or coding challenges.",
          "Example: !What is a good way to host a local AI developer meetup?",
        ].join("\n"),
      ),
      usedAI: false,
      domainLocked: true,
    };
  }

  const aiReply = await getGroqReply(
    session.messages,
    groqApiKey,
    groqModel,
    userPrompt,
  );
  return { reply: formatBotReply(aiReply), usedAI: true };
}

export default {
  handleMessage,
};
