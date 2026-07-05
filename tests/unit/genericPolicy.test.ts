import { describe, it, expect } from "vitest";
import { decideGenericAction } from "../../agents/Generic/genericPolicy";

const base = {
  isGroup: false,
  isBroadcast: false,
  isAdmin: false,
  isAllowlisted: false,
  isSaved: true,
  text: "hi",
  count: 0,
  limit: 3,
  ownerOnline: false,
};

describe("decideGenericAction — scope passes", () => {
  it("passes groups, broadcast, admin, allowlisted, empty, !!, unsaved", () => {
    expect(decideGenericAction({ ...base, isGroup: true }).type).toBe("pass");
    expect(decideGenericAction({ ...base, isBroadcast: true }).type).toBe("pass");
    expect(decideGenericAction({ ...base, isAdmin: true }).type).toBe("pass");
    expect(decideGenericAction({ ...base, isAllowlisted: true }).type).toBe("pass");
    expect(decideGenericAction({ ...base, text: "" }).type).toBe("pass");
    expect(decideGenericAction({ ...base, text: "!!help" }).type).toBe("pass");
    expect(decideGenericAction({ ...base, isSaved: false }).type).toBe("pass");
  });
});

describe("decideGenericAction — offline greeting (non-command)", () => {
  it("greets the first message of the day when owner is offline", () => {
    expect(decideGenericAction({ ...base, count: 0, ownerOnline: false }).type).toBe("greet");
  });
  it("stays silent when the owner is online", () => {
    expect(decideGenericAction({ ...base, count: 0, ownerOnline: true }).type).toBe("silent");
  });
  it("ignores later non-! messages once the first reply is used", () => {
    expect(decideGenericAction({ ...base, count: 1 }).type).toBe("silent");
  });
  it("goes silent when the daily budget is spent", () => {
    expect(decideGenericAction({ ...base, count: 3 }).type).toBe("silent");
  });
});

describe("decideGenericAction — ! commands", () => {
  it("!reset and !help always work and are never counted", () => {
    expect(decideGenericAction({ ...base, text: "!reset", count: 3 }).type).toBe("reset");
    expect(decideGenericAction({ ...base, text: "!help", count: 3 }).type).toBe("help");
  });
  it("!<message> under budget produces a counted reply with the stripped text", () => {
    const a = decideGenericAction({ ...base, text: "!how are you", count: 1 });
    expect(a.type).toBe("reply");
    expect(a).toMatchObject({ userMsg: "how are you" });
  });
  it("!<message> over budget is silent", () => {
    expect(decideGenericAction({ ...base, text: "!hello", count: 3 }).type).toBe("silent");
  });
});
