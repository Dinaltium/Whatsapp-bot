const fs = require('fs');
const path = require('path');

let allowedGroups = null;

function loadFromEnv() {
  const env = process.env.ALLOWED_GROUPS || '';
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
  if (allowedGroups !== null) return;

  allowedGroups = loadFromEnv();

  const filePath = process.env.ALLOWED_GROUPS_FILE || 'allowed-groups.json';
  if (filePath) {
    const fromFile = loadFromFile(filePath);
    allowedGroups = allowedGroups.concat(fromFile);
  }

  allowedGroups = Array.from(new Set(allowedGroups.map((entry) => entry.trim()))).filter(Boolean);
}

function isGroupAllowed(jid) {
  if (!jid || !jid.endsWith('@g.us')) return false;

  ensureLoaded();

  if (allowedGroups.length === 0) return true;
  return allowedGroups.includes(jid);
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
  const filePath = process.env.ALLOWED_GROUPS_FILE || 'allowed-groups.json';
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
  allowedGroups = Array.from(new Set(allowedGroups.map((entry) => entry.trim()))).filter(Boolean);

  return writeToFile(getStorageFile(), allowedGroups);
}

function removeGroup(jid) {
  if (!jid || !jid.endsWith('@g.us')) return false;

  ensureLoaded();

  const index = allowedGroups.indexOf(jid);
  if (index === -1) return false;
  allowedGroups.splice(index, 1);

  return writeToFile(getStorageFile(), allowedGroups);
}

module.exports = {
  isGroupAllowed,
  listGroups,
  addGroup,
  removeGroup
};
