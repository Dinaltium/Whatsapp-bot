import { Pool } from "pg";
import puppeteer from "puppeteer";
import { getDatabaseUrl } from "./neonAuthStateStore";

export interface CommunityRep {
  name: string;
  role: string;
  email?: string;
}

export interface Club {
  id: string;
  name: string;
  college: string;
  description: string;
  website?: string;
  logo?: string;
  pocs: CommunityRep[];
  representatives: CommunityRep[];
}

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

// Global DB pool holder
let dbPool: Pool | null = null;

function getPool(): Pool | null {
  if (dbPool) return dbPool;

  const dbUrl = getDatabaseUrl();
  if (!dbUrl) {
    console.warn(
      "⚠️ DATABASE_URL is not set. Running in static fallback mode.",
    );
    return null;
  }

  try {
    dbPool = new Pool({
      connectionString: dbUrl,
      connectionTimeoutMillis: Number(
        process.env.DB_CONNECT_TIMEOUT_MS || 10000,
      ),
      idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
      ssl:
        process.env.DATABASE_SSL === "false"
          ? false
          : { rejectUnauthorized: false },
    });

    dbPool.on("error", (err) => {
      console.warn("⚠️ dk24Store Pool error:", err.message);
    });

    return dbPool;
  } catch (error) {
    console.error("⚠️ Failed to initialize dbPool:", error);
    return null;
  }
}

// Bootstrap schema
export interface Mentor {
  id: number;
  name: string;
  expertise?: string;
  linkedin?: string;
  organization?: string;
  description?: string;
  instagram?: string;
  github?: string;
  email?: string;
  phone?: string;
  added_by?: string;
  created_at?: string;
}

// Bootstrap schema
export async function ensureSchema(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dk24_clubs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        college TEXT NOT NULL,
        description TEXT NOT NULL,
        website TEXT,
        logo TEXT,
        pocs JSONB NOT NULL DEFAULT '[]'::jsonb,
        representatives JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS dk24_events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        host TEXT,
        date TEXT,
        location TEXT,
        description TEXT,
        registration_deadline TEXT,
        prize_pool TEXT,
        tracks TEXT[],
        registration_link TEXT,
        join_link TEXT,
        youtube_link TEXT,
        poster_url TEXT,
        tags TEXT[],
        stage TEXT,
        month_year TEXT NOT NULL,
        last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS dk24_cache_log (
        key TEXT PRIMARY KEY,
        last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS dk24_managed_roles (
        jid TEXT NOT NULL,
        role TEXT NOT NULL,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (jid, role)
      );

      CREATE TABLE IF NOT EXISTS dk24_mentors (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        expertise TEXT,
        linkedin TEXT,
        organization TEXT,
        description TEXT,
        instagram TEXT,
        github TEXT,
        email TEXT,
        phone TEXT,
        added_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE dk24_mentors ADD COLUMN IF NOT EXISTS description TEXT;
      ALTER TABLE dk24_mentors ADD COLUMN IF NOT EXISTS instagram TEXT;
      ALTER TABLE dk24_mentors ADD COLUMN IF NOT EXISTS github TEXT;
      ALTER TABLE dk24_mentors ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE dk24_mentors ADD COLUMN IF NOT EXISTS phone TEXT;
      ALTER TABLE dk24_mentors ALTER COLUMN expertise DROP NOT NULL;

      CREATE TABLE IF NOT EXISTS wa_allowed_groups (
        jid TEXT PRIMARY KEY,
        bot_number INTEGER NOT NULL DEFAULT 0,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wa_allowed_chats (
        jid TEXT PRIMARY KEY,
        bot_number INTEGER NOT NULL DEFAULT 0,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log("✅ dk24Store database schema verified.");
  } catch (error) {
    console.error("⚠️ Failed to bootstrap dk24Store schema:", error);
  }
}

export async function addManagedRole(
  jid: string,
  role: string,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO dk24_managed_roles (jid, role)
       VALUES ($1, $2)
       ON CONFLICT (jid, role) DO NOTHING`,
      [jid, role],
    );
    return true;
  } catch (error) {
    console.error("⚠️ Error adding managed role:", error);
    return false;
  }
}

export async function isWorkerAuthorized(
  jid: string,
  role: string,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const res = await pool.query(
      `SELECT 1 FROM dk24_managed_roles WHERE jid = $1 AND role = $2 LIMIT 1`,
      [jid, role],
    );
    return res.rows.length > 0;
  } catch (error) {
    console.error("⚠️ Error checking worker authorization:", error);
    return false;
  }
}

export async function addMentor(
  name: string,
  org: string,
  expertise?: string,
  description?: string,
  linkedin?: string,
  instagram?: string,
  github?: string,
  email?: string,
  phone?: string,
  addedBy?: string,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO dk24_mentors (name, organization, expertise, description, linkedin, instagram, github, email, phone, added_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        name,
        org,
        expertise || null,
        description || null,
        linkedin || null,
        instagram || null,
        github || null,
        email || null,
        phone || null,
        addedBy || null,
      ],
    );
    return true;
  } catch (error) {
    console.error("⚠️ Error adding mentor:", error);
    return false;
  }
}

export async function deleteMentor(query: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const num = parseInt(query, 10);
    if (!isNaN(num)) {
      const res = await pool.query(`DELETE FROM dk24_mentors WHERE id = $1`, [
        num,
      ]);
      return (res.rowCount ?? 0) > 0;
    } else {
      const trimmed = query.trim();
      const res = await pool.query(
        `DELETE FROM dk24_mentors WHERE LOWER(name) = LOWER($1)`,
        [trimmed],
      );
      return (res.rowCount ?? 0) > 0;
    }
  } catch (error) {
    console.error("⚠️ Error deleting mentor:", error);
    return false;
  }
}

export async function getMentors(filter?: string): Promise<Mentor[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    let queryStr = `SELECT id, name, expertise, linkedin, organization, description, instagram, github, email, phone, added_by, created_at FROM dk24_mentors`;
    const params: string[] = [];
    if (filter && filter.trim()) {
      const trimmed = filter.trim().toLowerCase();
      if (trimmed.length === 1) {
        queryStr += ` WHERE LOWER(name) LIKE $1`;
        params.push(`${trimmed}%`);
      } else {
        queryStr += ` WHERE LOWER(name) LIKE $1`;
        params.push(`%${trimmed}%`);
      }
    }
    queryStr += ` ORDER BY name ASC`;
    const res = await pool.query(queryStr, params);
    return res.rows as Mentor[];
  } catch (error) {
    console.error("⚠️ Error fetching mentors:", error);
    return [];
  }
}

export async function getMentorById(id: number): Promise<Mentor | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const res = await pool.query(
      `SELECT id, name, expertise, linkedin, organization, description, instagram, github, email, phone, added_by, created_at 
       FROM dk24_mentors WHERE id = $1 LIMIT 1`,
      [id],
    );
    return (res.rows[0] as Mentor) || null;
  } catch (error) {
    console.error("⚠️ Error fetching mentor by ID:", error);
    return null;
  }
}

export async function updateMentorField(
  id: number,
  flag: string,
  value: string | null,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;

  const fieldMapping: Record<string, string> = {
    n: "name",
    name: "name",
    d: "description",
    desc: "description",
    description: "description",
    o: "organization",
    org: "organization",
    organization: "organization",
    ex: "expertise",
    s: "expertise",
    expertise: "expertise",
    l: "linkedin",
    linkedin: "linkedin",
    i: "instagram",
    instagram: "instagram",
    g: "github",
    github: "github",
    p: "phone",
    phone: "phone",
  };

  let columnName = fieldMapping[flag.toLowerCase().replace(/^-+/, "")];
  if (!columnName) {
    if (flag.toLowerCase().replace(/^-+/, "") === "e") {
      columnName = value && value.includes("@") ? "email" : "expertise";
    } else {
      return false;
    }
  }

  try {
    const res = await pool.query(
      `UPDATE dk24_mentors SET ${columnName} = $1 WHERE id = $2`,
      [value, id],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (error) {
    console.error("⚠️ Error updating mentor field:", error);
    return false;
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

// ----------------------------------------------------
// Headless Crawlers (Puppeteer)
// ----------------------------------------------------

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

export async function scrapeClubsLive(): Promise<Club[]> {
  return serializePuppeteer(async () => {
    console.log("🕷️ Launching Puppeteer to scrape communities...");
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      );
      await page.setViewport({ width: 1280, height: 1000 });
      
      // Speed up execution by blocking unneeded assets (images, stylesheets, fonts, media)
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const type = req.resourceType();
        if (["image", "stylesheet", "font", "media"].includes(type)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      page.setDefaultNavigationTimeout(60000);
      
      console.log("🕷️ Navigating to communities...");
      const response = await page.goto("https://dk24.org/communities", {
        waitUntil: "networkidle2",
        timeout: 60000,
      });
    
    console.log(`🕷️ Response Status: ${response?.status() || "unknown"}`);
    console.log(`🕷️ Page Title: ${await page.title()}`);

    // Give it a dynamic delay to ensure loading skeleton clears
    try {
      await page.waitForFunction(
        () => !document.querySelector(".animate-pulse"),
        { timeout: 8000 }
      );
      console.log("🕷️ Skeleton loading cleared.");
    } catch (e) {
      console.log("🕷️ Timing out waiting for skeleton to clear, using fallback delay...");
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    const clubs = await page.evaluate(() => {
      const cards: any[] = [];
      const allCards = Array.from(
        document.querySelectorAll("div.rounded-xl, div.border"),
      );
      for (const card of allCards) {
        const nameEl = card.querySelector("h3");
        if (
          nameEl &&
          card.textContent.includes("POCs") &&
          card.textContent.includes("Representatives")
        ) {
          const name = nameEl.textContent.trim();
          const collegeEl =
            card.querySelector("p.text-muted-foreground") ||
            card.querySelector("p");
          const college = collegeEl ? collegeEl.textContent.trim() : "";

          // Parse Description
          let description = "";
          const h4s = Array.from(card.querySelectorAll("h4"));
          const descH4 = h4s.find(
            (h) => h.textContent.trim() === "Description",
          );
          if (descH4 && descH4.nextElementSibling) {
            description = descH4.nextElementSibling.textContent.trim();
          }

          // Parse POCs
          const pocs: any[] = [];
          const pocsH4 = h4s.find((h) => h.textContent.trim() === "POCs");
          if (pocsH4 && pocsH4.nextElementSibling) {
            const lis = Array.from(
              pocsH4.nextElementSibling.querySelectorAll("li"),
            );
            for (const li of lis) {
              const nameText =
                li.querySelector("span.font-medium")?.textContent.trim() || "";
              const emailDiv = li.querySelector(".text-xs");
              const email = emailDiv ? emailDiv.textContent.trim() : "";

              // Clone the element and remove name/email to isolate the role
              const clone = li.cloneNode(true) as HTMLElement;
              const nameEl = clone.querySelector("span.font-medium");
              if (nameEl) nameEl.remove();
              const emailEl = clone.querySelector(".text-xs");
              if (emailEl) emailEl.remove();
              let role = clone.textContent.trim();
              role = role
                .replace(/^[-\s]+/, "")
                .replace(/[-\s]+$/, "")
                .trim();

              if (nameText) pocs.push({ name: nameText, role, email });
            }
          }

          // Parse Representatives
          const reps: any[] = [];
          const repsH4 = h4s.find(
            (h) => h.textContent.trim() === "Representatives",
          );
          if (repsH4 && repsH4.nextElementSibling) {
            const lis = Array.from(
              repsH4.nextElementSibling.querySelectorAll("li"),
            );
            for (const li of lis) {
              const nameText =
                li.querySelector("span.font-medium")?.textContent.trim() || "";
              const emailDiv = li.querySelector(".text-xs");
              const email = emailDiv ? emailDiv.textContent.trim() : "";

              // Clone the element and remove name/email to isolate the role
              const clone = li.cloneNode(true) as HTMLElement;
              const nameEl = clone.querySelector("span.font-medium");
              if (nameEl) nameEl.remove();
              const emailEl = clone.querySelector(".text-xs");
              if (emailEl) emailEl.remove();
              let role = clone.textContent.trim();
              role = role
                .replace(/^[-\s]+/, "")
                .replace(/[-\s]+$/, "")
                .trim();

              if (nameText) reps.push({ name: nameText, role, email });
            }
          }

          // Parse Website
          let website = "";
          const webH4 = h4s.find((h) => h.textContent.trim() === "Website");
          if (webH4) {
            const a = webH4.nextElementSibling?.querySelector("a");
            if (a) website = a.getAttribute("href") || "";
          }

          const id = name
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "");

          cards.push({
            id,
            name,
            college,
            description,
            pocs,
            representatives: reps,
            website,
          });
        }
      }
      return cards;
    });

    console.log(
      `🕷️ Successfully scraped ${clubs.length} communities from website.`,
    );

    if (clubs.length === 0) {
      const htmlSnippet = (await page.content()).substring(0, 800);
      console.warn(
        `⚠️ Found 0 communities in scrapeClubsLive. Page status: ${response?.status() || "unknown"}, title: "${await page.title()}". Snapshot: \n${htmlSnippet}`
      );
    }

    return clubs;
  } catch (error) {
    console.error("❌ Puppeteer error scraping clubs:", error);
    throw error;
  } finally {
    await browser.close();
  }
});
}

export async function scrapeEventsLive(monthYear: string): Promise<Event[]> {
  return serializePuppeteer(async () => {
    console.log(
      `🕷️ Launching Puppeteer to scrape calendar events for [${monthYear}]...`,
    );
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      );
      await page.setViewport({ width: 1280, height: 1000 });

      // Speed up execution by blocking unneeded assets (images, stylesheets, fonts, media)
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const type = req.resourceType();
        if (["image", "stylesheet", "font", "media"].includes(type)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      page.setDefaultNavigationTimeout(60000);

      const url = `https://dk24.org/calendar?date=${monthYear}`;
      console.log(`🕷️ Navigating to calendar: ${url}`);
      const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    
    console.log(`🕷️ Response Status: ${response?.status() || "unknown"}`);
    console.log(`🕷️ Page Title: ${await page.title()}`);

    // Wait for React rendering / skeleton elements to load dynamically
    try {
      await page.waitForFunction(
        () => !document.querySelector(".animate-pulse"),
        { timeout: 8000 }
      );
      console.log("🕷️ Skeleton loading cleared.");
    } catch (e) {
      console.log("🕷️ Timing out waiting for skeleton to clear, using fallback delay...");
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
      `🕷️ Found ${eventButtonsIndex.length} event card buttons to scrape.`,
    );

    if (eventButtonsIndex.length === 0) {
      const htmlSnippet = (await page.content()).substring(0, 800);
      console.warn(
        `⚠️ Found 0 calendar event buttons in scrapeEventsLive. Page status: ${response?.status() || "unknown"}, title: "${await page.title()}". Snapshot: \n${htmlSnippet}`
      );
    }

    const scrapedEvents: Event[] = [];

    for (let i = 0; i < eventButtonsIndex.length; i++) {
      const freshButtons = await page.$$("button");
      const idx = eventButtonsIndex[i];
      if (freshButtons[idx]) {
        console.log(
          `🕷️ Scraping event detail modal ${i + 1}/${eventButtonsIndex.length}...`,
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
      `🕷️ Successfully scraped ${scrapedEvents.length} events for ${monthYear}.`,
    );
    return scrapedEvents;
  } catch (error) {
    console.error(
      `❌ Puppeteer error scraping calendar events for ${monthYear}:`,
      error,
    );
    throw error;
  } finally {
    await browser.close();
  }
});
}

// In-flight promise caches to collapse multiple parallel crawls
const inFlightClubsScrape = { promise: null as Promise<Club[]> | null };
const inFlightEventsScrapes = new Map<string, Promise<Event[]>>();

export async function getClubsLiveLocked(): Promise<Club[]> {
  if (inFlightClubsScrape.promise) {
    console.log("🔒 Clubs scrape already in flight. Reusing existing promise...");
    return inFlightClubsScrape.promise;
  }
  inFlightClubsScrape.promise = scrapeClubsLive().finally(() => {
    inFlightClubsScrape.promise = null;
  });
  return inFlightClubsScrape.promise;
}

export async function getEventsLiveLocked(monthYear: string): Promise<Event[]> {
  let promise = inFlightEventsScrapes.get(monthYear);
  if (promise) {
    console.log(`🔒 Events scrape for ${monthYear} already in flight. Reusing existing promise...`);
    return promise;
  }
  promise = scrapeEventsLive(monthYear).finally(() => {
    inFlightEventsScrapes.delete(monthYear);
  });
  inFlightEventsScrapes.set(monthYear, promise);
  return promise;
}

// ----------------------------------------------------
// Caching Implementation Layers (Neon cache lookup)
// ----------------------------------------------------

async function isCacheValid(key: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;

  try {
    const result = await pool.query(
      `SELECT last_updated FROM dk24_cache_log WHERE key = $1 LIMIT 1`,
      [key],
    );

    if (result.rows.length === 0) return false;

    const lastUpdated = new Date(result.rows[0].last_updated).getTime();
    const now = Date.now();
    const cacheAgeMs = now - lastUpdated;

    // 24 hours = 24 * 60 * 60 * 1000 ms
    return cacheAgeMs < 24 * 60 * 60 * 1000;
  } catch (error) {
    console.error(`⚠️ Failed to verify cache freshness for ${key}:`, error);
    return false;
  }
}

async function markCacheUpdated(key: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `
      INSERT INTO dk24_cache_log (key, last_updated)
      VALUES ($1, NOW())
      ON CONFLICT (key) DO UPDATE SET last_updated = NOW()
    `,
      [key],
    );
  } catch (error) {
    console.error(`⚠️ Failed to mark cache updated for ${key}:`, error);
  }
}

// Get Clubs dynamically (reads from Neon with background/foreground scrape logic)
export async function getClubs(allowScrape: boolean = true): Promise<Club[]> {
  const pool = getPool();
  if (!pool) {
    if (!allowScrape) {
      return [];
    }
    console.warn("⚠️ No database configured. Scraping clubs live directly...");
    try {
      return await getClubsLiveLocked();
    } catch (err) {
      return [];
    }
  }

  try {
    // 1. Fetch current DB clubs
    const dbClubs = await pool.query(`
      SELECT id, name, college, description, website, logo, pocs, representatives 
      FROM dk24_clubs ORDER BY id ASC
    `);

    if (!allowScrape) {
      return dbClubs.rows as Club[];
    }

    // 2. Check cache freshness
    const fresh = await isCacheValid("clubs");

    if (fresh) {
      return dbClubs.rows as Club[];
    }

    if (dbClubs.rows.length > 0) {
      // Background scrape since we have cached stale records (serves instantly, updates quietly)
      console.log(
        "♻️ Clubs cache is stale. serving DB cached records and running background crawling...",
      );
      triggerBackgroundClubsScrape();
      return dbClubs.rows as Club[];
    }

    // Foreground scrape since database is completely empty
    console.log("🔍 Clubs database is empty. Running foreground scraping...");
    const liveClubs = await getClubsLiveLocked();
    await saveClubsToDb(liveClubs);
    await markCacheUpdated("clubs");
    return liveClubs;
  } catch (error) {
    console.error("⚠️ getClubs DB error. Scraping live:", error);
    if (!allowScrape) {
      return [];
    }
    try {
      return await getClubsLiveLocked();
    } catch (err) {
      return [];
    }
  }
}

async function saveClubsToDb(clubs: Club[]): Promise<void> {
  const pool = getPool();
  if (!pool || clubs.length === 0) return;

  try {
    await pool.query("BEGIN");

    // Delete existing records to maintain perfectly dynamic synchronization
    await pool.query("DELETE FROM dk24_clubs");

    for (const c of clubs) {
      await pool.query(
        `
        INSERT INTO dk24_clubs (id, name, college, description, website, logo, pocs, representatives, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      `,
        [
          c.id,
          c.name,
          c.college,
          c.description,
          c.website || null,
          c.logo || null,
          JSON.stringify(c.pocs),
          JSON.stringify(c.representatives),
        ],
      );
    }

    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error("❌ Failed to save clubs to database:", error);
  }
}

function triggerBackgroundClubsScrape(): void {
  // Run asynchronously without blocking current process thread
  getClubsLiveLocked()
    .then(async (live) => {
      await saveClubsToDb(live);
      await markCacheUpdated("clubs");
      console.log("♻️ Background clubs scrape completed successfully.");
    })
    .catch((err) => {
      console.warn("⚠️ Background clubs scrape failed:", err.message);
    });
}

// Get Events dynamically (reads from Neon with background/foreground scrape logic)
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

    const fresh = await isCacheValid(cacheKey);

    if (fresh) {
      return dbEvents.rows as Event[];
    }

    if (dbEvents.rows.length > 0) {
      // Stale cache hit: Return immediately, run scrape in background
      console.log(
        `♻️ Events cache is stale for ${normalized}. serving DB records and running background crawling...`,
      );
      triggerBackgroundEventsScrape(normalized);
      return dbEvents.rows as Event[];
    }

    // No records exist and cache is NOT fresh: Run in foreground so the user receives a correct list
    console.log(
      `🔍 Events database empty/missing cache for ${normalized}. Running foreground calendar scraping...`,
    );
    const liveEvents = await getEventsLiveLocked(normalized);
    await saveEventsToDb(liveEvents, normalized);
    await markCacheUpdated(cacheKey);
    return liveEvents;
  } catch (error) {
    console.error(
      `⚠️ getEventsForMonth DB error for ${normalized}. Scraping live:`,
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
      await saveEventsToDb(live, monthYear);
      await markCacheUpdated(cacheKey);
      console.log(
        `♻️ Background events scrape for ${monthYear} completed successfully.`,
      );
    })
    .catch((err) => {
      console.warn(
        `⚠️ Background events scrape for ${monthYear} failed:`,
        err.message,
      );
    });
}

export interface DbGroupEntry {
  jid: string;
  bot_number: number;
}

export interface DbChatEntry {
  jid: string;
  bot_number: number;
}

export async function getAllowedGroups(): Promise<DbGroupEntry[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT jid, bot_number FROM wa_allowed_groups`
    );
    return res.rows.map((row) => ({
      jid: row.jid,
      bot_number: row.bot_number,
    }));
  } catch (error) {
    console.error("⚠️ Error getting allowed groups from DB:", error);
    return [];
  }
}

export async function addAllowedGroup(jid: string, botNumber: number): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO wa_allowed_groups (jid, bot_number)
       VALUES ($1, $2)
       ON CONFLICT (jid) DO UPDATE SET bot_number = EXCLUDED.bot_number`,
      [jid, botNumber],
    );
    return true;
  } catch (error) {
    console.error(`⚠️ Error adding allowed group ${jid} to DB:`, error);
    return false;
  }
}

export async function removeAllowedGroup(jid: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `DELETE FROM wa_allowed_groups WHERE jid = $1`,
      [jid],
    );
    return true;
  } catch (error) {
    console.error(`⚠️ Error removing allowed group ${jid} from DB:`, error);
    return false;
  }
}

export async function getAllowedChats(): Promise<DbChatEntry[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT jid, bot_number FROM wa_allowed_chats`
    );
    return res.rows.map((row) => ({
      jid: row.jid,
      bot_number: row.bot_number,
    }));
  } catch (error) {
    console.error("⚠️ Error getting allowed chats from DB:", error);
    return [];
  }
}

export async function addAllowedChat(jid: string, botNumber: number): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO wa_allowed_chats (jid, bot_number)
       VALUES ($1, $2)
       ON CONFLICT (jid) DO UPDATE SET bot_number = EXCLUDED.bot_number`,
      [jid, botNumber],
    );
    return true;
  } catch (error) {
    console.error(`⚠️ Error adding allowed chat ${jid} to DB:`, error);
    return false;
  }
}

export async function removeAllowedChat(jid: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `DELETE FROM wa_allowed_chats WHERE jid = $1`,
      [jid],
    );
    return true;
  } catch (error) {
    console.error(`⚠️ Error removing allowed chat ${jid} from DB:`, error);
    return false;
  }
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


