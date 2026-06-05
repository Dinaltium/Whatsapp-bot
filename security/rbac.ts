import { proto, jidNormalizedUser } from "@whiskeysockets/baileys";

export function normalizeJid(jid: string | null | undefined): string | null | undefined {
  if (!jid || typeof jid !== "string") return jid;

  // Clean all whitespace
  let cleaned = jid.replace(/\s+/g, "");

  // Strip leading plus symbol if present
  cleaned = cleaned.replace(/^\+/, "");

  // Handle device indicators (e.g. 1234:1@s.whatsapp.net or 1234:1@lid)
  if (cleaned.includes(":")) {
    const parts = cleaned.split(":");
    const domainPart = parts[1].includes("@") ? parts[1].split("@")[1] : "s.whatsapp.net";
    cleaned = parts[0] + "@" + domainPart;
  }

  // If bare number, append domain
  if (cleaned && !cleaned.includes("@")) {
    cleaned = cleaned + "@s.whatsapp.net";
  }

  try {
    return jidNormalizedUser(cleaned);
  } catch (e) {
    return cleaned;
  }
}

export function getSenderId(msg: proto.IWebMessageInfo): string {
  return normalizeJid(
    msg.key?.participant || msg.key?.remoteJid || "unknown",
  ) as string;
}

export function isAdminSender(msg: proto.IWebMessageInfo, resolvedSenderId?: string): boolean {
  if (!msg) return false;
  if (msg.key?.fromMe) return true;
  const adminEnv = process.env.ADMIN_JIDS || "";
  const admins = adminEnv
    .split(",")
    .map((s) => s.trim())
    .map((s) => normalizeJid(s))
    .filter(Boolean);
  const senderId = normalizeJid(resolvedSenderId || getSenderId(msg));
  return admins.includes(senderId as string);
}

export function isAdminAction(msg: proto.IWebMessageInfo, resolvedSenderId?: string): boolean {
  return isAdminSender(msg, resolvedSenderId);
}
