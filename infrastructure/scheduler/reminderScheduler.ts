import schedule from "node-schedule";
import { getPendingReminders, markReminderStatus } from "../../storage/core/reminderRepository";
import { getActiveSocket, sendBotReply } from "../../bot";
import { safeGetContactName } from "../../bot"; // optional context

let isSchedulerRunning = false;

export function startReminderScheduler(): void {
  if (isSchedulerRunning) return;
  isSchedulerRunning = true;

  // Run every minute
  schedule.scheduleJob("* * * * *", async () => {
    try {
      const pending = await getPendingReminders();
      const sock = getActiveSocket();
      
      if (!sock || pending.length === 0) return;

      for (const reminder of pending) {
        try {
          const text = `🔔 *Reminder*\n\n${reminder.message}`;
          
          await sendBotReply(sock, reminder.jid, text);
          await markReminderStatus(reminder.id, 'sent');
        } catch (err) {
          console.error(`Failed to send reminder ID ${reminder.id}:`, err);
          await markReminderStatus(reminder.id, 'failed');
        }
      }
    } catch (err) {
      console.error("Error in reminder scheduler job:", err);
    }
  });

  console.log("Reminder scheduler started.");
}
