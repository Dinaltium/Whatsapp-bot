import { getPool } from "../db";
import puppeteer from "puppeteer";
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

// Global promise queue to serialize Puppeteer crawl executions
let puppeteerQueue: Promise<any> = Promise.resolve();

async function serializePuppeteer<T>(task: () => Promise<T>): Promise<T> {
  const currentQueue = puppeteerQueue;
  let resolveQueue: () => void;
  const nextInQueue = new Promise<void>((resolve) => {
    resolveQueue = resolve;
  });
  puppeteerQueue = nextInQueue;
  try {
    await currentQueue;
  } catch (err) {
    // Ignore errors from previous tasks in the queue to prevent deadlocking
  }
  try {
    return await task();
  } finally {
    resolveQueue!();
  }
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
  return serializePuppeteer(async () => {
    console.log(
      `🕷️ Launching Puppeteer to scrape calendar events for [${monthYear}]...`,
    );
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      );
      await page.setViewport({ width: 1280, height: 1000 });
      // Request interception disabled for maximum page loading stability

      page.setDefaultNavigationTimeout(60000);

      const url = `https://dk24.org/calendar?date=${monthYear}`;
      console.log(`Navigating to calendar: ${url}`);
      const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    
      console.log(`Response Status: ${response?.status() || "unknown"}`);
      console.log(`Page Title: ${await page.title()}`);

      // Wait for React rendering / skeleton elements to load dynamically
      try {
        await page.waitForFunction(
          () => !document.querySelector(".animate-pulse"),
          { timeout: 8000 }
        );
        console.log("Skeleton loading cleared.");
      } catch (e) {
        console.log("Timing out waiting for skeleton to clear, using fallback delay...");
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }

      // Find all buttons on the page that contain an h3 (representing event cards)
      const buttons = await page.$$("button");
      const eventButtonsIndex: number[] = [];
      for (let i = 0; i < buttons.length; i++) {
        const hasH3 = await buttons[i].$("h3");
        if (hasH3) {
          eventButtonsIndex.push(i);
        }
      }

      console.log(
        `Found ${eventButtonsIndex.length} event card buttons to scrape.`,
      );

      if (eventButtonsIndex.length === 0) {
        const htmlSnippet = (await page.content()).substring(0, 800);
        console.warn(
          `Found 0 calendar event buttons in scrapeEventsLive. Page status: ${response?.status() || "unknown"}, title: "${await page.title()}". Snapshot: \n${htmlSnippet}`
        );
      }

      const scrapedEvents: Event[] = [];

      for (let i = 0; i < eventButtonsIndex.length; i++) {
        const freshButtons = await page.$$("button");
        const idx = eventButtonsIndex[i];
        if (freshButtons[idx]) {
          console.log(
            `Scraping event detail modal ${i + 1}/${eventButtonsIndex.length}...`,
          );
          await freshButtons[idx].click();

          // Wait for modal dialog transitions
          await new Promise((resolve) => setTimeout(resolve, 1500));

          const details = await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"]');
            if (!dialog) return null;

            const titleEl =
              dialog.querySelector("h2") || dialog.querySelector('[id*="title"]');
            const title = titleEl ? titleEl.textContent?.trim() : "";

            const hostEl = dialog.querySelector(".text-lg.text-muted-foreground");
            const hostText = hostEl ? hostEl.textContent?.trim() : "";

            const badges = Array.from(
              dialog.querySelectorAll(".flex.flex-wrap.gap-2 span"),
            );
            const tags = badges.map((b) => b.textContent?.trim()).filter(Boolean);

            const detailsContainer = dialog.querySelector(
              ".grid.grid-cols-2.gap-6",
            );
            const dates: any[] = [];
            if (detailsContainer) {
              const blocks = Array.from(detailsContainer.children);
              blocks.forEach((block) => {
                const label =
                  block.querySelector(".text-sm")?.textContent?.trim() || "";
                const value =
                  block.querySelector(".font-semibold")?.textContent?.trim() ||
                  "";
                const subValue =
                  block.querySelector(".text-md")?.textContent?.trim() || "";
                dates.push({ label, value, subValue });
              });
            }

            const locHeader = Array.from(dialog.querySelectorAll("span")).find(
              (s) => s.textContent?.includes("Location"),
            );
            const location = locHeader
              ? locHeader.parentElement?.nextElementSibling?.textContent?.trim()
              : "";

            const aboutHeader = Array.from(dialog.querySelectorAll("h4")).find(
              (h) => h.textContent?.includes("About Event"),
            );
            const description = aboutHeader
              ? aboutHeader.nextElementSibling?.textContent?.trim()
              : "";

            const footer =
              dialog.querySelector("footer") ||
              dialog.querySelector('[class*="Footer"]');
            const links: Record<string, string> = {};
            if (footer) {
              const anchors = Array.from(footer.querySelectorAll("a"));
              anchors.forEach((a) => {
                const href = a.getAttribute("href") || "";
                const text = a.textContent?.trim() || "";
                if (text.includes("Register")) links.registrationLink = href;
                else if (text.includes("Website")) links.joinLink = href;
                else if (text.includes("Recording")) links.youtubeLink = href;
              });
            }

            return {
              title,
              hostText,
              tags,
              dates,
              location,
              description,
              links,
            };
          });

          if (details && details.title) {
            // Combine extracted dates into a single date string
            let formattedDate = "";
            if (details.dates && details.dates.length > 0) {
              formattedDate = details.dates
                .map((d: any) => `${d.label}: ${d.value} ${d.subValue}`)
                .join(" | ");
            }

            // Determine stage status
            let stage = "Upcoming";
            const now = new Date();
            const startVal = details.dates?.find((d: any) => d.label === "Start");
            const endVal = details.dates?.find((d: any) => d.label === "End");
            if (startVal && endVal) {
              const startDate = new Date(
                `${startVal.value} ${startVal.subValue}`,
              );
              const endDate = new Date(`${endVal.value} ${endVal.subValue}`);
              if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
                if (now > endDate) {
                  stage = "Completed / Concluded";
                } else if (now >= startDate && now <= endDate) {
                  stage = "Active / Ongoing";
                }
              }
            }

            // Clean host text
            const host = details.hostText
              ? details.hostText.replace(/^Hosted by\s+/i, "")
              : "";

            const id = `evt-${details.title.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${monthYear}`;

            scrapedEvents.push({
              id,
              title: details.title,
              host,
              date: formattedDate || undefined,
              location: details.location || undefined,
              description: details.description || undefined,
              registration_deadline: undefined,
              prize_pool: undefined,
              tracks: undefined,
              registration_link: details.links?.registrationLink || undefined,
              join_link: details.links?.joinLink || undefined,
              youtube_link: details.links?.youtubeLink || undefined,
              poster_url: undefined,
              tags: details.tags || undefined,
              stage,
              month_year: monthYear,
            });
          }

          // Close modal cleanly via Escape key
          await page.keyboard.press("Escape");
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }

      console.log(
        `Successfully scraped ${scrapedEvents.length} events for ${monthYear}.`,
      );
      return scrapedEvents;
    } catch (error) {
      console.error(
        `Puppeteer error scraping calendar events for ${monthYear}:`,
        error,
      );
      throw error;
    } finally {
      await browser.close();
    }
  });
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

    if (!allowScrape) {
      return dbEvents.rows as Event[];
    }

    // Check cache freshness (only reuse cache if valid AND we actually have records for this month)
    const fresh = await isCacheValid(cacheKey);

    if (fresh && dbEvents.rows.length > 0) {
      return dbEvents.rows as Event[];
    }

    if (dbEvents.rows.length > 0) {
      // Stale cache hit: Return immediately, run scrape in background
      console.log(
        `Events cache is stale for ${normalized}. serving DB records and running background crawling...`,
      );
      triggerBackgroundEventsScrape(normalized);
      return dbEvents.rows as Event[];
    }

    // No records exist and cache is NOT fresh: Run in foreground so the user receives a correct list
    console.log(
      `Events database empty/missing cache for ${normalized}. Running foreground calendar scraping...`,
    );
    const liveEvents = await getEventsLiveLocked(normalized);
    if (liveEvents && liveEvents.length > 0) {
      await saveEventsToDb(liveEvents, normalized);
      await markCacheUpdated(cacheKey);
    } else {
      console.warn(`Foreground events scrape for ${normalized} returned empty array, skipping cache update to allow retry.`);
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
      if (live && live.length > 0) {
        await saveEventsToDb(live, monthYear);
        await markCacheUpdated(cacheKey);
        console.log(
          `Background events scrape for ${monthYear} completed successfully.`,
        );
      } else {
        console.warn(
          `Background events scrape for ${monthYear} returned empty array, skipping cache update.`
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
