import {
  getClubs,
  getEventsForMonth,
  normalizeMonthYear,
  searchEventsGlobally,
  getMentors,
  Event,
} from "../storage/dk24Store";
import { cleanRole } from "../utils/normalization";
import { sanitizeForPrompt } from "../security/promptFirewall";

export async function buildDynamicContextPrompt(userPrompt: string): Promise<string> {
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
      "what", "is", "about", "event", "events", "the", "there", "in", "on", "at", "for", "of",
      "and", "to", "a", "an", "this", "that", "these", "those", "which", "who", "how", "why",
      "where", "when", "details", "detail", "info", "information", "can", "you", "me", "show",
      "list", "get", "any", "find", "search", "with", "from", "are", "here", "there", "is",
      "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "but",
      "by", "or", "as", "if", "then", "else", "so", "than", "too", "very", "s", "t",
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
  - Event Name: ${sanitizeForPrompt(e.title)} (id: ${sanitizeForPrompt(e.id)})
    Host: ${sanitizeForPrompt(e.host || "N/A")}
    Date: ${sanitizeForPrompt(e.date || "N/A")}
    Location: ${sanitizeForPrompt(e.location || "N/A")}
    Current Stage: ${sanitizeForPrompt(e.stage || "Upcoming")}
    Registration Deadline: ${sanitizeForPrompt(e.registration_deadline || "N/A")}
    Prize Pool: ${sanitizeForPrompt(e.prize_pool || "N/A")}
    Description: ${sanitizeForPrompt(e.description || "N/A")}
    Tracks: ${e.tracks ? e.tracks.map((t) => sanitizeForPrompt(t)).join(", ") : "N/A"}
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
  - Event Name: ${sanitizeForPrompt(e.title)} (id: ${sanitizeForPrompt(e.id)})
    Host: ${sanitizeForPrompt(e.host || "N/A")}
    Date: ${sanitizeForPrompt(e.date || "N/A")}
    Location: ${sanitizeForPrompt(e.location || "N/A")}
    Current Stage: ${sanitizeForPrompt(e.stage || "Upcoming")}
    Registration Deadline: ${sanitizeForPrompt(e.registration_deadline || "N/A")}
    Prize Pool: ${sanitizeForPrompt(e.prize_pool || "N/A")}
    Description: ${sanitizeForPrompt(e.description || "N/A")}
    Tracks: ${e.tracks ? e.tracks.map((t) => sanitizeForPrompt(t)).join(", ") : "N/A"}
  `,
          )
          .join("\n");
    }

    const mentors = await getMentors();

    return `
<community_database>

MEMBER_COMMUNITIES:
${clubs
  .map(
    (c) => `
- Community Name: ${sanitizeForPrompt(c.name)} (ID: ${sanitizeForPrompt(c.id)})
  College: ${sanitizeForPrompt(c.college)}
  Website: ${sanitizeForPrompt(c.website && c.website.toLowerCase().startsWith("http") ? c.website : "None")}
  Description: ${sanitizeForPrompt(c.description)}
  Representatives: ${c.representatives.map((r) => `${sanitizeForPrompt(r.name)} (${sanitizeForPrompt(cleanRole(r.role, r.email))})${r.email ? ` - ${sanitizeForPrompt(r.email)}` : ""}`).join(", ")}
  POCs: ${c.pocs.map((p) => `${sanitizeForPrompt(p.name)} (${sanitizeForPrompt(cleanRole(p.role, p.email))})${p.email ? ` - ${sanitizeForPrompt(p.email)}` : ""}`).join(", ")}
`,
  )
  .join("\n")}

CALENDAR_EVENTS:
${eventsStr}

MENTORS_DIRECTORY:
${
  mentors.length > 0
    ? mentors
        .map(
          (m) => `
- Mentor Name: ${sanitizeForPrompt(m.name)} (ID: ${sanitizeForPrompt(m.id)})
  Expertise: ${sanitizeForPrompt(m.expertise)}
  Organization: ${sanitizeForPrompt(m.organization || "None")}
  LinkedIn: ${sanitizeForPrompt(m.linkedin || "None")}
`,
        )
        .join("\n")
    : "No mentors listed yet."
}

</community_database>
`;
  } catch (error) {
    console.error("⚠️ Failed to build dynamic context prompt:", error);
    return "Error loading dynamic context.";
  }
}
