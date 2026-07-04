/**
 * Intro Notifier
 *
 * Event-driven replacement for the old text-scraping + LLM auto-classification
 * intro detector. When a new member is added to a watched DKB (bot 2) group,
 * post a notification to the configured mentor group (INTRO_NOTIFY_GROUP_JID)
 * with the new member's number pre-filled into an !addmentor command, so a
 * mentor-role holder can add them if they're a mentor — or simply ignore it.
 *
 * No LLM judgement is involved: a human mentor makes the call. This fixes
 * "easy to miss an addition" (it's triggered by the actual participant-add
 * event, not by guessing from message text) without the misclassification
 * cleanup burden of the old approach.
 */

import { normalizeJid } from "../../security/rbac";
import { getJidHash, logStructured } from "../../utils/logger";

/**
 * Notifies the mentor group about a newly-added member. No-op (feature
 * disabled) when INTRO_NOTIFY_GROUP_JID is unset or the source group is the
 * mentor group itself.
 */
export const INTRO_NOTIFY_SETTING_KEY = "intro_notify_group_jid";

export async function notifyMentorGroupOfNewMember(
  sock: any,
  sourceGroupJid: string,
  addedJid: string,
): Promise<void> {
  // Prefer the in-bot setting (set via !notify) over the env fallback, so the
  // target can be changed at runtime without a redeploy.
  let configured = "";
  try {
    const { getSetting } = await import("../../storage/core/settingsRepository");
    configured = (await getSetting(INTRO_NOTIFY_SETTING_KEY)) || "";
  } catch {
    /* fall back to env */
  }
  if (!configured) configured = process.env.INTRO_NOTIFY_GROUP_JID || "";

  const notifyGroup = normalizeJid(configured);
  if (!notifyGroup || !notifyGroup.endsWith("@g.us")) return; // disabled
  if (notifyGroup === sourceGroupJid) return; // avoid self-notification

  const phone = addedJid.endsWith("@s.whatsapp.net")
    ? `+${addedJid.split("@")[0]}`
    : null;

  let sourceName = "a group";
  try {
    const meta = await sock.groupMetadata(sourceGroupJid);
    sourceName = meta?.subject || sourceName;
  } catch {
    /* non-fatal — fall back to generic label */
  }

  const addLine = phone
    ? `!addmentor -n <name> -o <org> -p ${phone}`
    : `(number not resolved yet — add manually with !addmentor)`;

  const text =
    `New member joined *${sourceName}*` +
    (phone ? `: ${phone}` : "") +
    `\n\nIf they're a mentor, add them:\n${addLine}\n\nOtherwise, ignore this.`;

  try {
    const { sendBotReply } = await import("../../bot");
    await sendBotReply(sock, notifyGroup, text);
    logStructured({
      event: "intro_notify_sent",
      sourceGroupHash: getJidHash(sourceGroupJid),
      addedHash: getJidHash(addedJid),
    });
  } catch (err) {
    console.error("[IntroNotifier] Failed to notify mentor group:", err);
  }
}
