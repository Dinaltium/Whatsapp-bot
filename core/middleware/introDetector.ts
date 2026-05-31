/**
 * Intro Detector Middleware
 *
 * Detects member introductions in DKB (Bot 2) groups:
 *   Phase 1 — Trigger: A message contains "welcome" or "introduce" + @mentions
 *             → Registers the mentioned JIDs for intro tracking.
 *   Phase 2 — Capture: A tracked sender posts a message > 20 chars
 *             → AI classifies as mentor/student, auto-adds mentor to chat allowlist.
 *
 * Extracted from messageRouter.ts to reduce routing complexity.
 */

import { normalizeJid } from "../../security/rbac";
import { getJidHash, logStructured } from "../../utils/logger";
import {
  addPendingIntro,
  getPendingIntro,
  removePendingIntro,
  getAllPendingIntros,
} from "../state";
import {
  extractMentionedJids,
  sendBotReply,
  GROQ_API_KEY,
  GROQ_MODEL,
  COMMAND_PREFIX,
} from "../../bot";
import groupConfig from "../../config/groupAllowlist";
import chatConfig from "../../config/chatAllowlist";
import { classifyAndAutoAddMentor } from "../../agents/DKBAgent";

/**
 * Runs intro detection on a message. Returns true if the message was
 * handled as an intro (caller should `continue` to the next message).
 */
export async function handleIntroDetection(
  sock: any,
  msg: any,
  from: string,
  senderId: string,
  text: string,
): Promise<boolean> {
  // Only runs in DKB (bot 2) groups, on non-command messages
  if (!from.endsWith("@g.us") || text.startsWith(COMMAND_PREFIX)) return false;
  if (!msg.message) return false;

  const introGroupBot = groupConfig.getGroupBot(from);
  if (introGroupBot?.botNumber !== 2) return false;

  const introSenderId = normalizeJid(senderId) || "";
  const hasTriggerWord = /\bintroduce\b|\bwelcome\b/i.test(text);

  // --- Phase 1: detect trigger and register JIDs to watch ---
  if (hasTriggerWord) {
    const mentionedJids = extractMentionedJids(msg);
    for (const jid of mentionedJids) {
      const normalized = normalizeJid(jid);
      if (
        normalized &&
        !normalized.endsWith("@g.us") &&
        normalized !== introSenderId
      ) {
        await addPendingIntro(normalized, from);
        logStructured({
          event: "intro_tracker_watch",
          bot: 2,
          groupHash: getJidHash(from),
          targetHash: getJidHash(normalized),
        });
      }
    }
    // Fallback: extract phone numbers from text when no @mention
    if (mentionedJids.length === 0) {
      const phoneMatches = text.match(/(?:\+?\d[\d\s\-]{7,14}\d)/g) || [];
      for (const ph of phoneMatches) {
        const digits = ph.replace(/\D/g, "");
        if (digits.length >= 10) {
          const derivedJid = `${digits}@s.whatsapp.net`;
          await addPendingIntro(derivedJid, from);
          logStructured({
            event: "intro_tracker_watch_phone",
            bot: 2,
            groupHash: getJidHash(from),
            targetHash: getJidHash(derivedJid),
          });
        }
      }
    }
  }

  // --- Phase 2: sender is tracked — this IS their intro message ---
  let trackedGroupJid: string | null = null;

  // Exact JID match
  if ((await getPendingIntro(introSenderId)) !== null) {
    trackedGroupJid = await getPendingIntro(introSenderId);
    await removePendingIntro(introSenderId);
  } else {
    // Fuzzy: compare last 10 digits to handle country-code mismatches
    const senderSuffix = introSenderId.replace(/\D/g, "").slice(-10);
    const allIntros = await getAllPendingIntros();
    for (const [trackedJid, groupJid] of Object.entries(allIntros)) {
      const trackedSuffix = trackedJid.replace(/\D/g, "").slice(-10);
      if (senderSuffix && senderSuffix === trackedSuffix) {
        trackedGroupJid = groupJid;
        await removePendingIntro(trackedJid);
        break;
      }
    }
  }

  if (trackedGroupJid && trackedGroupJid === from && text.length > 20) {
    logStructured({
      event: "intro_captured",
      bot: 2,
      userHash: getJidHash(introSenderId),
    });
    try {
      const senderPhone = introSenderId.replace(/@.*/, "");
      const result = await classifyAndAutoAddMentor(
        text,
        introSenderId,
        senderPhone,
        GROQ_API_KEY,
        GROQ_MODEL,
      );

      if (result.isMentor) {
        logStructured({
          event: "intro_classified",
          result: "mentor",
          userHash: getJidHash(introSenderId),
        });
        await chatConfig.addChat(introSenderId, 2);
      } else {
        logStructured({
          event: "intro_classified",
          result: "student",
          userHash: getJidHash(introSenderId),
        });
      }

      // Send the welcome message if we received one, else use a fallback
      let welcomeText = result.welcomeMessage;
      if (!welcomeText) {
        const displayName = result.mentorName || "there";
        if (result.isMentor) {
          welcomeText = `Hi ${displayName}, welcome to DK24! Glad to have you with us as a mentor. We look forward to your active presence in our developer community!`;
        } else {
          welcomeText = `Hi ${displayName}, welcome to DK24! Glad to have you join us as a student. We hope you connect, learn, and grow with the community!`;
        }
      }

      await sendBotReply(sock, from, welcomeText);
    } catch (err) {
      console.error("[DEBUG] Intro classification error:", err);
    }
    return true; // Intro handled — skip command processing for this message
  }

  return false;
}
