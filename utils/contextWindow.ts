import { redis } from "../storage/redisClient";

export interface CachedMessage {
  msgId: string;
  sender: string;
  senderName: string;
  text: string;
  timestamp: number;
}

const CONTEXT_TTL = 7 * 24 * 60 * 60; // 7 days
const MAX_CACHED = 100;

export async function cacheMessageForContext(
  from: string,
  msgId: string,
  senderName: string,
  text: string,
  timestamp: number,
): Promise<void> {
  if (!from || !text) return;
  const key = `chat_history:${from}`;
  const entry: CachedMessage = { msgId, sender: from, senderName, text, timestamp };
  try {
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, MAX_CACHED - 1);
    await redis.expire(key, CONTEXT_TTL);
  } catch (err) {
    console.warn("[ContextWindow] Failed to cache message:", err);
  }
}

export async function getContextFromMessage(
  from: string,
  fromMsgId: string,
  maxMessages: number = 30,
): Promise<CachedMessage[]> {
  const key = `chat_history:${from}`;
  try {
    const raw = await redis.lrange(key, 0, MAX_CACHED - 1);
    const messages: CachedMessage[] = raw
      .map((r) => { try { return JSON.parse(r) as CachedMessage; } catch { return null; } })
      .filter((m): m is CachedMessage => m !== null);

    // messages are newest-first from LPUSH
    const idx = messages.findIndex((m) => m.msgId === fromMsgId);
    if (idx === -1) return messages.slice(0, maxMessages);
    return messages.slice(0, idx + 1).slice(0, maxMessages);
  } catch (err) {
    console.warn("[ContextWindow] Failed to get context:", err);
    return [];
  }
}

export async function getRecentMessages(
  from: string,
  count: number = 20,
): Promise<CachedMessage[]> {
  const key = `chat_history:${from}`;
  try {
    const raw = await redis.lrange(key, 0, count - 1);
    return raw
      .map((r) => { try { return JSON.parse(r) as CachedMessage; } catch { return null; } })
      .filter((m): m is CachedMessage => m !== null);
  } catch (err) {
    console.warn("[ContextWindow] Failed to get recent messages:", err);
    return [];
  }
}
