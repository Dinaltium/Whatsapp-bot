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

const COMMAND_PREFIX = "!";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const ALLOW_FROM_ME_MESSAGES =
  (process.env.ALLOW_FROM_ME_MESSAGES || "true").toLowerCase() === "true";
const AI_WINDOW_MS = 60 * 1000;
const AI_MAX_REQUESTS_PER_WINDOW = 5;
const AI_COOLDOWN_MS = 8 * 1000;
const AI_SESSION_TTL_MS = 15 * 60 * 1000;
const AI_MAX_SESSION_MESSAGES = 8;

interface RateLimitState {
  windowStart: number;
  requestCount: number;
  lastRequestAt: number;
}

interface RateLimitCheck {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

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

interface RateLimitNotice {
  reason: string;
  notifiedAt: number;
}

const userAiRateLimits = new Map<string, RateLimitState>();
const userAiRateLimitNotices = new Map<string, RateLimitNotice>();
const userAiSessions = new Map<string, UserSession>();

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
  await sock.sendMessage(to, {
    text: String(text || "").trim(),
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

  if (isCommand) {
    console.log(
      `[DEBUG] Potential command detected: "${text}" from JID: "${from}" (IsAdmin: ${isAdmin}, MsgId: ${msgId})`,
    );
  }

  if (adminOnlyCommands.includes(commandName)) {
    if (!isAdmin) {
      console.log(
        `[DEBUG] Skipped command '${commandName}': Administrative permission required (sender is not admin).`,
      );
      return true;
    }
  }

  if (msg.key?.fromMe && !ALLOW_FROM_ME_MESSAGES) {
    if (isCommand) {
      console.log(
        `[DEBUG] Skipped command '${commandName}': Message is from self (fromMe = true) and ALLOW_FROM_ME_MESSAGES is disabled.`,
      );
    }
    return true;
  }

  if (!from) {
    if (isCommand) {
      console.log(
        `[DEBUG] Skipped command '${commandName}': Remote JID (from) is missing.`,
      );
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
          console.log(
            `[DEBUG] Skipped command '${commandName}': Group JID "${from}" is not in groupConfig allowlist.`,
          );
        }
        return true;
      }
    } else {
      if (!chatConfig.isChatAllowed(from)) {
        if (isCommand) {
          console.log(
            `[DEBUG] Skipped command '${commandName}': Chat JID "${from}" is not in chatConfig allowlist.`,
          );
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

  console.log(
    `[DEBUG] Command matches rules and is approved for processing: "${text}"`,
  );
  return false;
}

function getSenderId(msg: proto.IWebMessageInfo): string {
  return msg.key?.participant || msg.key?.remoteJid || "unknown";
}

function normalizeJid(
  jid: string | null | undefined,
): string | null | undefined {
  if (!jid || typeof jid !== "string") return jid;

  if (jid.endsWith("@lid")) {
    return jid.replace(/@lid$/, "@s.whatsapp.net");
  }

  return jid;
}

function isAdminSender(msg: proto.IWebMessageInfo): boolean {
  if (!msg) return false;
  if (msg.key?.fromMe) return true;
  const adminEnv = process.env.ADMIN_JIDS || "";
  const admins = adminEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const senderId = normalizeJid(getSenderId(msg));
  return admins.includes(senderId as string);
}

/** Extracts @mentioned JIDs from a WhatsApp extended text message. */
function extractMentionedJids(msg: proto.IWebMessageInfo): string[] {
  const jids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!jids || !Array.isArray(jids)) return [];
  return jids.filter((j): j is string => typeof j === "string");
}

function buildRateLimitKey(from: string, senderId: string): string {
  return `${from}:${senderId}`;
}

function getRateLimitState(key: string): RateLimitState {
  if (!userAiRateLimits.has(key)) {
    userAiRateLimits.set(key, {
      windowStart: Date.now(),
      requestCount: 0,
      lastRequestAt: 0,
    });
  }

  return userAiRateLimits.get(key)!;
}

function checkAiRateLimit(from: string, senderId: string): RateLimitCheck {
  const now = Date.now();
  const key = buildRateLimitKey(from, senderId);
  const state = getRateLimitState(key);

  if (now - state.windowStart >= AI_WINDOW_MS) {
    state.windowStart = now;
    state.requestCount = 0;
  }

  const cooldownRemaining = AI_COOLDOWN_MS - (now - state.lastRequestAt);

  if (cooldownRemaining > 0) {
    return {
      allowed: false,
      reason: "cooldown",
      retryAfterMs: cooldownRemaining,
    };
  }

  if (state.requestCount >= AI_MAX_REQUESTS_PER_WINDOW) {
    return {
      allowed: false,
      reason: "window-limit",
      retryAfterMs: AI_WINDOW_MS - (now - state.windowStart),
    };
  }

  state.requestCount += 1;
  state.lastRequestAt = now;

  return {
    allowed: true,
  };
}

function clearRateLimitNotice(from: string, senderId: string): void {
  const key = buildRateLimitKey(from, senderId);
  userAiRateLimitNotices.delete(key);
}

function shouldSendRateLimitNotice(
  from: string,
  senderId: string,
  rateLimitCheck: RateLimitCheck,
): boolean {
  if (rateLimitCheck?.allowed) {
    clearRateLimitNotice(from, senderId);
    return false;
  }

  const key = buildRateLimitKey(from, senderId);
  const existing = userAiRateLimitNotices.get(key);
  const reason = rateLimitCheck?.reason || "unknown";

  if (existing?.reason === reason) {
    return false;
  }

  userAiRateLimitNotices.set(key, {
    reason,
    notifiedAt: Date.now(),
  });

  return true;
}

function formatRetryAfter(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return `${seconds}s`;
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
    console.log(
      `[DEBUG] Connection state transition: connection = "${connection || "N/A"}", qrCodePresent = ${!!qr}`,
    );

    if (qr) {
      qrcode.generate(qr, {
        small: true,
      });

      console.log("Scan QR");
    }

    if (connection === "open") {
      console.log("PARAG connected.");
    }

    if (connection === "close") {
      const err = lastDisconnect?.error as any;
      const statusCode = err?.output?.statusCode || err?.statusCode;

      console.log("Connection closed");
      console.log("Reason:", statusCode);

      if (statusCode === 515) {
        console.log("Restart required. Reconnecting...");

        setTimeout(() => {
          startBot();
        }, 3000);
      } else if (statusCode === DisconnectReason.loggedOut) {
        console.log("Logged out.");
      } else if (statusCode === DisconnectReason.connectionReplaced) {
        console.log(
          "Connection replaced (440). Another instance connected! Exiting to prevent conflict...",
        );
        process.exit(0);
      } else {
        console.log("Reconnecting...");

        setTimeout(() => {
          startBot();
        }, 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    console.log(
      `[DEBUG] Received messages.upsert event (type: "${type}", messageCount: ${messages.length})`,
    );
    for (const msg of messages) {
      const from = msg.key?.remoteJid;
      const textRaw = extractMessageText(msg.message);
      const text = textRaw ? textRaw.trim() : null;

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
                console.log(
                  `[DEBUG] Intro tracker: watching ${normalized} in ${from}`,
                );
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
                  console.log(
                    `[DEBUG] Intro tracker: watching phone-derived ${derivedJid} in ${from}`,
                  );
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
            console.log(
              `[DEBUG] Intro captured from ${introSenderId}, running classification...`,
            );
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
                console.log(
                  `[DEBUG] Intro classified as MENTOR: ${
                    result.mentorName || introSenderId
                  } — adding to directory and allowchats`,
                );
                await chatConfig.addChat(introSenderId, 2);
              } else {
                console.log(
                  `[DEBUG] Intro classified as STUDENT: ${introSenderId} — ignoring`,
                );
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

      console.log(`[DEBUG] Processing command: "${command}"`);

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

      function isAdminAction(): boolean {
        if (msg.key?.fromMe) return true;
        const adminEnv = process.env.ADMIN_JIDS || "";
        const admins = adminEnv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const senderId = normalizeJid(getSenderId(msg));
        return admins.includes(senderId as string);
      }

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
        if (!isAdminAction()) {
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
              `Usage: !changebot <jid> <bot-number>\nBot 0: PARAG | Bot 1: ECB | Bot 2: DKB`,
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

        if (!isAdminAction()) {
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
          const targetJid = `${numberMatch[1]}@s.whatsapp.net`;
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
        const targetJid = `${rawPhone}@s.whatsapp.net`;

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
        addSessionMessage(session, "user", userPrompt);

        const agentResult = await WhatsAppAgent.handleAgentMessage(
          session,
          userPrompt,
          GROQ_API_KEY,
          GROQ_MODEL,
          botNumber,
          isAdminSender(msg),
          senderId,
        );

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
