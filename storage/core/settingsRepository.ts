import { getPool } from "../db";

/**
 * Small key/value store for runtime-configurable bot settings that should be
 * changeable via command (not just env) and survive restarts / Redis flushes.
 * Backed by the durable Postgres `bot_settings` table.
 */
export async function getSetting(key: string): Promise<string | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const res = await pool.query(
      `SELECT value FROM bot_settings WHERE key = $1 LIMIT 1`,
      [key],
    );
    return (res.rows[0]?.value as string) ?? null;
  } catch (error) {
    console.error(`⚠️ Failed to read setting ${key}:`, error);
    return null;
  }
}

export async function setSetting(key: string, value: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO bot_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    );
    return true;
  } catch (error) {
    console.error(`⚠️ Failed to write setting ${key}:`, error);
    return false;
  }
}

export async function deleteSetting(key: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const res = await pool.query(`DELETE FROM bot_settings WHERE key = $1`, [
      key,
    ]);
    return (res.rowCount ?? 0) > 0;
  } catch (error) {
    console.error(`⚠️ Failed to delete setting ${key}:`, error);
    return false;
  }
}
