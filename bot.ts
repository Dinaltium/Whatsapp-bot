import {
  default as makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  proto,
} from "@whiskeysockets/baileys";
import http from "http";
import qrcode from "qrcode-terminal";
import pino from "pino";
import "dotenv/config";
import ffmpegPath from "ffmpeg-static";
import path from "path";

if (ffmpegPath) {
  process.env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH}`;
}

import groupConfig from "./config/groupAllowlist";
import chatConfig from "./config/chatAllowlist";
import { useNeonAuthState, getDatabaseUrl } from "./storage/neonAuthStateStore";
import { getJidHash, logStructured, logEvent } from "./utils/logger";
import { normalizeJid, isAdminSender } from "./security/rbac";
import { calculateTypingDelay } from "./utils/typingDelay";
import { startHealthServer } from "./infrastructure/health/healthServer";
import { registerContactSyncHandlers } from "./infrastructure/whatsapp/contactSync";
import { registerLidMapperHandlers } from "./infrastructure/whatsapp/lidMapper";
import { startReminderScheduler } from "./infrastructure/scheduler/reminderScheduler";

export const COMMAND_PREFIX = "!";
export const GROQ_API_KEY = process.env.GROQ_API_KEY;
export const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const ALLOW_FROM_ME_MESSAGES =
  (process.env.ALLOW_FROM_ME_MESSAGES || "false").toLowerCase() === "true";
const AI_MAX_SESSION_MESSAGES = 8;

let activeSocket: any = null;
export function getActiveSocket() {
  return activeSocket;
}

// Session state lives exclusively in Redis (core/state.ts). The former
// in-memory userAiSessions Map + UserSession interface were dead — nothing on
// the live message path read them — and have been removed to avoid a second,
// divergent source of truth.

function printBanner(): void {
  console.log("\nWhatsApp Bot Coordinator Online.");
}

export async function sendBotReply(
  sock: ReturnType<typeof makeWASocket>,
  to: string,
  text: string,
): Promise<void> {
  // ── OUTGOING RATE GUARD (Task 3.2) ────────────────────────────
  try {
    const { redis } = await import("./storage/redisClient");
    const minuteKey = `outgoing:${to}:${Math.floor(Date.now() / 60000)}`;
    const outgoingCount = await redis.incr(minuteKey);
    if (outgoingCount === 1) await redis.expire(minuteKey, 120);
    if (outgoingCount > 5) {
      console.warn(
        `[RateGuard] Suppressed outgoing to ${getJidHash(to)} — limit reached (${outgoingCount}/5)`,
      );
      return;
    }
  } catch {
    /* fail open — never block on Redis error */
  }

  try {
    // Notify composing/typing presence
    await sock.sendPresenceUpdate("composing", to);
  } catch (err) {
    console.error("Failed to send presence update:", err);
  }

  const totalDelay = calculateTypingDelay(text);

  await new Promise((resolve) => setTimeout(resolve, totalDelay));

  try {
    // Notify paused presence before sending message
    await sock.sendPresenceUpdate("paused", to);
  } catch (err) {}

  const trimmedText = String(text || "").trim();

  // ── REDIS-BACKED ECHO DETECTION (Task 3.4) ───────────────────────
  try {
    const { setLastSentMessage } = await import("./core/state");
    await setLastSentMessage(to, trimmedText);
  } catch {
    /* non-fatal */
  }

  await sock.sendMessage(to, {
    text: trimmedText,
  });
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

export async function safeGetGroupName(
  sock: any,
  jid: string,
): Promise<string> {
  if (!jid || !jid.endsWith("@g.us")) return "Not a Group";
  try {
    const metadata = await sock.groupMetadata(jid);
    return metadata.subject || "Unknown Group Name";
  } catch (error) {
    return "Unknown Group Name";
  }
}

export async function safeGetContactName(jid: string): Promise<string> {
  if (!jid) return "Unknown User";
  try {
    const { redis } = await import("./storage/redisClient");
    // 1. Try direct lookup in Redis
    let name = await redis.hget("contact_names", jid);
    if (name) return name;

    // 2. If it's a LID, try resolving to Phone JID
    if (jid.endsWith("@lid")) {
      const { resolvePhoneJidFromLid } =
        await import("./storage/core/rbacRepository");
      const phoneJid = await resolvePhoneJidFromLid(jid);
      if (phoneJid) {
        name = await redis.hget("contact_names", phoneJid);
        if (name) return name;

        // Fallback to phone number of the resolved JID
        const phone = phoneJid.split("@")[0];
        return `+${phone}`;
      }
    }
  } catch (_) {}

  // Fallback to phone number if JID is phone JID
  if (jid.endsWith("@s.whatsapp.net")) {
    const phone = jid.split("@")[0];
    return `+${phone}`;
  }

  // Fallback to bare LID key
  if (jid.endsWith("@lid")) {
    return `LID: ${jid.split("@")[0]}`;
  }

  return "Unknown User";
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

  // Anti-echo & duplicate bot response suppression (Redis-backed, Task 3.4)
  if (from) {
    try {
      const { getLastSentMessage } = await import("./core/state");
      const lastSent = await getLastSentMessage(from);
      if (lastSent && lastSent === String(text || "").trim()) {
        logStructured({
          event: "command_skipped",
          reason: "echo_detected",
          userHash: getJidHash(from),
        });
        return true;
      }
    } catch {
      /* non-fatal */
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
            ((pid && pid === botJid) || (plid && plid === botJid)) &&
            (p.admin === "admin" || p.admin === "superadmin")
          );
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
      console.warn(
        "Failed to check announcement status in shouldSkipMessage:",
        err,
      );
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

  // Only verify allowlists if the sender is not an admin, and the command is not publicExempt or adminOnly
  if (
    !isAdmin &&
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

export function addSessionMessage(
  session: { messages: Array<{ role: "user" | "assistant"; content: string }> },
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

let persistentAuthStore: any = null;

async function startBot(): Promise<void> {
  printBanner();
  startHealthServer();
  startReminderScheduler();

  try {
    const { redis } = await import("./storage/redisClient");
    await redis.ping();
    console.log("Redis ping successful! Ready for caching and rate limiting.");
  } catch (error) {
    console.error(
      "FATAL: Cannot connect to Redis. Ensure REDIS_URL is correctly set and the server is running.",
    );
    process.exit(1);
  }

  const databaseUrl = getDatabaseUrl();
  let authStore: any;

  if (databaseUrl) {
    try {
      if (!persistentAuthStore) {
        persistentAuthStore = await useNeonAuthState("parag");
        console.log("Using Neon PostgreSQL for auth state storage.");
        const { ensureSchema } = await import("./storage/db");
        await ensureSchema();
      } else {
        console.log("Reusing existing auth store for reconnect.");
      }
      authStore = persistentAuthStore;
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
  activeSocket = sock;

  // Intercept and cache all bot-sent message IDs to prevent self-loops
  const originalSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args: any[]) => {
    const result = await (originalSendMessage as any)(...args);
    if (result && result.key && result.key.id) {
      try {
        const { redis } = await import("./storage/redisClient");
        await redis.setex(`bot_sent_msg:${result.key.id}`, 600, "1");
      } catch (err) {
        console.error("[LoopPrevention] Failed to cache sent message ID:", err);
      }
    }
    return result;
  };

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

      // ── BOOT NOTIFICATION TO ADMIN (Task 3.9) ──────────────────
      const adminEnv = process.env.ADMIN_JIDS || "";
      const firstAdmin = adminEnv.split(",")[0].trim();
      if (firstAdmin) {
        setTimeout(async () => {
          try {
            const normalizedAdmin = normalizeJid(firstAdmin);
            if (normalizedAdmin) {
              await sock.sendMessage(normalizedAdmin, {
                text: `[BOT] Online. ${new Date().toISOString()}`,
              });
            }
          } catch (_) {
            /* non-fatal */
          }
        }, 5000);
      }
    }

    if (connection === "close") {
      const err = lastDisconnect?.error as any;
      const statusCode = err?.output?.statusCode || err?.statusCode;

      logStructured({
        event: "connection_closed",
        statusCode,
      });

      // Stop the old socket so it doesn't leak
      try {
        if (activeSocket) {
          activeSocket.ws?.close();
        }
      } catch (e) {}

      if (statusCode === 515) {
        logStructured({ event: "reconnecting", reason: "restart_required" });
        setTimeout(() => startBot(), 3000);
      } else if (statusCode === DisconnectReason.loggedOut) {
        logStructured({ event: "connection_logout" });
      } else if (statusCode === DisconnectReason.connectionReplaced) {
        logStructured({
          event: "connection_replaced",
          error: "another_instance",
        });
        process.exit(0);
      } else {
        logStructured({ event: "reconnecting", reason: "generic_close" });
        setTimeout(() => startBot(), 5000);
      }
    }
  });

  registerContactSyncHandlers(sock);
  registerLidMapperHandlers(sock);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      const { handleMessageUpsert } = await import("./core/messageRouter");
      await handleMessageUpsert(sock, messages, type);
    } catch (err) {
      console.error("Error in message router:", err);
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
