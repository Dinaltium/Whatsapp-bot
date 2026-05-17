const fs = require('fs');
const path = require('path');

let allowedChats = null;

function normalizeChatJid(jid) {
  if (!jid || typeof jid !== 'string') return jid;
  if (jid.endsWith('@lid')) return jid.replace(/@lid$/, '@s.whatsapp.net');
  return jid;
}

function loadFromEnv() {
  const env = process.env.ALLOWED_CHATS || '';
  return env.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function loadFromFile(filePath) {
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);
    const raw = fs.readFileSync(absolutePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch (error) {
    // ignore file errors and use empty list
  }

  return [];
}

function ensureLoaded() {
  if (allowedChats !== null) return;

  allowedChats = loadFromEnv();

  const filePath = process.env.ALLOWED_CHATS_FILE || 'allowed-chats.json';
  if (filePath) {
    const fromFile = loadFromFile(filePath);
    allowedChats = allowedChats.concat(fromFile);
  }

  allowedChats = Array.from(new Set(allowedChats.map((entry) => entry.trim()))).filter(Boolean);
}

function isChatAllowed(jid) {
  if (!jid) return false;

  ensureLoaded();

  if (allowedChats.length === 0) return true;

  const normalizedInput = normalizeChatJid(jid);
  const inputVariants = new Set([
    jid,
    normalizedInput,
    normalizedInput?.replace(/@s\.whatsapp\.net$/, '@lid')
  ].filter(Boolean));

  return allowedChats.some((entry) => {
    const normalizedEntry = normalizeChatJid(entry);
    return inputVariants.has(entry) || inputVariants.has(normalizedEntry);
  });
}

function writeToFile(filePath, data) {
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);
    fs.writeFileSync(absolutePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    return false;
  }
}

function getStorageFile() {
  const filePath = process.env.ALLOWED_CHATS_FILE || 'allowed-chats.json';
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

function listChats() {
  ensureLoaded();
  return Array.from(allowedChats);
}

function addChat(jid) {
  if (!jid) return false;

  ensureLoaded();

  const normalized = normalizeChatJid(jid);
  if (allowedChats.includes(normalized)) return true;

  allowedChats.push(normalized);
  allowedChats = Array.from(new Set(allowedChats.map((entry) => entry.trim()))).filter(Boolean);

  return writeToFile(getStorageFile(), allowedChats);
}

function removeChat(jid) {
  if (!jid) return false;

  ensureLoaded();

  const normalized = normalizeChatJid(jid);
  const index = allowedChats.indexOf(normalized);
  if (index === -1) return false;

  allowedChats.splice(index, 1);

  return writeToFile(getStorageFile(), allowedChats);
}

module.exports = {
  isChatAllowed,
  listChats,
  addChat,
  removeChat
};
