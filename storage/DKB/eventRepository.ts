import { getPool } from "../db";
import { isCacheValid, markCacheUpdated } from "../core/cacheRepository";

export interface Event {
  id: string;
  title: string;
  host?: string;
  date?: string;
  location?: string;
  description?: string;
  registration_deadline?: string;
  prize_pool?: string;
  tracks?: string[];
  registration_link?: string;
  join_link?: string;
  youtube_link?: string;
  poster_url?: string;
  tags?: string[];
  stage?: string;
  month_year: string;
}

// Date normalization helper (e.g. may26, may-2026, May 26 -> may-2026)
export function normalizeMonthYear(input: string): string {
  const trimmed = input.trim().toLowerCase();

  if (trimmed === "events" || trimmed === "event" || !trimmed) {
    const now = new Date();
    const months = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ];
    return `${months[now.getMonth()]}-${now.getFullYear()}`;
  }

  const match = trimmed.match(/^([a-z]{3,9})[\s-]*(\d{2,4})$/);
  if (match) {
    const month = match[1].slice(0, 3);
    let year = match[2];
    if (year.length === 2) {
      year = `20${year}`;
    }
    return `${month}-${year}`;
  }

  // Return input if it matches format already, else fallback
  if (/^[a-z]{3}-\d{4}$/.test(trimmed)) {
    return trimmed;
  }

  const now = new Date();
  const months = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  return `${months[now.getMonth()]}-${now.getFullYear()}`;
}

export async function scrapeEventsLive(monthYear: string): Promise<Event[]> {
  const baseUrl = process.env.DK24_API_BASE_URL || "https://dk24.org";
  const cleanBaseUrl = baseUrl.replace(/\/$/, "");
  const url = `${cleanBaseUrl}/api/v1/calendar?date=${monthYear}`;
  console.log(`📡 Fetching calendar events from API: ${url}`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`API responded with status: ${res.status}`);
    }
    const data = (await res.json()) as { events: any[] };
    const now = new Date();

    const mappedEvents: Event[] = data.events.map((e) => {
      const startDate = new Date(e.startDateTime);
      const endDate = new Date(e.endDateTime);
      
      let stage = "Upcoming";
      if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
        if (now > endDate) {
          stage = "Completed / Concluded";
        } else if (now >= startDate && now <= endDate) {
          stage = "Active / Ongoing";
        }
      }

      // Format date string to match expected text format (e.g., Start: Jun 15, 2026 16:00 | End: Jun 16, 2026 17:00)
      const formatDateStr = (date: Date) => {
        if (isNaN(date.getTime())) return "";
        const formattedDate = date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric"
        });
        const formattedTime = date.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        });
        return `${formattedDate} ${formattedTime}`;
      };

      const startStr = formatDateStr(startDate);
      const endStr = formatDateStr(endDate);
      const formattedDate = `Start: ${startStr} | End: ${endStr}`;

      return {
        id: e.id,
        title: e.title,
        host: e.organizationName || "",
        date: formattedDate,
        location: e.location || undefined,
        description: e.description || undefined,
        registration_deadline: undefined,
        prize_pool: undefined,
        tracks: undefined,
        registration_link: e.registrationLink || undefined,
        join_link: e.joinLink || undefined,
        youtube_link: e.youtubeLink || undefined,
        poster_url: e.posterUrl || undefined,
        tags: e.tags || undefined,
        stage,
        month_year: monthYear,
      };
    });

    console.log(`Successfully fetched and mapped ${mappedEvents.length} events from API.`);
    return mappedEvents;
  } catch (error: any) {
    console.error(`Error fetching calendar events from API for ${monthYear}:`, error.message);
    throw error;
  }
}

const inFlightEventsScrapes = new Map<string, Promise<Event[]>>();

export async function getEventsLiveLocked(monthYear: string): Promise<Event[]> {
  let promise = inFlightEventsScrapes.get(monthYear);
  if (promise) {
    console.log(`Events scrape for ${monthYear} already in flight. Reusing existing promise...`);
    return promise;
  }
  promise = scrapeEventsLive(monthYear).finally(() => {
    inFlightEventsScrapes.delete(monthYear);
  });
  inFlightEventsScrapes.set(monthYear, promise);
  return promise;
}

export async function getEventsForMonth(
  monthYear: string,
  allowScrape: boolean = true,
): Promise<Event[]> {
  const normalized = normalizeMonthYear(monthYear);
  const pool = getPool();
  if (!pool) {
    if (!allowScrape) {
      return [];
    }
    console.warn(
      `⚠️ No database configured. Scraping events live for ${normalized}...`,
    );
    try {
      return await getEventsLiveLocked(normalized);
    } catch (err) {
      return [];
    }
  }

  const cacheKey = `calendar:${normalized}`;

  try {
    const dbEvents = await pool.query(
      `
      SELECT id, title, host, date, location, description, registration_deadline, prize_pool, tracks, registration_link, join_link, youtube_link, poster_url, tags, stage, month_year
      FROM dk24_events WHERE month_year = $1 ORDER BY id ASC
    `,
      [normalized],
    );

    // Enforce a strict 30-minute cooldown since the last check for this specific month
    const fresh = await isCacheValid(cacheKey, 30 * 60 * 1000);

    if (fresh) {
      // Cooldown active: Return the existing DB results instantly (whether empty [] or populated)
      return dbEvents.rows as Event[];
    }

    if (dbEvents.rows.length > 0) {
      // Cooldown expired but DB has events: Return instantly and trigger update in the background
      if (allowScrape) {
        console.log(
          `Events cache is stale for ${normalized}. Serving DB records and running background crawling...`,
        );
        triggerBackgroundEventsScrape(normalized);
      }
      return dbEvents.rows as Event[];
    }

    // Cooldown expired and DB has 0 events:
    if (!allowScrape) {
      // Non-blocking query requested: trigger background crawl to populate database and return [] instantly
      console.log(
        `Events database empty for ${normalized}. Triggering background calendar scraping...`,
      );
      triggerBackgroundEventsScrape(normalized);
      return [];
    }

    // Foreground scrape allowed: block until Puppeteer returns events to ensure accuracy
    console.log(
      `Events database empty/missing cache for ${normalized}. Running foreground calendar scraping...`,
    );
    const liveEvents = await getEventsLiveLocked(normalized);
    if (liveEvents) {
      await saveEventsToDb(liveEvents, normalized);
      await markCacheUpdated(cacheKey);
    }
    return liveEvents;
  } catch (error) {
    console.error(
      `getEventsForMonth DB error for ${normalized}. Scraping live:`,
      error,
    );
    if (!allowScrape) {
      return [];
    }
    try {
      return await getEventsLiveLocked(normalized);
    } catch (err) {
      return [];
    }
  }
}

async function saveEventsToDb(
  events: Event[],
  monthYear: string,
): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query("BEGIN");

    // Clear out only this specific month_year to avoid polluting database
    await pool.query("DELETE FROM dk24_events WHERE month_year = $1", [
      monthYear,
    ]);

    for (const e of events) {
      await pool.query(
        `
        INSERT INTO dk24_events (id, title, host, date, location, description, registration_deadline, prize_pool, tracks, registration_link, join_link, youtube_link, poster_url, tags, stage, month_year, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
      `,
        [
          e.id,
          e.title,
          e.host || null,
          e.date || null,
          e.location || null,
          e.description || null,
          e.registration_deadline || null,
          e.prize_pool || null,
          e.tracks || null,
          e.registration_link || null,
          e.join_link || null,
          e.youtube_link || null,
          e.poster_url || null,
          e.tags || null,
          e.stage || null,
          monthYear,
        ],
      );
    }

    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error(
      `❌ Failed to save events for ${monthYear} to database:`,
      error,
    );
  }
}

function triggerBackgroundEventsScrape(monthYear: string): void {
  const cacheKey = `calendar:${monthYear}`;
  getEventsLiveLocked(monthYear)
    .then(async (live) => {
      if (live) {
        await saveEventsToDb(live, monthYear);
        await markCacheUpdated(cacheKey);
        console.log(
          `Background events scrape for ${monthYear} completed successfully with ${live.length} events.`,
        );
      }
    })
    .catch((err) => {
      console.warn(
        `Background events scrape for ${monthYear} failed:`,
        err.message,
      );
    });
}

export async function searchEventsGlobally(query: string): Promise<Event[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const trimmed = query.trim().toLowerCase();
    const res = await pool.query(
      `SELECT id, title, host, date, location, description, registration_deadline, prize_pool, tracks, registration_link, join_link, youtube_link, poster_url, tags, stage, month_year 
       FROM dk24_events 
       WHERE LOWER(title) LIKE $1 OR LOWER(host) LIKE $1 
       ORDER BY date DESC`,
      [`%${trimmed}%`],
    );
    return res.rows as Event[];
  } catch (error) {
    console.error("⚠️ Error searching events globally:", error);
    return [];
  }
}
