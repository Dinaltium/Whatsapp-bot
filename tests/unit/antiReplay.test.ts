import { describe, it, expect } from "vitest";
import { isHistoricalMessage } from "../../core/middleware/antiReplay";
import { proto } from "@whiskeysockets/baileys";

function makeMsg(messageTimestamp: number | null): proto.IWebMessageInfo {
  return {
    key: { id: "test-id", remoteJid: "1234@s.whatsapp.net" },
    messageTimestamp: messageTimestamp ?? undefined,
  } as proto.IWebMessageInfo;
}

describe("antiReplay - isHistoricalMessage", () => {
  it("returns true for message 3 minutes old", () => {
    const threeMinutesAgo = Math.floor((Date.now() - 3 * 60 * 1000) / 1000);
    const msg = makeMsg(threeMinutesAgo);
    expect(isHistoricalMessage(msg)).toBe(true);
  });

  it("returns false for message 30 seconds old", () => {
    const thirtySecondsAgo = Math.floor((Date.now() - 30 * 1000) / 1000);
    const msg = makeMsg(thirtySecondsAgo);
    expect(isHistoricalMessage(msg)).toBe(false);
  });

  it("returns false for message with no timestamp", () => {
    const msg = makeMsg(null);
    expect(isHistoricalMessage(msg)).toBe(false);
  });
});
