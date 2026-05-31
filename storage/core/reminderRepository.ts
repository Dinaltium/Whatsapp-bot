import { getPool } from "../db";
import { logEvent } from "../../utils/logger";

export interface Reminder {
  id: number;
  jid: string;
  sender_id: string;
  message: string;
  remind_at: Date;
  status: string;
}

export async function createReminder(
  jid: string,
  senderId: string,
  message: string,
  remindAt: Date
): Promise<Reminder | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const res = await pool.query(
      `INSERT INTO wa_reminders (jid, sender_id, message, remind_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [jid, senderId, message, remindAt]
    );
    return res.rows[0];
  } catch (error) {
    console.error("Error creating reminder:", error);
    return null;
  }
}

export async function getPendingReminders(): Promise<Reminder[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT * FROM wa_reminders WHERE status = 'pending' AND remind_at <= NOW()`
    );
    return res.rows;
  } catch (error) {
    console.error("Error fetching pending reminders:", error);
    return [];
  }
}

export async function markReminderStatus(id: number, status: 'sent' | 'failed'): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE wa_reminders SET status = $1 WHERE id = $2`,
      [status, id]
    );
  } catch (error) {
    console.error("Error updating reminder status:", error);
  }
}
