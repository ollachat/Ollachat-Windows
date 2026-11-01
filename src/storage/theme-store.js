/**
 * theme-store.js
 *
 * Persistent local theme preference storage for OllaChat.
 *
 * Stores per-room chat theme configuration in a JSON file inside the
 * Electron userData directory. Completely independent of OllaCore / backend.
 *
 * Schema:
 *   {
 *     version: 1,
 *     rooms: {
 *       [roomId]: {
 *         preset: string,       // e.g. "ocean"
 *         bubbleStyle: string,  // e.g. "rounded"
 *         wallpaper: {
 *           type: "none" | "preset" | "custom",
 *           value: string | null,     // preset name or null
 *           localPath: string | null  // absolute local path for custom
 *         }
 *       }
 *     }
 *   }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_ROOM_THEME = Object.freeze({
  custom: false,
  preset: 'default',
  bubbleStyle: 'default',
  wallpaper: Object.freeze({ type: 'none', value: null, localPath: null })
});

const THEME_FILE = 'ollacore_themes.json';
const SCHEMA_VERSION = 1;

export class ThemeStore {
  /**
   * @param {string} storageDir  Electron app.getPath('userData')
   */
  constructor(storageDir) {
    if (!storageDir) throw new Error('ThemeStore requires a valid storage directory path');
    this.storageDir = storageDir;
    this.filePath = path.join(storageDir, THEME_FILE);
    this._data = {
      version: SCHEMA_VERSION,
      appPreferences: { theme: 'system' },
      appTheme: 'system',
      rooms: {}
    };
    this._loaded = false;
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────
  _sanitizeWallpaper(w) {
    if (!w || typeof w !== 'object') return { ...DEFAULT_ROOM_THEME.wallpaper };
    const type = ['none', 'preset', 'custom'].includes(w.type) ? w.type : 'none';
    return {
      type,
      value: typeof w.value === 'string' && w.value.trim() ? w.value.trim() : null,
      localPath: typeof w.localPath === 'string' && w.localPath.trim() ? w.localPath.trim() : null
    };
  }

  _sanitizeRoomTheme(raw) {
    if (!raw || typeof raw !== 'object') {
      return { ...DEFAULT_ROOM_THEME, wallpaper: { ...DEFAULT_ROOM_THEME.wallpaper } };
    }
    return {
      custom: raw.custom !== false,
      preset: typeof raw.preset === 'string' && raw.preset.trim() ? raw.preset.trim() : 'default',
      bubbleStyle: typeof raw.bubbleStyle === 'string' && raw.bubbleStyle.trim() ? raw.bubbleStyle.trim() : 'default',
      wallpaper: this._sanitizeWallpaper(raw.wallpaper)
    };
  }

  async _load() {
    if (this._loaded) return;
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      const content = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        const sanitizedRooms = {};
        if (parsed.rooms && typeof parsed.rooms === 'object') {
          for (const [roomId, theme] of Object.entries(parsed.rooms)) {
            if (typeof roomId === 'string' && roomId.trim()) {
              sanitizedRooms[roomId.trim()] = this._sanitizeRoomTheme(theme);
            }
          }
        }
        const appTheme = ['light', 'dark', 'system'].includes(parsed.appPreferences?.theme)
          ? parsed.appPreferences.theme
          : (['light', 'dark', 'system'].includes(parsed.appTheme) ? parsed.appTheme : 'system');

        this._data = {
          version: SCHEMA_VERSION,
          appPreferences: { theme: appTheme },
          appTheme,
          rooms: sanitizedRooms
        };
      } else {
        this._data = {
          version: SCHEMA_VERSION,
          appPreferences: { theme: 'system' },
          appTheme: 'system',
          rooms: {}
        };
      }
    } catch {
      this._data = {
        version: SCHEMA_VERSION,
        appPreferences: { theme: 'system' },
        appTheme: 'system',
        rooms: {}
      };
    }
    this._loaded = true;
  }

  async _persist() {
    await fs.mkdir(this.storageDir, { recursive: true });
    const tmp = path.join(this.storageDir, `ollacore_themes.tmp.${crypto.randomBytes(6).toString('hex')}`);
    await fs.writeFile(tmp, JSON.stringify(this._data, null, 2), 'utf8');
    for (let i = 0; i < 5; i++) {
      try {
        await fs.rename(tmp, this.filePath);
        return;
      } catch (err) {
        if ((err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') && i < 4) {
          await new Promise(r => setTimeout(r, 25 * (i + 1)));
        } else {
          try { await fs.copyFile(tmp, this.filePath); await fs.unlink(tmp).catch(() => {}); return; }
          catch { throw err; }
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────

  /** Returns global app theme preference ('light' | 'dark' | 'system'). */
  async getAppTheme() {
    await this._load();
    return this._data.appPreferences?.theme || this._data.appTheme || 'system';
  }

  /** Sets and persists global app theme preference. */
  async setAppTheme(theme) {
    await this._load();
    const valid = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
    if (!this._data.appPreferences) {
      this._data.appPreferences = {};
    }
    this._data.appPreferences.theme = valid;
    this._data.appTheme = valid;
    await this._persist();
    return valid;
  }

  /** Checks if a room has an active custom theme. */
  async hasCustomRoomTheme(roomId) {
    await this._load();
    if (!roomId || !this._data.rooms || !this._data.rooms[roomId]) return false;
    return this._data.rooms[roomId].custom !== false;
  }

  /** Returns the theme for a room, falling back to DEFAULT_ROOM_THEME if no custom theme. */
  async getRoomTheme(roomId) {
    await this._load();
    if (!roomId) return { ...DEFAULT_ROOM_THEME, wallpaper: { ...DEFAULT_ROOM_THEME.wallpaper } };
    const room = this._data.rooms[roomId];
    if (!room) {
      return { ...DEFAULT_ROOM_THEME, wallpaper: { ...DEFAULT_ROOM_THEME.wallpaper } };
    }
    return {
      ...room,
      custom: room.custom !== false,
      wallpaper: { ...room.wallpaper }
    };
  }

  /** Sets and persists the full theme for a room. */
  async setRoomTheme(roomId, theme) {
    await this._load();
    if (!roomId || typeof roomId !== 'string') throw new Error('roomId must be a non-empty string');
    if (theme && theme.custom === false) {
      delete this._data.rooms[roomId];
      await this._persist();
      return { ...DEFAULT_ROOM_THEME, wallpaper: { ...DEFAULT_ROOM_THEME.wallpaper } };
    }
    this._data.rooms[roomId] = this._sanitizeRoomTheme(theme);
    await this._persist();
    return { ...this._data.rooms[roomId], wallpaper: { ...this._data.rooms[roomId].wallpaper } };
  }

  /** Updates only the preset for a room (preserves other settings). */
  async setPreset(roomId, preset) {
    const current = await this.getRoomTheme(roomId);
    return this.setRoomTheme(roomId, { ...current, custom: true, preset: preset || 'default' });
  }

  /** Updates only the bubble style for a room. */
  async setBubbleStyle(roomId, bubbleStyle) {
    const current = await this.getRoomTheme(roomId);
    return this.setRoomTheme(roomId, { ...current, custom: true, bubbleStyle: bubbleStyle || 'default' });
  }

  /** Updates only the wallpaper for a room. */
  async setWallpaper(roomId, wallpaper) {
    const current = await this.getRoomTheme(roomId);
    return this.setRoomTheme(roomId, { ...current, custom: true, wallpaper });
  }

  /** Clears a room's wallpaper (sets type: none). */
  async clearWallpaper(roomId) {
    return this.setWallpaper(roomId, { type: 'none', value: null, localPath: null });
  }

  /** Resets a room to defaults and removes custom settings. */
  async resetRoomTheme(roomId) {
    await this._load();
    if (roomId && this._data.rooms) {
      delete this._data.rooms[roomId];
      await this._persist();
    }
    return { ...DEFAULT_ROOM_THEME, wallpaper: { ...DEFAULT_ROOM_THEME.wallpaper } };
  }

  /** Returns all stored room IDs that have custom themes. */
  async getAllRoomIds() {
    await this._load();
    return Object.keys(this._data.rooms);
  }
}
