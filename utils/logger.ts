import { createHash } from "crypto";

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

const levels = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: keyof typeof levels): boolean {
  const currentLevel = (levels[LOG_LEVEL as keyof typeof levels] !== undefined ? LOG_LEVEL : "info") as keyof typeof levels;
  return levels[level] >= levels[currentLevel];
}

export function getJidHash(jid?: string | null): string {
  if (!jid) return "unknown";
  return createHash("sha256").update(jid).digest("hex").substring(0, 8);
}

export function logEvent(
  level: keyof typeof levels,
  data: Record<string, any>,
): void {
  if (!shouldLog(level)) return;

  console.log(
    JSON.stringify({
      level,
      timestamp: new Date().toISOString(),
      ...data,
    }),
  );
}

// Backwards compatibility fallback wrapping logEvent at info level
export function logStructured(data: Record<string, any>): void {
  logEvent("info", data);
}
