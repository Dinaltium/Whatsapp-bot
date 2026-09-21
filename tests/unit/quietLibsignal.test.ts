import { describe, it, expect } from "vitest";
import { classifyLibsignalLine } from "../../utils/quietLibsignal";

describe("classifyLibsignalLine", () => {
  it("swallows the known libsignal chatter", () => {
    expect(classifyLibsignalLine(["Decrypted message with closed session."])).toBe("Decrypted message with closed session");
    expect(classifyLibsignalLine(["Closing session:", { privKey: "x" }])).toBe("Closing session");
    expect(classifyLibsignalLine(["Session error:Error: Bad MAC Error: Bad MAC", "stack"])).toBe("Session error");
    expect(classifyLibsignalLine(["Failed to decrypt message with any known session..."])).toBe("Failed to decrypt message with any known session");
  });
  it("lets everything else through", () => {
    expect(classifyLibsignalLine(["[db] SSL disabled"])).toBeNull();
    expect(classifyLibsignalLine([new Error("boom")])).toBeNull();
    expect(classifyLibsignalLine([])).toBeNull();
  });
});
