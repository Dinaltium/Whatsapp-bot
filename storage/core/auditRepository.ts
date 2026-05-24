import { getPool } from "../db";

export interface DailyUsageResult {
  allowed: boolean;
  count: number;
  limit: number;
  day: string;
}

/**
 * Inserts an audit action log to the dk24_action_logs PostgreSQL table.
 */
export async function logAction(
  actorJid: string,
  actionType: string,
  targetId: string | null,
  targetName: string | null,
  details: string | null,
): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO dk24_action_logs (actor_jid, action_type, target_id, target_name, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorJid, actionType, targetId, targetName, details],
    );
  } catch (error) {
    console.error("⚠️ Error inserting action log:", error);
  }
}

function getUtcDayBucket(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function checkAndIncrementDailyUserUsage(
  jid: string,
  usageType: string,
  limit: number,
): Promise<DailyUsageResult> {
  const pool = getPool();
  const day = getUtcDayBucket();
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeUsageType = usageType.trim().toLowerCase() || "ai";

  if (!pool || !jid) {
    return { allowed: true, count: 0, limit: safeLimit, day };
  }

  try {
    const res = await pool.query(
      `
      INSERT INTO wa_daily_user_usage (jid, usage_type, day, count)
      VALUES ($1, $2, $3::date, 1)
      ON CONFLICT (jid, usage_type, day)
      DO UPDATE SET
        count = wa_daily_user_usage.count + 1,
        last_seen_at = NOW()
      WHERE wa_daily_user_usage.count < $4
      RETURNING count
      `,
      [jid, safeUsageType, day, safeLimit],
    );

    if (res.rows.length > 0) {
      const count = Number(res.rows[0].count || 0);
      return {
        allowed: count <= safeLimit,
        count,
        limit: safeLimit,
        day,
      };
    }

    const existing = await pool.query(
      `SELECT count FROM wa_daily_user_usage
       WHERE jid = $1 AND usage_type = $2 AND day = $3::date
       LIMIT 1`,
      [jid, safeUsageType, day],
    );
    const count = Number(existing.rows[0]?.count || safeLimit);
    return {
      allowed: false,
      count,
      limit: safeLimit,
      day,
    };
  } catch (error) {
    console.error("Error checking daily user usage:", error);
    return { allowed: true, count: 0, limit: safeLimit, day };
  }
}
