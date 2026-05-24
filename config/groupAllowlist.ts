interface GroupEntry {
  id: number;
  jid: string;
  botNumber: number;
  enabled: boolean;
}

let allowedGroups: GroupEntry[] | null = null;

function loadFromEnv(): { jid: string; botNumber: number }[] {
  const env = process.env.ALLOWED_GROUPS || "";
  return env
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(" ");
      const jid = parts[0];
      const botNumber = parseInt(parts[1] || "0", 10);
      return { jid, botNumber: isNaN(botNumber) ? 0 : botNumber };
    });
}

function ensureLoaded(): void {
  if (allowedGroups !== null) return;

  const envEntries = loadFromEnv();
  allowedGroups = envEntries.map((e, idx) => ({
    id: 99000 + idx,
    jid: e.jid,
    botNumber: e.botNumber,
    enabled: true,
  }));
}

async function init(): Promise<void> {
  const envEntries = loadFromEnv();

  let dbEntries: GroupEntry[] = [];
  try {
    const { getAllowedGroups, addAllowedGroup } = await import("../storage/dk24Store");

    // Sync any env entries that don't exist in DB yet
    const currentDb = await getAllowedGroups();
    for (const envEnt of envEntries) {
      const exists = currentDb.some((dbE) => dbE.jid === envEnt.jid);
      if (!exists) {
        await addAllowedGroup(envEnt.jid, envEnt.botNumber);
      }
    }

    const dbRows = await getAllowedGroups();
    dbEntries = dbRows.map((e) => ({
      id: e.id,
      jid: e.jid,
      botNumber: e.bot_number,
      enabled: e.enabled,
    }));
  } catch (error) {
    console.warn("⚠️ Failed to load allowed groups from Neon DB, using env fallback:", error);
    dbEntries = envEntries.map((e, idx) => ({
      id: 99000 + idx,
      jid: e.jid,
      botNumber: e.botNumber,
      enabled: true,
    }));
  }

  allowedGroups = dbEntries;
}

function getGroupBot(
  jid: string | null | undefined,
): { botNumber: number } | null {
  if (!jid || !jid.endsWith("@g.us")) return null;

  ensureLoaded();

  if (allowedGroups!.length === 0) return null;

  const entry = allowedGroups!.find((g) => g.jid === jid);
  return entry && entry.enabled ? { botNumber: entry.botNumber } : null;
}

function isGroupAllowed(jid: string | null | undefined): boolean {
  return getGroupBot(jid) !== null;
}

function listGroups(): GroupEntry[] {
  ensureLoaded();
  return allowedGroups!.map((g) => ({
    id: g.id,
    jid: g.jid,
    botNumber: g.botNumber,
    enabled: g.enabled,
  }));
}

function getGroupEntryById(id: number): GroupEntry | null {
  ensureLoaded();
  return allowedGroups!.find((g) => g.id === id) || null;
}

function getGroupEntryByJid(jid: string): GroupEntry | null {
  ensureLoaded();
  return allowedGroups!.find((g) => g.jid === jid) || null;
}

async function addGroup(
  jid: string | null | undefined,
  botNumber: number = 0,
): Promise<boolean> {
  if (!jid || !jid.endsWith("@g.us")) return false;

  ensureLoaded();

  try {
    const { addAllowedGroup } = await import("../storage/dk24Store");
    const ok = await addAllowedGroup(jid, botNumber);
    if (ok) {
      await init();
      return true;
    }
  } catch (error) {
    console.warn(`⚠️ Failed to persist added group ${jid} to DB:`, error);
  }

  const existing = allowedGroups!.find((g) => g.jid === jid);
  if (existing) {
    existing.botNumber = botNumber;
    existing.enabled = true;
  } else {
    allowedGroups!.push({
      id: 99000 + allowedGroups!.length,
      jid,
      botNumber,
      enabled: true,
    });
  }
  return true;
}

async function removeGroupById(id: number): Promise<boolean> {
  ensureLoaded();

  const entry = allowedGroups!.find((g) => g.id === id);
  if (!entry) return false;

  try {
    const { removeAllowedGroupById } = await import("../storage/dk24Store");
    const ok = await removeAllowedGroupById(id);
    if (ok) {
      await init();
      return true;
    }
  } catch (error) {
    console.warn(`⚠️ Failed to persist removed group ID ${id} from DB:`, error);
  }

  const index = allowedGroups!.findIndex((g) => g.id === id);
  if (index !== -1) {
    allowedGroups!.splice(index, 1);
    return true;
  }
  return false;
}

async function editGroupBot(id: number, botNumber: number): Promise<boolean> {
  ensureLoaded();

  const entry = allowedGroups!.find((g) => g.id === id);
  if (!entry) return false;

  try {
    const { setGroupBotNumber } = await import("../storage/dk24Store");
    const ok = await setGroupBotNumber(id, botNumber);
    if (ok) {
      await init();
      return true;
    }
  } catch (error) {
    console.warn(`⚠️ Failed to persist edit group bot ID ${id} to DB:`, error);
  }

  entry.botNumber = botNumber;
  return true;
}

async function setGroupEnabled(id: number, enabled: boolean): Promise<boolean> {
  ensureLoaded();

  const entry = allowedGroups!.find((g) => g.id === id);
  if (!entry) return false;

  try {
    const { setGroupEnabled: dbSetEnabled } = await import("../storage/dk24Store");
    const ok = await dbSetEnabled(id, enabled);
    if (ok) {
      await init();
      return true;
    }
  } catch (error) {
    console.warn(`⚠️ Failed to persist enabled group ID ${id} state to DB:`, error);
  }

  entry.enabled = enabled;
  return true;
}

export default {
  init,
  getGroupBot,
  isGroupAllowed,
  listGroups,
  getGroupEntryById,
  getGroupEntryByJid,
  addGroup,
  removeGroupById,
  editGroupBot,
  setGroupEnabled,
};
