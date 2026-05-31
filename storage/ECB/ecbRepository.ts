import { getPool } from "../db";

export interface EcbProject {
  id: number;
  title: string;
  description: string;
  created_at: Date;
}

export async function createEcbProject(title: string, description: string): Promise<EcbProject | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const res = await pool.query(
      `INSERT INTO ecb_projects (title, description) VALUES ($1, $2) RETURNING *`,
      [title, description]
    );
    return res.rows[0];
  } catch (error) {
    console.error("Error creating ECB project:", error);
    return null;
  }
}

export async function getEcbProjects(): Promise<EcbProject[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const res = await pool.query(`SELECT * FROM ecb_projects ORDER BY created_at DESC`);
    return res.rows;
  } catch (error) {
    console.error("Error fetching ECB projects:", error);
    return [];
  }
}
