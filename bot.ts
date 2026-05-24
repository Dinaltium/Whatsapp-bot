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

async function safeGetGroupName(sock: any, jid: string): Promise<string> {
  if (!jid || !jid.endsWith("@g.us")) return "Not a Group";
  try {
    const metadata = await sock.groupMetadata(jid);
    return metadata.subject || "Unknown Group Name";
  } catch (error) {
    return "Unknown Group Name";
  }
}

function shouldSkipMessage(
  msg: proto.IWebMessageInfo,
  from: string | null | undefined,
  text: string | null,
  resolvedSenderId?: string,
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
  let commandName = normalizedText.startsWith(COMMAND_PREFIX)
    ? normalizedText.slice(COMMAND_PREFIX.length).split(/\s+/)[0]
    : "";
  if (commandName === "removegroup") commandName = "rmgroup";
  if (commandName === "removechat") commandName = "rmchat";
  if (commandName === "listgroup") commandName = "listgroups";
  if (commandName === "listchat") commandName = "listchats";

  const isCommand = normalizedText.startsWith(COMMAND_PREFIX);
  const isAdmin = isAdminSender(msg, resolvedSenderId);

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

  // ── LID MAPPING VIA CONTACT SYNC ──────────────────────────────────────────
  // When Baileys syncs contacts (on startup and updates), each contact object
  // may have both id (phone JID) and lid (LID). Persist any new mappings.
  sock.ev.on("contacts.upsert", async (contacts) => {
    try {
      const { storeLidPhoneMapping } = await import("./storage/dk24Store");
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
      const { storeLidPhoneMapping } = await import("./storage/dk24Store");
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
      }
    } catch (_e) { /* non-critical */ }
  });

  // ── LID MAPPING VIA NATIVE 6.8.0 EVENT ──────────────────────────────
  sock.ev.on("lid-mapping.update" as any, async (update: any) => {
    try {
      const { storeLidPhoneMapping } = await import("./storage/dk24Store");
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
            import("./storage/dk24Store").then(({ storeLidPhoneMapping }) =>
              storeLidPhoneMapping(normalizedLid, normalizedPn)
            ).catch(() => {});
          }
        }

        if (!hasAltMapping && rawRemoteJid && altRemoteJid && typeof rawRemoteJid === "string" && typeof altRemoteJid === "string") {
          const normalizedLid = normalizeJid(rawRemoteJid);
          const normalizedPn = normalizeJid(altRemoteJid);
          if (normalizedLid && normalizedPn && normalizedLid.endsWith("@lid") && normalizedPn.endsWith("@s.whatsapp.net")) {
            hasAltMapping = true;
            import("./storage/dk24Store").then(({ storeLidPhoneMapping }) =>
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
          const { resolvePhoneJidFromLid } = await import("./storage/dk24Store");
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
                import("./storage/dk24Store").then(({ storeLidPhoneMapping }) =>
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
                  import("./storage/dk24Store").then(({ storeLidPhoneMapping }) =>
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

      if (shouldSkipMessage(msg, from, text, senderId)) {
        continue;
      }

      const command = text!.toLowerCase();
      const session = getOrCreateSession(from || "", senderId);

      resetSessionIfExpired(session);

      // ── INTERCEPT ALLOWLIST CONFIRMATIONS ────────────────────────────────
      if (session.pendingDeleteGroup) {
        const pending = session.pendingDeleteGroup;
        delete session.pendingDeleteGroup;

        const isYes = /^!?yes$/i.test(text!.trim());
        if (isYes) {
          const ok = await groupConfig.removeGroupById(pending.id);
          if (ok) {
            const { logAction } = await import("./storage/dk24Store");
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
        continue;
      }

      if (session.pendingDeleteChat) {
        const pending = session.pendingDeleteChat;
        delete session.pendingDeleteChat;

        const isYes = /^!?yes$/i.test(text!.trim());
        if (isYes) {
          const ok = await chatConfig.removeChatById(pending.id);
          if (ok) {
            const { logAction } = await import("./storage/dk24Store");
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
        continue;
      }

      if (session.pendingEditGroup) {
        const pending = session.pendingEditGroup;
        delete session.pendingEditGroup;

        const isYes = /^!?yes$/i.test(text!.trim());
        if (isYes) {
          const ok = await groupConfig.editGroupBot(pending.id, pending.botNumber);
          if (ok) {
            const { logAction } = await import("./storage/dk24Store");
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
        continue;
      }

      if (session.pendingEditChat) {
        const pending = session.pendingEditChat;
        delete session.pendingEditChat;

        const isYes = /^!?yes$/i.test(text!.trim());
        if (isYes) {
          const ok = await chatConfig.editChatBot(pending.id, pending.botNumber);
          if (ok) {
            const { logAction } = await import("./storage/dk24Store");
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
                    : entry.botNumber === 3
                      ? "TEMP"
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
                    : entry.botNumber === 3
                      ? "TEMP"
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
              "Usage: !addgroup <group-jid> [bot-number]\nBot 0: PARAG | Bot 1: ECB | Bot 2: DKB | Bot 3: TEMP",
            );
            continue;
          }

          target = normalizeJid(target) as string;
          const ok = await groupConfig.addGroup(target, isNaN(botNumber) ? 0 : botNumber);
          if (ok) {
            const groupEntry = groupConfig.getGroupEntryByJid(target);
            const idLabel = groupEntry ? ` (ID: ${groupEntry.id})` : "";
            const groupName = await safeGetGroupName(sock, target);
            const { logAction } = await import("./storage/dk24Store");
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
              "Usage: !addchat <chat-jid> [bot-number]\nBot 0: PARAG | Bot 1: ECB | Bot 2: DKB | Bot 3: TEMP",
            );
            continue;
          }

          target = normalizeJid(target) as string;
          const ok = await chatConfig.addChat(target, isNaN(botNumber) ? 0 : botNumber);
          if (ok) {
            const chatEntry = chatConfig.getChatEntryByJid(target);
            const idLabel = chatEntry ? ` (ID: ${chatEntry.id})` : "";
            const { logAction } = await import("./storage/dk24Store");
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
              : groupEntry.botNumber === 3
                ? "TEMP"
                : "PARAG";

          await sendBotReply(
            sock,
            from || "",
            `Are you sure you want to remove Group ID: ${groupId} | Name: ${groupName} | JID: ${groupEntry.jid} | Bot: ${groupEntry.botNumber} (${botLabel}) from the allowlist?\n(Enter !YES for confirmation)`
          );
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
              : chatEntry.botNumber === 3
                ? "TEMP"
                : "PARAG";

          await sendBotReply(
            sock,
            from || "",
            `Are you sure you want to remove Chat ID: ${chatId} | JID: ${chatEntry.jid} | Bot: ${chatEntry.botNumber} (${botLabel}) from the allowlist?\n(Enter !YES for confirmation)`
          );
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

          const oldBotLabel = groupEntry.botNumber === 1 ? "ECB" : groupEntry.botNumber === 2 ? "DKB" : groupEntry.botNumber === 3 ? "TEMP" : "PARAG";
          const newBotLabel = newBotNumber === 1 ? "ECB" : newBotNumber === 2 ? "DKB" : newBotNumber === 3 ? "TEMP" : "PARAG";

          await sendBotReply(
            sock,
            from || "",
            `Are you sure you want to change Group ID: ${groupId} | Name: ${groupName} | JID: ${groupEntry.jid} to use Bot ${newBotNumber} (${newBotLabel}) instead of Bot ${groupEntry.botNumber} (${oldBotLabel})?\n(Enter !YES for confirmation)`
          );
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

          const oldBotLabel = chatEntry.botNumber === 1 ? "ECB" : chatEntry.botNumber === 2 ? "DKB" : chatEntry.botNumber === 3 ? "TEMP" : "PARAG";
          const newBotLabel = newBotNumber === 1 ? "ECB" : newBotNumber === 2 ? "DKB" : newBotNumber === 3 ? "TEMP" : "PARAG";

          await sendBotReply(
            sock,
            from || "",
            `Are you sure you want to change Chat ID: ${chatId} | JID: ${chatEntry.jid} to use Bot ${newBotNumber} (${newBotLabel}) instead of Bot ${chatEntry.botNumber} (${oldBotLabel})?\n(Enter !YES for confirmation)`
          );
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
            const { logAction } = await import("./storage/dk24Store");
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
            const { logAction } = await import("./storage/dk24Store");
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
            const { logAction } = await import("./storage/dk24Store");
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
            const { logAction } = await import("./storage/dk24Store");
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
              const formatted = list.map((g, idx) => `${idx + 1}. ${g.subject} | JID: ${g.id}`);
              await sendBotReply(sock, from || "", `Groups the bot is in:\n${formatted.join("\n")}`);
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

        const isManageAdmin = isAdminAction(msg, senderId);
        const isManageAuthorized = isManageAdmin ||
          (senderId && await (async () => {
            const { userHasPermission } = await import("./storage/dk24Store");
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
              const { resolvePhoneJidFromLid } = await import("./storage/dk24Store");
              const resolved = await resolvePhoneJidFromLid(targetJid);
              if (resolved) effectiveQueryJid = resolved;
            } catch (_) {}
          }

          try {
            const { getUserRoles } = await import("./storage/dk24Store");
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

        const { addManagedRole, storeLidPhoneMapping } = await import("./storage/dk24Store");
        let resolvedPhoneJid: string | null = null;
        let resolvedLid: string | null = null;

        if (targetJid.endsWith("@lid")) {
          resolvedLid = targetJid;
          try {
            const { resolvePhoneJidFromLid } = await import("./storage/dk24Store");
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
