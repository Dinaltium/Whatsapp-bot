import { getPool } from "../db";

export interface Reminder {
  id: number;
  owner_jid: string;
  chat_jid: string;
  message: string;
  remind_at: Date;
  sent: boolean;
  created_at: Date;
}

export async function addReminder(
  ownerJid: string,
  chatJid: string,
  message: string,
  remindAt: Date,
): Promise<number | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const res = await pool.query(
      `INSERT INTO self_reminders (owner_jid, chat_jid, message, remind_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ownerJid, chatJid, message, remindAt],
    );
    return res.rows[0]?.id ?? null;
  } catch (err) {
    console.error("[ReminderRepo] addReminder failed:", err);
    return null;
  }
}

export async function getPendingReminders(ownerJid: string): Promise<Reminder[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT * FROM self_reminders WHERE owner_jid = $1 AND sent = FALSE ORDER BY remind_at ASC`,
      [ownerJid],
    );
    return res.rows;
  } catch (err) {
    console.error("[ReminderRepo] getPendingReminders failed:", err);
    return [];
  }
}

export async function markReminderSent(id: number): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(`UPDATE self_reminders SET sent = TRUE WHERE id = $1`, [id]);
  } catch (err) {
    console.error("[ReminderRepo] markReminderSent failed:", err);
  }
}

export async function deleteReminder(id: number, ownerJid: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const res = await pool.query(
      `DELETE FROM self_reminders WHERE id = $1 AND owner_jid = $2`,
      [id, ownerJid],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    console.error("[ReminderRepo] deleteReminder failed:", err);
    return false;
  }
}

export async function getUnsentDueReminders(): Promise<Reminder[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT * FROM self_reminders WHERE remind_at <= NOW() AND sent = FALSE ORDER BY remind_at ASC`,
    );
    return res.rows;
  } catch (err) {
    console.error("[ReminderRepo] getUnsentDueReminders failed:", err);
    return [];
  }
}
