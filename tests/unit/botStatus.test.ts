import { describe, it, expect } from "vitest";
import { watchdogVerdict, type BotStatus } from "../../infrastructure/health/botStatus";

const MIN = 60_000;

function status(partial: Partial<BotStatus>): BotStatus {
  return {
    state: "starting",
    startedAt: 0,
    lastOpenAt: null,
    lastCloseAt: null,
    lastCloseCode: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    reconnectAttempts: 0,
    qr: null,
    qrAt: null,
    selfJid: null,
    ...partial,
  };
}

describe("watchdogVerdict", () => {
  it("never fires while the socket is open", () => {
    expect(watchdogVerdict(100 * MIN, 5 * MIN, status({ state: "open", lastOpenAt: 0 }))).toBeNull();
  });

  it("fires once a non-open socket has been down for staleMs", () => {
    const s = status({ state: "closed", lastOpenAt: 0, lastCloseCode: 428 });
    expect(watchdogVerdict(4 * MIN, 5 * MIN, s)).toBeNull();
    expect(watchdogVerdict(5 * MIN, 5 * MIN, s)).toMatch(/not open for 300s/);
    expect(watchdogVerdict(5 * MIN, 5 * MIN, s)).toMatch(/lastCloseCode=428/);
  });

  it("measures from the drop, not from the last open (regression: false fire after a long run)", () => {
    // Open at t=0, healthy for 49 minutes, dropped at t=49min, now t=49min+20s.
    const s = status({ state: "connecting", lastOpenAt: 0, lastCloseAt: 49 * MIN, lastCloseCode: 428 });
    expect(watchdogVerdict(49 * MIN + 20_000, 5 * MIN, s)).toBeNull();
    expect(watchdogVerdict(54 * MIN, 5 * MIN, s)).not.toBeNull();
  });

  it("uses startedAt as the reference when the socket never opened", () => {
    const s = status({ state: "connecting", startedAt: 10 * MIN });
    expect(watchdogVerdict(14 * MIN, 5 * MIN, s)).toBeNull();
    expect(watchdogVerdict(15 * MIN, 5 * MIN, s)).not.toBeNull();
  });

  it("stays quiet when logged out — a restart cannot fix a revoked session", () => {
    const s = status({ state: "logged_out", lastOpenAt: 0 });
    expect(watchdogVerdict(60 * MIN, 5 * MIN, s)).toBeNull();
  });

  it("stays quiet while a QR is pending so pairing isn't interrupted", () => {
    const s = status({ state: "connecting", startedAt: 0, qr: "2@abc", qrAt: 0 });
    expect(watchdogVerdict(60 * MIN, 5 * MIN, s)).toBeNull();
  });
});
