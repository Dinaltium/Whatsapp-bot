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
  limit: 5,
  ownerOnline: false,
};

describe("decideGenericAction — scope passes", () => {
  it("passes groups, broadcast, admin, empty, !!, unsaved", () => {
    expect(decideGenericAction({ ...base, isGroup: true }).type).toBe("pass");
    expect(decideGenericAction({ ...base, isBroadcast: true }).type).toBe("pass");
    expect(decideGenericAction({ ...base, isAdmin: true }).type).toBe("pass");
    expect(decideGenericAction({ ...base, text: "" }).type).toBe("pass");
    expect(decideGenericAction({ ...base, text: "!!help" }).type).toBe("pass");
    expect(decideGenericAction({ ...base, isSaved: false }).type).toBe("pass");
  });
});

describe("decideGenericAction — bot-1/2/3 chats (isAllowlisted)", () => {
  const al = { ...base, isAllowlisted: true };
  it("greets a plain first message while away (notify layer)", () => {
    expect(decideGenericAction({ ...al, text: "hi", count: 0 }).type).toBe("greet");
  });
  it("handles !chat as the generic reply", () => {
    expect(decideGenericAction({ ...al, text: "!chat hey", count: 0 }).type).toBe("reply");
  });
  it("passes every OTHER command to the assigned bot", () => {
    expect(decideGenericAction({ ...al, text: "!reset" }).type).toBe("pass");
    expect(decideGenericAction({ ...al, text: "!help" }).type).toBe("pass");
    expect(decideGenericAction({ ...al, text: "!mentors" }).type).toBe("pass");
  });
});

describe("decideGenericAction — owner online means silence", () => {
  it("suppresses the greeting when the owner is online", () => {
    expect(decideGenericAction({ ...base, ownerOnline: true }).type).toBe("silent");
  });
  it("suppresses even an explicit !chat when the owner is online", () => {
    expect(
      decideGenericAction({ ...base, text: "!chat hello", ownerOnline: true }).type,
    ).toBe("silent");
  });
});

describe("decideGenericAction — offline greeting (non-command)", () => {
  it("greets the first message while away", () => {
    expect(decideGenericAction({ ...base, count: 0 }).type).toBe("greet");
  });
  it("ignores later non-command messages once the greeting is used", () => {
    expect(decideGenericAction({ ...base, count: 1 }).type).toBe("silent");
  });
  it("goes silent when the budget is spent", () => {
    expect(decideGenericAction({ ...base, count: 5 }).type).toBe("silent");
  });
});

describe("decideGenericAction — !chat and utility commands", () => {
  it("!reset and !help always work and are never counted", () => {
    expect(decideGenericAction({ ...base, text: "!reset", count: 5 }).type).toBe("reset");
    expect(decideGenericAction({ ...base, text: "!help", count: 5 }).type).toBe("help");
  });
  it("!chat under budget replies with the stripped text", () => {
    const a = decideGenericAction({ ...base, text: "!chat how are you", count: 1 });
    expect(a.type).toBe("reply");
    expect(a).toMatchObject({ userMsg: "how are you" });
  });
  it("!chat with no text shows help", () => {
    expect(decideGenericAction({ ...base, text: "!chat" }).type).toBe("help");
  });
  it("!chat over budget is silent", () => {
    expect(decideGenericAction({ ...base, text: "!chat hello", count: 5 }).type).toBe("silent");
  });
  it("a stray '!<message>' fumble is treated as a normal message (greets)", () => {
    expect(decideGenericAction({ ...base, text: "!<remind him ...>", count: 0 }).type).toBe("greet");
  });
});
