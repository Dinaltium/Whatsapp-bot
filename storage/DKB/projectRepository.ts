import { getPool } from "../db";
import { isCacheValid, markCacheUpdated } from "../core/cacheRepository";

export interface ProjectContributor {
  kind: string; // "professional" | "student"
  name: string;
  company?: string;
  college?: string;
  role: string;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  tags: string[];
  image?: string;
  link?: string;
  github?: string;
  categories: string[];
  contributors: ProjectContributor[];
}

// Fetches the live project list from the dk24.org public API.
export async function fetchProjectsLive(): Promise<Project[]> {
  const baseUrl = process.env.DK24_API_BASE_URL || "https://dk24.org";
  const cleanBaseUrl = baseUrl.replace(/\/$/, "");
  const url = `${cleanBaseUrl}/api/v1/projects`;
  console.log(`📡 Fetching projects from API: ${url}`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`API responded with status: ${res.status}`);
    }
    const data = (await res.json()) as { projects: any[] };

    const mapped: Project[] = (data.projects || []).map((p) => ({
      id: String(p.id || "").trim(),
      title: p.title || "",
      description: p.description || "",
      tags: Array.isArray(p.tags) ? p.tags.map((t: any) => String(t)) : [],
      image: p.image || undefined,
      link: p.link || undefined,
      github: p.github || undefined,
      categories: Array.isArray(p.categories)
        ? p.categories.map((c: any) => String(c))
        : [],
      contributors: (p.contributors || []).map((c: any) => ({
        kind: c.kind || "",
        name: c.name || "",
        company: c.company || undefined,
        college: c.college || undefined,
        role: c.role || "",
      })),
    }));

    console.log(
      `Successfully fetched and mapped ${mapped.length} projects from API.`,
    );
    return mapped;
  } catch (error: any) {
    console.error("Error fetching projects from API:", error.message);
    throw error;
  }
}

// In-flight promise cache to collapse parallel fetches into one.
const inFlightProjectsFetch = { promise: null as Promise<Project[]> | null };

export async function getProjectsLiveLocked(): Promise<Project[]> {
  if (inFlightProjectsFetch.promise) {
    console.log("Projects fetch already in flight. Reusing existing promise...");
    return inFlightProjectsFetch.promise;
  }
  inFlightProjectsFetch.promise = fetchProjectsLive().finally(() => {
    inFlightProjectsFetch.promise = null;
  });
  return inFlightProjectsFetch.promise;
}

// Reads projects from Neon with background/foreground refresh, mirroring clubs.
export async function getProjects(allowFetch: boolean = true): Promise<Project[]> {
  const pool = getPool();
  if (!pool) {
    if (!allowFetch) return [];
    console.warn("⚠️ No database configured. Fetching projects live directly...");
    try {
      return await getProjectsLiveLocked();
    } catch {
      return [];
    }
  }

  try {
    const dbProjects = await pool.query(`
      SELECT id, title, description, tags, image, link, github, categories, contributors
      FROM dk24_projects ORDER BY title ASC
    `);
    const fresh = await isCacheValid("projects");

    if (fresh && dbProjects.rows.length > 0) {
      return dbProjects.rows as Project[];
    }

    if (dbProjects.rows.length > 0) {
      if (allowFetch) {
        console.log(
          "Projects cache is stale. Serving DB records and refreshing in background...",
        );
        triggerBackgroundProjectsFetch();
      }
      return dbProjects.rows as Project[];
    }

    if (!allowFetch) {
      console.log("Projects database is empty. Triggering background fetch...");
      triggerBackgroundProjectsFetch();
      return [];
    }

    console.log("Projects database is empty. Running foreground fetch...");
    const live = await getProjectsLiveLocked();
    if (live && live.length > 0) {
      await saveProjectsToDb(live);
      await markCacheUpdated("projects");
    } else {
      console.warn(
        "Foreground projects fetch returned empty array, skipping cache update to allow retry.",
      );
    }
    return live;
  } catch (error) {
    console.error("getProjects DB error. Fetching live:", error);
    if (!allowFetch) return [];
    try {
      return await getProjectsLiveLocked();
    } catch {
      return [];
    }
  }
}

async function saveProjectsToDb(projects: Project[]): Promise<void> {
  const pool = getPool();
  if (!pool || projects.length === 0) return;

  try {
    await pool.query("BEGIN");
    // Full replace to stay perfectly in sync with the source of truth.
    await pool.query("DELETE FROM dk24_projects");

    for (const p of projects) {
      if (!p.id) continue;
      await pool.query(
        `
        INSERT INTO dk24_projects (id, title, description, tags, image, link, github, categories, contributors, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title, description = EXCLUDED.description,
          tags = EXCLUDED.tags, image = EXCLUDED.image, link = EXCLUDED.link,
          github = EXCLUDED.github, categories = EXCLUDED.categories,
          contributors = EXCLUDED.contributors, last_updated = NOW()
      `,
        [
          p.id,
          p.title,
          p.description,
          p.tags,
          p.image || null,
          p.link || null,
          p.github || null,
          p.categories,
          JSON.stringify(p.contributors),
        ],
      );
    }

    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error("Failed to save projects to database:", error);
  }
}

function triggerBackgroundProjectsFetch(): void {
  getProjectsLiveLocked()
    .then(async (live) => {
      if (live && live.length > 0) {
        await saveProjectsToDb(live);
        await markCacheUpdated("projects");
        console.log("Background projects fetch completed successfully.");
      } else {
        console.warn(
          "Background projects fetch returned empty array, skipping cache update.",
        );
      }
    })
    .catch((err) => {
      console.warn("Background projects fetch failed:", err.message);
    });
}

// Lightweight global search for prompt-context injection.
export async function searchProjectsGlobally(keyword: string): Promise<Project[]> {
  const projects = await getProjects(true);
  const k = keyword.trim().toLowerCase();
  if (!k) return projects.slice(0, 5);
  return projects
    .filter(
      (p) =>
        p.title.toLowerCase().includes(k) ||
        p.description.toLowerCase().includes(k) ||
        p.tags.some((t) => t.toLowerCase().includes(k)) ||
        p.categories.some((c) => c.toLowerCase().includes(k)),
    )
    .slice(0, 5);
}
