import { getPool } from "../db";
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

export async function scrapeClubsLive(): Promise<Club[]> {
  const baseUrl = process.env.DK24_API_BASE_URL || "https://dk24.org";
  const cleanBaseUrl = baseUrl.replace(/\/$/, "");
  const url = `${cleanBaseUrl}/api/v1/communities`;
  console.log(`📡 Fetching communities from API: ${url}`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`API responded with status: ${res.status}`);
    }
    const data = (await res.json()) as { communities: any[] };

    const mappedClubs: Club[] = data.communities.map((c) => {
      const name = c.name || "";
      const id = name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      return {
        id,
        name,
        college: c.college || "",
        description: c.description || "",
        website: c.website || undefined,
        logo: c.logo || undefined,
        pocs: (c.pocs || []).map((p: any) => ({
          name: p.name || "",
          role: p.role || "",
          email: p.email || undefined,
        })),
        representatives: (c.representatives || []).map((r: any) => ({
          name: r.name || "",
          role: r.role || "",
          email: r.email || undefined,
        })),
      };
    });

    console.log(`Successfully fetched and mapped ${mappedClubs.length} communities from API.`);
    return mappedClubs;
  } catch (error: any) {
    console.error("Error fetching communities from API:", error.message);
    throw error;
  }
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
