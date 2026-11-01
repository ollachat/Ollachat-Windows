/**
 * notification-store.js
 *
 * Persistent local notification preference storage for OllaChat Windows Desktop.
 * Stores global desktop notification and message preview preferences in a JSON file
 * inside the Electron userData directory.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  version: 1,
  enabled: true,
  showPreview: true
});

const NOTIFICATION_FILE = 'ollacore_notification_settings.json';

export class NotificationStore {
  /**
   * @param {string} storageDir Electron app.getPath('userData')
   */
  constructor(storageDir) {
    if (!storageDir) throw new Error('NotificationStore requires a valid storage directory path');
    this.storageDir = storageDir;
    this.filePath = path.join(storageDir, NOTIFICATION_FILE);
    this._data = { ...DEFAULT_NOTIFICATION_SETTINGS };
    this._loaded = false;
  }

  /**
   * Loads notification settings from disk.
   * If the file does not exist, defaults are used.
   * @returns {Promise<object>}
   */
  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this._data = {
        version: parsed.version || DEFAULT_NOTIFICATION_SETTINGS.version,
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_NOTIFICATION_SETTINGS.enabled,
        showPreview: typeof parsed.showPreview === 'boolean' ? parsed.showPreview : DEFAULT_NOTIFICATION_SETTINGS.showPreview
      };
      this._loaded = true;
    } catch {
      // File missing or corrupt, fallback to defaults
      this._data = { ...DEFAULT_NOTIFICATION_SETTINGS };
      this._loaded = true;
    }
    return this.getSettings();
  }

  /**
   * Returns a copy of the current notification settings.
   * @returns {{ enabled: boolean, showPreview: boolean }}
   */
  getSettings() {
    return {
      enabled: Boolean(this._data.enabled),
      showPreview: Boolean(this._data.showPreview)
    };
  }

  /**
   * Returns whether desktop notifications are globally enabled.
   * @returns {boolean}
   */
  getEnabled() {
    return Boolean(this._data.enabled);
  }

  /**
   * Returns whether message previews should be displayed in notifications.
   * @returns {boolean}
   */
  getShowPreview() {
    return Boolean(this._data.showPreview);
  }

  /**
   * Updates and persists notification settings.
   * @param {object} settings
   * @returns {Promise<{ ok: boolean, settings: { enabled: boolean, showPreview: boolean } }>}
   */
  async setSettings(settings = {}) {
    if (!this._loaded) {
      await this.load();
    }

    if (typeof settings.enabled === 'boolean') {
      this._data.enabled = settings.enabled;
    }
    if (typeof settings.showPreview === 'boolean') {
      this._data.showPreview = settings.showPreview;
    }

    await this._persist();
    return { ok: true, settings: this.getSettings() };
  }

  /**
   * Alias for setSettings.
   * @param {object} settings
   */
  async save(settings = {}) {
    return this.setSettings(settings);
  }

  /**
   * Atomically writes data to disk.
   * @private
   */
  async _persist() {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      const tmpPath = `${this.filePath}.tmp.${Date.now()}`;
      await fs.writeFile(tmpPath, JSON.stringify(this._data, null, 2), 'utf8');
      await fs.rename(tmpPath, this.filePath);
    } catch (err) {
      console.warn('[NotificationStore] Failed to write notification settings to disk:', err?.message || err);
    }
  }
}
