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
    console.warn("⚠️ DATABASE_URL is not set. Running in static fallback mode.");
    return null;
  }
  
  try {
    dbPool = new Pool({
      connectionString: dbUrl,
      connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
      idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
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
    `);
    console.log("✅ dk24Store database schema verified.");
  } catch (error) {
    console.error("⚠️ Failed to bootstrap dk24Store schema:", error);
  }
}

export async function addManagedRole(jid: string, role: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO dk24_managed_roles (jid, role)
       VALUES ($1, $2)
       ON CONFLICT (jid, role) DO NOTHING`,
      [jid, role]
    );
    return true;
  } catch (error) {
    console.error("⚠️ Error adding managed role:", error);
    return false;
  }
}

export async function isWorkerAuthorized(jid: string, role: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const res = await pool.query(
      `SELECT 1 FROM dk24_managed_roles WHERE jid = $1 AND role = $2 LIMIT 1`,
      [jid, role]
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
  addedBy?: string
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
        addedBy || null
      ]
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
      const res = await pool.query(`DELETE FROM dk24_mentors WHERE id = $1`, [num]);
      return (res.rowCount ?? 0) > 0;
    } else {
      const trimmed = query.trim();
      const res = await pool.query(`DELETE FROM dk24_mentors WHERE LOWER(name) = LOWER($1)`, [trimmed]);
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
      [id]
    );
    return (res.rows[0] as Mentor) || null;
  } catch (error) {
    console.error("⚠️ Error fetching mentor by ID:", error);
    return null;
  }
}

export async function updateMentorField(id: number, flag: string, value: string | null): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;

  const fieldMapping: Record<string, string> = {
    "n": "name",
    "name": "name",
    "d": "description",
    "desc": "description",
    "description": "description",
    "o": "organization",
    "org": "organization",
    "organization": "organization",
    "ex": "expertise",
    "s": "expertise",
    "expertise": "expertise",
    "l": "linkedin",
    "linkedin": "linkedin",
    "i": "instagram",
    "instagram": "instagram",
    "g": "github",
    "github": "github",
    "p": "phone",
    "phone": "phone"
  };

  let columnName = fieldMapping[flag.toLowerCase().replace(/^-+/, "")];
  if (!columnName) {
    if (flag.toLowerCase().replace(/^-+/, "") === "e") {
      columnName = (value && value.includes("@")) ? "email" : "expertise";
    } else {
      return false;
    }
  }

  try {
    const res = await pool.query(
      `UPDATE dk24_mentors SET ${columnName} = $1 WHERE id = $2`,
      [value, id]
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
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
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
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  return `${months[now.getMonth()]}-${now.getFullYear()}`;
}

// ----------------------------------------------------
// Headless Crawlers (Puppeteer)
// ----------------------------------------------------

export async function scrapeClubsLive(): Promise<Club[]> {
  console.log("🕷️ Launching Puppeteer to scrape communities...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    await page.goto("https://dk24.org/communities", { waitUntil: 'networkidle2' });
    
    // Give it a tiny delay to ensure page elements settle
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const clubs = await page.evaluate(() => {
      const cards: any[] = [];
      const allCards = Array.from(document.querySelectorAll('div.rounded-xl, div.border'));
      for (const card of allCards) {
        const nameEl = card.querySelector('h3');
        if (nameEl && card.textContent.includes('POCs') && card.textContent.includes('Representatives')) {
          const name = nameEl.textContent.trim();
          const collegeEl = card.querySelector('p.text-muted-foreground') || card.querySelector('p');
          const college = collegeEl ? collegeEl.textContent.trim() : '';

          // Parse Description
          let description = '';
          const h4s = Array.from(card.querySelectorAll('h4'));
          const descH4 = h4s.find(h => h.textContent.trim() === 'Description');
          if (descH4 && descH4.nextElementSibling) {
            description = descH4.nextElementSibling.textContent.trim();
          }

          // Parse POCs
          const pocs: any[] = [];
          const pocsH4 = h4s.find(h => h.textContent.trim() === 'POCs');
          if (pocsH4 && pocsH4.nextElementSibling) {
            const lis = Array.from(pocsH4.nextElementSibling.querySelectorAll('li'));
            for (const li of lis) {
              const nameText = li.querySelector('span.font-medium')?.textContent.trim() || '';
              const emailDiv = li.querySelector('.text-xs');
              const email = emailDiv ? emailDiv.textContent.trim() : '';

              // Clone the element and remove name/email to isolate the role
              const clone = li.cloneNode(true) as HTMLElement;
              const nameEl = clone.querySelector('span.font-medium');
              if (nameEl) nameEl.remove();
              const emailEl = clone.querySelector('.text-xs');
              if (emailEl) emailEl.remove();
              let role = clone.textContent.trim();
              role = role.replace(/^[-\s]+/, '').replace(/[-\s]+$/, '').trim();

              if (nameText) pocs.push({ name: nameText, role, email });
            }
          }

          // Parse Representatives
          const reps: any[] = [];
          const repsH4 = h4s.find(h => h.textContent.trim() === 'Representatives');
          if (repsH4 && repsH4.nextElementSibling) {
            const lis = Array.from(repsH4.nextElementSibling.querySelectorAll('li'));
            for (const li of lis) {
              const nameText = li.querySelector('span.font-medium')?.textContent.trim() || '';
              const emailDiv = li.querySelector('.text-xs');
              const email = emailDiv ? emailDiv.textContent.trim() : '';

              // Clone the element and remove name/email to isolate the role
              const clone = li.cloneNode(true) as HTMLElement;
              const nameEl = clone.querySelector('span.font-medium');
              if (nameEl) nameEl.remove();
              const emailEl = clone.querySelector('.text-xs');
              if (emailEl) emailEl.remove();
              let role = clone.textContent.trim();
              role = role.replace(/^[-\s]+/, '').replace(/[-\s]+$/, '').trim();

              if (nameText) reps.push({ name: nameText, role, email });
            }
          }

          // Parse Website
          let website = '';
          const webH4 = h4s.find(h => h.textContent.trim() === 'Website');
          if (webH4) {
            const a = webH4.nextElementSibling?.querySelector('a');
            if (a) website = a.getAttribute('href') || '';
          }

          const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

          cards.push({ id, name, college, description, pocs, representatives: reps, website });
        }
      }
      return cards;
    });
    
    console.log(`🕷️ Successfully scraped ${clubs.length} communities from website.`);
    return clubs;
  } catch (error) {
    console.error("❌ Puppeteer error scraping clubs:", error);
    throw error;
  } finally {
    await browser.close();
  }
}

export async function scrapeEventsLive(monthYear: string): Promise<Event[]> {
  console.log(`🕷️ Launching Puppeteer to scrape calendar events for [${monthYear}]...`);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    
    const url = `https://dk24.org/calendar?date=${monthYear}`;
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    // Wait for React rendering / skeleton elements to load
    await new Promise(resolve => setTimeout(resolve, 4000));
    
    // Find all buttons on the page that contain an h3 (representing event cards)
    const buttons = await page.$$('button');
    const eventButtonsIndex: number[] = [];
    for (let i = 0; i < buttons.length; i++) {
      const hasH3 = await buttons[i].$('h3');
      if (hasH3) {
        eventButtonsIndex.push(i);
      }
    }
    
    console.log(`🕷️ Found ${eventButtonsIndex.length} event card buttons to scrape.`);
    const scrapedEvents: Event[] = [];
    
    for (let i = 0; i < eventButtonsIndex.length; i++) {
      const freshButtons = await page.$$('button');
      const idx = eventButtonsIndex[i];
      if (freshButtons[idx]) {
        console.log(`🕷️ Scraping event detail modal ${i + 1}/${eventButtonsIndex.length}...`);
        await freshButtons[idx].click();
        
        // Wait for modal dialog transitions
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const details = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return null;
          
          const titleEl = dialog.querySelector('h2') || dialog.querySelector('[id*="title"]');
          const title = titleEl ? titleEl.textContent?.trim() : '';
          
          const hostEl = dialog.querySelector('.text-lg.text-muted-foreground');
          const hostText = hostEl ? hostEl.textContent?.trim() : '';
          
          const badges = Array.from(dialog.querySelectorAll('.flex.flex-wrap.gap-2 span'));
          const tags = badges.map(b => b.textContent?.trim()).filter(Boolean);
          
          const detailsContainer = dialog.querySelector('.grid.grid-cols-2.gap-6');
          const dates: any[] = [];
          if (detailsContainer) {
            const blocks = Array.from(detailsContainer.children);
            blocks.forEach(block => {
              const label = block.querySelector('.text-sm')?.textContent?.trim() || '';
              const value = block.querySelector('.font-semibold')?.textContent?.trim() || '';
              const subValue = block.querySelector('.text-md')?.textContent?.trim() || '';
              dates.push({ label, value, subValue });
            });
          }
          
          const locHeader = Array.from(dialog.querySelectorAll('span')).find(s => s.textContent?.includes('Location'));
          const location = locHeader ? locHeader.parentElement?.nextElementSibling?.textContent?.trim() : '';
          
          const aboutHeader = Array.from(dialog.querySelectorAll('h4')).find(h => h.textContent?.includes('About Event'));
          const description = aboutHeader ? aboutHeader.nextElementSibling?.textContent?.trim() : '';
          
          const footer = dialog.querySelector('footer') || dialog.querySelector('[class*="Footer"]');
          const links: Record<string, string> = {};
          if (footer) {
            const anchors = Array.from(footer.querySelectorAll('a'));
            anchors.forEach(a => {
              const href = a.getAttribute('href') || '';
              const text = a.textContent?.trim() || '';
              if (text.includes('Register')) links.registrationLink = href;
              else if (text.includes('Website')) links.joinLink = href;
              else if (text.includes('Recording')) links.youtubeLink = href;
            });
          }
          
          return {
            title,
            hostText,
            tags,
            dates,
            location,
            description,
            links
          };
        });
        
        if (details && details.title) {
          // Combine extracted dates into a single date string
          let formattedDate = "";
          if (details.dates && details.dates.length > 0) {
            formattedDate = details.dates.map((d: any) => `${d.label}: ${d.value} ${d.subValue}`).join(" | ");
          }
          
          // Determine stage status
          let stage = "Upcoming";
          const now = new Date();
          const startVal = details.dates?.find((d: any) => d.label === 'Start');
          const endVal = details.dates?.find((d: any) => d.label === 'End');
          if (startVal && endVal) {
            const startDate = new Date(`${startVal.value} ${startVal.subValue}`);
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
          const host = details.hostText ? details.hostText.replace(/^Hosted by\s+/i, '') : '';
          
          const id = `evt-${details.title.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${monthYear}`;
          
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
            month_year: monthYear
          });
        }
        
        // Close modal cleanly via Escape key
        await page.keyboard.press('Escape');
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
    
    console.log(`🕷️ Successfully scraped ${scrapedEvents.length} events for ${monthYear}.`);
    return scrapedEvents;
  } catch (error) {
    console.error(`❌ Puppeteer error scraping calendar events for ${monthYear}:`, error);
    throw error;
  } finally {
    await browser.close();
  }
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
      [key]
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
    await pool.query(`
      INSERT INTO dk24_cache_log (key, last_updated)
      VALUES ($1, NOW())
      ON CONFLICT (key) DO UPDATE SET last_updated = NOW()
    `, [key]);
  } catch (error) {
    console.error(`⚠️ Failed to mark cache updated for ${key}:`, error);
  }
}

// Get Clubs dynamically (reads from Neon with background/foreground scrape logic)
export async function getClubs(): Promise<Club[]> {
  const pool = getPool();
  if (!pool) return staticClubs;
  
  try {
    // 1. Check cache freshness
    const fresh = await isCacheValid("clubs");
    
    // 2. Fetch current DB clubs
    const dbClubs = await pool.query(`
      SELECT id, name, college, description, website, logo, pocs, representatives 
      FROM dk24_clubs ORDER BY id ASC
    `);
    
    if (fresh && dbClubs.rows.length > 0) {
      return dbClubs.rows as Club[];
    }
    
    if (dbClubs.rows.length > 0) {
      // Background scrape since we have cached stale records (serves instantly, updates quietly)
      console.log("♻️ Clubs cache is stale. serving DB cached records and running background crawling...");
      triggerBackgroundClubsScrape();
      return dbClubs.rows as Club[];
    }
    
    // Foreground scrape since database is completely empty
    console.log("🔍 Clubs database is empty. Running foreground scraping...");
    const liveClubs = await scrapeClubsLive();
    await saveClubsToDb(liveClubs);
    await markCacheUpdated("clubs");
    return liveClubs;
  } catch (error) {
    console.error("⚠️ getClubs DB error. Falling back to static clubs list:", error);
    return staticClubs;
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
      await pool.query(`
        INSERT INTO dk24_clubs (id, name, college, description, website, logo, pocs, representatives, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      `, [
        c.id, 
        c.name, 
        c.college, 
        c.description, 
        c.website || null, 
        c.logo || null, 
        JSON.stringify(c.pocs), 
        JSON.stringify(c.representatives)
      ]);
    }
    
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error("❌ Failed to save clubs to database:", error);
  }
}

function triggerBackgroundClubsScrape(): void {
  // Run asynchronously without blocking current process thread
  scrapeClubsLive()
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
export async function getEventsForMonth(monthYear: string): Promise<Event[]> {
  const normalized = normalizeMonthYear(monthYear);
  const pool = getPool();
  if (!pool) {
    // If static fallback and target matches april 2026, return staticAprilEvents, else empty
    return normalized === "apr-2026" ? staticAprilEvents : [];
  }
  
  const cacheKey = `calendar:${normalized}`;
  
  try {
    const fresh = await isCacheValid(cacheKey);
    
    const dbEvents = await pool.query(`
      SELECT id, title, host, date, location, description, registration_deadline, prize_pool, tracks, registration_link, join_link, youtube_link, poster_url, tags, stage, month_year
      FROM dk24_events WHERE month_year = $1 ORDER BY id ASC
    `, [normalized]);
    
    if (fresh) {
      return dbEvents.rows as Event[];
    }
    
    if (dbEvents.rows.length > 0) {
      // Stale cache hit: Return immediately, run scrape in background
      console.log(`♻️ Events cache is stale for ${normalized}. serving DB records and running background crawling...`);
      triggerBackgroundEventsScrape(normalized);
      return dbEvents.rows as Event[];
    }
    
    // No records exist: Run in foreground so the user receives a correct list
    console.log(`🔍 Events database empty for ${normalized}. Running foreground calendar scraping...`);
    const liveEvents = await scrapeEventsLive(normalized);
    await saveEventsToDb(liveEvents, normalized);
    await markCacheUpdated(cacheKey);
    return liveEvents;
  } catch (error) {
    console.error(`⚠️ getEventsForMonth DB error for ${normalized}. Falling back to static events:`, error);
    return normalized === "apr-2026" ? staticAprilEvents : [];
  }
}

async function saveEventsToDb(events: Event[], monthYear: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  
  try {
    await pool.query("BEGIN");
    
    // Clear out only this specific month_year to avoid polluting database
    await pool.query("DELETE FROM dk24_events WHERE month_year = $1", [monthYear]);
    
    for (const e of events) {
      await pool.query(`
        INSERT INTO dk24_events (id, title, host, date, location, description, registration_deadline, prize_pool, tracks, registration_link, join_link, youtube_link, poster_url, tags, stage, month_year, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
      `, [
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
        monthYear
      ]);
    }
    
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error(`❌ Failed to save events for ${monthYear} to database:`, error);
  }
}

function triggerBackgroundEventsScrape(monthYear: string): void {
  const cacheKey = `calendar:${monthYear}`;
  scrapeEventsLive(monthYear)
    .then(async (live) => {
      await saveEventsToDb(live, monthYear);
      await markCacheUpdated(cacheKey);
      console.log(`♻️ Background events scrape for ${monthYear} completed successfully.`);
    })
    .catch((err) => {
      console.warn(`⚠️ Background events scrape for ${monthYear} failed:`, err.message);
    });
}

// ----------------------------------------------------
// Static Fallbacks (Original Static Datasets)
// ----------------------------------------------------

const staticClubs: Club[] = [
  {
    id: "sosc",
    name: "Sahyadri Open Source Community (SOSC)",
    college: "Sahyadri College of Engineering & Management",
    description: "SOSC is a vibrant community of tech enthusiasts and open-source contributors dedicated to upskilling students through peer-to-peer learning, hands-on workshops, and real-world project experience.",
    website: "https://sosc.org.in",
    pocs: [
      { name: "Kushal SM", role: "Core Member", email: "mrkushalsm@gmail.com" },
      { name: "Soniya", role: "Core Member", email: "soniyakolvekar7@gmail.com" }
    ],
    representatives: [
      { name: "Manas S", role: "Community Lead", email: "salianmanas@gmail.com" }
    ]
  },
  {
    id: "devnation",
    name: "DevNation",
    college: "AJ Institute of Engineering and Technology",
    description: "A community of developers working on innovative projects and organizing technical events to enhance coding skills and promote collaboration.",
    pocs: [
      { name: "Aboobakkar Twaha", role: "Club President", email: "aboobakkar@ajiet.edu.in" },
      { name: "Muaz Ismail Mohammed", role: "Core Member", email: "6muazx@gmail.com" }
    ],
    representatives: [
      { name: "Aboobakkar Twaha", role: "Club President", email: "aboobakkar@ajiet.edu.in" }
    ]
  },
  {
    id: "finiteloop",
    name: "FiniteLoop",
    college: "NMAMIT NITTE",
    description: "Finite Loop Club (FLC) is the premier coding club at NMAMIT, dedicated to realising and inspiring ideas. FLC provides opportunities to work with the latest trending tech stacks, access workshops, secure internships, engage in peer-to-peer learning, attend guest lectures by renowned experts, and collaborate on real-time projects. Our coding contests enhance analytical and problem-solving skills.",
    website: "https://www.finiteloop.club",
    pocs: [
      { name: "Sujnan D Devadiga", role: "Core member", email: "nnm23cb063@nmamit.in" },
      { name: "Chinmay P Kulkarni", role: "Core member", email: "nnm24cs315@nmamit.in" }
    ],
    representatives: [
      { name: "Nandan R Pai", role: "President", email: "nnm22am033@nmamit.in" }
    ]
  },
  {
    id: "sceptix",
    name: "The Sceptix Club",
    college: "St Joseph Engineering College",
    description: "The Sceptix Club is a free and open-source technology community established in 2022 at St. Joseph Engineering College (SJEC). Built on the philosophy of \"Liberate the Mind,\" the club empowers students to think beyond conventional boundaries and transform ideas into impactful technological solutions.",
    website: "https://www.sceptix.in",
    pocs: [
      { name: "Dion Lobo", role: "Member", email: "23h13.joshua@sjec.ac.in" },
      { name: "Alston Dsouza", role: "Member", email: "24j04.alston@sjec.ac.in" }
    ],
    representatives: [
      { name: "Nithin", role: "Lead", email: "nithinumeshanchan@gmail.com" },
      { name: "Shovin", role: "Co-Lead", email: "23h46.shovin@sjec.ac.in" }
    ]
  },
  {
    id: "techbots",
    name: "TechBots-SIT",
    college: "Srinivas Institute of Technology",
    description: "TechBots robotics club dedicated to building innovative solutions through hands-on projects in Robotics, Electronics, IoT, Communication Systems, AI & ML, and Mechanical Design.",
    pocs: [
      { name: "Ashwin Bhat", role: "Workshop coordinator", email: "ashwinb326@gmail.com" },
      { name: "Disha I Sanil", role: "Member", email: "dishaisanil2@gmail.com" }
    ],
    representatives: [
      { name: "Mahammad Safwan T", role: "President", email: "mahammadsafwant786@gmail.com" }
    ]
  },
  {
    id: "core",
    name: "CoRE",
    college: "Vivekananda College of Engineering and Technology, Puttur",
    description: "CoRE (Center of Research Excellency) is a community of engineering students who are passionate about learning, growing, and exploring various fields of engineering.",
    website: "https://corevcet.wixsite.com/core",
    pocs: [
      { name: "K Shreekrishna Upadhyaya", role: "Coordinator", email: "upadhyayashreekrishna@gmail.com" },
      { name: "Abhinav N G", role: "Member", email: "abhinav.ng2006@gmail.com" }
    ],
    representatives: [
      { name: "K Shreekrishna Upadhyaya", role: "Coordinator", email: "upadhyayashreekrishna@gmail.com" }
    ]
  },
  {
    id: "embed",
    name: "Embed Club",
    college: "PA College of Engineering",
    description: "Embed Club is a student-led community focused on integrating software and hardware through real-world projects in IoT, embedded systems, and blockchain.",
    website: "https://www.embedclub.org/",
    pocs: [
      { name: "Rafan Ahamad Sheik", role: "Joint Secretary", email: "rafan79200@gmail.com" },
      { name: "Darel Oliver Tauro", role: "Member", email: "taurodarel@gmail.com" }
    ],
    representatives: [
      { name: "K Mohammad Hisham", role: "President", email: "hishammohd313@gmail.com" }
    ]
  },
  {
    id: "acm",
    name: "Association For Computing Machinery (ACM)",
    college: "NMAM Institute of Technology, Nitte",
    description: "The ACM Student Chapter at NMAM Institute of Technology is an official student chapter of the global Association for Computing Machinery.",
    website: "https://nmamit.acm.org/",
    pocs: [
      { name: "Prakyath Suvarna", role: "Core member", email: "prakyathyadav@gmail.com" },
      { name: "Hasnain Khan", role: "Core member", email: "hasnainkhan8704@gmail.com" }
    ],
    representatives: [
      { name: "Pratheeksha", role: "President", email: "pratheeksha291@gmail.com" }
    ]
  },
  {
    id: "cosc",
    name: "Canara Open-Source Community",
    college: "Canara Engineering College, Benjanapadavu",
    description: "Canara open-source community dedicated to sharing valuable resources and opportunities in tech!",
    pocs: [
      { name: "Priyanka Goankar", role: "Core member", email: "gaonkarpriyanka71@gmail.com" },
      { name: "Chaithra S", role: "Core member", email: "Schaithra2006@gmail.com" }
    ],
    representatives: [
      { name: "Kaushik H S", role: "President", email: "kaushik0h0s@gmail.com" },
      { name: "Sanjana M", role: "Vice President" }
    ]
  }
];

const staticAprilEvents: Event[] = [
  {
    id: "evt-hacktofuture",
    title: "HackToFuture 4.0",
    host: "The Sceptix Club (SJEC)",
    date: "April 15 - 17, 2026",
    location: "St. Joseph Engineering College, Mangaluru",
    stage: "Completed / Concluded",
    registration_deadline: "March 31, 2026",
    prize_pool: "₹4,00,000+",
    description: "SJEC's national-level flagship hackathon. A 36-hour sprint empowering student teams to liberate their minds and construct modern tech products.",
    tracks: ["Cloud & Serverless", "DevOps & Infrastructure", "Cybersecurity & Cryptography", "Open Innovation"],
    month_year: "apr-2026"
  },
  {
    id: "evt-hackfest",
    title: "Hackfest 2026",
    host: "Finite Loop Club (NMAMIT)",
    date: "April 17 - 19, 2026",
    location: "NMAMIT, Nitte",
    stage: "Completed / Concluded",
    registration_deadline: "April 5, 2026",
    description: "NMAMIT's premier coding hackathon event promoting cutting-edge solutions for real-world problems.",
    tracks: ["Healthcare Tech", "Sustainability & Green energy", "FinTech Solutions", "Logistics & Supply Chain", "Open Innovation"],
    month_year: "apr-2026"
  },
  {
    id: "evt-core-unleashed",
    title: "CoRE Unleashed",
    host: "CoRE (VCET Puttur)",
    date: "April 24 - 26, 2026",
    location: "VCET, Puttur",
    stage: "Completed / Concluded",
    registration_deadline: "April 12, 2026",
    description: "VCET's flagship mega hackathon and engineering design showcase, challenging students to build highly optimized hardware and software solutions.",
    month_year: "apr-2026"
  },
  {
    id: "evt-openloop",
    title: "OpenLoop",
    host: "YenTech (Yenepoya)",
    date: "April 25 - 26, 2026",
    location: "Yenepoya Institute of Technology, Mangaluru",
    stage: "Completed / Concluded",
    registration_deadline: "April 15, 2026",
    description: "Collaborative tech-sprint and open innovation challenge bringing developers and makers together to build and present open-source solutions.",
    month_year: "apr-2026"
  }
];
