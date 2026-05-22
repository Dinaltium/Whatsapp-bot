import fs from "fs";
import path from "path";

interface ChatEntry {
  jid: string;
  botNumber: number;
}

let allowedChats: ChatEntry[] | null = null;

function normalizeChatJid(
  jid: string | null | undefined,
): string | null | undefined {
  if (!jid || typeof jid !== "string") return jid;
  if (jid.endsWith("@lid")) return jid.replace(/@lid$/, "@s.whatsapp.net");
  return jid;
}

function loadFromEnv(): ChatEntry[] {
  const env = process.env.ALLOWED_CHATS || "";
  return env
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(" ");
      const jid = parts[0];
      const botNumber = parseInt(parts[1] || "0", 10);
      return {
        jid: normalizeChatJid(jid) || jid,
        botNumber: isNaN(botNumber) ? 0 : botNumber,
      };
    });
}

function loadFromFile(filePath: string): ChatEntry[] {
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);
    const raw = fs.readFileSync(absolutePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => {
        if (typeof entry === "string") {
          return { jid: normalizeChatJid(entry) || entry, botNumber: 0 };
        }
        return {
          jid: normalizeChatJid(entry.jid) || entry.jid,
          botNumber: entry.botNumber || 0,
        };
      });
    }
  } catch (error) {
    // ignore file errors and use empty list
  }

  return [];
}

function ensureLoaded(): void {
  if (allowedChats !== null) return;

  allowedChats = loadFromEnv();

  const filePath = process.env.ALLOWED_CHATS_FILE || "allowed-chats.json";
  if (filePath) {
    const fromFile = loadFromFile(filePath);
    allowedChats = allowedChats.concat(fromFile);
  }

  // deduplicate by normalized jid, keeping the last entry
  const uniqueMap = new Map<string, ChatEntry>();
  for (const entry of allowedChats) {
    const normalized = normalizeChatJid(entry.jid) || entry.jid;
    if (normalized.trim()) {
      uniqueMap.set(normalized.trim(), {
        jid: normalized,
        botNumber: entry.botNumber,
      });
    }
  }
  allowedChats = Array.from(uniqueMap.values());
}

function getChatBot(
  jid: string | null | undefined,
): { botNumber: number } | null {
  if (!jid) return null;

  ensureLoaded();

  if (allowedChats!.length === 0) return null;

  const normalizedInput = normalizeChatJid(jid);
  const inputVariants = new Set(
    [
      jid,
      normalizedInput,
      normalizedInput?.replace(/@s\.whatsapp\.net$/, "@lid"),
    ].filter(Boolean),
  );

  const entry = allowedChats!.find((chat) => {
    const normalizedEntry = normalizeChatJid(chat.jid);
    return (
      inputVariants.has(chat.jid) ||
      inputVariants.has(normalizedEntry as string)
    );
  });

  return entry ? { botNumber: entry.botNumber } : null;
}

function isChatAllowed(jid: string | null | undefined): boolean {
  return getChatBot(jid) !== null;
}

function writeToFile(filePath: string, data: ChatEntry[]): boolean {
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);
    fs.writeFileSync(absolutePath, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (error) {
    return false;
  }
}

function getStorageFile(): string {
  const filePath = process.env.ALLOWED_CHATS_FILE || "allowed-chats.json";
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
}

function listChats(): ChatEntry[] {
  ensureLoaded();
  return allowedChats!.map((c) => ({ jid: c.jid, botNumber: c.botNumber }));
}

function addChat(
  jid: string | null | undefined,
  botNumber: number = 0,
): boolean {
  if (!jid) return false;

  ensureLoaded();

  const normalized = normalizeChatJid(jid) || jid;
  const existing = allowedChats!.find((c) => {
    const normalizedEntry = normalizeChatJid(c.jid);
    return normalizedEntry === normalized || c.jid === jid;
  });

  if (existing) {
    existing.botNumber = botNumber;
  } else {
    allowedChats!.push({ jid: normalized, botNumber });
  }

  return writeToFile(getStorageFile(), allowedChats!);
}

function removeChat(jid: string | null | undefined): boolean {
  if (!jid) return false;

  ensureLoaded();

  const normalized = normalizeChatJid(jid) || jid;
  const index = allowedChats!.findIndex((c) => {
    const normalizedEntry = normalizeChatJid(c.jid);
    return normalizedEntry === normalized || c.jid === jid;
  });

  if (index === -1) return false;
  allowedChats!.splice(index, 1);

  return writeToFile(getStorageFile(), allowedChats!);
}

export default {
  getChatBot,
  isChatAllowed,
  listChats,
  addChat,
  removeChat,
};
