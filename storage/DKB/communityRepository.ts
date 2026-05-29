import { getPool } from "../db";
import puppeteer from "puppeteer";
import { isCacheValid, markCacheUpdated } from "../core/cacheRepository";

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
    console.log("Launching Puppeteer to scrape communities...");
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
      
      console.log("Navigating to communities...");
      const response = await page.goto("https://dk24.org/communities", {
        waitUntil: "networkidle2",
        timeout: 60000,
      });
    
      console.log(`Response Status: ${response?.status() || "unknown"}`);
      console.log(`Page Title: ${await page.title()}`);

      // Give it a dynamic delay to ensure loading skeleton clears
      try {
        await page.waitForFunction(
          () => !document.querySelector(".animate-pulse"),
          { timeout: 8000 }
        );
        console.log("Skeleton loading cleared.");
      } catch (e) {
        console.log("Timing out waiting for skeleton to clear, using fallback delay...");
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
            card.textContent?.includes("POCs") &&
            card.textContent?.includes("Representatives")
          ) {
            const name = nameEl.textContent?.trim() || "";
            const collegeEl =
              card.querySelector("p.text-muted-foreground") ||
              card.querySelector("p");
            const college = collegeEl ? collegeEl.textContent?.trim() || "" : "";

            // Parse Description
            let description = "";
            const h4s = Array.from(card.querySelectorAll("h4"));
            const descH4 = h4s.find(
              (h) => h.textContent?.trim() === "Description",
            );
            if (descH4 && descH4.nextElementSibling) {
              description = descH4.nextElementSibling.textContent?.trim() || "";
            }

            // Parse POCs
            const pocs: any[] = [];
            const pocsH4 = h4s.find((h) => h.textContent?.trim() === "POCs");
            if (pocsH4 && pocsH4.nextElementSibling) {
              const lis = Array.from(
                pocsH4.nextElementSibling.querySelectorAll("li"),
              );
              for (const li of lis) {
                const nameText =
                  li.querySelector("span.font-medium")?.textContent?.trim() || "";
                const emailDiv = li.querySelector(".text-xs");
                const email = emailDiv ? emailDiv.textContent?.trim() || "" : "";

                // Clone the element and remove name/email to isolate the role
                const clone = li.cloneNode(true) as HTMLElement;
                const nameEl = clone.querySelector("span.font-medium");
                if (nameEl) nameEl.remove();
                const emailEl = clone.querySelector(".text-xs");
                if (emailEl) emailEl.remove();
                let role = clone.textContent?.trim() || "";
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
              (h) => h.textContent?.trim() === "Representatives",
            );
            if (repsH4 && repsH4.nextElementSibling) {
              const lis = Array.from(
                repsH4.nextElementSibling.querySelectorAll("li"),
              );
              for (const li of lis) {
                const nameText =
                  li.querySelector("span.font-medium")?.textContent?.trim() || "";
                const emailDiv = li.querySelector(".text-xs");
                const email = emailDiv ? emailDiv.textContent?.trim() || "" : "";

                // Clone the element and remove name/email to isolate the role
                const clone = li.cloneNode(true) as HTMLElement;
                const nameEl = clone.querySelector("span.font-medium");
                if (nameEl) nameEl.remove();
                const emailEl = clone.querySelector(".text-xs");
                if (emailEl) emailEl.remove();
                let role = clone.textContent?.trim() || "";
                role = role
                  .replace(/^[-\s]+/, "")
                  .replace(/[-\s]+$/, "")
                  .trim();

                if (nameText) reps.push({ name: nameText, role, email });
              }
            }

            // Parse Website
            let website = "";
            const webH4 = h4s.find((h) => h.textContent?.trim() === "Website");
            if (webH4) {
              const sibling = webH4.nextElementSibling;
              if (sibling) {
                const a = (sibling.tagName && sibling.tagName.toLowerCase() === "a")
                  ? sibling
                  : sibling.querySelector("a");
                if (a) {
                  const href = a.getAttribute("href") || "";
                  if (href.startsWith("http")) {
                    website = href;
                  }
                }
              }
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

// In-flight promise caches to collapse multiple parallel crawls
const inFlightClubsScrape = { promise: null as Promise<Club[]> | null };

export async function getClubsLiveLocked(): Promise<Club[]> {
  if (inFlightClubsScrape.promise) {
    console.log("Clubs scrape already in flight. Reusing existing promise...");
    return inFlightClubsScrape.promise;
  }
  inFlightClubsScrape.promise = scrapeClubsLive().finally(() => {
    inFlightClubsScrape.promise = null;
  });
  return inFlightClubsScrape.promise;
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
    // 2. Check cache freshness (only reuse cache if valid AND we actually have records)
    const fresh = await isCacheValid("clubs");

    if (fresh && dbClubs.rows.length > 0) {
      return dbClubs.rows as Club[];
    }

    if (dbClubs.rows.length > 0) {
      // Background scrape since we have cached stale records (serves instantly, updates quietly)
      if (allowScrape) {
        console.log(
          "Clubs cache is stale. serving DB cached records and running background crawling...",
        );
        triggerBackgroundClubsScrape();
      }
      return dbClubs.rows as Club[];
    }

    if (!allowScrape) {
      // Non-blocking query requested: trigger background crawl to populate database and return [] instantly
      console.log("Clubs database is empty. Triggering background scraping...");
      triggerBackgroundClubsScrape();
      return [];
    }

    // Foreground scrape since database is completely empty
    console.log("Clubs database is empty. Running foreground scraping...");
    const liveClubs = await getClubsLiveLocked();
    if (liveClubs && liveClubs.length > 0) {
      await saveClubsToDb(liveClubs);
      await markCacheUpdated("clubs");
    } else {
      console.warn("Foreground clubs scrape returned empty array, skipping cache update to allow retry.");
    }
    return liveClubs;
  } catch (error) {
    console.error("getClubs DB error. Scraping live:", error);
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
    console.error("Failed to save clubs to database:", error);
  }
}

function triggerBackgroundClubsScrape(): void {
  // Run asynchronously without blocking current process thread
  getClubsLiveLocked()
    .then(async (live) => {
      if (live && live.length > 0) {
        await saveClubsToDb(live);
        await markCacheUpdated("clubs");
        console.log("Background clubs scrape completed successfully.");
      } else {
        console.warn("Background clubs scrape returned empty array, skipping cache update.");
      }
    })
    .catch((err) => {
      console.warn("Background clubs scrape failed:", err.message);
    });
}
