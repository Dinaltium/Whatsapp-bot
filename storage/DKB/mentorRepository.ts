import { getPool } from "../db";
import { logAction } from "../core/auditRepository";
import { sanitizeForPrompt } from "../../security/promptFirewall";

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

  const sName = name ? name.trim().slice(0, 100) : "Unknown";
  const sOrg = org ? org.trim().slice(0, 100) : "";
  const sExpertise = expertise ? expertise.trim().slice(0, 100) : null;
  const sDescription = description ? description.trim().slice(0, 300) : null;
  const sLinkedin = linkedin ? linkedin.trim().slice(0, 200) : null;
  const sInstagram = instagram ? instagram.trim().slice(0, 200) : null;
  const sGithub = github ? github.trim().slice(0, 200) : null;
  const sEmail = email ? email.trim().slice(0, 100) : null;
  const sPhone = phone ? phone.trim().slice(0, 50) : null;
  const sAddedBy = addedBy ? addedBy.trim().slice(0, 100) : null;

  try {
    const res = await pool.query(
      `INSERT INTO dk24_mentors (name, organization, expertise, description, linkedin, instagram, github, email, phone, added_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        sName,
        sOrg,
        sExpertise,
        sDescription,
        sLinkedin,
        sInstagram,
        sGithub,
        sEmail,
        sPhone,
        sAddedBy,
      ],
    );
    const newId = res.rows[0]?.id;
    if (newId) {
      await logAction(
        addedBy || "unknown",
        "add_mentor",
        String(newId),
        name,
        JSON.stringify({ organization: org, expertise, email, phone }),
      );
    }
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

function buildMentorFilterClause(filter?: string): {
  clause: string;
  params: string[];
} {
  const params: string[] = [];
  let clause = "";
  if (filter && filter.trim()) {
    const trimmed = filter.trim().toLowerCase();
    clause = ` WHERE LOWER(name) LIKE $1`;
    params.push(trimmed.length === 1 ? `${trimmed}%` : `%${trimmed}%`);
  }
  return { clause, params };
}

/**
 * Fetches mentors, optionally filtered by name and paginated at the DB layer.
 * When limit/offset are omitted the full set is returned (legacy callers).
 */
export async function getMentors(
  filter?: string,
  limit?: number,
  offset?: number,
): Promise<Mentor[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const { clause, params } = buildMentorFilterClause(filter);
    const qParams: (string | number)[] = [...params];
    let queryStr = `SELECT id, name, expertise, linkedin, organization, description, instagram, github, email, phone, added_by, created_at FROM dk24_mentors${clause} ORDER BY name ASC`;
    if (typeof limit === "number") {
      qParams.push(limit);
      queryStr += ` LIMIT $${qParams.length}`;
    }
    if (typeof offset === "number") {
      qParams.push(offset);
      queryStr += ` OFFSET $${qParams.length}`;
    }
    const res = await pool.query(queryStr, qParams);
    return res.rows as Mentor[];
  } catch (error) {
    console.error("⚠️ Error fetching mentors:", error);
    return [];
  }
}

/** Counts mentors matching an optional name filter (for pagination totals). */
export async function countMentors(filter?: string): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  try {
    const { clause, params } = buildMentorFilterClause(filter);
    const res = await pool.query(
      `SELECT COUNT(*)::int AS count FROM dk24_mentors${clause}`,
      params,
    );
    return res.rows[0]?.count ?? 0;
  } catch (error) {
    console.error("⚠️ Error counting mentors:", error);
    return 0;
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
  actorJid: string = "unknown",
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
    const maxLengths: Record<string, number> = {
      name: 100,
      description: 300,
      organization: 100,
      expertise: 100,
      linkedin: 200,
      instagram: 200,
      github: 200,
      phone: 50,
      email: 100
    };
    const maxLen = maxLengths[columnName] || 500;
    const sanitizedValue = value ? value.trim().slice(0, maxLen) : null;
    const mentor = await getMentorById(id);
    const oldVal = mentor ? (mentor as any)[columnName] : null;
    const res = await pool.query(
      `UPDATE dk24_mentors SET ${columnName} = $1 WHERE id = $2`,
      [sanitizedValue, id],
    );
    const success = (res.rowCount ?? 0) > 0;
    if (success && mentor) {
      await logAction(
        actorJid,
        "edit_mentor",
        String(id),
        mentor.name,
        JSON.stringify({ field: columnName, old_value: oldVal, new_value: value }),
      );
    }
    return success;
  } catch (error) {
    console.error("⚠️ Error updating mentor field:", error);
    return false;
  }
}

export async function searchMentorsGlobally(keyword: string): Promise<Mentor[]> {
  const pool = getPool();
  if (!pool || !keyword.trim()) return [];
  try {
    const trimmed = keyword.trim().toLowerCase();
    const res = await pool.query(
      `SELECT id, name, expertise, organization, linkedin, description 
       FROM dk24_mentors 
       WHERE LOWER(name) LIKE $1 
          OR LOWER(expertise) LIKE $1 
          OR LOWER(organization) LIKE $1 
       ORDER BY name ASC
       LIMIT 5`,
      [`%${trimmed}%`]
    );
    return res.rows as Mentor[];
  } catch (error) {
    console.error("⚠️ Error searching mentors globally:", error);
    return [];
  }
}
