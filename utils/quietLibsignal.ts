/**
 * libsignal (used by Baileys) logs straight to the global console — it
 * ignores Baileys' pino logger. After a fresh pairing or any session churn it
 * emits hundreds of "Decrypted message with closed session." / "Bad MAC"
 * lines, and "Closing session: SessionEntry {…}" dumps the ratchet's
 * PRIVATE keys into whatever log sink you have (Render, files, etc.).
 *
 * This shim drops those specific lines and prints one aggregated count per
 * minute instead, so a real problem still shows up as a rising number
 * without leaking key material or drowning the useful logs.
 */

const PREFIXES = [
  "Decrypted message with closed session.",
  "Closing session:",
  "Closing open session in favor of incoming prekey bundle",
  "Removing old closed session:",
  "Failed to decrypt message with any known session...",
  "Session error:",
  "Unhandled bucket type (for naming):",
];

const counts = new Map<string, number>();
let installed = false;
let flushTimer: NodeJS.Timeout | null = null;

/** Pure: returns the bucket name if this console call should be swallowed. */
export function classifyLibsignalLine(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first !== "string") return null;
  for (const p of PREFIXES) {
    if (first.startsWith(p)) return p.replace(/[:.]+$/, "");
  }
  return null;
}

function flush(): void {
  if (counts.size === 0) return;
  const parts: string[] = [];
  for (const [k, v] of counts) parts.push(`${k} ×${v}`);
  counts.clear();
  process.stdout.write(`[signal] last minute: ${parts.join("; ")}\n`);
}

export function installLibsignalQuiet(intervalMs = 60_000): void {
  if (installed) return;
  installed = true;
  if ((process.env.LIBSIGNAL_VERBOSE || "").toLowerCase() === "true") return;

  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const bucket = classifyLibsignalLine(args);
      if (bucket) {
        counts.set(bucket, (counts.get(bucket) || 0) + 1);
        return;
      }
      original(...args);
    };
  }
  flushTimer = setInterval(flush, intervalMs);
  flushTimer.unref();
}

/** Test hook. */
export function _flushNow(): void {
  flush();
}
