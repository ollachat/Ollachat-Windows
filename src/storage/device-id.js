import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let _cachedDeviceId = null;

/**
 * Returns or generates a persistent installation-level Windows client device ID.
 * Stored in `ollacore_device.json` inside Electron's `userData` storage directory.
 *
 * Properties:
 * - Generated once and reused across application restarts and user logouts.
 * - Formatted as `windows-<uuid>`.
 * - Cached in volatile memory for synchronous, zero-I/O subsequent reads.
 * - Does not use hardware fingerprinting or machine serials.
 *
 * @param {string} storageDir Path to storage directory (typically app.getPath('userData'))
 * @param {string} [prefix='windows'] Optional prefix
 * @returns {string} e.g. "windows-e65b2633-5c5f-4a0b-8d19-482a0b16521a"
 */
export function getOrCreatePersistentDeviceId(storageDir, prefix = 'windows') {
  if (_cachedDeviceId) {
    return _cachedDeviceId;
  }
  if (!storageDir || typeof storageDir !== 'string') {
    return generateEphemeralDeviceId(prefix);
  }

  const filePath = path.join(storageDir, 'ollacore_device.json');

  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content && content.trim()) {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed.deviceId === 'string' && parsed.deviceId.startsWith(`${prefix}-`)) {
          _cachedDeviceId = parsed.deviceId;
          return _cachedDeviceId;
        }
      }
    }
  } catch (err) {
    console.warn('[DeviceId] Existing device file read error, will regenerate:', err?.message || err);
  }

  // Generate fresh persistent installation ID
  const newId = generateEphemeralDeviceId(prefix);
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    const payload = JSON.stringify({
      deviceId: newId,
      createdAt: new Date().toISOString()
    }, null, 2);
    const tmpFile = path.join(storageDir, `ollacore_device.json.tmp.${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(tmpFile, payload, 'utf8');
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    console.warn('[DeviceId] Failed to persist device ID file to disk:', err?.message || err);
  }

  _cachedDeviceId = newId;
  return _cachedDeviceId;
}

/**
 * Synchronous getter returning the active cached device ID.
 * Falls back to an ephemeral ID if persistent ID has not yet been initialized.
 *
 * @returns {string}
 */
export function getDeviceId() {
  return _cachedDeviceId || generateEphemeralDeviceId('windows');
}

/**
 * Generates an ephemeral Windows client device ID.
 * Retained for backward compatibility and test isolation.
 *
 * @param {string} [prefix='windows'] Optional prefix
 * @returns {string} e.g. "windows-e65b2633-5c5f-4a0b-8d19-482a0b16521a"
 */
export function generateEphemeralDeviceId(prefix = 'windows') {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Test helper to reset in-memory cached device ID between test runs.
 */
export function _resetCachedDeviceIdForTesting() {
  _cachedDeviceId = null;
}

