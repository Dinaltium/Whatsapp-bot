import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  proto,
} from "@whiskeysockets/baileys";
import http from "http";
import qrcode from "qrcode-terminal";
import pino from "pino";
import "dotenv/config";
import WhatsAppAgent from "./agents/WhatsAppAgent";
import DKBAgent from "./agents/DKBAgent";
import groupConfig from "./config/groupAllowlist";
import chatConfig from "./config/chatAllowlist";
import { useNeonAuthState, getDatabaseUrl } from "./storage/neonAuthStateStore";
import { getJidHash, logStructured, logEvent } from "./utils/logger";
import { normalizeJid, getSenderId, isAdminSender, isAdminAction } from "./security/rbac";
import {
  checkAiRateLimit,
  checkGroupAndGlobalLimits,
  shouldSendRateLimitNotice,
  formatRetryAfter,
  incrementGlobalDailyAiCount,
  clearRateLimitNotice,
} from "./security/rateLimiter";

const COMMAND_PREFIX = "!";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const ALLOW_FROM_ME_MESSAGES =
  (process.env.ALLOW_FROM_ME_MESSAGES || "false").toLowerCase() === "true";
const AI_SESSION_TTL_MS = 15 * 60 * 1000;
const AI_MAX_SESSION_MESSAGES = 8;



interface UserSession {
  domainUnlocked: boolean;
  lastActiveAt: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  lastQuery?: { type: "mentors"; filter?: string; page: number };
  pendingMentor?: {
    name: string;
    organization: string;
    description?: string;
    expertise?: string;
    linkedin?: string;
    instagram?: string;
    github?: string;
    email?: string;
    phoneNoCountryCode: string;
  };
  pendingEdit?: {
    mentorId: number;
    flag: string;
    phoneNoCountryCode: string;
  };
}

const userAiSessions = new Map<string, UserSession>();
const lastSentMessages = new Map<string, string>();
const lastUserMessages = new Map<string, string>();

// Tracks members being watched for their intro message after a
// "welcome / introduce" trigger in a bot-2 group.
// Key: normalized sender JID.  Value: { group JID, timestamp }
const pendingIntros = new Map<
  string,
  { groupJid: string; triggeredAt: number }
>();
const INTRO_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
setInterval(
  () => {
    const now = Date.now();
    for (const [jid, info] of pendingIntros) {
      if (now - info.triggeredAt > INTRO_TTL_MS) pendingIntros.delete(jid);
    }
  },
  30 * 60 * 1000,
);

let isHealthServerStarted = false;

function startHealthServer(): void {
  if (isHealthServerStarted) {
    return;
  }

  isHealthServerStarted = true;
  const port = Number(process.env.PORT || 3000);

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "parag-whatsapp-bot" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("PARAG bot is running");
  });

  server.listen(port, () => {
    console.log(`Health server listening on port ${port}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err && err.code === "EADDRINUSE") {
      console.warn(
        `Health server port ${port} already in use. Continuing without health endpoint.`,
      );
      return;
    }
    console.error("Health server error:", err);
    throw err;
  });
}

function printBanner(): void {
  console.log("\nWhatsApp Bot Coordinator Online.");
}

async function sendBotReply(
  sock: ReturnType<typeof makeWASocket>,
  to: string,
  text: string,
): Promise<void> {
  try {
    // Notify composing/typing presence
    await sock.sendPresenceUpdate("composing", to);
  } catch (err) {
    console.error("Failed to send presence update:", err);
  }

  // Calculate delay based on length of response or a solid randomized human delay
  // Min 1200ms, Max 4500ms
  const delay = Math.floor(Math.random() * (4500 - 1200 + 1)) + 1200;
  await new Promise((resolve) => setTimeout(resolve, delay));

  try {
    // Notify paused presence before sending message
    await sock.sendPresenceUpdate("paused", to);
  } catch (err) {}

  const trimmedText = String(text || "").trim();
  lastSentMessages.set(to, trimmedText);

  await sock.sendMessage(to, {
    text: trimmedText,
  });
}

function extractMessageText(
  message: proto.IWebMessageInfo["message"],
): string | null {
  if (!message) return null;

  const unwrappedMessage =
    (message.ephemeralMessage?.message as any) ||
    (message.viewOnceMessage?.message as any) ||
    (message.viewOnceMessageV2?.message as any) ||
    message;

  return (
    (unwrappedMessage as any).conversation ||
    (unwrappedMessage as any).extendedTextMessage?.text ||
    (unwrappedMessage as any).imageMessage?.caption ||
    (unwrappedMessage as any).videoMessage?.caption ||
    null
  );
}

function shouldSkipMessage(
  msg: proto.IWebMessageInfo,
  from: string | null | undefined,
  text: string | null,
): boolean {
  const msgId = msg.key?.id || "unknown";

  if (!msg?.message) {
    return true;
  }

  // Anti-echo & duplicate bot response suppression
  if (from) {
    const lastSent = lastSentMessages.get(from);
    if (lastSent && lastSent === String(text || "").trim()) {
      logStructured({
        event: "command_skipped",
        reason: "echo_detected",
        userHash: getJidHash(from),
      });
      return true;
    }
  }

  const normalizedText = String(text || "")
    .trim()
    .toLowerCase();
  const commandName = normalizedText.startsWith(COMMAND_PREFIX)
    ? normalizedText.slice(COMMAND_PREFIX.length).split(/\s+/)[0]
    : "";

  const isCommand = normalizedText.startsWith(COMMAND_PREFIX);
  const isAdmin = isAdminSender(msg);

  // Public utility commands that can be run in any group or DM (even unapproved ones)
  const publicExemptCommands = ["getjid", "whoami"];

  const adminOnlyCommands = [
    "addgroup",
    "rmgroup",
    "listgroups",
    "addchat",
    "rmchat",
    "listchats",
    "changebot",
    "neonping",
    "neonconnect",
    "manage",
  ];



  if (adminOnlyCommands.includes(commandName)) {
    if (!isAdmin) {
      logStructured({
        event: "command_skipped",
        reason: "admin_required",
        command: commandName,
        userHash: getJidHash(from),
      });
      return true;
    }
  }

  if (msg.key?.fromMe && !ALLOW_FROM_ME_MESSAGES) {
    if (isCommand) {
      logStructured({
        event: "command_skipped",
        reason: "from_self",
        command: commandName,
        userHash: getJidHash(from),
      });
    }
    return true;
  }

  if (!from) {
    if (isCommand) {
      logStructured({
        event: "command_skipped",
        reason: "missing_jid",
        command: commandName,
      });
    }
    return true;
  }

  if (from === "status@broadcast") {
    return true;
  }

  // Only verify allowlists if the command is not publicExempt and not an adminOnlyCommand
  if (
    !publicExemptCommands.includes(commandName) &&
    !adminOnlyCommands.includes(commandName)
  ) {
    if (from.endsWith("@g.us")) {
      if (!groupConfig.isGroupAllowed(from)) {
        if (isCommand) {
          logStructured({
            event: "command_skipped",
            reason: "group_not_allowed",
            command: commandName,
            userHash: getJidHash(from),
          });
        }
        return true;
      }
    } else {
      if (!chatConfig.isChatAllowed(from)) {
        if (isCommand) {
          logStructured({
            event: "command_skipped",
            reason: "chat_not_allowed",
            command: commandName,
            userHash: getJidHash(from),
          });
        }
        return true;
      }
    }
  }

  if (msg.message?.protocolMessage) {
    return true;
  }

  if (!text) {
    return true;
  }

  if (!text.startsWith(COMMAND_PREFIX)) {
    return true;
  }

  return false;
}

/** Extracts @mentioned JIDs from a WhatsApp extended text message. */
function extractMentionedJids(msg: proto.IWebMessageInfo): string[] {
  const jids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!jids || !Array.isArray(jids)) return [];
  return jids.filter((j): j is string => typeof j === "string");
}

function buildSessionKey(from: string, senderId: string): string {
  return `${from}:${senderId}`;
}

function getOrCreateSession(from: string, senderId: string): UserSession {
  const sessionKey = buildSessionKey(from, senderId);

  if (!userAiSessions.has(sessionKey)) {
    userAiSessions.set(sessionKey, {
      domainUnlocked: false,
      lastActiveAt: 0,
      messages: [],
    });
  }

  return userAiSessions.get(sessionKey)!;
}

function resetSessionIfExpired(session: UserSession): void {
  if (!session.lastActiveAt) return;

  const isExpired = Date.now() - session.lastActiveAt > AI_SESSION_TTL_MS;

  if (isExpired) {
    session.domainUnlocked = false;
    session.messages = [];
    session.lastActiveAt = 0;
  }
}

function addSessionMessage(
  session: UserSession,
  role: "user" | "assistant",
  content: string,
): void {
  session.messages.push({
    role,
    content,
  });

  if (session.messages.length > AI_MAX_SESSION_MESSAGES) {
    session.messages = session.messages.slice(-AI_MAX_SESSION_MESSAGES);
  }
}

async function startBot(): Promise<void> {
  printBanner();
  startHealthServer();

  const databaseUrl = getDatabaseUrl();
  let authStore:
    | Awaited<ReturnType<typeof useNeonAuthState>>
    | Awaited<ReturnType<typeof useMultiFileAuthState>>;

  if (databaseUrl) {
    try {
      authStore = await useNeonAuthState("parag");
      console.log("Using Neon PostgreSQL for auth state storage.");

      // Bootstrap PostgreSQL schemas
      const { ensureSchema } = await import("./storage/dk24Store");
      await ensureSchema();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`FATAL: Neon auth storage unavailable (${message}).`);
      console.error("Since local fallback is disabled, exiting the process.");
      process.exit(1);
    }
  } else {
    console.error("FATAL: DATABASE_URL not found, cannot connect to Neon.");
    process.exit(1);
  }

  // Load allowlists from Database (with env/file fallback) on startup
  console.log("Initializing group and chat allowlists...");
  await groupConfig.init();
  await chatConfig.init();
  console.log("Allowlists initialized.");

  const { state, saveCreds } = authStore;

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({
      level: "silent",
    }),
    browser: ["Ubuntu", "Chrome", "22.04.4"],
  });

  sock.ev.on("creds.update", async () => {
    try {
      await saveCreds();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to persist auth credentials: ${message}`);
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    logStructured({
      event: "connection_transition",
      connection: connection || "N/A",
      qrCodePresent: !!qr,
    });

    if (qr) {
      qrcode.generate(qr, {
        small: true,
      });
      logStructured({ event: "qr_generated" });
    }

    if (connection === "open") {
      logStructured({ event: "connection_open", service: "PARAG" });
    }

    if (connection === "close") {
      const err = lastDisconnect?.error as any;
      const statusCode = err?.output?.statusCode || err?.statusCode;

      logStructured({
        event: "connection_closed",
        statusCode,
      });

      if (statusCode === 515) {
        logStructured({ event: "reconnecting", reason: "restart_required" });

        setTimeout(() => {
          startBot();
        }, 3000);
      } else if (statusCode === DisconnectReason.loggedOut) {
        logStructured({ event: "connection_logout" });
      } else if (statusCode === DisconnectReason.connectionReplaced) {
        logStructured({ event: "connection_replaced", error: "another_instance" });
        process.exit(0);
      } else {
        logStructured({ event: "reconnecting", reason: "generic_close" });

        setTimeout(() => {
          startBot();
        }, 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
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

      if (from && text) {
        const senderId = getSenderId(msg);
        lastUserMessages.set(`${from}:${senderId}`, text);
      }

      // ── INTRO DETECTION ──────────────────────────────────────────────────
      // Runs on ALL non-command messages in bot-2 groups.
      // Phase 1 – Trigger: someone says "welcome/introduce" + @mentions a JID
      //           → add that JID to pendingIntros.
      // Phase 2 – Capture: sender is in pendingIntros
      //           → classify via AI, auto-add if mentor, give chatConfig access.
      if (
        text &&
        from?.endsWith("@g.us") &&
        !text.startsWith(COMMAND_PREFIX) &&
        msg.message
      ) {
        const introGroupBot = groupConfig.getGroupBot(from);
        if (introGroupBot?.botNumber === 2) {
          const introSenderId = normalizeJid(getSenderId(msg)) || "";
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
                pendingIntros.set(normalized, {
                  groupJid: from,
                  triggeredAt: Date.now(),
                });
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
                  pendingIntros.set(derivedJid, {
                    groupJid: from,
                    triggeredAt: Date.now(),
                  });
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
          if (pendingIntros.has(introSenderId)) {
            trackedGroupJid = pendingIntros.get(introSenderId)!.groupJid;
            pendingIntros.delete(introSenderId);
          } else {
            // Fuzzy: compare last 10 digits to handle country-code mismatches
            const senderSuffix = introSenderId.replace(/\D/g, "").slice(-10);
            for (const [trackedJid, info] of pendingIntros) {
              const trackedSuffix = trackedJid.replace(/\D/g, "").slice(-10);
              if (senderSuffix && senderSuffix === trackedSuffix) {
                trackedGroupJid = info.groupJid;
                pendingIntros.delete(trackedJid);
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

      if (shouldSkipMessage(msg, from, text)) {
        continue;
      }

      const command = text!.toLowerCase();
      const senderId = getSenderId(msg);
      const session = getOrCreateSession(from || "", senderId);

      resetSessionIfExpired(session);

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
            "• !editmentor <id> -<flag> <value> - Update a single field on a mentor (Authorized only)",
            "• !delmentor <id_or_name> - Remove a mentor (Authorized only)",
            "• !<question> - Chat directly with DKB (e.g. !What is a good way to host an AI meetup?)",
          ].join("\n");
        } else if (botNumber === 3) {
          helpText = [
            "TEMP - Sarcastic & Banter Shenanigans Assistant",
            "Available Commands (Authorized Admins Only):",
            "• !ping - Check status",
            "• !hello - Check availability",
            "• !reset - Reset your conversation context",
            "• !<kannada/tulu text or translate request> - Translates and does brutal, funny banter explanations",
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
      const cmdName = (parts[0] || "").toLowerCase();
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
        const senderId = getSenderId(msg);
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
          "neonping",
          "neonconnect",
        ].includes(cmdName)
      ) {
        if (!isAdminAction(msg)) {
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
            const formatted = list.map((entry) => {
              const botLabel =
                entry.botNumber === 1
                  ? "ECB"
                  : entry.botNumber === 2
                    ? "DKB"
                    : "PARAG";
              return `${entry.jid} (Bot ${entry.botNumber} - ${botLabel})`;
            });
            await sendBotReply(
              sock,
              from || "",
              `Allowed groups:\n${formatted.join("\n")}`,
            );
          }
          continue;
        }

        if (cmdName === "addgroup" || cmdName === "rmgroup") {
          let target = cmdArgs[0];
          const botNumber = cmdArgs[1] ? parseInt(cmdArgs[1], 10) : 0;

          if (!target) {
            await sendBotReply(
              sock,
              from || "",
              `Usage: !${cmdName} <group-jid> [bot-number]\nBot 0: PARAG | Bot 1: ECB | Bot 2: DKB`,
            );
            continue;
          }

          target = normalizeJid(target) as string;

          if (cmdName === "addgroup") {
            const ok = await groupConfig.addGroup(
              target,
              isNaN(botNumber) ? 0 : botNumber,
            );
            if (ok) {
              await sendBotReply(
                sock,
                from || "",
                `Added ${target} to group allowlist (Bot ${isNaN(botNumber) ? 0 : botNumber}).`,
              );
            } else {
              await sendBotReply(
                sock,
                from || "",
                `Failed to add ${target}. Ensure it's a valid group JID and writable file is configured.`,
              );
            }
            continue;
          }

          if (cmdName === "rmgroup") {
            const ok = await groupConfig.removeGroup(target);
            if (ok) {
              await sendBotReply(
                sock,
                from || "",
                `Removed ${target} from group allowlist.`,
              );
            } else {
              await sendBotReply(
                sock,
                from || "",
                `Failed to remove ${target}. It may not be present.`,
              );
            }
            continue;
          }
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
              return `${entry.jid} (Bot ${entry.botNumber} - ${botLabel})`;
            });
            await sendBotReply(
              sock,
              from || "",
              `Allowed chats:\n${formatted.join("\n")}`,
            );
          }
          continue;
        }

        if (cmdName === "addchat" || cmdName === "rmchat") {
          let target = cmdArgs[0];
          const botNumber = cmdArgs[1] ? parseInt(cmdArgs[1], 10) : 0;

          if (!target) {
            await sendBotReply(
              sock,
              from || "",
              `Usage: !${cmdName} <chat-jid> [bot-number]\nBot 0: PARAG | Bot 1: ECB | Bot 2: DKB`,
            );
            continue;
          }

          target = normalizeJid(target) as string;

          if (cmdName === "addchat") {
            const ok = await chatConfig.addChat(
              target,
              isNaN(botNumber) ? 0 : botNumber,
            );
            if (ok) {
              await sendBotReply(
                sock,
                from || "",
                `Added ${target} to chat allowlist (Bot ${isNaN(botNumber) ? 0 : botNumber}).`,
              );
            } else {
              await sendBotReply(
                sock,
                from || "",
                `Failed to add ${target}. Ensure it's a valid JID and writable file is configured.`,
              );
            }
            continue;
          }

          if (cmdName === "rmchat") {
            const ok = await chatConfig.removeChat(target);
            if (ok) {
              await sendBotReply(
                sock,
                from || "",
                `Removed ${target} from chat allowlist.`,
              );
            } else {
              await sendBotReply(
                sock,
                from || "",
                `Failed to remove ${target}. It may not be present.`,
              );
            }
            continue;
          }
        }

        if (cmdName === "changebot") {
          let target = cmdArgs[0];
          const botNumber = cmdArgs[1] ? parseInt(cmdArgs[1], 10) : NaN;

          if (!target || isNaN(botNumber)) {
            await sendBotReply(
              sock,
              from || "",
              `Usage: !changebot <jid> <bot-number>\nBot 0: PARAG | Bot 1: ECB | Bot 2: DKB | Bot 3: TEMP`,
            );
            continue;
          }

          target = normalizeJid(target) as string;

          if (target.endsWith("@g.us")) {
            const hasExisting = groupConfig.isGroupAllowed(target);
            if (hasExisting) {
              const ok = await groupConfig.addGroup(target, botNumber);
              if (ok) {
                await sendBotReply(
                  sock,
                  from || "",
                  `Changed ${target} to use Bot ${botNumber} (Group).`,
                );
              } else {
                await sendBotReply(
                  sock,
                  from || "",
                  `Failed to change bot for ${target}.`,
                );
              }
            } else {
              await sendBotReply(
                sock,
                from || "",
                `${target} is not in the group allowlist. Use !addgroup first.`,
              );
            }
          } else {
            const hasExisting = chatConfig.isChatAllowed(target);
            if (hasExisting) {
              const ok = await chatConfig.addChat(target, botNumber);
              if (ok) {
                await sendBotReply(
                  sock,
                  from || "",
                  `Changed ${target} to use Bot ${botNumber} (Chat).`,
                );
              } else {
                await sendBotReply(
                  sock,
                  from || "",
                  `Failed to change bot for ${target}.`,
                );
              }
            } else {
              await sendBotReply(
                sock,
                from || "",
                `${target} is not in the chat allowlist. Use !addchat first.`,
              );
            }
          }
          continue;
        }

        if (cmdName === "neonping") {
          try {
            const { getDatabaseUrl } =
              await import("./storage/neonAuthStateStore");
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

        if (!isAdminAction(msg)) {
          await sendBotReply(
            sock,
            from || "",
            "Unauthorized: admin privileges required for that command.",
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
          const numberMatch = arg1.trim().match(/^\+(\d{7,15})$/);
          if (!numberMatch) {
            await sendBotReply(
              sock,
              from || "",
              "Error: Phone number must start with + followed by country code and number, and contain no spaces.\nFormat: +{country_code}{number}\nExample: !manage +919902849280 -p",
            );
            continue;
          }
          const rawPhone = numberMatch[1];
          let targetJid = `${rawPhone}@s.whatsapp.net`;
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

          try {
            const { getUserRoles } = await import("./storage/dk24Store");
            const roles = await getUserRoles(targetJid);
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
              `Successfully sent ping to ${arg1}.`,
            );
          } catch (e) {
            await sendBotReply(
              sock,
              from || "",
              `Failed to send ping to ${arg1}.`,
            );
          }
          continue;
        }

        const normalizedWork = arg1.trim().toLowerCase();

        if (arg2 === "-l") {
          const { getUsersWithRole } = await import("./storage/dk24Store");
          const users = await getUsersWithRole(normalizedWork);
          if (users.length === 0) {
            await sendBotReply(
              sock,
              from || "",
              `No users found with role "${normalizedWork}".`,
            );
          } else {
            const formattedUsers = users
              .map((j) => `+${j.split("@")[0]}`)
              .join("\n");
            await sendBotReply(
              sock,
              from || "",
              `Users with role "${normalizedWork}":\n${formattedUsers}`,
            );
          }
          continue;
        }

        const numberMatch = arg2.trim().match(/^\+(\d{7,15})$/);

        if (!numberMatch) {
          await sendBotReply(
            sock,
            from || "",
            "Error: Phone number must start with + followed by country code and number, and contain no spaces.\nFormat: +{country_code}{number}\nExample: +919902849280",
          );
          continue;
        }

        const rawPhone = numberMatch[1];
        let targetJid = `${rawPhone}@s.whatsapp.net`;
        
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

        const { addManagedRole } = await import("./storage/dk24Store");
        const ok = await addManagedRole(targetJid, normalizedWork);

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
            "Failed to assign role. Ensure the database connection is healthy.",
          );
        }
        continue;
      }

      // Check Group & Global limits and burst protection
      if (from) {
        const groupLimit = checkGroupAndGlobalLimits(from);
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

      const rateLimitCheck = checkAiRateLimit(from || "", senderId);

      if (!rateLimitCheck.allowed) {
        if (shouldSendRateLimitNotice(from || "", senderId, rateLimitCheck)) {
          await sendBotReply(
            sock,
            from || "",
            `Rate limit active. Please retry in ${formatRetryAfter(rateLimitCheck.retryAfterMs!)}.`,
          );
        }

        continue;
      }

      clearRateLimitNotice(from || "", senderId);

      try {
        let finalPrompt = userPrompt;
        if (botNumber === 3) {
          const mentionedJids = extractMentionedJids(msg);
          if (mentionedJids.length > 0) {
            const targetJid = mentionedJids[0];
            const lastMsg = lastUserMessages.get(`${from}:${targetJid}`);
            if (lastMsg) {
              finalPrompt = `[CONTEXT: The last message sent by @${targetJid.split("@")[0]} in this group was: "${lastMsg}"]. ${userPrompt}`;
            } else {
              finalPrompt = `[CONTEXT: No recent message was captured in the cache for @${targetJid.split("@")[0]}]. ${userPrompt}`;
            }
          }
        }

        addSessionMessage(session, "user", finalPrompt);

        const agentResult = await WhatsAppAgent.handleAgentMessage(
          session,
          finalPrompt,
          GROQ_API_KEY,
          GROQ_MODEL,
          botNumber,
          isAdminSender(msg),
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
          continue;
        }

        session.domainUnlocked = true;
        addSessionMessage(session, "assistant", agentResult.reply);
        session.lastActiveAt = Date.now();
        incrementGlobalDailyAiCount();

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
  });

  // Handle graceful shutdown for hosting environments like Render
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");

  process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down gracefully...");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log("Received SIGINT, shutting down gracefully...");
    process.exit(0);
  });
}

startBot();
