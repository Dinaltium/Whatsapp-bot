/**
 * Shared Typing Delay Calculator
 *
 * Computes a natural-looking typing delay based on response length.
 * Used by both sendBotReply (bot.ts) and the outgoing reply worker
 * to simulate human-like typing presence before sending a message.
 */

/**
 * Calculates a dynamic delay in milliseconds that simulates human typing.
 * @param text - The text content being "typed"
 * @returns Delay in milliseconds (capped at 20-30 seconds)
 */
export function calculateTypingDelay(text: string): number {
  const textLength = String(text || "").length;
  const baseDelay = Math.floor(Math.random() * 1500) + 1200; // 1200ms to 2700ms base (reading/thinking delay)
  const charDelay = textLength * 20; // 20ms per character of typing speed
  let totalDelay = baseDelay + charDelay;

  // Cap total typing duration at 20-30 seconds (randomized ceiling)
  const maxDelayCap = Math.floor(Math.random() * 10000) + 20000; // 20000ms to 30000ms
  if (totalDelay > maxDelayCap) {
    totalDelay = maxDelayCap;
  }

  return totalDelay;
}
