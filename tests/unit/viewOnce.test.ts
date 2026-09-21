import { describe, it, expect } from "vitest";
import { getViewOnceMedia, getAnyMedia, hasMediaKey } from "../../utils/viewOnce";

const img = { url: "u", mediaKey: Uint8Array.from([1, 2, 3]), mimetype: "image/jpeg" };

describe("getViewOnceMedia", () => {
  it("detects viewOnceMessage / V2 / V2Extension wrappers", () => {
    expect(getViewOnceMedia({ viewOnceMessage: { message: { imageMessage: img } } })?.kind).toBe("image");
    expect(getViewOnceMedia({ viewOnceMessageV2: { message: { videoMessage: { ...img } } } })?.kind).toBe("video");
    expect(getViewOnceMedia({ viewOnceMessageV2Extension: { message: { audioMessage: { ...img } } } } as any)?.kind).toBe("audio");
  });
  it("detects the flat viewOnce flag on media", () => {
    expect(getViewOnceMedia({ imageMessage: { ...img, viewOnce: true } })?.kind).toBe("image");
    expect(getViewOnceMedia({ videoMessage: { ...img, viewOnce: true } })?.kind).toBe("video");
  });
  it("sees through ephemeral (disappearing-chat) wrapping", () => {
    expect(getViewOnceMedia({ ephemeralMessage: { message: { viewOnceMessageV2: { message: { imageMessage: img } } } } })?.kind).toBe("image");
    expect(getViewOnceMedia({ ephemeralMessage: { message: { imageMessage: { ...img, viewOnce: true } } } })?.kind).toBe("image");
  });
  it("ignores ordinary media and text", () => {
    expect(getViewOnceMedia({ imageMessage: img })).toBeNull();
    expect(getViewOnceMedia({ conversation: "hi" })).toBeNull();
    expect(getViewOnceMedia(null)).toBeNull();
  });
  it("returns the unwrapped inner message for download", () => {
    const r = getViewOnceMedia({ viewOnceMessageV2: { message: { imageMessage: img } } })!;
    expect(r.inner.imageMessage).toBe(img);
  });
});

describe("getAnyMedia / hasMediaKey", () => {
  it("finds plain media too (for the quoted-copy fallback)", () => {
    expect(getAnyMedia({ documentMessage: { ...img } })?.kind).toBe("document");
  });
  it("knows when a quoted copy has had its key stripped", () => {
    expect(hasMediaKey(img)).toBe(true);
    expect(hasMediaKey({ url: "u" })).toBe(false);
    expect(hasMediaKey({ mediaKey: new Uint8Array(0) })).toBe(false);
    expect(hasMediaKey({ mediaKey: "" })).toBe(false);
    expect(hasMediaKey({ mediaKey: "AQID" })).toBe(true);
  });
});
