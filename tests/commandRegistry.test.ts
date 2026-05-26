process.env.REDIS_URL = "redis://127.0.0.1:6379";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCommand, dispatchCommand, CommandContext } from "../core/commands/commandRegistry";
import { proto } from "@whiskeysockets/baileys";

// Mock the dependencies
vi.mock("../bot", () => ({
  sendBotReply: vi.fn(),
  safeGetGroupName: vi.fn(),
  buildSessionKey: vi.fn(),
}));

vi.mock("../security/rbac", () => ({
  isAdminAction: vi.fn().mockImplementation((msg, senderId) => {
    return senderId === "admin@s.whatsapp.net";
  }),
  normalizeJid: vi.fn().mockImplementation(jid => jid),
}));

describe("Command Registry & Dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should register and execute a public command successfully", async () => {
    const executedLogs: string[] = [];
    registerCommand({
      name: "mocktest",
      handler: async (ctx) => {
        executedLogs.push("ran mocktest");
      },
    });

    const ctx = {
      sock: {},
      msg: {} as proto.IWebMessageInfo,
      cmdName: "mocktest",
      cmdArgs: [],
      senderId: "user@s.whatsapp.net",
      from: "123@s.whatsapp.net",
      session: {},
    } as CommandContext;

    const result = await dispatchCommand(ctx);
    expect(result).toBe(true);
    expect(executedLogs).toContain("ran mocktest");
  });

  it("should enforce admin middleware checks on registered commands", async () => {
    const executedLogs: string[] = [];
    registerCommand({
      name: "mockadmin",
      requiresAdmin: true,
      handler: async (ctx) => {
        executedLogs.push("ran mockadmin");
      },
    });

    // Case 1: Unauthorized User
    const ctxUser = {
      sock: {},
      msg: {} as proto.IWebMessageInfo,
      cmdName: "mockadmin",
      cmdArgs: [],
      senderId: "user@s.whatsapp.net",
      from: "123@s.whatsapp.net",
      session: {},
    } as CommandContext;

    const resultUser = await dispatchCommand(ctxUser);
    expect(resultUser).toBe(true); // Intercepted
    expect(executedLogs).not.toContain("ran mockadmin");

    // Case 2: Authorized Admin
    const ctxAdmin = {
      sock: {},
      msg: {} as proto.IWebMessageInfo,
      cmdName: "mockadmin",
      cmdArgs: [],
      senderId: "admin@s.whatsapp.net",
      from: "123@s.whatsapp.net",
      session: {},
    } as CommandContext;

    const resultAdmin = await dispatchCommand(ctxAdmin);
    expect(resultAdmin).toBe(true);
    expect(executedLogs).toContain("ran mockadmin");
  });

  it("should return false for non-registered command strings", async () => {
    const ctx = {
      sock: {},
      msg: {} as proto.IWebMessageInfo,
      cmdName: "unknowncommand",
      cmdArgs: [],
      senderId: "user@s.whatsapp.net",
      from: "123@s.whatsapp.net",
      session: {},
    } as CommandContext;

    const result = await dispatchCommand(ctx);
    expect(result).toBe(false);
  });
});
