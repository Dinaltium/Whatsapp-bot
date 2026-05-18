import fs from "fs";
import path from "path";

interface GroupEntry {
  jid: string;
  botNumber: number;
}

let allowedGroups: GroupEntry[] | null = null;

function loadFromEnv(): GroupEntry[] {
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

function loadFromFile(filePath: string): GroupEntry[] {
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);
    const raw = fs.readFileSync(absolutePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => {
        if (typeof entry === "string") {
          return { jid: entry, botNumber: 0 };
        }
        return { jid: entry.jid, botNumber: entry.botNumber || 0 };
      });
    }
  } catch (error) {
    // ignore file errors and use empty list
  }

  return [];
}

function ensureLoaded(): void {
  if (allowedGroups !== null) return;

  allowedGroups = loadFromEnv();

  const filePath = process.env.ALLOWED_GROUPS_FILE || "allowed-groups.json";
  if (filePath) {
    const fromFile = loadFromFile(filePath);
    allowedGroups = allowedGroups.concat(fromFile);
  }

  // deduplicate by jid, keeping the last entry
  const uniqueMap = new Map<string, GroupEntry>();
  for (const entry of allowedGroups) {
    if (entry.jid.trim()) {
      uniqueMap.set(entry.jid.trim(), entry);
    }
  }
  allowedGroups = Array.from(uniqueMap.values());
}

function getGroupBot(
  jid: string | null | undefined,
): { botNumber: number } | null {
  if (!jid || !jid.endsWith("@g.us")) return null;

  ensureLoaded();

  if (allowedGroups!.length === 0) return { botNumber: 0 };

  const entry = allowedGroups!.find((g) => g.jid === jid);
  return entry ? { botNumber: entry.botNumber } : null;
}

function isGroupAllowed(jid: string | null | undefined): boolean {
  return getGroupBot(jid) !== null;
}

function writeToFile(filePath: string, data: GroupEntry[]): boolean {
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
  const filePath = process.env.ALLOWED_GROUPS_FILE || "allowed-groups.json";
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
}

function listGroups(): GroupEntry[] {
  ensureLoaded();
  return allowedGroups!.map((g) => ({ jid: g.jid, botNumber: g.botNumber }));
}

function addGroup(
  jid: string | null | undefined,
  botNumber: number = 0,
): boolean {
  if (!jid || !jid.endsWith("@g.us")) return false;

  ensureLoaded();

  const existing = allowedGroups!.find((g) => g.jid === jid);
  if (existing) {
    existing.botNumber = botNumber;
  } else {
    allowedGroups!.push({ jid, botNumber });
  }

  return writeToFile(getStorageFile(), allowedGroups!);
}

function removeGroup(jid: string | null | undefined): boolean {
  if (!jid || !jid.endsWith("@g.us")) return false;

  ensureLoaded();

  const index = allowedGroups!.findIndex((g) => g.jid === jid);
  if (index === -1) return false;
  allowedGroups!.splice(index, 1);

  return writeToFile(getStorageFile(), allowedGroups!);
}

export default {
  getGroupBot,
  isGroupAllowed,
  listGroups,
  addGroup,
  removeGroup,
};
