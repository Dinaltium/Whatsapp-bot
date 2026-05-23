import { proto, jidNormalizedUser } from "@whiskeysockets/baileys";

export function normalizeJid(jid: string | null | undefined): string | null | undefined {
  if (!jid || typeof jid !== "string") return jid;

  // Clean all whitespace
  let cleaned = jid.replace(/\s+/g, "");

  // Strip leading plus symbol if present
  cleaned = cleaned.replace(/^\+/, "");

  // If bare number, append domain
  if (cleaned && !cleaned.includes("@")) {
    cleaned = cleaned + "@s.whatsapp.net";
  }

  try {
    return jidNormalizedUser(cleaned);
  } catch (e) {
    if (cleaned.includes(":") && cleaned.endsWith("@s.whatsapp.net")) {
      return cleaned.split(":")[0] + "@s.whatsapp.net";
    }

    return cleaned;
  }
}

export function getSenderId(msg: proto.IWebMessageInfo): string {
  return normalizeJid(
    msg.key?.participant || msg.key?.remoteJid || "unknown",
  ) as string;
}

export function isAdminSender(msg: proto.IWebMessageInfo): boolean {
  if (!msg) return false;
  if (msg.key?.fromMe) return true;
  const adminEnv = process.env.ADMIN_JIDS || "";
  const admins = adminEnv
    .split(",")
    .map((s) => s.trim())
    .map((s) => normalizeJid(s))
    .filter(Boolean);
  const senderId = normalizeJid(getSenderId(msg));
  return admins.includes(senderId as string);
}

export function isAdminAction(msg: proto.IWebMessageInfo): boolean {
  return isAdminSender(msg);
}
