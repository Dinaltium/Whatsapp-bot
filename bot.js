const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const http = require("http");

const qrcode = require("qrcode-terminal");
const P = require("pino");
require("dotenv").config();

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
const userAiRateLimits = new Map();
const userAiRateLimitNotices = new Map();
const userAiSessions = new Map();
const BOT_ASCII_BANNER = String.raw`░█▀█░█▀█░█▀▄░█▀█░█▀▀
░█▀▀░█▀█░█▀▄░█▀█░█░█
░▀░░░▀░▀░▀░▀░▀░▀░▀▀▀`;

function startHealthServer() {

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
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.warn(`⚠️ Health server port ${port} already in use. Continuing without health endpoint.`);
      return;
    }

    // Re-throw unexpected errors so they're not silently swallowed
    console.error('Health server error:', err);
    throw err;
  });

}

function printBanner() {

  console.log(`\n${BOT_ASCII_BANNER}`);

}

function formatBotReply(text) {

  const cleanedText = String(text || "").trim();

  if (!cleanedText) {
    return `${BOT_ASCII_BANNER}`;
  }

  return `${BOT_ASCII_BANNER}\n\n${cleanedText}`;

}

async function sendBotReply(sock, to, text) {

  return sock.sendMessage(to, {
    text: formatBotReply(text)
  });

}

function extractMessageText(message) {

  if (!message) return null;

  const unwrappedMessage =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message;

  return (
    unwrappedMessage.conversation ||
    unwrappedMessage.extendedTextMessage?.text ||
    unwrappedMessage.imageMessage?.caption ||
    unwrappedMessage.videoMessage?.caption ||
    null
  );

}

function shouldSkipMessage(msg, from, text) {

  if (!msg?.message) return true;

  const normalizedText = String(text || "").trim().toLowerCase();
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
    "listchats"
  ];

  // Admin-only commands: only admins can use them. Admin can run these anywhere.
  if (adminOnlyCommands.includes(commandName)) {
    return !isAdmin;
  }

  // Allow your own commands when enabled; keep optional guard for strict mode.
  if (msg.key?.fromMe && !ALLOW_FROM_ME_MESSAGES) return true;

  if (!from || from === "status@broadcast") return true;

  // Allow groups and private chats but enforce allowlists.
  if (from.endsWith("@g.us")) {
    // Group message: check group allowlist
    if (!groupConfig.isGroupAllowed(from)) return true;
  } else {
    // Private chat: check chat allowlist
    if (!chatConfig.isChatAllowed(from)) return true;
  }

  // Ignore system/protocol updates and empty payloads.
  if (msg.message?.protocolMessage) return true;
  if (!text) return true;

  // Only accept command-style messages for controlled processing.
  if (!text.startsWith(COMMAND_PREFIX)) return true;

  return false;

}

function getSenderId(msg) {

  return msg.key?.participant || msg.key?.remoteJid || "unknown";

}

function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return jid;

  // Some Baileys/WA variants return a linked-device id suffix '@lid'.
  // Normalize common variants to the standard user JID domain.
  if (jid.endsWith('@lid')) {
    return jid.replace(/@lid$/, '@s.whatsapp.net');
  }

  return jid;

}

function isAdminSender(msg) {
  if (!msg) return false;
  if (msg.key?.fromMe) return true;
  const adminEnv = process.env.ADMIN_JIDS || "";
  const admins = adminEnv.split(',').map(s => s.trim()).filter(Boolean);
  const senderId = normalizeJid(getSenderId(msg));
  return admins.includes(senderId);

}

function buildRateLimitKey(from, senderId) {

  return `${from}:${senderId}`;

}

function getRateLimitState(key) {

  if (!userAiRateLimits.has(key)) {
    userAiRateLimits.set(key, {
      windowStart: Date.now(),
      requestCount: 0,
      lastRequestAt: 0
    });
  }

  return userAiRateLimits.get(key);

}

function checkAiRateLimit(from, senderId) {

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
      retryAfterMs: cooldownRemaining
    };
  }

  if (state.requestCount >= AI_MAX_REQUESTS_PER_WINDOW) {
    return {
      allowed: false,
      reason: "window-limit",
      retryAfterMs: AI_WINDOW_MS - (now - state.windowStart)
    };
  }

  state.requestCount += 1;
  state.lastRequestAt = now;

  return {
    allowed: true
  };

}

function clearRateLimitNotice(from, senderId) {

  const key = buildRateLimitKey(from, senderId);
  userAiRateLimitNotices.delete(key);

}

function shouldSendRateLimitNotice(from, senderId, rateLimitCheck) {

  if (rateLimitCheck?.allowed) {
    clearRateLimitNotice(from, senderId);
    return false;
  }

  const key = buildRateLimitKey(from, senderId);
  const existing = userAiRateLimitNotices.get(key);
  const reason = rateLimitCheck?.reason || "unknown";

  // Send only once per active blocked streak/reason.
  if (existing?.reason === reason) {
    return false;
  }

  userAiRateLimitNotices.set(key, {
    reason,
    notifiedAt: Date.now()
  });

  return true;

}

function formatRetryAfter(ms) {

  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return `${seconds}s`;

}

function buildSessionKey(from, senderId) {

  return `${from}:${senderId}`;

}

function getOrCreateSession(from, senderId) {

  const sessionKey = buildSessionKey(from, senderId);

  if (!userAiSessions.has(sessionKey)) {
    userAiSessions.set(sessionKey, {
      domainUnlocked: false,
      lastActiveAt: 0,
      messages: []
    });
  }

  return userAiSessions.get(sessionKey);

}

function resetSessionIfExpired(session) {

  if (!session.lastActiveAt) return;

  const isExpired = (Date.now() - session.lastActiveAt) > AI_SESSION_TTL_MS;

  if (isExpired) {
    session.domainUnlocked = false;
    session.messages = [];
    session.lastActiveAt = 0;
  }

}

function addSessionMessage(session, role, content) {

  session.messages.push({
    role,
    content
  });

  if (session.messages.length > AI_MAX_SESSION_MESSAGES) {
    session.messages = session.messages.slice(-AI_MAX_SESSION_MESSAGES);
  }

}

const WhatsAppAgent = require("./agents/WhatsAppAgent");
const groupConfig = require("./config/groupAllowlist");
const chatConfig = require("./config/chatAllowlist");
const {
  useNeonAuthState,
  getDatabaseUrl
} = require("./storage/neonAuthStateStore");

// Agent-specific helpers moved to agents/WhatsAppAgent.js

async function startBot() {

  printBanner();
  startHealthServer();

  const databaseUrl = getDatabaseUrl();
  const authStore = databaseUrl
    ? await useNeonAuthState("parag")
    : await useMultiFileAuthState("auth");

  const { state, saveCreds } = authStore;

  if (databaseUrl) {
    console.log("✅ Using Neon PostgreSQL for auth state storage.");
  } else {
    console.log("ℹ Using local auth/ files for auth state storage.");
  }

  const { version } =
    await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,

    auth: state,

    logger: P({
      level: "silent"
    }),

    browser: ["Ubuntu", "Chrome", "22.04.4"]
  });

  // Save creds
  sock.ev.on("creds.update", saveCreds);

  // Connection handler
  sock.ev.on("connection.update", async (update) => {

    const {
      connection,
      lastDisconnect,
      qr
    } = update;

    // Show QR
    if (qr) {

      qrcode.generate(qr, {
        small: true
      });

      console.log("📱 Scan QR");
    }

    // Connected
    if (connection === "open") {

      console.log("✅ PARAG connected.");
    }

    // Closed
    if (connection === "close") {

      const statusCode =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.statusCode;

      console.log("❌ Connection closed");
      console.log("Reason:", statusCode);

      // IMPORTANT FIX
      // 515 means restart required
      if (statusCode === 515) {

        console.log("♻ Restart required. Reconnecting...");

        setTimeout(() => {
          startBot();
        }, 3000);

      }

      // Logged out
      else if (
        statusCode === DisconnectReason.loggedOut
      ) {

        console.log("❌ Logged out.");

      }

      // Other disconnects
      else {

        console.log("♻ Reconnecting...");

        setTimeout(() => {
          startBot();
        }, 3000);
      }

    }

  });

  // Message listener
  sock.ev.on("messages.upsert", async ({ messages }) => {

    for (const msg of messages) {

      const from = msg.key?.remoteJid;
      const text = extractMessageText(msg.message)?.trim();

      if (shouldSkipMessage(msg, from, text)) {
        continue;
      }

      const command = text.toLowerCase();
      const senderId = getSenderId(msg);
      const session = getOrCreateSession(from, senderId);

      resetSessionIfExpired(session);

      // Message allowlists are enforced in shouldSkipMessage (groups and private chats).

      console.log("📩", command);

      // Ping
      if (command === "!ping") {

        await sendBotReply(sock, from, "pong 🗿");

        continue;
      }

      // Hello
      if (command === "!hello") {

        await sendBotReply(sock, from, "PARAG online and operational.");

        continue;
      }

      // Manual reset for context when user wants a fresh thread.
      if (command === "!reset") {

        session.domainUnlocked = false;
        session.messages = [];
        session.lastActiveAt = 0;

        await sendBotReply(sock, from, "Context reset for your session. Start with a new !tech or !hackathon question.");

        continue;
      }

      const userPrompt = text.slice(COMMAND_PREFIX.length).trim();

      if (!userPrompt) {
        await sendBotReply(sock, from, "Use ! followed by your question. Example: !How do I optimize API latency?");

        continue;
      }

      // Parse simple command name + args (preserve original casing in args)
      const parts = userPrompt.split(/\s+/);
      const cmdName = (parts[0] || "").toLowerCase();
      const cmdArgs = parts.slice(1);

      function isAdminAction() {
        // Allow if message is from the running client (fromMe) or listed in ADMIN_JIDS env
        if (msg.key?.fromMe) return true;
        const adminEnv = process.env.ADMIN_JIDS || "";
        const admins = adminEnv.split(',').map(s => s.trim()).filter(Boolean);
        const senderId = normalizeJid(getSenderId(msg));
        return admins.includes(senderId);
      }

      // Convenience: get JID — group or private
      if (cmdName === 'getjid') {
        if (from?.endsWith('@g.us')) {
          await sendBotReply(sock, from, `Group JID: ${from}`);
        } else {
          await sendBotReply(sock, from, `Chat JID: ${from}`);
        }
        continue;
      }

      // Convenience: reveal sender JID in private or group (useful to set ADMIN_JIDS)
      if (cmdName === 'whoami') {
        const senderId = getSenderId(msg);
        const normalized = normalizeJid(senderId);
        await sendBotReply(sock, from, `Your JID: ${senderId}\nNormalized: ${normalized}`);
        continue;
      }

      // Admin group management commands
      if (['addgroup', 'rmgroup', 'listgroups', 'addchat', 'rmchat', 'listchats'].includes(cmdName)) {
        if (!isAdminAction()) {
          await sendBotReply(sock, from, "Unauthorized: admin privileges required for that command.");
          continue;
        }

        // Group commands
        if (cmdName === 'listgroups') {
          const list = groupConfig.listGroups();
          if (!list || list.length === 0) {
            await sendBotReply(sock, from, "No groups configured (allowlist is empty).");
          } else {
            await sendBotReply(sock, from, `Allowed groups:\n${list.join('\n')}`);
          }
          continue;
        }

        if (cmdName === 'addgroup' || cmdName === 'rmgroup') {
          let target = cmdArgs[0];
          if (!target) {
            await sendBotReply(sock, from, `Usage: !${cmdName} <group-jid>`);
            continue;
          }

          target = normalizeJid(target);

          if (cmdName === 'addgroup') {
            const ok = groupConfig.addGroup(target);
            if (ok) await sendBotReply(sock, from, `Added ${target} to group allowlist.`);
            else await sendBotReply(sock, from, `Failed to add ${target}. Ensure it's a valid group JID and writable file is configured.`);
            continue;
          }

          if (cmdName === 'rmgroup') {
            const ok = groupConfig.removeGroup(target);
            if (ok) await sendBotReply(sock, from, `Removed ${target} from group allowlist.`);
            else await sendBotReply(sock, from, `Failed to remove ${target}. It may not be present.`);
            continue;
          }
        }

        // Chat commands
        if (cmdName === 'listchats') {
          const list = chatConfig.listChats();
          if (!list || list.length === 0) {
            await sendBotReply(sock, from, "No chats configured (allowlist is empty).");
          } else {
            await sendBotReply(sock, from, `Allowed chats:\n${list.join('\n')}`);
          }
          continue;
        }

        if (cmdName === 'addchat' || cmdName === 'rmchat') {
          let target = cmdArgs[0];
          if (!target) {
            await sendBotReply(sock, from, `Usage: !${cmdName} <chat-jid>`);
            continue;
          }

          target = normalizeJid(target);

          if (cmdName === 'addchat') {
            const ok = chatConfig.addChat(target);
            if (ok) await sendBotReply(sock, from, `Added ${target} to chat allowlist.`);
            else await sendBotReply(sock, from, `Failed to add ${target}. Ensure it's a valid JID and writable file is configured.`);
            continue;
          }

          if (cmdName === 'rmchat') {
            const ok = chatConfig.removeChat(target);
            if (ok) await sendBotReply(sock, from, `Removed ${target} from chat allowlist.`);
            else await sendBotReply(sock, from, `Failed to remove ${target}. It may not be present.`);
            continue;
          }
        }
      }

      const rateLimitCheck = checkAiRateLimit(from, senderId);

      if (!rateLimitCheck.allowed) {
        if (shouldSendRateLimitNotice(from, senderId, rateLimitCheck)) {
          await sendBotReply(sock, from, `Rate limit active. Please retry in ${formatRetryAfter(rateLimitCheck.retryAfterMs)}.`);
        }

        continue;
      }

      clearRateLimitNotice(from, senderId);

      try {
        // Add the user's message to the session first
        addSessionMessage(session, "user", userPrompt);

        const agentResult = await WhatsAppAgent.handleAgentMessage(session, userPrompt, GROQ_API_KEY, GROQ_MODEL, isAdminSender(msg));

        if (agentResult.domainLocked) {
          await sendBotReply(sock, from, agentResult.reply);
          continue;
        }

        if (!agentResult.usedAI) {
          // Special-case or non-AI reply (don't treat as AI session unlock)
          await sendBotReply(sock, from, agentResult.reply);
          session.lastActiveAt = Date.now();
          continue;
        }

        // AI reply used — persist and unlock session
        session.domainUnlocked = true;
        addSessionMessage(session, "assistant", agentResult.reply);
        session.lastActiveAt = Date.now();

        await sendBotReply(sock, from, agentResult.reply);
      } catch (error) {
        console.error("Groq error:", error.message);

        await sendBotReply(sock, from, "AI is temporarily unavailable. Please try again in a moment.");

      }

    }

  });

}

startBot();