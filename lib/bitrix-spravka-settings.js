'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const error = (status, message) => Object.assign(new Error(message), { status, publicMessage: message });
const invalid = () => error(400, 'Некорректные настройки доступа.');
const unavailable = () => error(503, 'Хранилище настроек недоступно. Доступ через Битрикс24 закрыт.');
const userId = value => typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value);
const defaults = () => ({ version: 1, revision: 0, enabled: false, allowedUserIds: [], cacheSeconds: 60 });
function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'allowedUserIds,cacheSeconds,enabled,revision,version' ||
      value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.enabled !== 'boolean' || ![60, 300, 600].includes(value.cacheSeconds) ||
      !Array.isArray(value.allowedUserIds) || value.allowedUserIds.length > 500 ||
      !value.allowedUserIds.every(userId) || new Set(value.allowedUserIds).size !== value.allowedUserIds.length ||
      (value.enabled && !value.allowedUserIds.length)) throw invalid();
  return structuredClone(value);
}
function installationHash(record) {
  return crypto.createHash('sha256').update(JSON.stringify([
    record.clientId, record.memberId, record.appId, record.applicationToken
  ])).digest('hex');
}
function settingsStore(directory) {
  const resolved = path.resolve(directory), webRoot = path.resolve(__dirname, '..');
  if (!path.isAbsolute(directory) || resolved === webRoot || resolved.startsWith(webRoot + path.sep)) throw unavailable();
  const file = path.join(resolved, 'settings.json');
  async function privateDirectory() {
    const stat = await fs.lstat(resolved);
    if (!stat.isDirectory() || (stat.mode & 0o077)) throw unavailable();
  }
  async function read(binding) {
    try {
      await privateDirectory();
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 65536) throw unavailable();
        const record = JSON.parse(await handle.readFile('utf8'));
        if (record.binding !== binding || Object.keys(record).sort().join(',') !== 'binding,settings') throw unavailable();
        return validateSettings(record.settings);
      } finally { await handle.close(); }
    } catch (e) {
      if (e.code === 'ENOENT') return defaults();
      throw unavailable();
    }
  }
  return {
    read,
    async write(binding, expectedRevision, value) {
      const clean = validateSettings(value);
      if (clean.revision !== expectedRevision || expectedRevision >= Number.MAX_SAFE_INTEGER) throw invalid();
      let lock, temporary;
      const lockfile = path.join(resolved, 'settings.lock');
      try {
        await privateDirectory();
        try { lock = await fs.open(lockfile, 'wx', 0o600); }
        catch (e) {
          if (e.code === 'EEXIST') throw error(409, 'Настройки сейчас сохраняются. Обновите страницу и повторите.');
          throw e;
        }
        const current = await read(binding);
        if (current.revision !== expectedRevision) throw error(409, 'Настройки изменены другим администратором. Обновите страницу.');
        clean.revision++;
        temporary = path.join(resolved, `.settings-${crypto.randomBytes(16).toString('hex')}`);
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ binding, settings: clean }));
          await handle.sync();
        } finally { await handle.close(); }
        await fs.rename(temporary, file); temporary = null;
        const dir = await fs.open(resolved, constants.O_RDONLY);
        try { await dir.sync(); } finally { await dir.close(); }
        return clean;
      } catch (e) {
        if ([400, 409].includes(e.status)) throw e;
        throw unavailable();
      } finally {
        if (temporary) await fs.unlink(temporary).catch(() => {});
        if (lock) { await lock.close(); await fs.unlink(lockfile).catch(() => {}); }
      }
    }
  };
}
module.exports = { defaults, validateSettings, settingsStore, installationHash, userId };
