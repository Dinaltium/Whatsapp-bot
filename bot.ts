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
}

interface RateLimitNotice {
  reason: string;
  notifiedAt: number;
}

const userAiRateLimits = new Map<string, RateLimitState>();
const userAiRateLimitNotices = new Map<string, RateLimitNotice>();
const userAiSessions = new Map<string, UserSession>();
let isHealthServerStarted = false;

const BOT_ASCII_BANNER = String.raw`░█▀█░█▀█░█▀▄░█▀█░█▀▀
░█▀▀░█▀█░█▀▄░█▀█░█░█
░▀░░░▀░▀░▀░▀░▀░▀░▀▀▀`;

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
    console.log(`🌐 Health server listening on port ${port}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err && err.code === "EADDRINUSE") {
      console.warn(
        `⚠️ Health server port ${port} already in use. Continuing without health endpoint.`,
      );
      return;
    }
    console.error("Health server error:", err);
    throw err;
  });
}

function printBanner(): void {
  console.log(`\n${BOT_ASCII_BANNER}`);
}

function formatBotReply(text: string): string {
  const cleanedText = String(text || "").trim();

  if (!cleanedText) {
    return `${BOT_ASCII_BANNER}`;
  }

  return `${BOT_ASCII_BANNER}\n\n${cleanedText}`;
}

async function sendBotReply(
  sock: ReturnType<typeof makeWASocket>,
  to: string,
  text: string,
): Promise<void> {
  await sock.sendMessage(to, {
    text: formatBotReply(text),
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
  if (!msg?.message) return true;

  const normalizedText = String(text || "")
    .trim()
    .toLowerCase();
  const commandName = normalizedText.startsWith(COMMAND_PREFIX)
    ? normalizedText.slice(COMMAND_PREFIX.length).split(/\s+/)[0]
    : "";
  const isAdmin = isAdminSender(msg);
  const adminOnlyCommands = [
    "getjid",
    "whoami",
    "addgroup",
    "rmgroup",
    "listgroups",
    "addchat",
    "rmchat",
    "listchats",
  ];

  if (adminOnlyCommands.includes(commandName)) {
    return !isAdmin;
  }

  if (msg.key?.fromMe && !ALLOW_FROM_ME_MESSAGES) return true;

  if (!from || from === "status@broadcast") return true;

  if (from.endsWith("@g.us")) {
    if (!groupConfig.isGroupAllowed(from)) return true;
  } else {
    if (!chatConfig.isChatAllowed(from)) return true;
  }

  if (msg.message?.protocolMessage) return true;
  if (!text) return true;

  if (!text.startsWith(COMMAND_PREFIX)) return true;

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
      console.log("✅ Using Neon PostgreSQL for auth state storage.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `⚠️ Neon auth storage unavailable (${message}). Falling back to local auth/.`,
      );
      authStore = await useMultiFileAuthState("auth");
      console.log("ℹ Using local auth/ files for auth state storage.");
    }
  } else {
    authStore = await useMultiFileAuthState("auth");
    console.log("ℹ Using local auth/ files for auth state storage.");
  }

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
      console.warn(`⚠️ Failed to persist auth credentials: ${message}`);
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, {
        small: true,
      });

      console.log("📱 Scan QR");
    }

    if (connection === "open") {
      console.log("✅ PARAG connected.");
    }

    if (connection === "close") {
      const err = lastDisconnect?.error as any;
      const statusCode = err?.output?.statusCode || err?.statusCode;

      console.log("❌ Connection closed");
      console.log("Reason:", statusCode);

      if (statusCode === 515) {
        console.log("♻ Restart required. Reconnecting...");

        setTimeout(() => {
          startBot();
        }, 3000);
      } else if (statusCode === DisconnectReason.loggedOut) {
        console.log("❌ Logged out.");
      } else {
        console.log("♻ Reconnecting...");

        setTimeout(() => {
          startBot();
        }, 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      const from = msg.key?.remoteJid;
      const textRaw = extractMessageText(msg.message);
      const text = textRaw ? textRaw.trim() : null;

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

      console.log("📩", command);

      if (command === "!ping") {
        await sendBotReply(sock, from || "", "pong 🗿");
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
                entry.botNumber === 1 ? "Embedclub" : "Tech/Hackathon";
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
              `Usage: !${cmdName} <group-jid> [bot-number]\nBot 0: Tech/Hackathon | Bot 1: Embedclub`,
            );
            continue;
          }

          target = normalizeJid(target) as string;

          if (cmdName === "addgroup") {
            const ok = groupConfig.addGroup(
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
            const ok = groupConfig.removeGroup(target);
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
                entry.botNumber === 1 ? "Embedclub" : "Tech/Hackathon";
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
              `Usage: !${cmdName} <chat-jid> [bot-number]\nBot 0: Tech/Hackathon | Bot 1: Embedclub`,
            );
            continue;
          }

          target = normalizeJid(target) as string;

          if (cmdName === "addchat") {
            const ok = chatConfig.addChat(
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
            const ok = chatConfig.removeChat(target);
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
        console.error("Groq error:", errorMessage);

        await sendBotReply(
          sock,
          from || "",
          "AI is temporarily unavailable. Please try again in a moment.",
        );
      }
    }
  });
}

startBot();
