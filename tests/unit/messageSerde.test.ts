import { describe, it, expect } from "vitest";
import { serializeWAMessage, deserializeWAMessage } from "../../utils/messageSerde";

describe("WA message serde", () => {
  it("round-trips a view-once image with its mediaKey intact", () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i * 7 % 256);
    const msg: any = {
      key: { remoteJid: "111@g.us", id: "ABC123", fromMe: false, participant: "919000000001@s.whatsapp.net" },
      messageTimestamp: 1789966947,
      message: {
        viewOnceMessageV2: {
          message: {
            imageMessage: {
              url: "https://mmg.whatsapp.net/x",
              directPath: "/v/x",
              mimetype: "image/jpeg",
              mediaKey: key,
              fileSha256: Uint8Array.from([1, 2, 3]),
              fileEncSha256: Uint8Array.from([4, 5, 6]),
            },
          },
        },
      },
    };
    const json = serializeWAMessage(msg);
    expect(json).not.toContain('"0":'); // no Uint8Array-as-object leak
    const back: any = deserializeWAMessage(json);
    const img = back.message.viewOnceMessageV2.message.imageMessage;
    expect(Buffer.from(img.mediaKey).equals(Buffer.from(key))).toBe(true);
    expect(img.mediaKey.length).toBe(32);
    expect(img.url).toBe("https://mmg.whatsapp.net/x");
    expect(back.key.id).toBe("ABC123");
  });
});
