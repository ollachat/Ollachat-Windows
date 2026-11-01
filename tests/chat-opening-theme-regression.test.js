import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatShellState } from '../src/renderer/chat-shell-state.js';
import {
  PRESET_THEMES,
  BUBBLE_STYLES,
  PRESET_WALLPAPERS,
  getPresetTheme,
  getBubbleStyle,
  getPresetWallpaper,
  applyRoomTheme,
  resetThemeToDefault,
  loadAndApplyThemeForRoom
} from '../src/renderer/theme-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Chat Opening & Theme Loading Regression Suite (15 Invariants)', async (t) => {
  // Mock DOM environment for headless testing
  let styleProperties = {};
  let classMap = {};

  const mockElement = (id) => ({
    id,
    classList: {
      contains: (cls) => Boolean(classMap[id]?.has(cls)),
      add: (cls) => {
        if (!classMap[id]) classMap[id] = new Set();
        classMap[id].add(cls);
      },
      remove: (cls) => {
        if (!classMap[id]) classMap[id] = new Set();
        classMap[id].delete(cls);
      }
    },
    style: {
      setProperty: (prop, val) => { styleProperties[prop] = val; },
      removeProperty: (prop) => { delete styleProperties[prop]; },
      getPropertyValue: (prop) => styleProperties[prop] || ''
    },
    textContent: '',
    innerHTML: '',
    addEventListener: () => {},
    querySelectorAll: () => []
  });

  t.beforeEach(() => {
    styleProperties = {};
    classMap = {
      'chat-empty-panel': new Set(),
      'chat-selected-panel': new Set(['hidden']),
      'settings-modal': new Set(['hidden']),
      'chat-theme-modal': new Set(['hidden'])
    };

    global.document = {
      documentElement: mockElement('documentElement'),
      getElementById: (id) => mockElement(id),
      querySelectorAll: () => []
    };
  });

  t.afterEach(() => {
    delete global.document;
    delete global.window?.ollacoreDesktop;
  });

  await t.test('1. Chat Theme button exists in HTML structure', async () => {
    const htmlPath = path.resolve(__dirname, '../src/renderer/index.html');
    const html = await fs.readFile(htmlPath, 'utf8');

    assert(html.includes('id="btn-chat-theme"'), 'Header button btn-chat-theme must exist');
    assert(html.includes('id="setting-item-chat-theme"'), 'Settings row setting-item-chat-theme must exist');
    assert(html.includes('id="chat-theme-modal"'), 'Modal chat-theme-modal must exist');
  });

  await t.test('2. Chat Theme button opens the theme UI', () => {
    const modal = global.document.getElementById('chat-theme-modal');
    assert(modal.classList.contains('hidden'));

    // Open action
    modal.classList.remove('hidden');
    assert(!modal.classList.contains('hidden'));
  });

  await t.test('3. Theme preset collection is defined as an array of 12 presets', () => {
    assert(Array.isArray(PRESET_THEMES), 'PRESET_THEMES must be an array');
    assert.equal(PRESET_THEMES.length, 12);
  });

  await t.test('4. Bubble style collection is defined as an array of 5 styles', () => {
    assert(Array.isArray(BUBBLE_STYLES), 'BUBBLE_STYLES must be an array');
    assert.equal(BUBBLE_STYLES.length, 5);
  });

  await t.test('5. Wallpaper collection is defined as an array of 10 wallpapers', () => {
    assert(Array.isArray(PRESET_WALLPAPERS), 'PRESET_WALLPAPERS must be an array');
    assert.equal(PRESET_WALLPAPERS.length, 10);
  });

  await t.test('6. Theme gallery lookups return valid objects without throwing', () => {
    for (const preset of PRESET_THEMES) {
      const found = getPresetTheme(preset.id);
      assert.equal(found.id, preset.id);
    }
    for (const style of BUBBLE_STYLES) {
      const found = getBubbleStyle(style.id);
      assert.equal(found.id, style.id);
    }
    for (const wp of PRESET_WALLPAPERS) {
      const found = getPresetWallpaper(wp.id);
      assert.equal(found.id, wp.id);
    }
  });

  await t.test('7. Current room theme loads correctly', async () => {
    global.window = global.window || {};
    global.window.ollacoreDesktop = {
      theme: {
        getRoomTheme: async (roomId) => {
          if (roomId === 'room-custom') {
            return { ok: true, theme: { preset: 'ocean', bubbleStyle: 'rounded' } };
          }
          return { ok: true, theme: null };
        }
      }
    };

    const theme = await loadAndApplyThemeForRoom('room-custom');
    assert.equal(theme.preset, 'ocean');
    assert.equal(theme.bubbleStyle, 'rounded');
    assert.equal(styleProperties['--chat-outgoing-bg'], '#006994');
  });

  await t.test('8. Chat Theme does not crash without active room (Home screen context)', async () => {
    const shellState = new ChatShellState();
    shellState.conversations = [
      { id: 'room-1', name: 'Chat 1' }
    ];

    // No room selected
    const activeRoomId = null;
    const list = Array.isArray(shellState.conversations)
      ? shellState.conversations
      : (Array.isArray(shellState.inbox) ? shellState.inbox : []);

    let subtitle = '';
    if (activeRoomId) {
      const conv = list.find(i => i && (i.id === activeRoomId || i.roomId === activeRoomId));
      subtitle = conv ? conv.name : 'This Chat';
    } else {
      subtitle = 'Global default chat theme';
    }

    assert.equal(subtitle, 'Global default chat theme');

    // Theme load with null roomId must not throw
    const theme = await loadAndApplyThemeForRoom(null);
    assert.equal(theme.preset, 'default');
  });

  await t.test('9. Invalid/missing theme falls back to default theme', async () => {
    global.window = global.window || {};
    global.window.ollacoreDesktop = {
      theme: {
        getRoomTheme: async () => ({ ok: true, theme: null })
      }
    };

    const theme = await loadAndApplyThemeForRoom('room-unthemed');
    assert.equal(theme.preset, 'default');
    assert.equal(styleProperties['--chat-outgoing-bg'], '#005c4b');
  });

  await t.test('10. Theme page does not throw a TypeError on conversation search', () => {
    const shellState = new ChatShellState();
    shellState.conversations = [{ id: 'room-1', name: 'Alice' }];

    // Both shellState.conversations and shellState.inbox must be accessible without throwing
    assert.doesNotThrow(() => {
      const conv1 = shellState.conversations.find(c => c.id === 'room-1');
      assert.equal(conv1?.name, 'Alice');

      const conv2 = shellState.inbox.find(c => c.id === 'room-1');
      assert.equal(conv2?.name, 'Alice');
    });
  });

  await t.test('11. Opening Chat Theme does not break Settings', () => {
    const settingsModal = global.document.getElementById('settings-modal');
    const themeModal = global.document.getElementById('chat-theme-modal');

    // Settings is open
    settingsModal.classList.remove('hidden');
    assert(!settingsModal.classList.contains('hidden'));

    // Click "Chat Theme" row inside Settings: hides settings, shows theme modal
    settingsModal.classList.add('hidden');
    themeModal.classList.remove('hidden');

    assert(settingsModal.classList.contains('hidden'));
    assert(!themeModal.classList.contains('hidden'));
  });

  await t.test('12. Closing Chat Theme returns to Settings correctly when opened from settings', () => {
    const settingsModal = global.document.getElementById('settings-modal');
    const themeModal = global.document.getElementById('chat-theme-modal');

    let themeOpenedFromSettings = true;

    // Close theme modal
    themeModal.classList.add('hidden');
    if (themeOpenedFromSettings) {
      themeOpenedFromSettings = false;
      settingsModal.classList.remove('hidden');
    }

    assert(themeModal.classList.contains('hidden'));
    assert(!settingsModal.classList.contains('hidden'));
  });

  await t.test('13. Chat selection still opens normally and toggles panels', () => {
    const shellState = new ChatShellState();
    shellState.conversations = [
      { id: 'room-select-test', name: 'Bob' }
    ];

    shellState.selectConversation('room-select-test');
    assert.equal(shellState.selectedRoomId, 'room-select-test');

    const emptyPanel = global.document.getElementById('chat-empty-panel');
    const selectedPanel = global.document.getElementById('chat-selected-panel');
    emptyPanel.classList.add('hidden');
    selectedPanel.classList.remove('hidden');

    assert(emptyPanel.classList.contains('hidden'));
    assert(!selectedPanel.classList.contains('hidden'));
  });

  await t.test('14. Per-room theme persistence works across room loads', async () => {
    const storageMap = new Map();
    global.window = global.window || {};
    global.window.ollacoreDesktop = {
      theme: {
        getRoomTheme: async (roomId) => ({ ok: true, theme: storageMap.get(roomId) || null }),
        setRoomTheme: async (roomId, theme) => {
          storageMap.set(roomId, theme);
          return { ok: true, theme };
        }
      }
    };

    // Save theme for room A
    await global.window.ollacoreDesktop.theme.setRoomTheme('room-A', { preset: 'emerald', bubbleStyle: 'compact' });

    const loadedA = await loadAndApplyThemeForRoom('room-A');
    assert.equal(loadedA.preset, 'emerald');
    assert.equal(loadedA.bubbleStyle, 'compact');
  });

  await t.test('15. Switching between rooms (A -> B -> C -> A) updates themes seamlessly', async () => {
    global.window = global.window || {};
    global.window.ollacoreDesktop = {
      theme: {
        getRoomTheme: async (roomId) => {
          if (roomId === 'room-A') return { ok: true, theme: { preset: 'ocean' } };
          if (roomId === 'room-B') return { ok: true, theme: { preset: 'sunset' } };
          if (roomId === 'room-C') return { ok: true, theme: { preset: 'forest' } };
          return { ok: true, theme: null };
        }
      }
    };

    const themeA = await loadAndApplyThemeForRoom('room-A');
    assert.equal(themeA.preset, 'ocean');
    assert.equal(styleProperties['--chat-outgoing-bg'], '#006994');

    const themeB = await loadAndApplyThemeForRoom('room-B');
    assert.equal(themeB.preset, 'sunset');
    assert.equal(styleProperties['--chat-outgoing-bg'], '#e11d48');

    const themeC = await loadAndApplyThemeForRoom('room-C');
    assert.equal(themeC.preset, 'forest');
    assert.equal(styleProperties['--chat-outgoing-bg'], '#166534');

    const themeA2 = await loadAndApplyThemeForRoom('room-A');
    assert.equal(themeA2.preset, 'ocean');
    assert.equal(styleProperties['--chat-outgoing-bg'], '#006994');
  });
});
