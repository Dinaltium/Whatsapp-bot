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

  const sName = sanitizeForPrompt(name);
  const sOrg = org ? sanitizeForPrompt(org) : "";
  const sExpertise = expertise ? sanitizeForPrompt(expertise) : null;
  const sDescription = description ? sanitizeForPrompt(description) : null;
  const sLinkedin = linkedin ? sanitizeForPrompt(linkedin) : null;
  const sInstagram = instagram ? sanitizeForPrompt(instagram) : null;
  const sGithub = github ? sanitizeForPrompt(github) : null;
  const sEmail = email ? sanitizeForPrompt(email) : null;
  const sPhone = phone ? sanitizeForPrompt(phone) : null;
  const sAddedBy = addedBy ? sanitizeForPrompt(addedBy) : null;

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
    const sanitizedValue = value ? sanitizeForPrompt(value) : null;
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
