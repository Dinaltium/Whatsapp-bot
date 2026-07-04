import {
  getEventsForMonth,
  normalizeMonthYear,
  searchEventsGlobally,
  Event,
} from "../../storage/DKB/eventRepository";
import { paginate, pageFooter, DirectorySession } from "./pagination";

export async function handleEventsCommand(
  monthArg: string,
  session?: DirectorySession,
  page: number = 1,
): Promise<string> {
  try {
    const normalized = normalizeMonthYear(monthArg);
    const eventsList = await getEventsForMonth(normalized);

    const lines: string[] = [];
    lines.push(
      `Developer Kommunity Events Catalog (${normalized.toUpperCase()})`,
    );

    if (eventsList.length === 0) {
      lines.push("");
      lines.push("No events scheduled for this month on the calendar.");
    } else {
      const { pageItems, page: p, totalPages } = paginate(eventsList, page);
      if (session) {
        session.lastQuery = { type: "events", filter: normalized, page: p };
      }
      lines.push(`Calendar for ${normalized} (Total: ${eventsList.length}):\n`);
      pageItems.forEach((evt) => {
        lines.push(`*${evt.title}*`);
        if (evt.host) lines.push(`   • Host: ${evt.host}`);
        if (evt.date) lines.push(`   • Date: ${evt.date}`);
        if (evt.location) lines.push(`   • Location: ${evt.location}`);
        if (evt.stage) lines.push(`   • Current Stage: ${evt.stage}`);
        lines.push("");
      });
      const footer = pageFooter("events", p, totalPages);
      if (footer) lines.push(footer);
    }

    lines.push(
      `Tip: Type \`!event <name>\` (e.g. \`!event hackfest\`) for full details.`,
    );
    lines.push(
      `Tip: View other months with \`!events <monthYear>\` (e.g. \`!events may-2026\`).`,
    );

    return lines.join("\n");
  } catch (error) {
    console.error("Error handling events command:", error);
    return "Failed to fetch calendar events. Please try again later.";
  }
}

export async function handleEventDetailCommand(query: string): Promise<string> {
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
