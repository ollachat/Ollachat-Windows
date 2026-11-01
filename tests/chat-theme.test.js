import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ThemeStore, DEFAULT_ROOM_THEME } from '../src/storage/theme-store.js';
import {
  PRESET_THEMES,
  BUBBLE_STYLES,
  PRESET_WALLPAPERS,
  getPresetTheme,
  getBubbleStyle,
  getPresetWallpaper,
  loadAndApplyThemeForRoom
} from '../src/renderer/theme-manager.js';

test('Chat Theme System - ThemeStore & ThemeManager', async (t) => {
  let tempDir;

  t.beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollacore-theme-test-'));
  });

  t.afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  await t.test('1. ThemeStore requires a storage directory', () => {
    assert.throws(() => new ThemeStore(), /requires a valid storage directory path/);
  });

  await t.test('2. getRoomTheme returns default theme for unknown or empty room', async () => {
    const store = new ThemeStore(tempDir);
    const theme1 = await store.getRoomTheme('room-unknown');
    assert.deepEqual(theme1, DEFAULT_ROOM_THEME);

    const theme2 = await store.getRoomTheme('');
    assert.deepEqual(theme2, DEFAULT_ROOM_THEME);
  });

  await t.test('3. setRoomTheme persists and reloads across store instances', async () => {
    const store1 = new ThemeStore(tempDir);
    const customTheme = {
      preset: 'ocean',
      bubbleStyle: 'rounded',
      wallpaper: {
        type: 'preset',
        value: 'waves',
        localPath: null
      }
    };

    const saved = await store1.setRoomTheme('room-123', customTheme);
    assert.equal(saved.preset, 'ocean');
    assert.equal(saved.bubbleStyle, 'rounded');
    assert.equal(saved.wallpaper.type, 'preset');
    assert.equal(saved.wallpaper.value, 'waves');

    // Reload using fresh store instance reading from disk
    const store2 = new ThemeStore(tempDir);
    const loaded = await store2.getRoomTheme('room-123');
    assert.deepEqual(loaded, saved);
  });

  await t.test('4. setPreset updates only preset and preserves other properties', async () => {
    const store = new ThemeStore(tempDir);
    await store.setRoomTheme('room-abc', {
      preset: 'midnight',
      bubbleStyle: 'compact',
      wallpaper: { type: 'preset', value: 'aurora', localPath: null }
    });

    const updated = await store.setPreset('room-abc', 'emerald');
    assert.equal(updated.preset, 'emerald');
    assert.equal(updated.bubbleStyle, 'compact');
    assert.equal(updated.wallpaper.value, 'aurora');
  });

  await t.test('5. setBubbleStyle updates only bubble style', async () => {
    const store = new ThemeStore(tempDir);
    await store.setRoomTheme('room-def', {
      preset: 'sunset',
      bubbleStyle: 'default',
      wallpaper: { type: 'none', value: null, localPath: null }
    });

    const updated = await store.setBubbleStyle('room-def', 'soft');
    assert.equal(updated.preset, 'sunset');
    assert.equal(updated.bubbleStyle, 'soft');
  });

  await t.test('6. setWallpaper and clearWallpaper work correctly', async () => {
    const store = new ThemeStore(tempDir);
    const withWp = await store.setWallpaper('room-wp', {
      type: 'custom',
      value: 'custom_photo.png',
      localPath: 'C:\\Users\\test\\themes\\wallpapers\\custom_photo.png'
    });
    assert.equal(withWp.wallpaper.type, 'custom');
    assert.equal(withWp.wallpaper.value, 'custom_photo.png');
    assert.equal(withWp.wallpaper.localPath, 'C:\\Users\\test\\themes\\wallpapers\\custom_photo.png');

    const cleared = await store.clearWallpaper('room-wp');
    assert.equal(cleared.wallpaper.type, 'none');
    assert.equal(cleared.wallpaper.value, null);
    assert.equal(cleared.wallpaper.localPath, null);
  });

  await t.test('7. resetRoomTheme deletes customized settings for that room', async () => {
    const store = new ThemeStore(tempDir);
    await store.setRoomTheme('room-reset', { preset: 'purple', bubbleStyle: 'large' });
    const beforeReset = await store.getRoomTheme('room-reset');
    assert.equal(beforeReset.preset, 'purple');

    const afterReset = await store.resetRoomTheme('room-reset');
    assert.deepEqual(afterReset, DEFAULT_ROOM_THEME);

    const reloaded = await store.getRoomTheme('room-reset');
    assert.deepEqual(reloaded, DEFAULT_ROOM_THEME);
  });

  await t.test('8. Multi-room theme isolation', async () => {
    const store = new ThemeStore(tempDir);
    await store.setRoomTheme('room-A', { preset: 'ocean' });
    await store.setRoomTheme('room-B', { preset: 'forest' });

    const themeA = await store.getRoomTheme('room-A');
    const themeB = await store.getRoomTheme('room-B');

    assert.equal(themeA.preset, 'ocean');
    assert.equal(themeB.preset, 'forest');

    const allRooms = await store.getAllRoomIds();
    assert(allRooms.includes('room-A'));
    assert(allRooms.includes('room-B'));
  });

  await t.test('9. Sanitizes unknown or invalid values safely', async () => {
    const store = new ThemeStore(tempDir);
    const sanitized = await store.setRoomTheme('room-invalid', {
      preset: 12345, // invalid type
      bubbleStyle: null,
      wallpaper: { type: 'hacked_type', value: 999, localPath: {} }
    });

    assert.equal(sanitized.preset, 'default');
    assert.equal(sanitized.bubbleStyle, 'default');
    assert.equal(sanitized.wallpaper.type, 'none');
    assert.equal(sanitized.wallpaper.value, null);
    assert.equal(sanitized.wallpaper.localPath, null);
  });

  await t.test('10. Corrupt storage file gracefully defaults to empty state', async () => {
    const store = new ThemeStore(tempDir);
    await fs.writeFile(store.filePath, '{ corrupt-json :::', 'utf8');

    const loaded = await store.getRoomTheme('any-room');
    assert.deepEqual(loaded, DEFAULT_ROOM_THEME);
  });

  await t.test('11. PRESET_THEMES defines 12 distinct themes with valid colors', () => {
    assert.equal(PRESET_THEMES.length, 12);
    for (const theme of PRESET_THEMES) {
      assert(typeof theme.id === 'string' && theme.id.length > 0);
      assert(typeof theme.name === 'string' && theme.name.length > 0);
      assert(typeof theme.incomingBg === 'string');
      assert(typeof theme.outgoingBg === 'string');
      assert(typeof theme.chatBg === 'string');
      assert(typeof theme.composerBg === 'string');
      assert(typeof theme.accent === 'string');
    }
  });

  await t.test('12. BUBBLE_STYLES defines 5 bubble styles with valid radius and padding', () => {
    assert.equal(BUBBLE_STYLES.length, 5);
    for (const style of BUBBLE_STYLES) {
      assert(typeof style.id === 'string');
      assert(typeof style.name === 'string');
      assert(typeof style.radius === 'string');
      assert(typeof style.padding === 'string');
    }
  });

  await t.test('13. PRESET_WALLPAPERS defines 10 wallpapers without external URLs', () => {
    assert.equal(PRESET_WALLPAPERS.length, 10);
    for (const wp of PRESET_WALLPAPERS) {
      assert(typeof wp.id === 'string');
      assert(typeof wp.name === 'string');
      assert(!wp.image || !wp.image.startsWith('http'));
      assert(!wp.bg || !wp.bg.startsWith('http'));
    }
  });

  await t.test('14. Helper lookups fallback gracefully on unknown IDs', () => {
    const fallbackTheme = getPresetTheme('non-existent-theme');
    assert.equal(fallbackTheme.id, 'default');

    const fallbackBubble = getBubbleStyle('non-existent-bubble');
    assert.equal(fallbackBubble.id, 'default');

    const fallbackWp = getPresetWallpaper('non-existent-wp');
    assert.equal(fallbackWp.id, 'none');
  });

  await t.test('15. loadAndApplyThemeForRoom is exported and functions safely', async () => {
    assert.equal(typeof loadAndApplyThemeForRoom, 'function');

    // Without roomId, returns default theme
    const def = await loadAndApplyThemeForRoom('');
    assert.equal(def.preset, 'default');
  });

  await t.test('16. loadAndApplyThemeForRoom loads room theme from window.ollacoreDesktop.theme', async () => {
    const originalDesktop = global.window?.ollacoreDesktop;
    global.window = global.window || {};
    global.window.ollacoreDesktop = {
      theme: {
        getRoomTheme: async (roomId) => {
          if (roomId === 'room-test-1') {
            return {
              ok: true,
              theme: { preset: 'ocean', bubbleStyle: 'rounded', wallpaper: { type: 'none', value: null, localPath: null } }
            };
          }
          return { ok: true, theme: null };
        }
      }
    };

    try {
      const theme = await loadAndApplyThemeForRoom('room-test-1');
      assert.equal(theme.preset, 'ocean');
      assert.equal(theme.bubbleStyle, 'rounded');
    } finally {
      if (originalDesktop) {
        global.window.ollacoreDesktop = originalDesktop;
      } else {
        delete global.window.ollacoreDesktop;
      }
    }
  });

  await t.test('17. loadAndApplyThemeForRoom never throws on IPC bridge error and falls back to default', async () => {
    const originalDesktop = global.window?.ollacoreDesktop;
    global.window = global.window || {};
    global.window.ollacoreDesktop = {
      theme: {
        getRoomTheme: async () => {
          throw new Error('Simulated IPC crash');
        }
      }
    };

    try {
      const theme = await loadAndApplyThemeForRoom('room-failing');
      assert.equal(theme.preset, 'default');
      assert.equal(theme.bubbleStyle, 'default');
    } finally {
      if (originalDesktop) {
        global.window.ollacoreDesktop = originalDesktop;
      } else {
        delete global.window.ollacoreDesktop;
      }
    }
  });
});
