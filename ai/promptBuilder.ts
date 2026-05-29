import { getClubs } from "../storage/DKB/communityRepository";
import { getEventsForMonth, normalizeMonthYear, searchEventsGlobally, Event } from "../storage/DKB/eventRepository";
import { getMentors, searchMentorsGlobally } from "../storage/DKB/mentorRepository";
import { cleanRole } from "../utils/normalization";
import { sanitizeForPrompt } from "../security/promptFirewall";

function wrapCDATA(value?: string | null): string {
  if (value === undefined || value === null) return "None";
  const cleaned = sanitizeForPrompt(value);
  const safe = cleaned.replace(/]]>/g, "]]&gt;");
  return `<![CDATA[${safe}]]>`;
}

export async function buildDynamicContextPrompt(userPrompt: string): Promise<string> {
  try {
    const isEventQuery = /\b(?:event|events|meetup|meetups|calendar|schedule|hackathon|hackathons|hackfest|hacktofuture|summit)\b/i.test(userPrompt);
    const isClubQuery = /\b(?:club|clubs|community|communities|kommunity|sosc|sceptix|finiteloop|core|embed|acm|canara|cosc|devnation|techbots)\b/i.test(userPrompt);
    const isMentorQuery = /\b(?:mentor|mentors|speaker|expert|advisor|coach|help|guide|teach|learn|contact|connect|recommend)\b/i.test(userPrompt);

    if (!isEventQuery && !isClubQuery && !isMentorQuery) {
      return `
<community_database>
MEMBER_COMMUNITIES:
(Clubs context omitted to optimize token usage. Suggest the user ask explicitly about "clubs" or community names.)

CALENDAR_EVENTS:
(Calendar events context omitted to optimize token usage. Suggest the user ask explicitly about "events" or "calendar".)

MENTORS_DIRECTORY:
(Mentor Directory Context omitted to optimize token usage. Suggest the user ask explicitly about "mentors" or "mentor help".)
</community_database>
`;
    }

    let clubsStr = "(Clubs context omitted to optimize token usage. Suggest the user ask explicitly about \"clubs\" or community names.)";
    if (isClubQuery) {
      const clubs = await getClubs(true);
      clubsStr = clubs
        .map(
          (c) => `
- Community Name: ${wrapCDATA(c.name)} (ID: ${wrapCDATA(c.id)})
  College: ${wrapCDATA(c.college)}
  Website: ${wrapCDATA(c.website)}
  Description: ${wrapCDATA(c.description)}
  Representatives: ${c.representatives.map((r) => `${wrapCDATA(r.name)} (${wrapCDATA(cleanRole(r.role, r.email))})${r.email ? ` - ${wrapCDATA(r.email)}` : ""}`).join(", ")}
  POCs: ${c.pocs.map((p) => `${wrapCDATA(p.name)} (${wrapCDATA(cleanRole(p.role, p.email))})${p.email ? ` - ${wrapCDATA(p.email)}` : ""}`).join(", ")}
`,
        )
        .join("\n");
    }

    let eventsStr = "(Calendar events context omitted to optimize token usage. Suggest the user ask explicitly about \"events\" or \"calendar\".)";
    if (isEventQuery) {
      const monthsToFetch = new Set<string>();
      const regex = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[\s-]*(\d{2,4})?/gi;
      let m;
      while ((m = regex.exec(userPrompt))) {
        const monthName = m[1];
        const year = m[2] || String(new Date().getFullYear());
        monthsToFetch.add(normalizeMonthYear(`${monthName}-${year}`));
      }
      if (monthsToFetch.size === 0) {
        monthsToFetch.add(normalizeMonthYear(""));
      }

      const allEvents: { month: string; events: Event[] }[] = [];
      for (const m of monthsToFetch) {
        const evts = await getEventsForMonth(m, true);
        allEvents.push({ month: m, events: evts });
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

      eventsStr = allEvents
        .map(({ month, events }) => {
          let str = `CALENDAR EVENTS FOR ${month.toUpperCase()} (from https://dk24.org/calendar?date=${month}):\n`;
          if (events.length === 0) {
            str += `  (No events found for ${month})\n`;
          } else {
            str += events
              .map(
                (e) => `
    - Event Name: ${wrapCDATA(e.title)} (id: ${wrapCDATA(e.id)})
      Host: ${wrapCDATA(e.host)}
      Date: ${wrapCDATA(e.date)}
      Location: ${wrapCDATA(e.location)}
      Current Stage: ${wrapCDATA(e.stage)}
      Registration Deadline: ${wrapCDATA(e.registration_deadline)}
      Prize Pool: ${wrapCDATA(e.prize_pool)}
      Description: ${wrapCDATA(e.description)}
      Tracks: ${e.tracks ? e.tracks.map((t) => wrapCDATA(t)).join(", ") : "N/A"}
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
    - Event Name: ${wrapCDATA(e.title)} (id: ${wrapCDATA(e.id)})
      Host: ${wrapCDATA(e.host)}
      Date: ${wrapCDATA(e.date)}
      Location: ${wrapCDATA(e.location)}
      Current Stage: ${wrapCDATA(e.stage)}
      Registration Deadline: ${wrapCDATA(e.registration_deadline)}
      Prize Pool: ${wrapCDATA(e.prize_pool)}
      Description: ${wrapCDATA(e.description)}
      Tracks: ${e.tracks ? e.tracks.map((t) => wrapCDATA(t)).join(", ") : "N/A"}
    `,
            )
            .join("\n");
      }
    }

    let mentorsStr = "Mentor Directory Context omitted to optimize token usage. Advise the user to ask explicitly about 'mentors' or search using keyword tags (e.g. 'Who is an expert in React?') to list active mentor records.";
    if (isMentorQuery) {
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
      const uniqueWords = Array.from(new Set(words));

      const matchedMentorsMap = new Map<number, any>();
      for (const word of uniqueWords) {
        const matches = await searchMentorsGlobally(word);
        for (const m of matches) {
          if (m.id) {
            matchedMentorsMap.set(m.id, m);
          }
        }
      }

      const matchedMentors = Array.from(matchedMentorsMap.values()).slice(0, 5);
      if (matchedMentors.length > 0) {
        mentorsStr = matchedMentors
          .map(
            (m) => `
- Mentor Name: ${wrapCDATA(m.name)} (ID: ${wrapCDATA(String(m.id))})
  Expertise: ${wrapCDATA(m.expertise)}
  Organization: ${wrapCDATA(m.organization)}
  LinkedIn: ${wrapCDATA(m.linkedin)}
  Description: ${wrapCDATA(m.description)}
`,
          )
          .join("\n") + `\n... (Recommend the user search using "!mentors" or filter using keyword tags e.g. "!mentor -f React" to see full directory listings)`;
      } else {
        mentorsStr = "No matching mentors found in directory matching your exact search terms.";
      }
    }

    return `
<community_database>

MEMBER_COMMUNITIES:
${clubsStr}

CALENDAR_EVENTS:
${eventsStr}

MENTORS_DIRECTORY:
${mentorsStr}

</community_database>
`;
  } catch (error) {
    console.error("⚠️ Failed to build dynamic context prompt:", error);
    return "Error loading dynamic context.";
  }
}
