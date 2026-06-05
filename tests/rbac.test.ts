import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeJid, getSenderId, isAdminSender } from "../security/rbac";
import { proto } from "@whiskeysockets/baileys";

describe("RBAC & JID Normalization", () => {
  describe("normalizeJid", () => {
    it("should return null/undefined for invalid inputs", () => {
      expect(normalizeJid(null)).toBeNull();
      expect(normalizeJid(undefined)).toBeUndefined();
    });

    it("should strip leading plus symbols and clean spaces", () => {
      expect(normalizeJid("+91 990 284 9280")).toBe("919902849280@s.whatsapp.net");
    });

    it("should append standard WhatsApp domain to bare numbers", () => {
      expect(normalizeJid("12345678")).toBe("12345678@s.whatsapp.net");
    });

    it("should strip device suffixes correctly", () => {
      expect(normalizeJid("919902849280:2@s.whatsapp.net")).toBe("919902849280@s.whatsapp.net");
      expect(normalizeJid("1203630000000:4@lid")).toBe("1203630000000@lid");
    });
  });

  describe("getSenderId", () => {
    it("should extract and normalize sender from group message participant", () => {
      const msg = {
        key: {
          remoteJid: "12345@g.us",
          participant: "919902849280:2@s.whatsapp.net",
        },
      } as proto.IWebMessageInfo;
      expect(getSenderId(msg)).toBe("919902849280@s.whatsapp.net");
    });

    it("should default to remoteJid if participant is not present", () => {
      const msg = {
        key: {
          remoteJid: "919902849280:1@s.whatsapp.net",
        },
      } as proto.IWebMessageInfo;
      expect(getSenderId(msg)).toBe("919902849280@s.whatsapp.net");
    });
  });

  describe("isAdminSender", () => {
    const originalEnv = process.env.ADMIN_JIDS;

    beforeEach(() => {
      process.env.ADMIN_JIDS = "919902849280@s.whatsapp.net, +12345678";
    });

    it("should return true for a configured admin JID", () => {
      const msg = {
        key: {
          remoteJid: "123@g.us",
          participant: "919902849280@s.whatsapp.net",
        },
      } as proto.IWebMessageInfo;
      expect(isAdminSender(msg)).toBe(true);
    });

    it("should return true for resolved phone JID from LID", () => {
      const msg = {
        key: {
          remoteJid: "123@g.us",
          participant: "1203630000000@lid",
        },
      } as proto.IWebMessageInfo;
      expect(isAdminSender(msg, "919902849280@s.whatsapp.net")).toBe(true);
    });

    it("should return true if message key is fromMe", () => {
      const msg = {
        key: {
          fromMe: true,
          remoteJid: "123@g.us",
        },
      } as proto.IWebMessageInfo;
      expect(isAdminSender(msg)).toBe(true);
    });

    it("should return false for a non-admin JID", () => {
      const msg = {
        key: {
          remoteJid: "123@g.us",
          participant: "918888888888@s.whatsapp.net",
        },
      } as proto.IWebMessageInfo;
      expect(isAdminSender(msg)).toBe(false);
    });
  });
});
