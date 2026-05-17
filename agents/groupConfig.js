const fs = require('fs');
const path = require('path');

let allowedGroups = null;

function loadFromEnv() {
  const env = process.env.ALLOWED_GROUPS || '';
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
  if (allowedGroups !== null) return;

  allowedGroups = loadFromEnv();

  const filePath = process.env.ALLOWED_GROUPS_FILE;
  if (filePath) {
    const fromFile = loadFromFile(filePath);
    allowedGroups = allowedGroups.concat(fromFile);
  }

  // normalize and dedupe
  allowedGroups = Array.from(new Set(allowedGroups.map(s => s.trim()))).filter(Boolean);
}

function isGroupAllowed(jid) {
  if (!jid) return false;
  if (!jid.endsWith('@g.us')) return false;

  ensureLoaded();

  // If no allowed groups configured, allow all groups
  if (allowedGroups.length === 0) return true;

  return allowedGroups.includes(jid);
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
  const filePath = process.env.ALLOWED_GROUPS_FILE || 'allowedGroups.json';
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

function listGroups() {
  ensureLoaded();
  return Array.from(allowedGroups);
}

function addGroup(jid) {
  if (!jid || !jid.endsWith('@g.us')) return false;
  ensureLoaded();
  if (allowedGroups.includes(jid)) return true;
  allowedGroups.push(jid);
  allowedGroups = Array.from(new Set(allowedGroups.map(s => s.trim()))).filter(Boolean);
  const file = getStorageFile();
  return writeToFile(file, allowedGroups);
}

function removeGroup(jid) {
  if (!jid || !jid.endsWith('@g.us')) return false;
  ensureLoaded();
  const idx = allowedGroups.indexOf(jid);
  if (idx === -1) return false;
  allowedGroups.splice(idx, 1);
  const file = getStorageFile();
  return writeToFile(file, allowedGroups);
}

module.exports = {
  isGroupAllowed,
  listGroups,
  addGroup,
  removeGroup
};

