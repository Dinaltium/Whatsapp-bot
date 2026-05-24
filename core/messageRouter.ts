
import { default as makeWASocket, proto } from "@whiskeysockets/baileys";
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

      if (msg.key?.id) {
        const isSet = await redis.set(`msg_idemp:${msg.key.id}`, "1", "EX", 300, "NX");
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

      if (command === "!ping") {
        await sendBotReply(sock, from || "", "pong");
        continue;
      }

      if (command === "!help") {
        let helpText = "";
        if (botNumber === 1) {
          helpText = [
            "ECB - EmbedClub Assistant",
            "Available Commands:",
            "• !ping - Check bot response and status",
            "• !hello - Check bot availability",
            "• !reset - Reset your conversation context",
            "• !<question> - Ask about ECB events, hardware/embedded activities, and community guidelines",
          ].join("\n");
        } else if (botNumber === 2) {
          helpText = [
            "DKB - DK24 (Developer Kommunity 24) Assistant",
            "Available Commands:",
            "• !ping - Check bot response and status",
            "• !hello - Check bot availability",
            "• !reset - Reset your conversation context",
            "• !clubs - List all official member communities in the DK24 network",
            "• !club <name> - Get detailed spotlight card for a specific member community",
            "• !events [monthYear] - List chronological events (e.g. !events may-2026)",
            "• !event <name> - Get details, timeline, and registration links for an event",
            "• !mentors [page] - List mentors in alphabetical order (10 per page)",
            "• !mentor -id <id> - View full details for a specific mentor by ID",
            "• !mentor -f <letter_or_query> [page] - Filter mentors by name",
            "• !next - View the next page of mentors from your active query",
            "• !page <number> - View a specific page of mentors from your active query",
            "• !addmentor -n <name> -o <org> [-d <desc>] [-ex <expertise>] [-l <linkedin>] [-i <instagram>] [-g <github>] [-e <email>] [-p <phone>] - Add a mentor (Authorized only)",
            "• !editmentor -id <id> -<flag> <value> - Update a single field on a mentor (Authorized only)",
            "• !delmentor -id <id> - Remove a mentor (Authorized only)",
            "• !<question> - Chat directly with DKB (e.g. !What is a good way to host an AI meetup?)",
          ].join("\n");

        } else {
          // Default to Bot 0 (PARAG)
          helpText = [
            "PARAG - Technology and Hackathon Assistant",
            "Available Commands:",
            "• !ping - Check bot response and status",
            "• !hello - Check bot availability",
            "• !reset - Reset your conversation context",
            "• !<question> - Chat directly with PARAG (e.g. !How do I optimize API latency?)",
          ].join("\n");
        }
        await sendBotReply(sock, from || "", helpText);
        continue;
      }

      if (command === "!hello") {
        await sendBotReply(sock, from || "", "PARAG online and operational.");
        continue;
      }

      if (command === "!reset") {
        session.domainUnlocked = false;
        session.messages = [];
        session.lastActiveAt = 0;

        await sendBotReply(
          sock,
          from || "",
          "Context reset for your session. Start with a new !tech or !hackathon question.",
        );
        continue;
      }

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



      if (cmdName === "getjid") {
        if (from?.endsWith("@g.us")) {
          await sendBotReply(sock, from || "", `Group JID: ${from}`);
        } else {
          await sendBotReply(sock, from || "", `Chat JID: ${from}`);
        }
        continue;
      }

      if (cmdName === "whoami") {
        const normalized = normalizeJid(senderId);
        await sendBotReply(
          sock,
          from || "",
          `Your JID: ${senderId}\nNormalized: ${normalized}`,
        );
        continue;
      }

      if (
        [
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
        ].includes(cmdName)
      ) {
        if (!isAdminAction(msg, senderId)) {
          await sendBotReply(
            sock,
            from || "",
            "Unauthorized: admin privileges required for that command.",
          );
          continue;
        }

        if (cmdName === "listgroups") {
          const list = groupConfig.listGroups();
          if (!list || list.length === 0) {
            await sendBotReply(
              sock,
              from || "",
              "No groups configured (allowlist is empty).",
            );
          } else {
            const formattedPromises = list.map(async (entry) => {
              const botLabel =
                entry.botNumber === 1
                  ? "ECB"
                  : entry.botNumber === 2
                    ? "DKB"
                    : "PARAG";
              const statusLabel = entry.enabled ? "Enabled" : "Disabled";
              const groupName = await safeGetGroupName(sock, entry.jid);
              return `${entry.id}. ${groupName} (${entry.jid}) | Bot ${entry.botNumber} (${botLabel}) | [${statusLabel}]`;
            });
            const formatted = await Promise.all(formattedPromises);
            await sendBotReply(
              sock,
              from || "",
              `Allowed groups:\n${formatted.join("\n")}`,
            );
          }
          continue;
        }

        if (cmdName === "listchats") {
          const list = chatConfig.listChats();
          if (!list || list.length === 0) {
            await sendBotReply(
              sock,
              from || "",
              "No chats configured (allowlist is empty).",
            );
          } else {
            const formatted = list.map((entry) => {
              const botLabel =
                entry.botNumber === 1
                  ? "ECB"
                  : entry.botNumber === 2
                    ? "DKB"
                    : "PARAG";
              const statusLabel = entry.enabled ? "Enabled" : "Disabled";
              return `${entry.id}. ${entry.jid} | Bot ${entry.botNumber} (${botLabel}) | [${statusLabel}]`;
            });
            await sendBotReply(
              sock,
              from || "",
              `Allowed chats:\n${formatted.join("\n")}`,
            );
          }
          continue;
        }

        if (cmdName === "addgroup") {
          let target = cmdArgs[0];
          const botNumber = cmdArgs[1] ? parseInt(cmdArgs[1], 10) : 0;

          if (!target) {
            await sendBotReply(
              sock,
              from || "",
              "Usage: !addgroup <group-jid> [bot-number]\nBot 0: PARAG | Bot 1: ECB | Bot 2: DKB",
            );
            continue;
          }

          target = normalizeJid(target) as string;
          const ok = await groupConfig.addGroup(target, isNaN(botNumber) ? 0 : botNumber);
          if (ok) {
            const groupEntry = groupConfig.getGroupEntryByJid(target);
            const idLabel = groupEntry ? ` (ID: ${groupEntry.id})` : "";
            const groupName = await safeGetGroupName(sock, target);
            const { logAction } = await import("../storage/core/auditRepository");
            await logAction(
              senderId || "unknown",
              "add_group",
              groupEntry ? String(groupEntry.id) : null,
              target,
              JSON.stringify({ botNumber: isNaN(botNumber) ? 0 : botNumber })
            );
            await sendBotReply(
              sock,
              from || "",
              `Added group ${groupName} (${target}) to group allowlist${idLabel} (Bot ${isNaN(botNumber) ? 0 : botNumber}).`,
            );
          } else {
            await sendBotReply(
              sock,
              from || "",
              `Failed to add ${target}. Ensure it's a valid group JID.`,
            );
          }
          continue;
        }

        if (cmdName === "addchat") {
          let target = cmdArgs[0];
          const botNumber = cmdArgs[1] ? parseInt(cmdArgs[1], 10) : 0;

          if (!target) {
            await sendBotReply(
              sock,
              from || "",
              "Usage: !addchat <chat-jid> [bot-number]\nBot 0: PARAG | Bot 1: ECB | Bot 2: DKB",
            );
            continue;
          }

          target = normalizeJid(target) as string;
          const ok = await chatConfig.addChat(target, isNaN(botNumber) ? 0 : botNumber);
          if (ok) {
            const chatEntry = chatConfig.getChatEntryByJid(target);
            const idLabel = chatEntry ? ` (ID: ${chatEntry.id})` : "";
            const { logAction } = await import("../storage/core/auditRepository");
            await logAction(
              senderId || "unknown",
              "add_chat",
              chatEntry ? String(chatEntry.id) : null,
              target,
              JSON.stringify({ botNumber: isNaN(botNumber) ? 0 : botNumber })
            );
            await sendBotReply(
              sock,
              from || "",
              `Added ${target} to chat allowlist${idLabel} (Bot ${isNaN(botNumber) ? 0 : botNumber}).`,
            );
          } else {
            await sendBotReply(
              sock,
              from || "",
              `Failed to add ${target}. Ensure it's a valid chat JID.`,
            );
          }
          continue;
        }

        if (cmdName === "rmgroup") {
          const rawArgs = cmdArgs.join(" ").trim();
          const match = rawArgs.match(/^-id\s+(\d+)$/i);
          if (!match) {
            await sendBotReply(
              sock,
              from || "",
              "Usage: !rmgroup -id <id_number>\nExample: !rmgroup -id 4",
            );
            continue;
          }

          const groupId = parseInt(match[1], 10);
          const groupEntry = groupConfig.getGroupEntryById(groupId);
          if (!groupEntry) {
            await sendBotReply(
              sock,
              from || "",
              `No group found in the allowlist with ID ${groupId}.`,
            );
            continue;
          }

          const groupName = await safeGetGroupName(sock, groupEntry.jid);

          session.pendingDeleteGroup = {
            id: groupId,
            jid: groupEntry.jid,
            botNumber: groupEntry.botNumber,
          };

          const botLabel = groupEntry.botNumber === 1
            ? "ECB"
            : groupEntry.botNumber === 2
              ? "DKB"
              : "PARAG";

          await sendBotReply(
            sock,
            from || "",
            `Are you sure you want to remove Group ID: ${groupId} | Name: ${groupName} | JID: ${groupEntry.jid} | Bot: ${groupEntry.botNumber} (${botLabel}) from the allowlist?\n(Enter !YES for confirmation)`
          );
          await saveSession(sessionKey, session);
          continue;
        }

        if (cmdName === "rmchat") {
          const rawArgs = cmdArgs.join(" ").trim();
          const match = rawArgs.match(/^-id\s+(\d+)$/i);
          if (!match) {
            await sendBotReply(
              sock,
              from || "",
              "Usage: !rmchat -id <id_number>\nExample: !rmchat -id 4",
            );
            continue;
          }

          const chatId = parseInt(match[1], 10);
          const chatEntry = chatConfig.getChatEntryById(chatId);
          if (!chatEntry) {
            await sendBotReply(
              sock,
              from || "",
              `No chat found in the allowlist with ID ${chatId}.`,
            );
            continue;
          }

          session.pendingDeleteChat = {
            id: chatId,
            jid: chatEntry.jid,
            botNumber: chatEntry.botNumber,
          };

          const botLabel = chatEntry.botNumber === 1
            ? "ECB"
            : chatEntry.botNumber === 2
              ? "DKB"
              : "PARAG";

          await sendBotReply(
            sock,
            from || "",
            `Are you sure you want to remove Chat ID: ${chatId} | JID: ${chatEntry.jid} | Bot: ${chatEntry.botNumber} (${botLabel}) from the allowlist?\n(Enter !YES for confirmation)`
          );
          await saveSession(sessionKey, session);
          continue;
        }

        if (cmdName === "editgroup") {
          const rawArgs = cmdArgs.join(" ").trim();
          const match = rawArgs.match(/^-id\s+(\d+)\s+-b\s+(\d+)$/i);
          if (!match) {
            await sendBotReply(
              sock,
              from || "",
              "Usage: !editgroup -id <id_number> -b <bot_number>\nExample: !editgroup -id 4 -b 2",
            );
            continue;
          }

          const groupId = parseInt(match[1], 10);
          const newBotNumber = parseInt(match[2], 10);

          const groupEntry = groupConfig.getGroupEntryById(groupId);
          if (!groupEntry) {
            await sendBotReply(
              sock,
              from || "",
              `No group found in the allowlist with ID ${groupId}.`,
            );
            continue;
          }

          if (groupEntry.botNumber === newBotNumber) {
            await sendBotReply(
              sock,
              from || "",
              `Group is already using bot ${newBotNumber}.`,
            );
            continue;
          }

          const groupName = await safeGetGroupName(sock, groupEntry.jid);

          session.pendingEditGroup = {
            id: groupId,
            jid: groupEntry.jid,
            botNumber: newBotNumber,
          };

          const oldBotLabel = groupEntry.botNumber === 1 ? "ECB" : groupEntry.botNumber === 2 ? "DKB" : "PARAG";
          const newBotLabel = newBotNumber === 1 ? "ECB" : newBotNumber === 2 ? "DKB" : "PARAG";

          await sendBotReply(
            sock,
            from || "",
            `Are you sure you want to change Group ID: ${groupId} | Name: ${groupName} | JID: ${groupEntry.jid} to use Bot ${newBotNumber} (${newBotLabel}) instead of Bot ${groupEntry.botNumber} (${oldBotLabel})?\n(Enter !YES for confirmation)`
          );
          await saveSession(sessionKey, session);
          continue;
        }

        if (cmdName === "editchat") {
          const rawArgs = cmdArgs.join(" ").trim();
          const match = rawArgs.match(/^-id\s+(\d+)\s+-b\s+(\d+)$/i);
          if (!match) {
            await sendBotReply(
              sock,
              from || "",
              "Usage: !editchat -id <id_number> -b <bot_number>\nExample: !editchat -id 4 -b 2",
            );
            continue;
          }

          const chatId = parseInt(match[1], 10);
          const newBotNumber = parseInt(match[2], 10);

          const chatEntry = chatConfig.getChatEntryById(chatId);
          if (!chatEntry) {
            await sendBotReply(
              sock,
              from || "",
              `No chat found in the allowlist with ID ${chatId}.`,
            );
            continue;
          }

          if (chatEntry.botNumber === newBotNumber) {
            await sendBotReply(
              sock,
              from || "",
              `Chat is already using bot ${newBotNumber}.`,
            );
            continue;
          }

          session.pendingEditChat = {
            id: chatId,
            jid: chatEntry.jid,
            botNumber: newBotNumber,
          };

          const oldBotLabel = chatEntry.botNumber === 1 ? "ECB" : chatEntry.botNumber === 2 ? "DKB" : "PARAG";
          const newBotLabel = newBotNumber === 1 ? "ECB" : newBotNumber === 2 ? "DKB" : "PARAG";

          await sendBotReply(
            sock,
            from || "",
            `Are you sure you want to change Chat ID: ${chatId} | JID: ${chatEntry.jid} to use Bot ${newBotNumber} (${newBotLabel}) instead of Bot ${chatEntry.botNumber} (${oldBotLabel})?\n(Enter !YES for confirmation)`
          );
          await saveSession(sessionKey, session);
          continue;
        }

        if (cmdName === "disablegroup") {
          const rawArgs = cmdArgs.join(" ").trim();
          const match = rawArgs.match(/^-id\s+(\d+)$/i);
          if (!match) {
            await sendBotReply(
              sock,
              from || "",
              "Usage: !disablegroup -id <id_number>\nExample: !disablegroup -id 4",
            );
            continue;
          }

          const groupId = parseInt(match[1], 10);
          const groupEntry = groupConfig.getGroupEntryById(groupId);
          if (!groupEntry) {
            await sendBotReply(
              sock,
              from || "",
              `No group found in the allowlist with ID ${groupId}.`,
            );
            continue;
          }

          const ok = await groupConfig.setGroupEnabled(groupId, false);
          if (ok) {
            const { logAction } = await import("../storage/core/auditRepository");
            await logAction(
              senderId || "unknown",
              "disable_group",
              String(groupId),
              groupEntry.jid,
              JSON.stringify({ enabled: false })
            );
            await sendBotReply(
              sock,
              from || "",
              `Disabled Group ID: ${groupId} | JID: ${groupEntry.jid}. The bot will not respond in this group.`
            );
          } else {
            await sendBotReply(
              sock,
              from || "",
              `Failed to disable Group ID: ${groupId}.`
            );
          }
          continue;
        }

        if (cmdName === "disablechat") {
          const rawArgs = cmdArgs.join(" ").trim();
          const match = rawArgs.match(/^-id\s+(\d+)$/i);
          if (!match) {
            await sendBotReply(
              sock,
              from || "",
              "Usage: !disablechat -id <id_number>\nExample: !disablechat -id 4",
            );
            continue;
          }

          const chatId = parseInt(match[1], 10);
          const chatEntry = chatConfig.getChatEntryById(chatId);
          if (!chatEntry) {
            await sendBotReply(
              sock,
              from || "",
              `No chat found in the allowlist with ID ${chatId}.`,
            );
            continue;
          }

          const ok = await chatConfig.setChatEnabled(chatId, false);
          if (ok) {
            const { logAction } = await import("../storage/core/auditRepository");
            await logAction(
              senderId || "unknown",
              "disable_chat",
              String(chatId),
              chatEntry.jid,
              JSON.stringify({ enabled: false })
            );
            await sendBotReply(
              sock,
              from || "",
              `Disabled Chat ID: ${chatId} | JID: ${chatEntry.jid}. The bot will not respond in this chat.`
            );
          } else {
            await sendBotReply(
              sock,
              from || "",
              `Failed to disable Chat ID: ${chatId}.`
            );
          }
          continue;
        }

        if (cmdName === "enablegroup") {
          const rawArgs = cmdArgs.join(" ").trim();
          const match = rawArgs.match(/^-id\s+(\d+)$/i);
          if (!match) {
            await sendBotReply(
              sock,
              from || "",
              "Usage: !enablegroup -id <id_number>\nExample: !enablegroup -id 4",
            );
            continue;
          }

          const groupId = parseInt(match[1], 10);
          const groupEntry = groupConfig.getGroupEntryById(groupId);
          if (!groupEntry) {
            await sendBotReply(
              sock,
              from || "",
              `No group found in the allowlist with ID ${groupId}.`,
            );
            continue;
          }

          const ok = await groupConfig.setGroupEnabled(groupId, true);
          if (ok) {
            const { logAction } = await import("../storage/core/auditRepository");
            await logAction(
              senderId || "unknown",
              "enable_group",
              String(groupId),
              groupEntry.jid,
              JSON.stringify({ enabled: true })
            );
            await sendBotReply(
              sock,
              from || "",
              `Enabled Group ID: ${groupId} | JID: ${groupEntry.jid}. The bot is now active in this group.`
            );
          } else {
            await sendBotReply(
              sock,
              from || "",
              `Failed to enable Group ID: ${groupId}.`
            );
          }
          continue;
        }

                if (cmdName === "enablechat") {
          const rawArgs = cmdArgs.join(" ").trim();
          const match = rawArgs.match(/^-id\s+(\d+)$/i);
          if (!match) {
            await sendBotReply(
              sock,
              from || "",
              "Usage: !enablechat -id <id_number>\nExample: !enablechat -id 4",
            );
            continue;
          }

          const chatId = parseInt(match[1], 10);
          const chatEntry = chatConfig.getChatEntryById(chatId);
          if (!chatEntry) {
            await sendBotReply(
              sock,
              from || "",
              `No chat found in the allowlist with ID ${chatId}.`,
            );
            continue;
          }

          const ok = await chatConfig.setChatEnabled(chatId, true);
          if (ok) {
            const { logAction } = await import("../storage/core/auditRepository");
            await logAction(
              senderId || "unknown",
              "enable_chat",
              String(chatId),
              chatEntry.jid,
              JSON.stringify({ enabled: true })
            );
            await sendBotReply(
              sock,
              from || "",
              `Enabled Chat ID: ${chatId} | JID: ${chatEntry.jid}. The bot is now active in this chat.`
            );
          } else {
            await sendBotReply(
              sock,
              from || "",
              `Failed to enable Chat ID: ${chatId}.`
            );
          }
          continue;
        }

        if (cmdName === "findgroups") {
          try {
            const groups = await sock.groupFetchAllParticipating();
            const list = Object.values(groups);
            if (list.length === 0) {
              await sendBotReply(sock, from || "", "The bot is not currently in any groups.");
            } else {
              // Sort groups by last interaction time (descending)
              const listWithTime = await Promise.all(list.map(async (g) => {
                const lastTimeStr = await redis.get(`last_group_interaction:${g.id}`);
                const lastTime = lastTimeStr ? parseInt(lastTimeStr, 10) : 0;
                return { g, lastTime };
              }));
              listWithTime.sort((a, b) => b.lastTime - a.lastTime);

              // Limit to top 15 groups
              const top15 = listWithTime.slice(0, 15).map(item => item.g);

              const formatted = top15.map((g, idx) => `${idx + 1}. ${g.subject} | JID: ${g.id}`);
              await sendBotReply(
                sock,
                from || "",
                `Groups the bot is in (top 15 sorted by recent interaction):\n${formatted.join("\n")}`
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await sendBotReply(sock, from || "", `Failed to fetch groups:\n${msg}`);
          }
          continue;
        }

        if (cmdName === "changebot") {
          await sendBotReply(
            sock,
            from || "",
            "The !changebot command has been deprecated. Please use !editgroup or !editchat instead.\nExample: !editgroup -id 4 -b 2",
          );
          continue;
        }

        if (cmdName === "neonping") {
          try {
            const { getDatabaseUrl } =
              await import("../storage/neonAuthStateStore");
            const dbUrl = getDatabaseUrl();
            if (!dbUrl) {
              await sendBotReply(
                sock,
                from || "",
                "Neon is NOT configured (DATABASE_URL is missing in environment variables).",
              );
              continue;
            }

            const { Pool } = await import("pg");
            const tempPool = new Pool({
              connectionString: dbUrl,
              connectionTimeoutMillis: 5000,
              ssl: { rejectUnauthorized: false },
            });
            const start = Date.now();
            await tempPool.query("SELECT 1;");
            const duration = Date.now() - start;
            await tempPool.end();

            await sendBotReply(
              sock,
              from || "",
              `✅ Neon database is currently reachable! Timestamp: ${duration}ms.`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await sendBotReply(
              sock,
              from || "",
              `❌ Neon database query failed:\n${msg}`,
            );
          }
          continue;
        }

        if (cmdName === "neonconnect") {
          await sendBotReply(
            sock,
            from || "",
            "⏳ Initiating hard reconnect. The bot will exit and allow the environment manager (e.g. Render) to restart it cleanly with Neon connection...",
          );
          setTimeout(() => {
            process.exit(1);
          }, 2000);
          continue;
        }
      }

      if (cmdName === "manage") {
        if (botNumber !== 2) {
          await sendBotReply(
            sock,
            from || "",
            "Error: This command is only available for Bot 2 (DKB).",
          );
          continue;
        }

        const isManageAdmin = isAdminAction(msg, senderId);
        const isManageAuthorized = isManageAdmin ||
          (senderId && await (async () => {
            const { userHasPermission } = await import("../storage/core/rbacRepository");
            return userHasPermission(senderId, "role.manage");
          })());
        if (!isManageAuthorized) {
          await sendBotReply(
            sock,
            from || "",
            "Unauthorized: you need admin privileges or the role.manage permission to use this command.",
          );
          continue;
        }

        const arg1 = cmdArgs[0];
        const arg2 = cmdArgs[1];

        if (!arg1 || !arg2) {
          await sendBotReply(
            sock,
            from || "",
            "Usage: \n!manage <work> <+phone_number>\n!manage <work> -l\n!manage <+phone_number> -p\nExample: !manage mentor +919902849280\nExample: !manage mentor -l\nExample: !manage +919902849280 -p",
          );
          continue;
        }

        if (arg2 === "-p") {
          let targetJid = "";
          const inputLabel = arg1.trim();

          if (inputLabel.includes("@")) {
            const normalized = normalizeJid(inputLabel);
            if (normalized && (normalized.endsWith("@s.whatsapp.net") || normalized.endsWith("@lid"))) {
              targetJid = normalized;
            }
          }

          if (!targetJid && /^\d{7,20}$/.test(inputLabel)) {
            targetJid = `${inputLabel}@s.whatsapp.net`;
          }

          if (!targetJid) {
            const numberMatch = inputLabel.match(/^\+(\d{7,15})$/);
            if (!numberMatch) {
              await sendBotReply(
                sock,
                from || "",
                "Error: Target must be a JID/LID (e.g. 123@s.whatsapp.net, 456@lid) or a phone number starting with + (e.g. +919902849280).",
              );
              continue;
            }
            const rawPhone = numberMatch[1];
            targetJid = `${rawPhone}@s.whatsapp.net`;
            try {
              const waResult = await sock.onWhatsApp(rawPhone);
              if (waResult && waResult.length > 0 && waResult[0].exists) {
                targetJid = waResult[0].jid;
              } else {
                  await sendBotReply(sock, from || "", `Number +${rawPhone} is not registered on WhatsApp.`);
                  continue;
              }
            } catch(err) {
              console.error("onWhatsApp error:", err);
            }
          }

          let effectiveQueryJid = targetJid;
          if (targetJid.endsWith("@lid")) {
            try {
              const { resolvePhoneJidFromLid } = await import("../storage/core/rbacRepository");
              const resolved = await resolvePhoneJidFromLid(targetJid);
              if (resolved) effectiveQueryJid = resolved;
            } catch (_) {}
          }

          try {
            const { getUserRoles } = await import("../storage/core/rbacRepository");
            let roles = await getUserRoles(effectiveQueryJid);
            if (roles.length === 0 && effectiveQueryJid !== targetJid) {
              roles = await getUserRoles(targetJid);
            }

            if (roles.length === 0) {
              await sock.sendMessage(targetJid, {
                text: "You currently have no special roles assigned.",
              });
            } else if (roles.length === 1) {
              await sock.sendMessage(targetJid, {
                text: `You have received the role of ${roles[0]}`,
              });
            } else {
              const formattedRoles =
                roles.slice(0, -1).join(", ") + " & " + roles[roles.length - 1];
              await sock.sendMessage(targetJid, {
                text: `You have received the role of ${roles[roles.length - 1]}! You now have ${formattedRoles}`,
              });
            }
            await sendBotReply(
              sock,
              from || "",
              `Successfully sent role notification check to ${arg1}.`,
            );
          } catch (e) {
            await sendBotReply(
              sock,
              from || "",
              `Failed to send role notification to ${arg1}.`,
            );
          }
          continue;
        }

        const normalizedWork = arg1.trim().toLowerCase();

        if (arg2 === "-l") {
          const { getUsersWithRole } = await import("../storage/core/rbacRepository");
          const users = await getUsersWithRole(normalizedWork);
          if (users.length === 0) {
            await sendBotReply(
              sock,
              from || "",
              `No users found with role "${normalizedWork}".`,
            );
          } else {
            const formattedUsers = users
              .map((j) => {
                if (j.endsWith("@lid")) {
                  return `${j.split("@")[0]} (LID)`;
                }
                return `+${j.split("@")[0]}`;
              })
              .join("\n");
            await sendBotReply(
              sock,
              from || "",
              `Users with role "${normalizedWork}":\n${formattedUsers}`,
            );
          }
          continue;
        }

        let targetJid = "";
        const inputLabel = arg2.trim();

        if (inputLabel.includes("@")) {
          const normalized = normalizeJid(inputLabel);
          if (normalized && (normalized.endsWith("@s.whatsapp.net") || normalized.endsWith("@lid"))) {
            targetJid = normalized;
          }
        }

        if (!targetJid && /^\d{7,20}$/.test(inputLabel)) {
          targetJid = `${inputLabel}@s.whatsapp.net`;
        }

        if (!targetJid) {
          const numberMatch = inputLabel.match(/^\+(\d{7,15})$/);
          if (!numberMatch) {
            await sendBotReply(
              sock,
              from || "",
              "Error: Target must be a JID/LID (e.g. 123@s.whatsapp.net, 456@lid) or a phone number starting with + (e.g. +919902849280).",
            );
            continue;
          }
          const rawPhone = numberMatch[1];
          targetJid = `${rawPhone}@s.whatsapp.net`;

          try {
            const waResult = await sock.onWhatsApp(rawPhone);
            if (waResult && waResult.length > 0 && waResult[0].exists) {
              targetJid = waResult[0].jid;
            } else {
               await sendBotReply(sock, from || "", `Warning: Number +${rawPhone} does not appear to be registered on WhatsApp. Cannot assign role.`);
               continue;
            }
          } catch(err) {
              console.error("onWhatsApp error:", err);
          }
        }

        const { addManagedRole } = await import("../storage/core/rbacRepository");
        const { storeLidPhoneMapping } = await import("../storage/core/rbacRepository");
        let resolvedPhoneJid: string | null = null;
        let resolvedLid: string | null = null;

        if (targetJid.endsWith("@lid")) {
          resolvedLid = targetJid;
          try {
            const { resolvePhoneJidFromLid } = await import("../storage/core/rbacRepository");
            resolvedPhoneJid = await resolvePhoneJidFromLid(resolvedLid);
          } catch (_) {}

          if (!resolvedPhoneJid && from && from.endsWith("@g.us")) {
            try {
              const meta = await sock.groupMetadata(from);
              const match = meta.participants.find((p: any) => {
                const pid = p.id ? (normalizeJid(p.id) ?? "").toLowerCase() : "";
                const plid = p.lid ? (normalizeJid(p.lid) ?? "").toLowerCase() : "";
                const targetLower = resolvedLid!.toLowerCase();
                return pid === targetLower || plid === targetLower;
              });
              if (match) {
                const pid = match.id ? normalizeJid(match.id) : null;
                const ppn = match.phoneNumber ? normalizeJid(match.phoneNumber) : null;
                if (pid && pid.endsWith("@s.whatsapp.net")) {
                  resolvedPhoneJid = pid;
                } else if (ppn && ppn.endsWith("@s.whatsapp.net")) {
                  resolvedPhoneJid = ppn;
                }
              }
            } catch (_) {}
          }
        } else if (targetJid.endsWith("@s.whatsapp.net")) {
          resolvedPhoneJid = targetJid;
          if (from && from.endsWith("@g.us")) {
            try {
              const meta = await sock.groupMetadata(from);
              const match = meta.participants.find((p: any) => {
                const pid = p.id ? (normalizeJid(p.id) ?? "").toLowerCase() : "";
                const ppn = p.phoneNumber ? (normalizeJid(p.phoneNumber) ?? "").toLowerCase() : "";
                const targetLower = resolvedPhoneJid!.toLowerCase();
                return pid === targetLower || ppn === targetLower;
              });
              if (match) {
                const pid = match.id ? normalizeJid(match.id) : null;
                const plid = match.lid ? normalizeJid(match.lid) : null;
                if (pid && pid.endsWith("@lid")) {
                  resolvedLid = pid;
                } else if (plid && plid.endsWith("@lid")) {
                  resolvedLid = plid;
                }
              }
            } catch (_) {}
          }
        }

        if (resolvedLid && resolvedPhoneJid) {
          await storeLidPhoneMapping(resolvedLid, resolvedPhoneJid);
          logStructured({
            event: "lid_mapped_on_manage",
            role: normalizedWork,
            phoneHash: getJidHash(resolvedPhoneJid),
            lidHash: getJidHash(resolvedLid),
          });
        }

        const roleJid = resolvedPhoneJid || targetJid;
        const ok = await addManagedRole(roleJid, normalizedWork);

        if (ok) {
          await sendBotReply(
            sock,
            from || "",
            `Successfully assigned role "${normalizedWork}" to ${arg2}.`,
          );
        } else {
          await sendBotReply(
            sock,
            from || "",
            "Failed to assign role. Ensure the database connection is healthy and the role is valid.",
          );
        }
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
        if (userPrompt && GROQ_API_KEY) {
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


