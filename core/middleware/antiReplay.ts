/**
 * Anti-Replay Middleware
 *
 * Prevents processing of:
 * 1. Historical messages (> 120 seconds old) that flood in during reconnect storms
 * 2. Duplicate messages (idempotency check via Redis NX key)
 *
 * Extracted from messageRouter.ts to reduce routing complexity.
 */

import { redis } from "../../storage/redisClient";
import { logEvent } from "../../utils/logger";
import { proto } from "@whiskeysockets/baileys";

const MAX_MESSAGE_AGE_SECONDS = 120;
const IDEMPOTENCY_TTL_SECONDS = 86400; // 24 hours

/**
 * Returns true if the message should be skipped (too old).
 */
export function isHistoricalMessage(msg: proto.IWebMessageInfo): boolean {
  const messageTimestamp = msg.messageTimestamp;
  if (!messageTimestamp) return false;

  const messageAgeSeconds = Math.floor(Date.now() / 1000) - Number(messageTimestamp);
  if (messageAgeSeconds > MAX_MESSAGE_AGE_SECONDS) {
    logEvent("debug", {
      event: "historical_message_discarded",
      msgId: msg.key?.id,
      ageSeconds: messageAgeSeconds,
    });
    return true;
  }
  return false;
}

/**
 * Returns true if the message is a duplicate (already processed).
 * Uses Redis SET NX to atomically check-and-mark.
 */
export async function isDuplicateMessage(msg: proto.IWebMessageInfo): Promise<boolean> {
  if (!msg.key?.id) return false;

  const isSet = await redis.set(`msg_idemp:${msg.key.id}`, "1", "EX", IDEMPOTENCY_TTL_SECONDS, "NX");
  if (!isSet) {
    logEvent("debug", { event: "duplicate_message_dropped", msgId: msg.key.id });
    return true;
  }
  return false;
}
