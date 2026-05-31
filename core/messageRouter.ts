import { default as makeWASocket, proto } from "@whiskeysockets/baileys";
import WhatsAppAgent from "../agents/WhatsAppAgent";
import SelfAgent from "../agents/SelfAgent";

import groupConfig from "../config/groupAllowlist";
import chatConfig from "../config/chatAllowlist";
import { getJidHash, logStructured } from "../utils/logger";
import {
  normalizeJid,
  getSenderId,
  isAdminSender,
  isAdminAction,
} from "../security/rbac";
import { resolveSenderId } from "./middleware/lidResolver";
import {
  isHistoricalMessage,
  isDuplicateMessage,
} from "./middleware/antiReplay";
import { handleIntroDetection } from "./middleware/introDetector";
import {
  checkAiRateLimit,
  checkGroupAndGlobalLimits,
  shouldSendRateLimitNotice,
  formatRetryAfter,
  incrementGlobalDailyAiCount,
  clearRateLimitNotice,
  checkGlobalUserLimit,
} from "../security/rateLimiter";
import {
  handleCreateCommand,
  handleRoleDialogue,
} from "../services/core/rbacService";
import {
  getSession,
  saveSession,
  getLastUserMessage,
  setLastUserMessage,
  UserSession,
} from "./state";
import {
  COMMAND_PREFIX,
  extractMessageText,
  shouldSkipMessage,
  sendBotReply,
  addSessionMessage,
  safeGetGroupName,
  safeGetContactName,
  buildSessionKey,
  GROQ_API_KEY,
  GROQ_MODEL,
} from "../bot";
import { redis } from "../storage/redisClient";
import { logEvent } from "../utils/logger";
import { cacheMessageForContext } from "../utils/contextWindow";

function unwrapMessage(message: any): any {
  if (!message) return null;
  if (message.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  return message;
}

export async function handleMessageUpsert(
  sock: ReturnType<typeof makeWASocket>,
  messages: proto.IWebMessageInfo[],
  type: string,
) {
  if (type === "append") return;

  logEvent("debug", {
    event: "messages_received",
    type,
    count: messages.length,
  });
  for (const msg of messages) {
    const from = msg.key?.remoteJid;
    const textRaw = extractMessageText(msg.message);
    const text = textRaw ? textRaw.trim() : null;

    if (!from) continue;

    // ── ANTI-REPLAY GUARDS ──
    if (isHistoricalMessage(msg)) continue;

    // ── CACHE LATEST VIEW-ONCE MESSAGE ──────────────────────────────────
    if (msg.message) {
      const unwrapped = unwrapMessage(msg.message);
      if (unwrapped) {
        const hasViewOnce =
          unwrapped.viewOnceMessage ||
          unwrapped.viewOnceMessageV2 ||
          unwrapped.viewOnceMessageV2Lid;
        if (hasViewOnce) {
          await redis.setex(
            `latest_view_once:${from}`,
            3600,
            JSON.stringify(msg),
          );
        }
      }
    }

    if (await isDuplicateMessage(msg)) continue;

    if (from.endsWith("@g.us")) {
      await redis.setex(
        `last_group_interaction:${from}`,
        24 * 60 * 60,
        Date.now().toString(),
      );
    }

    let senderId = getSenderId(msg);
    senderId = await resolveSenderId(msg, sock, from, senderId);

    if (msg.pushName && senderId && !msg.key?.fromMe) {
      await redis.hset("contact_names", senderId, msg.pushName);
      const rawLid = getSenderId(msg);
      if (rawLid && rawLid.endsWith("@lid") && rawLid !== senderId) {
        await redis.hset("contact_names", rawLid, msg.pushName);
      }
    }

    if (text) {
      await setLastUserMessage(`${from}:${senderId}`, text);
    }

    // ── INTRO DETECTION (DKB groups only) ──
    if (text && from.endsWith("@g.us") && msg.message) {
      if (await handleIntroDetection(sock, msg, from, senderId, text)) {
        continue;
      }
    }

    // ── CONTEXT CACHING (for !!context, !!summarize, !!tldr features) ─────
    if (text && !msg.key?.fromMe && senderId) {
      try {
        const senderName = await safeGetContactName(senderId);
        await cacheMessageForContext(
          from,
          msg.key?.id || "",
          senderName,
          text,
          Date.now(),
        );
      } catch {
        /* non-fatal */
      }
    }

    // ── SELF BOT (ADMIN ONLY, !! PREFIX) ─────────────────────────────────────
    // Prevent !!! (triple) from triggering SELF — must be exactly !!
    if (text && text.startsWith("!!") && !text.startsWith("!!!")) {
      const isAdmin = isAdminSender(msg, senderId);
      if (!isAdmin) {
        continue; // silent ignore for non-admins
      }
      const prompt = text.slice(2).trim();
      if (prompt) {
        const sessionKey = buildSessionKey(from || "", senderId);
        const session = await getSession(sessionKey);
        try {
          const selfResult = await SelfAgent.handleMessage(
            session,
            prompt,
            GROQ_API_KEY,
            GROQ_MODEL,
            sock,
            msg,
            from || "",
            senderId,
          );
          if (selfResult.reply) {
            await sendBotReply(sock, from || "", selfResult.reply);
          }
          if (selfResult.usedAI) {
            addSessionMessage(session, "user", prompt);
            addSessionMessage(session, "assistant", selfResult.reply);
            await saveSession(sessionKey, session);
          }
        } catch (err) {
          console.error("[SELF] Handler error:", err);
        }
      }
      continue;
    }

    // ── MAJESTIC REVEAL INTERCEPTOR (NO PREFIX REQUIRED) ──
    const trimmedText = (text || "").trim().toLowerCase();
    const isMajesticReveal =
      /^reveal!+$/.test(trimmedText) ||
      /^revealthis!+$/.test(trimmedText) ||
      /^thepowerofwhatsappinmyhands!+$/.test(trimmedText);

    if (isMajesticReveal) {
      const { dispatchCommand } = await import("./commands/commandRegistry");
      const wasDispatched = await dispatchCommand({
        sock,
        msg,
        cmdName: trimmedText,
        cmdArgs: [],
        senderId,
        from: from || "",
        session: await getSession(buildSessionKey(from || "", senderId)),
      });
      if (wasDispatched) {
        continue;
      }
    }

    if (await shouldSkipMessage(sock, msg, from, text, senderId)) {
      continue;
    }

    // ── GLOBAL USER RATE LIMIT (non-admins only) ───────────────────────
    if (!isAdminSender(msg, senderId)) {
      const globalCheck = await checkGlobalUserLimit(senderId);
      if (!globalCheck.allowed) {
        if (
          await shouldSendRateLimitNotice(from || "", senderId, globalCheck)
        ) {
          await sendBotReply(
            sock,
            from || "",
            "You have reached the global usage limit. Please wait before sending more commands.",
          );
        }
        continue;
      }
    }

    const command = text!.toLowerCase();
    const sessionKey = buildSessionKey(from || "", senderId);
    const session = await getSession(sessionKey);

    // resetSessionIfExpired is handled by Redis TTL

    // ── INTERCEPT ROLE CREATION/MODIFICATION DIALOGUE ───────────────────
    if (session.pendingCreateRole) {
      const handled = await handleRoleDialogue(
        text!,
        session,
        async (replyText) => {
          await sendBotReply(sock, from || "", replyText);
        },
      );
      if (handled) {
        await saveSession(sessionKey, session);
        continue;
      }
    }

    // ── INTERCEPT ALLOWLIST CONFIRMATIONS ────────────────────────────────
    if (session.pendingDeleteGroup) {
      const pending = session.pendingDeleteGroup;
      delete session.pendingDeleteGroup;

      const isYes = /^!?yes$/i.test(text!.trim());
      if (isYes) {
        const ok = await groupConfig.removeGroupById(pending.id);
        if (ok) {
          const { logAction } = await import("../storage/core/auditRepository");
          await logAction(
            senderId || "unknown",
            "remove_group",
            String(pending.id),
            pending.jid,
            JSON.stringify({ jid: pending.jid, botNumber: pending.botNumber }),
          );
          const groupName = await safeGetGroupName(sock, pending.jid);
          await sendBotReply(
            sock,
            from || "",
            `Successfully removed Group ID: ${pending.id} | Name: ${groupName} | JID: ${pending.jid} from the allowlist.`,
          );
        } else {
          await sendBotReply(
            sock,
            from || "",
            `Failed to remove Group ID: ${pending.id}.`,
          );
        }
      } else {
        await sendBotReply(
          sock,
          from || "",
          `Removal of Group ID: ${pending.id} has been cancelled.`,
        );
      }
      await saveSession(sessionKey, session);
      continue;
    }

    if (session.pendingDeleteChat) {
      const pending = session.pendingDeleteChat;
      delete session.pendingDeleteChat;

      const isYes = /^!?yes$/i.test(text!.trim());
      if (isYes) {
        const ok = await chatConfig.removeChatById(pending.id);
        if (ok) {
          const { logAction } = await import("../storage/core/auditRepository");
          await logAction(
            senderId || "unknown",
            "remove_chat",
            String(pending.id),
            pending.jid,
            JSON.stringify({ jid: pending.jid, botNumber: pending.botNumber }),
          );
          const name = await safeGetContactName(pending.jid);
          await sendBotReply(
            sock,
            from || "",
            `Successfully removed Chat ID: ${pending.id} | Name: ${name} | JID: ${pending.jid} from the allowlist.`,
          );
        } else {
          await sendBotReply(
            sock,
            from || "",
            `Failed to remove Chat ID: ${pending.id}.`,
          );
        }
      } else {
        await sendBotReply(
          sock,
          from || "",
          `Removal of Chat ID: ${pending.id} has been cancelled.`,
        );
      }
      await saveSession(sessionKey, session);
      continue;
    }

    if (session.pendingEditGroup) {
      const pending = session.pendingEditGroup;
      delete session.pendingEditGroup;

      const isYes = /^!?yes$/i.test(text!.trim());
      if (isYes) {
        const ok = await groupConfig.editGroupBot(
          pending.id,
          pending.botNumber,
        );
        if (ok) {
          const { logAction } = await import("../storage/core/auditRepository");
          await logAction(
            senderId || "unknown",
            "edit_group",
            String(pending.id),
            pending.jid,
            JSON.stringify({ botNumber: pending.botNumber }),
          );
          const groupName = await safeGetGroupName(sock, pending.jid);
          // Clear sessions for the reassigned group (Task 3.5)
          try {
            const sessionPattern = `session:${pending.jid}:*`;
            const sessionKeys = await redis.keys(sessionPattern);
            if (sessionKeys.length > 0) {
              await redis.del(...sessionKeys);
              console.log(
                `[SessionClear] Cleared ${sessionKeys.length} sessions for reassigned group`,
              );
            }
          } catch {
            /* non-fatal */
          }
          await sendBotReply(
            sock,
            from || "",
            `Changed Group ID: ${pending.id} | Name: ${groupName} to use Bot ${pending.botNumber}.`,
          );
        } else {
          await sendBotReply(
            sock,
            from || "",
            `Failed to change Bot for Group ID: ${pending.id}.`,
          );
        }
      } else {
        await sendBotReply(
          sock,
          from || "",
          `Change of bot for Group ID: ${pending.id} has been cancelled.`,
        );
      }
      await saveSession(sessionKey, session);
      continue;
    }

    if (session.pendingEditChat) {
      const pending = session.pendingEditChat;
      delete session.pendingEditChat;

      const isYes = /^!?yes$/i.test(text!.trim());
      if (isYes) {
        const ok = await chatConfig.editChatBot(pending.id, pending.botNumber);
        if (ok) {
          const { logAction } = await import("../storage/core/auditRepository");
          await logAction(
            senderId || "unknown",
            "edit_chat",
            String(pending.id),
            pending.jid,
            JSON.stringify({ botNumber: pending.botNumber }),
          );
          const name = await safeGetContactName(pending.jid);
          // Clear sessions for the reassigned chat (Task 3.5)
          try {
            const sessionPattern = `session:${pending.jid}:*`;
            const sessionKeys = await redis.keys(sessionPattern);
            if (sessionKeys.length > 0) {
              await redis.del(...sessionKeys);
              console.log(
                `[SessionClear] Cleared ${sessionKeys.length} sessions for reassigned chat`,
              );
            }
          } catch {
            /* non-fatal */
          }
          await sendBotReply(
            sock,
            from || "",
            `Changed Chat ID: ${pending.id} | Name: ${name} to use Bot ${pending.botNumber}.`,
          );
        } else {
          await sendBotReply(
            sock,
            from || "",
            `Failed to change Bot for Chat ID: ${pending.id}.`,
          );
        }
      } else {
        await sendBotReply(
          sock,
          from || "",
          `Change of bot for Chat ID: ${pending.id} has been cancelled.`,
        );
      }
      await saveSession(sessionKey, session);
      continue;
    }

    // Determine bot number for this group/chat
    let botNumber = 0;
    if (from?.endsWith("@g.us")) {
      const groupBot = groupConfig.getGroupBot(from);
      botNumber = groupBot?.botNumber || 0;
    } else {
      const chatBot = chatConfig.getChatBot(from);
      botNumber = chatBot?.botNumber || 0;
    }

    logStructured({
      event: "command_processing",
      command: command.split(/\s+/)[0],
      bot: botNumber,
      userHash: getJidHash(from),
    });

    const userPrompt = text!.slice(COMMAND_PREFIX.length).trim();

    if (!userPrompt) {
      await sendBotReply(
        sock,
        from || "",
        "Use ! followed by your question. Example: !How do I optimize API latency?",
      );
      continue;
    }

    const parts = userPrompt.split(/\s+/);
    let cmdName = (parts[0] || "").toLowerCase();
    if (cmdName === "removegroup") cmdName = "rmgroup";
    if (cmdName === "removechat") cmdName = "rmchat";
    if (cmdName === "listgroup") cmdName = "listgroups";
    if (cmdName === "listchat") cmdName = "listchats";
    const cmdArgs = parts.slice(1);

    // ── INTERCEPT AND ROUTE VIA COMMAND DISPATCHER REGISTRY ──
    const { dispatchCommand } = await import("./commands/commandRegistry");
    const wasDispatched = await dispatchCommand({
      sock,
      msg,
      cmdName,
      cmdArgs,
      senderId,
      from: from || "",
      session,
    });
    if (wasDispatched) {
      continue;
    }

    // Check Group & Global limits and burst protection
    if (from) {
      const groupLimit = await checkGroupAndGlobalLimits(from);
      if (!groupLimit.allowed) {
        if (groupLimit.reason === "muted") {
          logStructured({
            event: "command_skipped",
            reason: "group_muted_burst_protection",
            userHash: getJidHash(from),
          });
        } else if (groupLimit.reason === "hourly_limit") {
          logStructured({
            event: "command_skipped",
            reason: "group_hourly_limit_reached",
            userHash: getJidHash(from),
          });
          await sendBotReply(
            sock,
            from,
            "Group command limit reached for this hour. Please try again later.",
          );
        } else if (groupLimit.reason === "global_limit") {
          logStructured({
            event: "command_skipped",
            reason: "global_daily_limit_reached",
            userHash: getJidHash(from),
          });
          await sendBotReply(
            sock,
            from,
            "Global AI assistant daily quota reached. Please try again tomorrow.",
          );
        }
        continue;
      }
    }

    const rateLimitCheck = await checkAiRateLimit(from || "", senderId);

    if (!rateLimitCheck.allowed) {
      if (
        await shouldSendRateLimitNotice(from || "", senderId, rateLimitCheck)
      ) {
        await sendBotReply(
          sock,
          from || "",
          `Rate limit active. Please retry in ${formatRetryAfter(rateLimitCheck.retryAfterMs!)}.`,
        );
      }

      continue;
    }

    await clearRateLimitNotice(from || "", senderId);

    try {
      const staticCommands = [
        "ping",
        "hello",
        "reset",
        "getjid",
        "whoami",
        "addgroup",
        "rmgroup",
        "listgroups",
        "addchat",
        "rmchat",
        "listchats",
        "changebot",
        "editgroup",
        "editchat",
        "disablegroup",
        "disablechat",
        "enablegroup",
        "enablechat",
        "findgroups",
        "neonping",
        "neonconnect",
        "manage",
        "createrole",
        "role",
        "reveal",
        "clubs",
        "club",
        "events",
        "event",
        "mentors",
        "mentor",
        "next",
        "page",
        "addmentor",
        "editmentor",
        "delmentor",
      ];
      let isStaticCommand = staticCommands.includes(cmdName);
      if (
        /^reveal!+$/.test(cmdName) ||
        cmdName === "revealthis!" ||
        cmdName === "thepowerofwhatsappinmyhands!"
      ) {
        isStaticCommand = true;
      }

      const isAdmin = isAdminSender(msg, senderId);

      if (userPrompt && GROQ_API_KEY && !isStaticCommand && !isAdmin) {
        const { hasPromptInjection } =
          await import("../security/promptFirewall");
        const isInjection = await hasPromptInjection(
          userPrompt,
          GROQ_API_KEY,
          GROQ_MODEL,
        );
        if (isInjection) {
          logEvent("warn", { event: "prompt_injection_blocked", senderId });
          await sendBotReply(
            sock,
            from || "",
            "⚠️ Security Alert: Prompt injection or instruction override attempt detected. Your query has been blocked.",
          );
          continue;
        }
      }

      let finalPrompt = userPrompt;

      addSessionMessage(session, "user", finalPrompt);

      const agentResult = await WhatsAppAgent.handleAgentMessage(
        {
          session,
          prompt: finalPrompt,
          groqApiKey: GROQ_API_KEY,
          groqModel: GROQ_MODEL,
          isAdmin: isAdminSender(msg, senderId),
          senderJid: senderId || "",
          from: from || "",
          sock,
          msg,
        },
        botNumber,
      );

      if (!agentResult.reply) {
        continue;
      }

      if (agentResult.domainLocked) {
        await sendBotReply(sock, from || "", agentResult.reply);
        continue;
      }

      if (!agentResult.usedAI) {
        await sendBotReply(sock, from || "", agentResult.reply);
        session.lastActiveAt = Date.now();
        await saveSession(sessionKey, session);
        continue;
      }

      session.domainUnlocked = true;
      addSessionMessage(session, "assistant", agentResult.reply);
      session.lastActiveAt = Date.now();
      await incrementGlobalDailyAiCount();
      await saveSession(sessionKey, session);

      await sendBotReply(sock, from || "", agentResult.reply);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("Agent/Baileys error:", errorMessage);

      try {
        await sendBotReply(
          sock,
          from || "",
          "We are unable to process your request at the moment. Please try again later.",
        );
      } catch (sendError) {
        console.error(
          "Failed to send fallback message:",
          sendError instanceof Error ? sendError.message : String(sendError),
        );
      }
    }
  }
}
