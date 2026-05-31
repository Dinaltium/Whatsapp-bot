import {
  getUnsentDueReminders,
  markReminderSent,
} from "../../storage/SELF/reminderRepository";
import { getActiveSocket } from "../../bot";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startReminderScheduler(): void {
  if (schedulerInterval) return;

  schedulerInterval = setInterval(async () => {
    try {
      const reminders = await getUnsentDueReminders();
      if (reminders.length === 0) return;

      const sock = getActiveSocket();
      if (!sock) {
        console.warn(
          "[ReminderScheduler] Socket not available, skipping tick.",
        );
        return;
      }

      for (const reminder of reminders) {
        try {
          await sock.sendMessage(reminder.chat_jid, {
            text: `\u23F0 Reminder: ${reminder.message}`,
          });
          await markReminderSent(reminder.id);
        } catch (err) {
          console.error(
            `[ReminderScheduler] Failed to send reminder ID ${reminder.id}:`,
            err,
          );
        }
      }
    } catch (err) {
      console.error("[ReminderScheduler] Tick error:", err);
    }
  }, 60 * 1000); // every 60 seconds

  console.log("[ReminderScheduler] Started (60s interval).");
}

export function stopReminderScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("[ReminderScheduler] Stopped.");
  }
}
