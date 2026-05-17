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
  return env.split(',').map(s => s.trim()).filter(Boolean);
}

function loadFromFile(filePath) {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    const raw = fs.readFileSync(abs, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch (e) {
    // ignore errors and return empty
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

  // normalize and dedupe
  allowedChats = Array.from(new Set(allowedChats.map(s => s.trim()))).filter(Boolean);
}

function isChatAllowed(jid) {
  if (!jid) return false;

  ensureLoaded();

  // If no allowed chats configured, allow all chats
  if (allowedChats.length === 0) return true;

  const normalizedInput = normalizeChatJid(jid);
  const inputVariants = new Set([
    jid,
    normalizedInput,
    normalizedInput?.replace(/@s\.whatsapp\.net$/, '@lid')
  ].filter(Boolean));

  return allowedChats.some((item) => {
    const normalizedItem = normalizeChatJid(item);
    return inputVariants.has(item) || inputVariants.has(normalizedItem);
  });
}

function writeToFile(filePath, arr) {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    fs.writeFileSync(abs, JSON.stringify(arr, null, 2), 'utf8');
    return true;
  } catch (e) {
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
  allowedChats = Array.from(new Set(allowedChats.map(s => s.trim()))).filter(Boolean);
  const file = getStorageFile();
  return writeToFile(file, allowedChats);
}

function removeChat(jid) {
  if (!jid) return false;
  ensureLoaded();
  const normalized = normalizeChatJid(jid);
  const idx = allowedChats.indexOf(normalized);
  if (idx === -1) return false;
  allowedChats.splice(idx, 1);
  const file = getStorageFile();
  return writeToFile(file, allowedChats);
}

module.exports = {
  isChatAllowed,
  listChats,
  addChat,
  removeChat
};
