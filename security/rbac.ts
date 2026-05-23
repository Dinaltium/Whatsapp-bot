import { proto, jidNormalizedUser } from "@whiskeysockets/baileys";

export function normalizeJid(jid: string | null | undefined): string | null | undefined {
  if (!jid || typeof jid !== "string") return jid;

  try {
    return jidNormalizedUser(jid);
  } catch (e) {
    if (jid.includes(":") && jid.endsWith("@s.whatsapp.net")) {
      return jid.split(":")[0] + "@s.whatsapp.net";
    }

    return jid;
  }
}

export function getSenderId(msg: proto.IWebMessageInfo): string {
  return normalizeJid(
    msg.key?.participant || msg.key?.remoteJid || "unknown",
  ) as string;
}

export function isAdminSender(msg: proto.IWebMessageInfo): boolean {
  if (!msg) return false;
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
