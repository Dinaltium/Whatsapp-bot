/**
 * Help scoping, cooldown, and role-gating for the `!help` command.
 *
 * Behaviour (non-admin group/chat members):
 *   1. Scope   — a member only ever sees the help for the bot assigned to THEIR
 *                chat. No bot number is specified; buildHelpText() renders the
 *                right one.
 *   2. Cooldown — a given chat can view its bot's help once per HELP_COOLDOWN
 *                window, and at most HELP_BOT_BUDGET distinct chats may view the
 *                same bot's help within a window. The next chat waits until a
 *                slot frees. This curbs spam/abuse without a hard block.
 *   3. Role    — mentors (mentor.manage) additionally see the mentor command
 *                block; everyone else sees a "you don't have access" note.
 *
 * The owner (admin) is never gated and may point at any bot with `!help -id`.
 * The gate fails OPEN on any Redis error — help is never blocked by infra.
 */
import { getBotRegistry } from "../../agents/WhatsAppAgent";
import { DKB_MENTOR_HELP_TEXT } from "../../agents/DKB/intro";

export const HELP_COOLDOWN_MS = 12 * 60 * 1000; // ~12 min per chat + per bot
export const HELP_BOT_BUDGET = 2; // distinct chats allowed per bot per window

export interface HelpGateResult {
  allowed: boolean;
  waitMin?: number;
  reason?: "cooldown" | "busy";
}

/**
 * Rate-limits non-admin help. Uses one Redis sorted set per bot, member = chat
 * JID, score = request time. Members older than the window are pruned each call,
 * so the set is effectively "distinct chats that viewed this bot's help within
 * the last window".
 *   - chat already in the set          → on cooldown (reason: "cooldown")
 *   - set already at HELP_BOT_BUDGET    → bot busy for a 3rd chat (reason: "busy")
 *   - otherwise                         → allowed, chat recorded
 */
export async function checkHelpGate(
  botNumber: number,
  chatJid: string,
): Promise<HelpGateResult> {
  const key = `help:budget:bot:${botNumber}`;
  const now = Date.now();
  const cutoff = now - HELP_COOLDOWN_MS;
  try {
    const { redis } = await import("../../storage/redisClient");
    await redis.zremrangebyscore(key, 0, cutoff);

    const own = await redis.zscore(key, chatJid);
    if (own) {
      const waitMin = Math.max(
        1,
        Math.ceil((Number(own) + HELP_COOLDOWN_MS - now) / 60000),
      );
      return { allowed: false, waitMin, reason: "cooldown" };
    }

    const count = await redis.zcard(key);
    if (count >= HELP_BOT_BUDGET) {
      const earliest = await redis.zrange(key, 0, 0, "WITHSCORES");
      const freeAt =
        earliest.length >= 2
          ? Number(earliest[1]) + HELP_COOLDOWN_MS
          : now + HELP_COOLDOWN_MS;
      const waitMin = Math.max(1, Math.ceil((freeAt - now) / 60000));
      return { allowed: false, waitMin, reason: "busy" };
    }

    await redis.zadd(key, now, chatJid);
    await redis.pexpire(key, HELP_COOLDOWN_MS);
    return { allowed: true };
  } catch (err) {
    // Fail open — a rate limiter must never take help down with it.
    console.warn("[helpService] gate check failed, allowing:", err);
    return { allowed: true };
  }
}

/**
 * Renders the help text for a given bot. Bot 2 (DKB) gets a mentor section:
 * mentors see the full command block, everyone else a locked note.
 */
export function buildHelpText(
  botNumber: number,
  opts: { isMentor: boolean },
): string {
  const registry = getBotRegistry();
  const bot = registry.find((b) => b.botId === botNumber) || registry[0];
  let text = bot.getHelpText();

  if (bot.botId === 2) {
    text +=
      "\n\n" +
      (opts.isMentor
        ? DKB_MENTOR_HELP_TEXT
        : "Mentor commands (require the mentor role — you don't have access):\n" +
          "• !addmentor · !editmentor · !rmmentor");
  }
  return text;
}
