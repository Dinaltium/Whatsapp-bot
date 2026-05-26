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

export const COMMAND_PREFIX = "!";
export const GROQ_API_KEY = process.env.GROQ_API_KEY;
export const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
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
  pendingDeleteGroup?: {
    id: number;
    jid: string;
    botNumber: number;
  };
  pendingDeleteChat?: {
    id: number;
    jid: string;
    botNumber: number;
  };
  pendingEditGroup?: {
    id: number;
    jid: string;
    botNumber: number;
  };
  pendingEditChat?: {
    id: number;
    jid: string;
    botNumber: number;
  };
}

const userAiSessions = new Map<string, UserSession>();
const lastSentMessages = new Map<string, string>();
const lastUserMessages = new Map<string, string>();
const lastGroupInteractionTime = new Map<string, number>();

import {
  getActiveSocket as getClientSocket,
  setActiveSocket,
  cleanupBotInstance as cleanupClientInstance
} from "./infrastructure/whatsapp/whatsappClient";

let activeAuthStore: any = null;

export function getActiveSocket(): any {
  return getClientSocket();
}

export async function cleanupBotInstance(): Promise<void> {
  await cleanupClientInstance();

  if (activeAuthStore) {
    try {
      if (activeAuthStore.close) {
        await activeAuthStore.close();
      }
    } catch (e) {
      console.warn("Error closing active auth store:", e);
    }
    activeAuthStore = null;
  }
}


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
let reconnectAttempts = 0;

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

export async function sendBotReply(
  sock: ReturnType<typeof makeWASocket>,
  to: string,
  text: string,
): Promise<void> {
  try {
    const trimmedText = String(text || "").trim();
    if (!trimmedText) return;
    
    lastSentMessages.set(to, trimmedText);
    
    const { outgoingQueue } = await import("./infrastructure/queue/queueManager");
    await outgoingQueue.add("send-reply", { to, text: trimmedText });
    console.log(`[bot.ts] Reply queued for asynchronous dispatch to ${to}`);
  } catch (err) {
    console.error("Failed to queue reply:", err);
  }
}

export function extractMessageText(
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

export async function safeGetGroupName(sock: any, jid: string): Promise<string> {
  if (!jid || !jid.endsWith("@g.us")) return "Not a Group";
  try {
    const metadata = await sock.groupMetadata(jid);
    return metadata.subject || "Unknown Group Name";
  } catch (error) {
    return "Unknown Group Name";
  }
}

export async function shouldSkipMessage(
  sock: any,
  msg: proto.IWebMessageInfo,
  from: string | null | undefined,
  text: string | null,
  resolvedSenderId?: string,
): Promise<boolean> {
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
  let commandName = normalizedText.startsWith(COMMAND_PREFIX)
    ? normalizedText.slice(COMMAND_PREFIX.length).split(/\s+/)[0]
    : "";
  if (commandName === "removegroup") commandName = "rmgroup";
  if (commandName === "removechat") commandName = "rmchat";
  if (commandName === "listgroup") commandName = "listgroups";
  if (commandName === "listchat") commandName = "listchats";

  const isCommand = normalizedText.startsWith(COMMAND_PREFIX);
  const isAdmin = isAdminSender(msg, resolvedSenderId);

  // ── ANNOUNCEMENT GROUP / ADMINS-ONLY GUARDRAILS ──
  if (from && from.endsWith("@g.us")) {
    try {
      const metadata = await sock.groupMetadata(from);
      if (metadata && metadata.announce) {
        // 1. Verify if the bot itself is an admin in this announcement group
        const botJid = normalizeJid(sock.user?.id || "");
        const isBotAdmin = metadata.participants.some((p: any) => {
          const pid = p.id ? normalizeJid(p.id) : null;
          const plid = p.lid ? normalizeJid(p.lid) : null;
          return (
            (pid && pid === botJid) ||
            (plid && plid === botJid)
          ) && (p.admin === "admin" || p.admin === "superadmin");
        });

        if (!isBotAdmin) {
          // Complete mute to prevent 403 server blocks / bans
          logStructured({
            event: "command_skipped",
            reason: "announcement_group_bot_not_admin",
            groupHash: getJidHash(from),
          });
          return true;
        }

        // 2. Even if the bot is admin, block public command replies to keep announcement channel clean
        if (isCommand) {
          logStructured({
            event: "command_skipped",
            reason: "announcement_group_cleanliness_mute",
            command: commandName,
            groupHash: getJidHash(from),
          });
          return true;
        }
      }
    } catch (err) {
      console.warn("Failed to check announcement status in shouldSkipMessage:", err);
    }
  }

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
    "editgroup",
    "editchat",
    "disablegroup",
    "disablechat",
    "enablegroup",
    "enablechat",
    "findgroups",
    "neonping",
    "neonconnect",
    "reveal",
    // NOTE: "manage" is NOT here — it has its own RBAC gate inside the handler
    // that allows both admins AND users with the role.manage permission.
  ];



  if (adminOnlyCommands.includes(commandName)) {
    if (!isAdmin) {
      logStructured({
        event: "command_skipped",
        reason: "admin_required",
        command: commandName,
        userHash: getJidHash(from),
        rawParticipant: msg.key?.participant || "none",
        resolvedSenderId: resolvedSenderId || "none",
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
export function extractMentionedJids(msg: proto.IWebMessageInfo): string[] {
  const jids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!jids || !Array.isArray(jids)) return [];
  return jids.filter((j): j is string => typeof j === "string");
}

export function buildSessionKey(from: string, senderId: string): string {
  return `${from}:${senderId}`;
}

export function getOrCreateSession(from: string, senderId: string): UserSession {
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

export function resetSessionIfExpired(session: UserSession): void {
  if (!session.lastActiveAt) return;

  const isExpired = Date.now() - session.lastActiveAt > AI_SESSION_TTL_MS;

  if (isExpired) {
    session.domainUnlocked = false;
    session.messages = [];
    session.lastActiveAt = 0;
  }
}

export function addSessionMessage(
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

  try {
    const { redis } = await import("./storage/redisClient");
    await redis.ping();
    console.log("Redis ping successful! Ready for caching and rate limiting.");
  } catch (error) {
    console.error("FATAL: Cannot connect to Redis. Ensure REDIS_URL is correctly set and the server is running.");
    process.exit(1);
  }

  const databaseUrl = getDatabaseUrl();
  let authStore: any;

  if (databaseUrl) {
    try {
      const { ensureSchema, getPool, warmPool } = await import("./storage/db");
      const sharedPool = getPool();
      if (!sharedPool) {
        throw new Error("Failed to initialize database pool");
      }

      authStore = await useNeonAuthState("parag", sharedPool);
      activeAuthStore = authStore;
      console.log("Using Neon PostgreSQL for auth state storage with shared pool.");

      // Bootstrap PostgreSQL schemas
      await ensureSchema();

      // Warm the connection pool BEFORE starting the WhatsApp socket.
      // Neon (serverless Postgres) cold-starts slowly; if the pool isn't
      // ready when WhatsApp fires keys.set() during the handshake, the
      // write times out and WhatsApp drops the connection with 408.
      await warmPool();
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

  // Boot BullMQ queue workers to start listening for jobs
  console.log("Initializing BullMQ queue workers...");
  await import("./infrastructure/queue/incomingWorker");
  await import("./infrastructure/queue/outgoingWorker");
  console.log("BullMQ queue workers initialized and listening.");

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
  setActiveSocket(sock);

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
      reconnectAttempts = 0; // reset on successful open
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
        setTimeout(async () => {
          await cleanupBotInstance();
          startBot();
        }, 3000);
      } else if (statusCode === DisconnectReason.loggedOut) {
        logStructured({ event: "connection_logout" });
        // Don't reconnect — session is gone, needs manual QR re-scan
      } else if (statusCode === DisconnectReason.connectionReplaced) {
        logStructured({ event: "connection_replaced", error: "another_instance" });
        await cleanupBotInstance();
        process.exit(0);
      } else if (statusCode === 408) {
        // 408 = session timeout / corrupted keys. Back off aggressively to
        // avoid a crash loop that triggers Dokploy's container kill policy.
        reconnectAttempts++;
        if (reconnectAttempts > 3) {
          logStructured({ event: "reconnect_aborted", reason: "too_many_408s", attempts: reconnectAttempts });
          console.error("FATAL: Too many 408 disconnects — session may be corrupted. Clear wa_auth_state in Neon and redeploy.");
          process.exit(1); // Let Dokploy restart cleanly rather than crash-looping
        }
        const delay = 15000 * reconnectAttempts; // 15s, 30s, 45s
        logStructured({ event: "reconnecting", reason: "session_timeout_408", attempt: reconnectAttempts, delayMs: delay });
        setTimeout(async () => {
          await cleanupBotInstance();
          startBot();
        }, delay);
      } else {
        // Generic disconnect — exponential backoff up to 60s
        reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000);
        logStructured({ event: "reconnecting", reason: "generic_close", attempt: reconnectAttempts, delayMs: delay });

        setTimeout(async () => {
          await cleanupBotInstance();
          startBot();
        }, 3000);
      }
    }
  });

  // ── LID MAPPING VIA CONTACT SYNC ──────────────────────────────────────────
  // When Baileys syncs contacts (on startup and updates), each contact object
  // may have both id (phone JID) and lid (LID). Persist any new mappings.
  sock.ev.on("contacts.upsert", async (contacts) => {
    try {
      const { storeLidPhoneMapping } = await import("./storage/core/rbacRepository");
      let stored = 0;
      for (const contact of contacts) {
        if (!contact) continue;

        const cid = contact.id ? normalizeJid(contact.id) : null;
        const clid = (contact as any).lid ? normalizeJid((contact as any).lid) : null;
        const cpn = (contact as any).phoneNumber ? normalizeJid((contact as any).phoneNumber) : null;

        let resolvedLid: string | null = null;
        let resolvedPn: string | null = null;

        // Case A: id is phone JID, lid is LID
        if (cid && cid.endsWith("@s.whatsapp.net")) {
          resolvedPn = cid;
          if (clid && clid.endsWith("@lid")) resolvedLid = clid;
        }
        // Case B: id is LID, phoneNumber is phone JID
        else if (cid && cid.endsWith("@lid")) {
          resolvedLid = cid;
          if (cpn && cpn.endsWith("@s.whatsapp.net")) {
            resolvedPn = cpn;
          } else if ((contact as any).phone) {
            const digits = String((contact as any).phone).replace(/\D/g, "");
            if (digits) resolvedPn = `${digits}@s.whatsapp.net`;
          }
        }

        if (resolvedLid && resolvedPn) {
          await storeLidPhoneMapping(resolvedLid, resolvedPn);
          stored++;
        }
      }
      if (stored > 0) {
        logStructured({ event: "lid_mapped_from_contacts", count: stored });
      }
    } catch (_e) { /* non-critical */ }
  });

  // ── LID MAPPING VIA GROUP PARTICIPANT EVENTS ──────────────────────────────
  sock.ev.on("group-participants.update", async (update) => {
    try {
      const { storeLidPhoneMapping } = await import("./storage/core/rbacRepository");
      const groupBot = groupConfig.getGroupBot(update.id);
      const isBot2 = groupBot?.botNumber === 2;

      for (const participant of update.participants || []) {
        if (!participant) continue;
        const pid = typeof participant === "string" ? normalizeJid(participant) : (participant.id ? normalizeJid(participant.id) : null);
        const plid = (participant as any).lid ? normalizeJid((participant as any).lid) : null;
        const ppn = (participant as any).phoneNumber ? normalizeJid((participant as any).phoneNumber) : null;

        let resolvedLid: string | null = null;
        let resolvedPn: string | null = null;

        if (pid && pid.endsWith("@s.whatsapp.net")) {
          resolvedPn = pid;
          if (plid && plid.endsWith("@lid")) resolvedLid = plid;
        } else if (pid && pid.endsWith("@lid")) {
          resolvedLid = pid;
          if (ppn && ppn.endsWith("@s.whatsapp.net")) {
            resolvedPn = ppn;
          } else if ((participant as any).phone) {
            const digits = String((participant as any).phone).replace(/\D/g, "");
            if (digits) resolvedPn = `${digits}@s.whatsapp.net`;
          }
        }

        if (resolvedLid && resolvedPn) {
          await storeLidPhoneMapping(resolvedLid, resolvedPn);
        }

        // Auto-register new participant to pendingIntros if action is 'add' and group is Bot 2
        if (isBot2 && update.action === "add") {
          const targetJid = resolvedPn || pid;
          if (targetJid && !targetJid.endsWith("@g.us")) {
            pendingIntros.set(targetJid, {
              groupJid: update.id,
              triggeredAt: Date.now(),
            });

            // Also store in Redis so messageRouter can see it
            import("./core/state").then(({ addPendingIntro }) => {
              addPendingIntro(targetJid, update.id).catch(err => {
                console.error("Failed to add pending intro to Redis:", err);
              });
            }).catch(err => {
              console.error("Failed to import state in group-participants.update:", err);
            });

            logStructured({
              event: "intro_tracker_watch_add_event",
              bot: 2,
              groupHash: getJidHash(update.id),
              targetHash: getJidHash(targetJid),
            });
          }
        }
      }
    } catch (_e) { /* non-critical */ }
  });

  // ── LID MAPPING VIA NATIVE 6.8.0 EVENT ──────────────────────────────
  sock.ev.on("lid-mapping.update" as any, async (update: any) => {
    try {
      const { storeLidPhoneMapping } = await import("./storage/core/rbacRepository");
      const items = Array.isArray(update) ? update : [update];
      let count = 0;
      for (const item of items) {
        if (!item) continue;
        const rawLid = item.lid;
        const rawPn = item.pn || item.phoneNumber || item.jid || item.id;
        if (rawLid && rawPn && typeof rawLid === "string" && typeof rawPn === "string") {
          const normalizedLid = normalizeJid(rawLid);
          const normalizedPn = normalizeJid(rawPn);
          if (normalizedLid && normalizedPn && normalizedLid.endsWith("@lid") && normalizedPn.endsWith("@s.whatsapp.net")) {
            await storeLidPhoneMapping(normalizedLid, normalizedPn);
            count++;
          }
        }
      }
      if (count > 0) {
        logStructured({ event: "lid_mapped_from_event", count });
      }
    } catch (_e) { /* non-critical */ }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
        const { incomingQueue } = await import("./infrastructure/queue/queueManager");
        await incomingQueue.add("upsert-message", { messages, type });
        logStructured({
          event: "messages_queued",
          count: messages.length,
          type,
        });
    } catch (err) {
        console.error("Error queueing incoming messages:", err);
    }
  });

  // Handle graceful shutdown for hosting environments like Render
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");

  process.on("SIGTERM", async () => {
    console.log("Received SIGTERM, shutting down gracefully...");
    await cleanupBotInstance();
    try {
      const { closeQueues } = await import("./infrastructure/queue/queueManager");
      await closeQueues();
      const { incomingWorker } = await import("./infrastructure/queue/incomingWorker");
      await incomingWorker.close();
      const { outgoingWorker } = await import("./infrastructure/queue/outgoingWorker");
      await outgoingWorker.close();
    } catch (_e) {}
    try {
      const { closePool } = await import("./storage/db");
      await closePool();
    } catch (_e) {}
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("Received SIGINT, shutting down gracefully...");
    await cleanupBotInstance();
    try {
      const { closeQueues } = await import("./infrastructure/queue/queueManager");
      await closeQueues();
      const { incomingWorker } = await import("./infrastructure/queue/incomingWorker");
      await incomingWorker.close();
      const { outgoingWorker } = await import("./infrastructure/queue/outgoingWorker");
      await outgoingWorker.close();
    } catch (_e) {}
    try {
      const { closePool } = await import("./storage/db");
      await closePool();
    } catch (_e) {}
    process.exit(0);
  });
}

startBot();
