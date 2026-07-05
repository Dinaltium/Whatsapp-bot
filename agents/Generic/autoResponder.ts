/**
 * Generic-bot auto-responder for the owner's personal number (PATCHES Fix #1).
 *
 * Handles 1:1 DMs that are NOT a configured (allowlisted) bot chat — i.e. people
 * messaging the owner directly. Heavily restricted by design:
 *   - Saved contacts only. Unknown numbers get nothing (ban-safety).
 *   - Two response modes, sharing a per-number 3/day budget (24h sliding):
 *       a. Offline greeting — a non-`!` message gets ONE canned "owner is away"
 *          reply, and only when the owner is offline and it's their first
 *          response of the day.
 *       b. `!<message>` — a short, generic small-talk reply (never real answers).
 *   - After the daily budget is spent, the bot goes silent for that number.
 *   - Owner "online" is inferred from recent owner activity (any message the
 *     owner sends — including from WhatsApp Web — arrives here as fromMe).
 *
 * !reset and !help are always allowed and never counted.
 */
import { getSession, saveSession } from "../../core/state";
import { buildSessionKey, sendBotReply, GROQ_MODEL } from "../../bot";
import chatConfig from "../../config/chatAllowlist";
import { getGroqReply } from "../../ai/groqClient";
import { GENERIC_SYSTEM_PROMPT, GENERIC_HELP_TEXT } from "./intro";
import { decideGenericAction } from "./genericPolicy";

const ONLINE_WINDOW_MS = Number(process.env.OWNER_ONLINE_WINDOW_MS) || 5 * 60 * 1000;
const DAILY_LIMIT = Number(process.env.GENERIC_DAILY_LIMIT) || 3;
const OWNER_NAME = process.env.OWNER_NAME || "the owner";

// ── Owner presence (activity proxy) ─────────────────────────────────────────
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
    const v = await redis.get("owner:last_active");
    if (!v) return false;
    return Date.now() - Number(v) < ONLINE_WINDOW_MS;
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

// ── Daily budget (per number, 24h sliding) ──────────────────────────────────
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
    if (n === 1) await redis.expire(`generic:count:${jid}`, 86400);
    return n;
  } catch {
    return DAILY_LIMIT; // fail closed — don't over-respond on Redis error
  }
}

function footer(remaining: number): string {
  const r = Math.max(0, remaining);
  return `\n\n_Beep bop — I'm ${OWNER_NAME}'s bot. Send !<message> to talk to me. ${r} ${r === 1 ? "reply" : "replies"} left today._`;
}

function cannedGreeting(): string {
  return `Hey! ${OWNER_NAME} isn't available right now — he'll get back to you soon. (I'm his auto-reply bot.)`;
}

async function genericReply(
  session: any,
  userMsg: string,
  groqApiKey: string | undefined,
): Promise<string> {
  if (!groqApiKey) {
    return `I'm ${OWNER_NAME}'s bot — he'll get back to you soon.`;
  }
  try {
    const messages = [
      ...(session.messages || []).slice(-4),
      { role: "user" as const, content: userMsg },
    ];
    return await getGroqReply(messages, groqApiKey, GROQ_MODEL, GENERIC_SYSTEM_PROMPT);
  } catch {
    return `I'm ${OWNER_NAME}'s bot — I can't help with that, but ${OWNER_NAME} will get back to you.`;
  }
}

export interface GenericInboundArgs {
  sock: any;
  from: string;
  senderId: string;
  text: string | null;
  isAdmin: boolean;
  groqApiKey: string | undefined;
}

/**
 * Returns true if this DM was handled by the generic auto-responder (caller must
 * then stop processing). Returns false to let the normal command flow run.
 */
export async function handleGenericInbound(a: GenericInboundArgs): Promise<boolean> {
  const { sock, from, senderId, isAdmin, groqApiKey } = a;
  const text = (a.text || "").trim();

  // Cheap pre-checks before any I/O (also short-circuits the common cases).
  if (!from || from.endsWith("@g.us") || from === "status@broadcast") return false;
  if (isAdmin || !text || text.startsWith("!!")) return false;
  if (chatConfig.isChatAllowed(from)) return false;

  const isSaved = await isSavedContact(senderId, from);
  if (!isSaved) return false; // not saved → let normal flow ignore it

  const jidKey = senderId || from;
  const count = await getCount(jidKey);
  const ownerOnline = text.startsWith("!") ? false : await isOwnerOnline();

  const action = decideGenericAction({
    isGroup: false,
    isBroadcast: false,
    isAdmin,
    isAllowlisted: false,
    isSaved,
    text,
    count,
    limit: DAILY_LIMIT,
    ownerOnline,
  });

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
      await sendBotReply(sock, from, reply + footer(DAILY_LIMIT - n));
      return true;
    }
    case "greet": {
      const n = await incrCount(jidKey);
      await sendBotReply(sock, from, cannedGreeting() + footer(DAILY_LIMIT - n));
      return true;
    }
  }
}
