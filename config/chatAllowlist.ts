interface ChatEntry {
  id: number;
  jid: string;
  botNumber: number;
  enabled: boolean;
}

let allowedChats: ChatEntry[] | null = null;

function normalizeChatJid(
  jid: string | null | undefined,
): string | null | undefined {
  if (!jid || typeof jid !== "string") return jid;
  return jid;
}

function loadFromEnv(): { jid: string; botNumber: number }[] {
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

function ensureLoaded(): void {
  if (allowedChats !== null) return;

  const envEntries = loadFromEnv();
  allowedChats = envEntries.map((e, idx) => ({
    id: 99000 + idx,
    jid: e.jid,
    botNumber: e.botNumber,
    enabled: true,
  }));
}

async function init(): Promise<void> {
  const envEntries = loadFromEnv();

  let dbEntries: ChatEntry[] = [];
  try {
    const { getAllowedChats, addAllowedChat } = await import("../storage/core/allowlistRepository");

    // Sync any env entries that don't exist in DB yet
    const currentDb = await getAllowedChats();
    for (const envEnt of envEntries) {
      const exists = currentDb.some((dbE) => dbE.jid === envEnt.jid);
      if (!exists) {
        await addAllowedChat(envEnt.jid, envEnt.botNumber);
      }
    }

    const dbRows = await getAllowedChats();
    dbEntries = dbRows.map((e) => ({
      id: e.id,
      jid: e.jid,
      botNumber: e.bot_number,
      enabled: e.enabled,
    }));
  } catch (error) {
    console.warn("⚠️ Failed to load allowed chats from Neon DB, using env fallback:", error);
    dbEntries = envEntries.map((e, idx) => ({
      id: 99000 + idx,
      jid: e.jid,
      botNumber: e.botNumber,
      enabled: true,
    }));
  }

  allowedChats = dbEntries;
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
    ].filter(Boolean),
  );

  const entry = allowedChats!.find((chat) => {
    const normalizedEntry = normalizeChatJid(chat.jid);
    return (
      inputVariants.has(chat.jid) ||
      inputVariants.has(normalizedEntry as string)
    );
  });

  return entry && entry.enabled ? { botNumber: entry.botNumber } : null;
}

function isChatAllowed(jid: string | null | undefined): boolean {
  return getChatBot(jid) !== null;
}

function listChats(): ChatEntry[] {
  ensureLoaded();
  return allowedChats!.map((c) => ({
    id: c.id,
    jid: c.jid,
    botNumber: c.botNumber,
    enabled: c.enabled,
  }));
}

function getChatEntryById(id: number): ChatEntry | null {
  ensureLoaded();
  return allowedChats!.find((c) => c.id === id) || null;
}

function getChatEntryByJid(jid: string): ChatEntry | null {
  ensureLoaded();
  return allowedChats!.find((c) => c.jid === jid) || null;
}

async function addChat(
  jid: string | null | undefined,
  botNumber: number = 0,
): Promise<boolean> {
  if (!jid) return false;

  ensureLoaded();

  const normalized = normalizeChatJid(jid) || jid;

  try {
    const { addAllowedChat } = await import("../storage/core/allowlistRepository");
    const ok = await addAllowedChat(normalized, botNumber);
    if (ok) {
      await init();
      return true;
    }
  } catch (error) {
    console.warn(`⚠️ Failed to persist added chat ${normalized} to DB:`, error);
  }

  const existing = allowedChats!.find((c) => {
    const normalizedEntry = normalizeChatJid(c.jid);
    return normalizedEntry === normalized || c.jid === jid;
  });

  if (existing) {
    existing.botNumber = botNumber;
    existing.enabled = true;
  } else {
    allowedChats!.push({
      id: 99000 + allowedChats!.length,
      jid: normalized,
      botNumber,
      enabled: true,
    });
  }
  return true;
}

async function removeChatById(id: number): Promise<boolean> {
  ensureLoaded();

  const entry = allowedChats!.find((c) => c.id === id);
  if (!entry) return false;

  try {
    const { removeAllowedChatById } = await import("../storage/core/allowlistRepository");
    const ok = await removeAllowedChatById(id);
    if (ok) {
      await init();
      return true;
    }
  } catch (error) {
    console.warn(`⚠️ Failed to persist removed chat ID ${id} from DB:`, error);
  }

  const index = allowedChats!.findIndex((c) => c.id === id);
  if (index !== -1) {
    allowedChats!.splice(index, 1);
    return true;
  }
  return false;
}

async function editChatBot(id: number, botNumber: number): Promise<boolean> {
  ensureLoaded();

  const entry = allowedChats!.find((c) => c.id === id);
  if (!entry) return false;

  try {
    const { setChatBotNumber } = await import("../storage/core/allowlistRepository");
    const ok = await setChatBotNumber(id, botNumber);
    if (ok) {
      await init();
      return true;
    }
  } catch (error) {
    console.warn(`⚠️ Failed to persist edit chat bot ID ${id} to DB:`, error);
  }

  entry.botNumber = botNumber;
  return true;
}

async function setChatEnabled(id: number, enabled: boolean): Promise<boolean> {
  ensureLoaded();

  const entry = allowedChats!.find((c) => c.id === id);
  if (!entry) return false;

  try {
    const { setChatEnabled: dbSetEnabled } = await import("../storage/core/allowlistRepository");
    const ok = await dbSetEnabled(id, enabled);
    if (ok) {
      await init();
      return true;
    }
  } catch (error) {
    console.warn(`⚠️ Failed to persist enabled chat ID ${id} state to DB:`, error);
  }

  entry.enabled = enabled;
  return true;
}

export default {
  init,
  getChatBot,
  isChatAllowed,
  listChats,
  getChatEntryById,
  getChatEntryByJid,
  addChat,
  removeChatById,
  editChatBot,
  setChatEnabled,
};
