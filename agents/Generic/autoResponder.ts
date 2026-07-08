/**
 * Generic-bot auto-responder for the owner's personal number (PATCHES Fix #1 + #2).
 *
 * Handles 1:1 DMs that are NOT a configured (allowlisted) bot chat — i.e. people
 * messaging the owner directly. Only ever acts while the owner is AWAY:
 *   - Owner "online" = active at their desk (laptop-notifier presence ping) OR
 *     a recent message the owner sent (activity proxy, incl. WhatsApp Web).
 *     While online the bot stays fully silent.
 *   - While away, per number, a shared budget (GENERIC_MSG_LIMIT per
 *     GENERIC_WINDOW_HOURS):
 *       a. a non-command message → ONE professional offline greeting (first of
 *          the window only);
 *       b. `!chat <text>` → a short, restricted small-talk reply.
 *   - Every inbound message received while away also fires a laptop
 *     notification (severity-classified), rate-limited per sender.
 *   - Each message id is handled once (no double replies).
 *
 * !reset and !help always work and are never counted.
 */
import { getSession, saveSession } from "../../core/state";
import { buildSessionKey, sendBotReply, safeGetContactName, GROQ_MODEL } from "../../bot";
import chatConfig from "../../config/chatAllowlist";
import { getGroqReply } from "../../ai/groqClient";
import { GENERIC_SYSTEM_PROMPT, GENERIC_HELP_TEXT } from "./intro";
import { decideGenericAction } from "./genericPolicy";
import { logStructured, getJidHash } from "../../utils/logger";

const ACTIVITY_WINDOW_MS = Number(process.env.OWNER_ONLINE_WINDOW_MS) || 30 * 1000;
const DESK_WINDOW_MS = Number(process.env.OWNER_DESK_WINDOW_MS) || 20 * 1000;
const MSG_LIMIT = Number(process.env.GENERIC_MSG_LIMIT) || 5;
const WINDOW_SEC = (Number(process.env.GENERIC_WINDOW_HOURS) || 4) * 3600;
const NOTIFY_COOLDOWN_SEC = Number(process.env.NOTIFY_PER_SENDER_COOLDOWN_SEC) || 300;
const OWNER_NAME = process.env.OWNER_NAME || "the owner";
const REPLY_AUDIENCE = (process.env.GENERIC_REPLY_AUDIENCE || "all").toLowerCase();

// ── Owner presence ──────────────────────────────────────────────────────────
export async function recordOwnerActivity(): Promise<void> {
  try {
    const { redis } = await import("../../storage/redisClient");
    await redis.set("owner:last_active", Date.now().toString(), "EX", 86400);
  } catch {
    /* non-fatal */
  }
}

async function isOwnerOnline(): Promise<boolean> {
  try {
    const { redis } = await import("../../storage/redisClient");
    // Desk presence (published by laptop-notifier) is authoritative — catches
    // "app open but idle", which the send-based proxy cannot.
    const desk = await redis.get("owner:desk_active");
    if (desk && Date.now() - Number(desk) < DESK_WINDOW_MS) return true;
    const active = await redis.get("owner:last_active");
    if (active && Date.now() - Number(active) < ACTIVITY_WINDOW_MS) return true;
    return false;
  } catch {
    return false;
  }
}

// ── Saved-contact tracking (populated from address-book sync) ────────────────
export async function markSavedContact(
  jids: (string | null | undefined)[],
): Promise<void> {
  const list = jids.filter((j): j is string => !!j);
  if (!list.length) return;
  try {
    const { redis } = await import("../../storage/redisClient");
    await redis.sadd("saved_contacts", ...list);
  } catch {
    /* non-fatal */
  }
}

async function isSavedContact(...jids: (string | null | undefined)[]): Promise<boolean> {
  try {
    const { redis } = await import("../../storage/redisClient");
    for (const j of jids) {
      if (j && (await redis.sismember("saved_contacts", j)) === 1) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Per-number budget (sliding window) ──────────────────────────────────────
async function getCount(jid: string): Promise<number> {
  try {
    const { redis } = await import("../../storage/redisClient");
    const v = await redis.get(`generic:count:${jid}`);
    return v ? Number(v) : 0;
  } catch {
    return 0;
  }
}

async function incrCount(jid: string): Promise<number> {
  try {
    const { redis } = await import("../../storage/redisClient");
    const n = await redis.incr(`generic:count:${jid}`);
    if (n === 1) await redis.expire(`generic:count:${jid}`, WINDOW_SEC);
    return n;
  } catch {
    return MSG_LIMIT; // fail closed — don't over-respond on Redis error
  }
}

/** Claims a message id so it's processed exactly once (no double replies). */
async function claimMessage(msgId: string | undefined): Promise<boolean> {
  if (!msgId) return true;
  try {
    const { redis } = await import("../../storage/redisClient");
    const ok = await redis.set(`generic:seen:${msgId}`, "1", "EX", 120, "NX");
    return ok === "OK";
  } catch {
    return true; // fail open — a Redis blip shouldn't drop the reply entirely
  }
}

function footer(remaining: number, withInstruction: boolean): string {
  const r = Math.max(0, remaining);
  const count = `(${r} ${r === 1 ? "reply" : "replies"} remaining.)`;
  if (!withInstruction) return `\n\n${count}`;
  return `\n\nTo reach the assistant, start your message with "!chat" — for example: !chat hello. ${count}`;
}

function cannedGreeting(): string {
  return `Hi — ${OWNER_NAME} is away at the moment and will reply when they are back. This is an automated message.`;
}

async function genericReply(
  session: any,
  userMsg: string,
  groqApiKey: string | undefined,
): Promise<string> {
  if (!groqApiKey) {
    return `${OWNER_NAME} is away and will reply when back. This is an automated assistant.`;
  }
  try {
    const messages = [
      ...(session.messages || []).slice(-4),
      { role: "user" as const, content: userMsg },
    ];
    return await getGroqReply(messages, groqApiKey, GROQ_MODEL, GENERIC_SYSTEM_PROMPT);
  } catch {
    return `I am an automated assistant and cannot help with that, but ${OWNER_NAME} will get back to you.`;
  }
}

/**
 * Fire-and-forget: classify urgency + push a laptop toast for a message the
 * owner didn't personally see (they were away). Rate-limited per sender so a
 * burst doesn't spam the laptop or the classifier. Never awaited by the reply
 * path.
 */
function notifyOwner(from: string, senderId: string, text: string, groqApiKey: string | undefined): void {
  (async () => {
    try {
      const { redis } = await import("../../storage/redisClient");
      const cdKey = `notify:cd:${senderId || from}`;
      const ok = await redis.set(cdKey, "1", "EX", NOTIFY_COOLDOWN_SEC, "NX");
      if (ok !== "OK") return; // within cooldown — skip

      const { classifySeverity } = await import("../../services/notify/severityClassifier");
      const { publishLaptopNotification } = await import("../../services/notify/laptopNotify");
      const [senderName, { severity, reason }] = await Promise.all([
        safeGetContactName(senderId || from),
        classifySeverity(text, groqApiKey),
      ]);
      await publishLaptopNotification({
        senderName,
        preview: text.slice(0, 200),
        severity,
        reason,
      });
    } catch (err) {
      console.warn("[Generic] notifyOwner failed:", err);
    }
  })();
}

export interface GenericInboundArgs {
  sock: any;
  from: string;
  senderId: string;
  text: string | null;
  isAdmin: boolean;
  groqApiKey: string | undefined;
  msgId?: string;
}

/**
 * Returns true if this DM was handled by the generic auto-responder (caller must
 * then stop processing). Returns false to let the normal command flow run.
 */
export async function handleGenericInbound(a: GenericInboundArgs): Promise<boolean> {
  const { sock, from, senderId, isAdmin, groqApiKey } = a;
  const text = (a.text || "").trim();

  // Cheap pre-checks before any I/O.
  if (!from || from.endsWith("@g.us") || from === "status@broadcast") return false;
  if (isAdmin || !text || text.startsWith("!!")) return false;

  // Bot 0 is the always-available small-talk / auto-reply layer, reached via
  // `!chat`. In a configured (bot 1/2/3) chat, ONLY `!chat` goes to bot 0 —
  // every other message is handled by that chat's assigned bot. In an
  // unconfigured DM, bot 0 handles everything (greeting, !chat, !reset, !help).
  const isChatCmd = text.toLowerCase().startsWith("!chat");
  if (chatConfig.isChatAllowed(from) && !isChatCmd) return false;

  const requireSaved = REPLY_AUDIENCE === "saved";
  const isSaved = requireSaved ? await isSavedContact(senderId, from) : true;
  if (requireSaved && !isSaved) {
    logStructured({
      event: "generic_autoresponder",
      reason: "skip_not_saved",
      chatHash: getJidHash(from),
      senderHash: getJidHash(senderId),
    });
    return false;
  }

  const jidKey = senderId || from;
  const online = await isOwnerOnline();
  const count = await getCount(jidKey);
  const action = decideGenericAction({
    isGroup: false,
    isBroadcast: false,
    isAdmin,
    isAllowlisted: false,
    isSaved,
    text,
    count,
    limit: MSG_LIMIT,
    ownerOnline: online,
  });

  logStructured({
    event: "generic_autoresponder",
    reason: action.type,
    chatHash: getJidHash(from),
    count,
    ownerOnline: online,
    isCommand: text.startsWith("!"),
  });

  // Handle each message id once — prevents any double reply/notification.
  if (!(await claimMessage(a.msgId))) return true;

  // Notify the owner about a real inbound message received while they were
  // away (regardless of whether the bot replied). Utility commands don't count.
  if (
    !online &&
    (action.type === "greet" || action.type === "reply" || action.type === "silent")
  ) {
    notifyOwner(from, senderId, text, groqApiKey);
  }

  const sessionKey = buildSessionKey(from, senderId);
  switch (action.type) {
    case "pass":
      return false;
    case "silent":
      return true;
    case "reset": {
      const session = await getSession(sessionKey);
      session.messages = [];
      session.domainUnlocked = false;
      session.lastActiveAt = 0;
      await saveSession(sessionKey, session);
      await sendBotReply(sock, from, "Your conversation context has been cleared.");
      return true;
    }
    case "help":
      await sendBotReply(sock, from, GENERIC_HELP_TEXT);
      return true;
    case "reply": {
      const session = await getSession(sessionKey);
      const reply = await genericReply(session, action.userMsg, groqApiKey);
      const n = await incrCount(jidKey);
      await sendBotReply(sock, from, reply + footer(MSG_LIMIT - n, false));
      return true;
    }
    case "greet": {
      const n = await incrCount(jidKey);
      await sendBotReply(sock, from, cannedGreeting() + footer(MSG_LIMIT - n, true));
      return true;
    }
  }
}
