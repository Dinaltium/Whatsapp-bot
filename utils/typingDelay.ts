/**
 * Shared Typing Delay Calculator
 *
 * Computes a natural-looking typing delay based on response length.
 * Used by both sendBotReply (bot.ts) and the outgoing reply worker
 * to simulate human-like typing presence before sending a message.
 */

// Reading/thinking pause before "typing" begins.
const BASE_MIN_MS = 1200;
const BASE_JITTER_MS = 1500; // base is BASE_MIN..BASE_MIN+JITTER

// Typing speed: full rate up to a knee, then a slower rate so long responses
// keep scaling with length instead of being hard-chopped to a flat ceiling
// (a fixed cap made long AI replies look suspiciously fast for their size).
const FULL_RATE_MS_PER_CHAR = 20;
const KNEE_CHARS = 800; // ~16s of typing before growth slows
const SLOW_RATE_MS_PER_CHAR = 7;

// Hard ceiling, with jitter so it never reads as a fixed constant to WhatsApp.
const CEILING_MIN_MS = 45000;
const CEILING_JITTER_MS = 10000; // ceiling is 45s..55s

/**
 * Calculates a dynamic delay in milliseconds that simulates human typing.
 *
 * The curve is piecewise-linear: `FULL_RATE_MS_PER_CHAR` per character up to
 * `KNEE_CHARS`, then `SLOW_RATE_MS_PER_CHAR` beyond it, clamped to a jittered
 * 45–55s ceiling. Length keeps influencing the delay well past the old flat
 * 20–30s cap, so a long reply no longer appears typed faster than a short one.
 *
 * @param text - The text content being "typed"
 * @returns Delay in milliseconds (bounded at ~45-55s)
 */
export function calculateTypingDelay(text: string): number {
  const textLength = String(text || "").length;
  const baseDelay = Math.floor(Math.random() * BASE_JITTER_MS) + BASE_MIN_MS;

  let charDelay: number;
  if (textLength <= KNEE_CHARS) {
    charDelay = textLength * FULL_RATE_MS_PER_CHAR;
  } else {
    charDelay =
      KNEE_CHARS * FULL_RATE_MS_PER_CHAR +
      (textLength - KNEE_CHARS) * SLOW_RATE_MS_PER_CHAR;
  }

  let totalDelay = baseDelay + charDelay;

  const maxDelayCap =
    Math.floor(Math.random() * CEILING_JITTER_MS) + CEILING_MIN_MS;
  if (totalDelay > maxDelayCap) {
    totalDelay = maxDelayCap;
  }

  return totalDelay;
}
