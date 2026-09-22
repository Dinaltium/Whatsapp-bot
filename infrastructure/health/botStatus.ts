/**
 * In-process view of the WhatsApp socket's health, plus a watchdog.
 *
 * bot.ts pushes transitions in here from `connection.update`; the health
 * server and admin dashboard read from it. Nothing here touches Baileys
 * directly so it stays trivially unit-testable.
 *
 * Watchdog: Render only restarts the process when it *exits*. A socket that
 * hangs in "connecting" forever never exits, so the bot goes silently dark.
 * If we have not been "open" for WATCHDOG_STALE_MS (default 5 min) and we are
 * not deliberately parked waiting for a human (logged out / banned), exit(1)
 * so the platform restarts us. Logged-out state is exempt: auto-restarting
 * there would just loop QR generation and trip WhatsApp's fraud heuristics.
 */

export type ConnectionState = "starting" | "connecting" | "open" | "closed" | "logged_out";

export interface BotStatus {
  state: ConnectionState;
  startedAt: number;
  lastOpenAt: number | null;
  lastCloseAt: number | null;
  lastCloseCode: number | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  reconnectAttempts: number;
  qr: string | null;
  qrAt: number | null;
  selfJid: string | null;
}

const status: BotStatus = {
  state: "starting",
  startedAt: Date.now(),
  lastOpenAt: null,
  lastCloseAt: null,
  lastCloseCode: null,
  lastInboundAt: null,
  lastOutboundAt: null,
  reconnectAttempts: 0,
  qr: null,
  qrAt: null,
  selfJid: null,
};

export function getBotStatus(): Readonly<BotStatus> {
  return status;
}

export function markConnecting(): void {
  status.state = "connecting";
}

export function markOpen(selfJid?: string | null): void {
  status.state = "open";
  status.lastOpenAt = Date.now();
  status.reconnectAttempts = 0;
  status.qr = null;
  status.qrAt = null;
  if (selfJid) status.selfJid = selfJid;
}

export function markClosed(code: number | null | undefined, loggedOut: boolean): void {
  status.state = loggedOut ? "logged_out" : "closed";
  status.lastCloseAt = Date.now();
  status.lastCloseCode = typeof code === "number" ? code : null;
}

export function markReconnectAttempt(attempt: number): void {
  status.reconnectAttempts = attempt;
  status.state = "connecting";
}

export function setQr(qr: string): void {
  status.qr = qr;
  status.qrAt = Date.now();
  // A QR means the socket has no valid session — not "open" by any measure.
  if (status.state === "open") status.state = "connecting";
}

export function markInbound(): void {
  status.lastInboundAt = Date.now();
}

export function markOutbound(): void {
  status.lastOutboundAt = Date.now();
}

/** True when the socket is usable — what /health should report 200 on. */
export function isHealthy(): boolean {
  return status.state === "open";
}

/**
 * Pure decision function so the watchdog is testable without timers.
 * Returns a reason string when the process should exit, else null.
 */
export function watchdogVerdict(now: number, staleMs: number, s: Readonly<BotStatus> = status): string | null {
  if (s.state === "open") return null;
  if (s.state === "logged_out") return null; // needs a human + QR, restarting won't help
  if (s.qr) return null; // pairing in progress — restarting would just churn QR codes
  // Measure from when we went DOWN, not from when we last came up — otherwise
  // a drop after a long healthy run trips the watchdog on the very next tick.
  const wentDownAt =
    s.lastCloseAt !== null && (s.lastOpenAt === null || s.lastCloseAt >= s.lastOpenAt)
      ? s.lastCloseAt
      : s.lastOpenAt ?? s.startedAt;
  const downFor = now - wentDownAt;
  if (downFor >= staleMs) {
    return `socket not open for ${Math.round(downFor / 1000)}s (state=${s.state}, lastCloseCode=${s.lastCloseCode ?? "n/a"})`;
  }
  return null;
}

let watchdogTimer: NodeJS.Timeout | null = null;

export function startWatchdog(opts?: { staleMs?: number; intervalMs?: number; exit?: (code: number) => void }): void {
  if (watchdogTimer) return;
  const staleMs = opts?.staleMs ?? Number(process.env.WATCHDOG_STALE_MS || 5 * 60 * 1000);
  const intervalMs = opts?.intervalMs ?? 30 * 1000;
  const exit = opts?.exit ?? ((code: number) => process.exit(code));
  if (staleMs <= 0) {
    console.log("[watchdog] disabled (WATCHDOG_STALE_MS <= 0)");
    return;
  }
  watchdogTimer = setInterval(() => {
    const reason = watchdogVerdict(Date.now(), staleMs);
    if (reason) {
      console.error(`[watchdog] ${reason} — exiting so the platform restarts us.`);
      exit(1);
    }
  }, intervalMs);
  // Don't keep the event loop alive on our account (tests, graceful exits).
  watchdogTimer.unref();
  console.log(`[watchdog] armed: exit if socket not open for ${Math.round(staleMs / 1000)}s`);
}

export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}
