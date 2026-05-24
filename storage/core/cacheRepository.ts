import { getPool } from "../db";

export async function isCacheValid(key: string): Promise<boolean> {
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

export async function markCacheUpdated(key: string): Promise<void> {
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
