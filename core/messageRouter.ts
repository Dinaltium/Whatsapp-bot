
import { default as makeWASocket, proto, downloadMediaMessage } from "@whiskeysockets/baileys";
import WhatsAppAgent from "../agents/WhatsAppAgent";
import DKBAgent from "../agents/DKBAgent";
import groupConfig from "../config/groupAllowlist";
import chatConfig from "../config/chatAllowlist";
import { getJidHash, logStructured, logEvent } from "../utils/logger";
import { normalizeJid, getSenderId, isAdminSender, isAdminAction } from "../security/rbac";
import {
  checkAiRateLimit,
  checkGroupAndGlobalLimits,
  shouldSendRateLimitNotice,
  formatRetryAfter,
  incrementGlobalDailyAiCount,
  clearRateLimitNotice,
} from "../security/rateLimiter";
import { handleCreateCommand, handleRoleDialogue } from "../services/core/rbacService";
import {
  getSession, saveSession, getLastUserMessage, setLastUserMessage, 
  addPendingIntro, getPendingIntro, removePendingIntro, getAllPendingIntros, UserSession
} from "./state";
import { COMMAND_PREFIX, GROQ_API_KEY, GROQ_MODEL, extractMessageText, shouldSkipMessage, extractMentionedJids, sendBotReply, addSessionMessage, safeGetGroupName, buildSessionKey } from "../bot";
import { redis } from "../storage/redisClient";

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
  type: string
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

      // ── ANTI-REPLAY: DISCARD HISTORICAL MESSAGES ON RECONNECT STORM ──
      const messageTimestamp = msg.messageTimestamp;
      if (messageTimestamp) {
        const messageAgeSeconds = Math.floor(Date.now() / 1000) - Number(messageTimestamp);
        if (messageAgeSeconds > 120) {
          logEvent("debug", {
            event: "historical_message_discarded",
            msgId: msg.key?.id,
            ageSeconds: messageAgeSeconds,
          });
          continue;
        }
      }

      // ── CACHE LATEST VIEW-ONCE MESSAGE ──────────────────────────────────
      if (msg.message) {
        const unwrapped = unwrapMessage(msg.message);
        if (unwrapped) {
          const hasViewOnce = unwrapped.viewOnceMessage 
            || unwrapped.viewOnceMessageV2 
            || unwrapped.viewOnceMessageV2Lid;
          if (hasViewOnce) {
            await redis.setex(`latest_view_once:${from}`, 3600, JSON.stringify(msg));
          }
        }
      }

      if (msg.key?.id) {
        const isSet = await redis.set(`msg_idemp:${msg.key.id}`, "1", "EX", 86400, "NX");
        if (!isSet) {
          logEvent("debug", { event: "duplicate_message_dropped", msgId: msg.key.id });
          continue;
        }
      }

      if (from.endsWith("@g.us")) {
        await redis.setex(`last_group_interaction:${from}`, 24 * 60 * 60, Date.now().toString());
      }

      let senderId = getSenderId(msg);
      if (msg.key?.fromMe && sock.user?.id) {
        senderId = normalizeJid(sock.user.id) as string;
      } else {
        // ── ZERO-QUERY INSTANT ALTERNATE JID EXTRACTION (Baileys 6.8.0) ──
        const rawParticipant = msg.key?.participant;
        const altParticipant = (msg.key as any)?.participantAlt;
        const rawRemoteJid = msg.key?.remoteJid;
        const altRemoteJid = (msg.key as any)?.remoteJidAlt;

        let hasAltMapping = false;

        if (rawParticipant && altParticipant && typeof rawParticipant === "string" && typeof altParticipant === "string") {
          const normalizedLid = normalizeJid(rawParticipant);
          const normalizedPn = normalizeJid(altParticipant);
          if (normalizedLid && normalizedPn && normalizedLid.endsWith("@lid") && normalizedPn.endsWith("@s.whatsapp.net")) {
            senderId = normalizedPn;
            hasAltMapping = true;
            import("../storage/core/rbacRepository").then(({ storeLidPhoneMapping }) =>
              storeLidPhoneMapping(normalizedLid, normalizedPn)
            ).catch(() => {});
          }
        }

        if (!hasAltMapping && rawRemoteJid && altRemoteJid && typeof rawRemoteJid === "string" && typeof altRemoteJid === "string") {
          const normalizedLid = normalizeJid(rawRemoteJid);
          const normalizedPn = normalizeJid(altRemoteJid);
          if (normalizedLid && normalizedPn && normalizedLid.endsWith("@lid") && normalizedPn.endsWith("@s.whatsapp.net")) {
            hasAltMapping = true;
            import("../storage/core/rbacRepository").then(({ storeLidPhoneMapping }) =>
              storeLidPhoneMapping(normalizedLid, normalizedPn)
            ).catch(() => {});
          }
        }
      }

      if (senderId && senderId.endsWith("@lid")) {
        const rawLid = senderId;
        let lidResolved = false;

        // Strategy 0: DB mapping table (most reliable — populated by !manage)
        try {
          const { resolvePhoneJidFromLid } = await import("../storage/core/rbacRepository");
          const dbResolved = await resolvePhoneJidFromLid(rawLid);
          if (dbResolved) {
            logStructured({ event: "lid_resolved_via_db", rawLidHash: getJidHash(rawLid), resolvedHash: getJidHash(dbResolved) });
            senderId = dbResolved;
            lidResolved = true;
          }
        } catch (_e) { /* db unavailable — fall through */ }

        // Strategy 1: Baileys native signalRepository.lidMapping
        if (!lidResolved) {
          try {
            const lidNum = rawLid.split("@")[0];
            const pn = (sock as any).signalRepository?.lidMapping?.getPNForLID?.(lidNum);
            if (pn && typeof pn === "string") {
              const resolvedId = normalizeJid(`${pn}@s.whatsapp.net`);
              if (resolvedId && !resolvedId.endsWith("@lid")) {
                logStructured({ event: "lid_resolved_via_signal", rawLidHash: getJidHash(rawLid), resolvedHash: getJidHash(resolvedId) });
                senderId = resolvedId;
                lidResolved = true;
                import("../storage/core/rbacRepository").then(({ storeLidPhoneMapping }) =>
                  storeLidPhoneMapping(rawLid, resolvedId)
                ).catch(() => {});
              }
            }
          } catch (_e) { /* signalRepository not available — fall through */ }
        }

        // Strategy 2: Group metadata participant scan (Upgraded for Baileys 6.8.0 Contact changes)
        if (!lidResolved && from.endsWith("@g.us")) {
          try {
            const metadata = await sock.groupMetadata(from);
            if (metadata && metadata.participants) {
              const participant = metadata.participants.find((p: any) => {
                const pid = p.id ? (normalizeJid(p.id) ?? "").toLowerCase() : "";
                const plid = p.lid ? (normalizeJid(p.lid) ?? "").toLowerCase() : "";
                const targetLower = rawLid.toLowerCase();
                return pid === targetLower || plid === targetLower;
              });

              if (participant) {
                const pid = participant.id ? normalizeJid(participant.id) : null;
                const ppn = participant.phoneNumber ? normalizeJid(participant.phoneNumber) : null;

                let resolvedId: string | null = null;
                if (pid && pid.endsWith("@s.whatsapp.net")) {
                  resolvedId = pid;
                } else if (ppn && ppn.endsWith("@s.whatsapp.net")) {
                  resolvedId = ppn;
                } else if ((participant as any).phone) {
                  const phoneStr = String((participant as any).phone);
                  const digits = phoneStr.replace(/\D/g, "");
                  if (digits) resolvedId = `${digits}@s.whatsapp.net`;
                }

                if (resolvedId && !resolvedId.endsWith("@lid")) {
                  logStructured({ event: "lid_resolved_via_metadata", rawLidHash: getJidHash(rawLid), resolvedHash: getJidHash(resolvedId) });
                  senderId = resolvedId;
                  lidResolved = true;
                  import("../storage/core/rbacRepository").then(({ storeLidPhoneMapping }) =>
                    storeLidPhoneMapping(rawLid, resolvedId)
                  ).catch(() => {});
                }
              }

              if (!lidResolved) {
                logStructured({
                  event: "lid_resolution_failed",
                  rawLid,
                  rawLidHash: getJidHash(rawLid),
                  groupHash: getJidHash(from),
                  participantCount: metadata.participants.length,
                  sampleLids: metadata.participants.slice(0, 5).map((p: any) => ({
                    id: p.id ?? null,
                    lid: p.lid ?? null,
                    phoneNumber: p.phoneNumber ?? null,
                  })),
                });
              }
            }
          } catch (err) {
            console.warn("Failed to resolve LID from group metadata:", err);
          }
        }

        if (!lidResolved) {
          logStructured({ event: "lid_unresolved", rawLid, groupHash: getJidHash(from) });
        }
      }

      if (text) {
        await setLastUserMessage(`${from}:${senderId}`, text);
      }

      // ── INTRO DETECTION ──────────────────────────────────────────────────
      // Runs on ALL non-command messages in bot-2 groups.
      // Phase 1 – Trigger: someone says "welcome/introduce" + @mentions a JID
      //           → add that JID to pendingIntros.
      // Phase 2 – Capture: sender is in pendingIntros
      //           → classify via AI, auto-add if mentor, give chatConfig access.
      if (
        text &&
        from.endsWith("@g.us") &&
        !text.startsWith(COMMAND_PREFIX) &&
        msg.message
      ) {
        const introGroupBot = groupConfig.getGroupBot(from);
        if (introGroupBot?.botNumber === 2) {
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
              const phoneMatches =
                text.match(/(?:\+?\d[\d\s\-]{7,14}\d)/g) || [];
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
              const result = await DKBAgent.classifyAndAutoAddMentor(
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
            continue; // Intro handled — skip command processing for this message
          }
        }
      }
      // ── END INTRO DETECTION ──────────────────────────────────────────────

      if (await shouldSkipMessage(sock, msg, from, text, senderId)) {
        continue;
      }

      const command = text!.toLowerCase();
      const sessionKey = buildSessionKey(from || "", senderId);
      const session = await getSession(sessionKey);

      // resetSessionIfExpired is handled by Redis TTL

      // ── INTERCEPT ROLE CREATION/MODIFICATION DIALOGUE ───────────────────
      if (session.pendingCreateRole) {
        const handled = await handleRoleDialogue(text!, session, async (replyText) => {
          await sendBotReply(sock, from || "", replyText);
        });
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
              JSON.stringify({ jid: pending.jid, botNumber: pending.botNumber })
            );
            const groupName = await safeGetGroupName(sock, pending.jid);
            await sendBotReply(
              sock,
              from || "",
              `Successfully removed Group ID: ${pending.id} | Name: ${groupName} | JID: ${pending.jid} from the allowlist.`
            );
          } else {
            await sendBotReply(
              sock,
              from || "",
              `Failed to remove Group ID: ${pending.id}.`
            );
          }
        } else {
          await sendBotReply(
            sock,
            from || "",
            `Removal of Group ID: ${pending.id} has been cancelled.`
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
              JSON.stringify({ jid: pending.jid, botNumber: pending.botNumber })
            );
            await sendBotReply(
              sock,
              from || "",
              `Successfully removed Chat ID: ${pending.id} | JID: ${pending.jid} from the allowlist.`
            );
          } else {
            await sendBotReply(
              sock,
              from || "",
              `Failed to remove Chat ID: ${pending.id}.`
            );
          }
        } else {
          await sendBotReply(
            sock,
            from || "",
            `Removal of Chat ID: ${pending.id} has been cancelled.`
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
          const ok = await groupConfig.editGroupBot(pending.id, pending.botNumber);
          if (ok) {
            const { logAction } = await import("../storage/core/auditRepository");
            await logAction(
              senderId || "unknown",
              "edit_group",
              String(pending.id),
              pending.jid,
              JSON.stringify({ botNumber: pending.botNumber })
            );
            const groupName = await safeGetGroupName(sock, pending.jid);
            await sendBotReply(
              sock,
              from || "",
              `Changed Group ID: ${pending.id} | Name: ${groupName} to use Bot ${pending.botNumber}.`
            );
          } else {
            await sendBotReply(
              sock,
              from || "",
              `Failed to change Bot for Group ID: ${pending.id}.`
            );
          }
        } else {
          await sendBotReply(
            sock,
            from || "",
            `Change of bot for Group ID: ${pending.id} has been cancelled.`
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
              JSON.stringify({ botNumber: pending.botNumber })
            );
            await sendBotReply(
              sock,
              from || "",
              `Changed Chat ID: ${pending.id} to use Bot ${pending.botNumber}.`
            );
          } else {
            await sendBotReply(
              sock,
              from || "",
              `Failed to change Bot for Chat ID: ${pending.id}.`
            );
          }
        } else {
          await sendBotReply(
            sock,
            from || "",
            `Change of bot for Chat ID: ${pending.id} has been cancelled.`
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
              "Group command limit reached for this hour. Please try again later."
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
              "Global AI assistant daily quota reached. Please try again tomorrow."
            );
          }
          continue;
        }
      }

      const rateLimitCheck = await checkAiRateLimit(from || "", senderId);

      if (!rateLimitCheck.allowed) {
        if (await shouldSendRateLimitNotice(from || "", senderId, rateLimitCheck)) {
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
          "ping", "hello", "reset", "getjid", "whoami",
          "addgroup", "rmgroup", "listgroups", "addchat", "rmchat", "listchats",
          "changebot", "editgroup", "editchat", "disablegroup", "disablechat",
          "enablegroup", "enablechat", "findgroups", "neonping", "neonconnect",
          "manage", "createrole", "role", "reveal",
          "clubs", "club", "events", "event", "mentors", "mentor", "next", "page",
          "addmentor", "editmentor", "delmentor"
        ];
        let isStaticCommand = staticCommands.includes(cmdName);
        if (/^reveal!+$/.test(cmdName) || cmdName === "revealthis!" || cmdName === "thepowerofwhatsappinmyhands!") {
          isStaticCommand = true;
        }

        const isAdmin = isAdminSender(msg, senderId);

        if (userPrompt && GROQ_API_KEY && !isStaticCommand && !isAdmin) {
          const { hasPromptInjection } = await import("../security/promptFirewall");
          const isInjection = await hasPromptInjection(userPrompt, GROQ_API_KEY, GROQ_MODEL);
          if (isInjection) {
            logEvent("warn", { event: "prompt_injection_blocked", senderId });
            await sendBotReply(
              sock,
              from || "",
              "⚠️ Security Alert: Prompt injection or instruction override attempt detected. Your query has been blocked."
            );
            continue;
          }
        }

        let finalPrompt = userPrompt;


        addSessionMessage(session, "user", finalPrompt);

        const agentResult = await WhatsAppAgent.handleAgentMessage(
          session,
          finalPrompt,
          GROQ_API_KEY,
          GROQ_MODEL,
          botNumber,
          isAdminSender(msg, senderId),
          senderId,
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


