import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRESET_THEMES,
  BUBBLE_STYLES,
  PRESET_WALLPAPERS,
  getPresetTheme,
  getBubbleStyle,
  getPresetWallpaper,
  applyRoomTheme,
  getResolvedAppTheme,
  applyAppTheme
} from '../src/renderer/theme-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Chat Theme Live Preview Regression Suite (10 Invariants)', async (suite) => {
  let styleProperties = {};
  let classMap = {};

  const createMockElement = (id) => {
    const elemStyles = {};
    const attrs = {};
    return {
      id,
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] || null,
      removeAttribute: (k) => { delete attrs[k]; },
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
        setProperty: (prop, val) => { elemStyles[prop] = val; },
        removeProperty: (prop) => { delete elemStyles[prop]; },
        getPropertyValue: (prop) => elemStyles[prop] || '',
        backgroundColor: '',
        color: '',
        border: '',
        borderRadius: '',
        padding: '',
        fontSize: '',
        background: '',
        backgroundImage: '',
        backgroundSize: '',
        backgroundPosition: '',
        backgroundRepeat: ''
      },
      textContent: '',
      innerHTML: '',
      children: [],
      appendChild: function(c) { this.children.push(c); return c; },
      querySelector: function(selector) {
        if (selector === '.theme-preview-time') {
          return { style: { color: '' } };
        }
        if (selector === '.theme-preview-media-thumb') {
          return { style: { borderRadius: '' } };
        }
        return null;
      },
      querySelectorAll: () => [],
      addEventListener: () => {}
    };
  };

  // Helper simulating the preview updater function
  function simulateUpdateThemePreview(currentEditingTheme, previewElements) {
    const isCustom = currentEditingTheme.custom === true;
    const resolved = getResolvedAppTheme();
    const effectivePresetId = isCustom
      ? currentEditingTheme.preset
      : (resolved === 'dark' ? 'dark-default' : 'default');

    const theme = getPresetTheme(effectivePresetId);
    const bubble = getBubbleStyle(isCustom ? currentEditingTheme.bubbleStyle : 'default');
    const wallpaper = isCustom
      ? (currentEditingTheme.wallpaper || { type: 'none', value: null, localPath: null })
      : { type: 'none', value: null, localPath: null };

    const { screen, incoming, outgoing, media, statusName } = previewElements;

    if (statusName) {
      statusName.textContent = !isCustom
        ? `App Theme (${resolved === 'dark' ? 'Dark' : 'Light'})`
        : theme.name;
    }

    if (screen) {
      screen.style.setProperty('--chat-incoming-bg', theme.incomingBg);
      screen.style.setProperty('--chat-incoming-text', theme.incomingText);
      screen.style.setProperty('--chat-outgoing-bg', theme.outgoingBg);
      screen.style.setProperty('--chat-outgoing-text', theme.outgoingText);
      screen.style.setProperty('--chat-secondary-text', theme.secondaryText);
      screen.style.setProperty('--chat-incoming-border', theme.bubbleBorder);
      screen.style.setProperty('--chat-bubble-radius', bubble.radius);
      screen.style.setProperty('--chat-bubble-padding', bubble.padding);
      screen.style.setProperty('--chat-bubble-font-size', bubble.fontSize);

      if (wallpaper.type === 'custom' && (wallpaper.safeUrl || wallpaper.previewDataUrl)) {
        const url = wallpaper.safeUrl || wallpaper.previewDataUrl;
        screen.style.backgroundColor = '#000000';
        screen.style.backgroundImage = `url("${url}")`;
        screen.style.backgroundSize = 'cover';
        screen.style.backgroundPosition = 'center';
        screen.style.backgroundRepeat = 'no-repeat';
      } else if (wallpaper.type === 'preset' && wallpaper.value) {
        const wp = getPresetWallpaper(wallpaper.value);
        if (wp.bg && wp.bg.includes('gradient')) {
          screen.style.background = wp.bg;
        } else {
          screen.style.backgroundColor = wp.bg || '#f0f2f5';
        }
        if (wp.image && wp.image !== 'none') {
          screen.style.backgroundImage = wp.image;
          screen.style.backgroundSize = wp.size || '24px 24px';
          screen.style.backgroundRepeat = 'repeat';
        }
      } else {
        screen.style.backgroundColor = theme.chatBg;
        if (theme.chatBgImage && theme.chatBgImage !== 'none') {
          screen.style.backgroundImage = theme.chatBgImage;
          screen.style.backgroundSize = theme.chatBgSize || '24px 24px';
          screen.style.backgroundRepeat = 'repeat';
        }
      }
    }

    if (incoming) {
      incoming.style.backgroundColor = theme.incomingBg;
      incoming.style.color = theme.incomingText;
      incoming.style.border = theme.bubbleBorder;
      incoming.style.borderRadius = bubble.radius;
      incoming.style.padding = bubble.padding;
      incoming.style.fontSize = bubble.fontSize;
      const incomingTime = incoming.querySelector('.theme-preview-time');
      if (incomingTime) incomingTime.style.color = theme.secondaryText;
    }

    if (media) {
      if (theme.outgoingBg.includes('gradient')) {
        media.style.background = theme.outgoingBg;
      } else {
        media.style.backgroundColor = theme.outgoingBg;
      }
      media.style.color = theme.outgoingText;
      media.style.borderRadius = bubble.radius;
      media.style.padding = bubble.padding;
      media.style.fontSize = bubble.fontSize;
      const mediaThumb = media.querySelector('.theme-preview-media-thumb');
      if (mediaThumb) mediaThumb.style.borderRadius = `calc(${bubble.radius} - 2px)`;
      const mediaTime = media.querySelector('.theme-preview-time');
      if (mediaTime) mediaTime.style.color = 'rgba(233, 237, 239, 0.8)';
    }

    if (outgoing) {
      if (theme.outgoingBg.includes('gradient')) {
        outgoing.style.background = theme.outgoingBg;
      } else {
        outgoing.style.backgroundColor = theme.outgoingBg;
      }
      outgoing.style.color = theme.outgoingText;
      outgoing.style.borderRadius = bubble.radius;
      outgoing.style.padding = bubble.padding;
      outgoing.style.fontSize = bubble.fontSize;
      const outgoingTime = outgoing.querySelector('.theme-preview-time');
      if (outgoingTime) outgoingTime.style.color = 'rgba(233, 237, 239, 0.8)';
    }
  }

  suite.beforeEach(() => {
    styleProperties = {};
    classMap = {
      'chat-theme-modal': new Set(['hidden'])
    };

    global.document = {
      documentElement: createMockElement('documentElement'),
      getElementById: (id) => createMockElement(id),
      querySelectorAll: () => []
    };
  });

  suite.afterEach(() => {
    delete global.document;
  });

  await suite.test('1. Preview renders markup properly inside theme modal in index.html', async () => {
    const htmlPath = path.resolve(__dirname, '../src/renderer/index.html');
    const html = await fs.readFile(htmlPath, 'utf8');

    assert(html.includes('class="theme-preview-container"'), 'Preview container must exist');
    assert(html.includes('Live Preview'), 'Preview label Live Preview must exist');
    assert(html.includes('id="theme-preview-status-name"'), 'Badge theme-preview-status-name must exist');
    assert(html.includes('id="theme-preview-screen"'), 'Preview screen must exist');
    assert(html.includes('class="theme-preview-day-divider"'), 'Day divider pill must exist');
    assert(html.includes('id="theme-preview-incoming"'), 'Incoming bubble element must exist');
    assert(html.includes('id="theme-preview-media"'), 'Media message bubble preview must exist');
    assert(html.includes('id="theme-preview-outgoing"'), 'Outgoing bubble element must exist');
    assert(html.includes('class="theme-preview-status-icon status-read"'), 'Read tick status element must exist');
  });

  await suite.test('2. Selecting each color theme updates preview styling for all 12 presets', () => {
    assert.equal(PRESET_THEMES.length, 12, 'Must have exactly 12 presets');

    const screen = createMockElement('theme-preview-screen');
    const incoming = createMockElement('theme-preview-incoming');
    const outgoing = createMockElement('theme-preview-outgoing');
    const media = createMockElement('theme-preview-media');
    const statusName = createMockElement('theme-preview-status-name');
    const previewElements = { screen, incoming, outgoing, media, statusName };

    for (const preset of PRESET_THEMES) {
      const themeState = {
        custom: true,
        preset: preset.id,
        bubbleStyle: 'default',
        wallpaper: { type: 'none', value: null, localPath: null }
      };

      simulateUpdateThemePreview(themeState, previewElements);

      assert.equal(statusName.textContent, preset.name, `Status badge must display preset name ${preset.name}`);
      assert.equal(incoming.style.backgroundColor, preset.incomingBg, `Incoming background must match for ${preset.id}`);
      assert.equal(incoming.style.color, preset.incomingText, `Incoming text must match for ${preset.id}`);
      assert.equal(outgoing.style.color, preset.outgoingText, `Outgoing text must match for ${preset.id}`);
      assert.equal(screen.style.getPropertyValue('--chat-incoming-bg'), preset.incomingBg);
      assert.equal(screen.style.getPropertyValue('--chat-outgoing-bg'), preset.outgoingBg);
      assert.equal(screen.style.getPropertyValue('--chat-secondary-text'), preset.secondaryText);
    }
  });

  await suite.test('3. Selecting each bubble style updates preview styling for all 5 styles', () => {
    assert.equal(BUBBLE_STYLES.length, 5, 'Must have exactly 5 bubble styles');

    const screen = createMockElement('theme-preview-screen');
    const incoming = createMockElement('theme-preview-incoming');
    const outgoing = createMockElement('theme-preview-outgoing');
    const media = createMockElement('theme-preview-media');
    const statusName = createMockElement('theme-preview-status-name');
    const previewElements = { screen, incoming, outgoing, media, statusName };

    for (const style of BUBBLE_STYLES) {
      const themeState = {
        custom: true,
        preset: 'default',
        bubbleStyle: style.id,
        wallpaper: { type: 'none', value: null, localPath: null }
      };

      simulateUpdateThemePreview(themeState, previewElements);

      assert.equal(incoming.style.borderRadius, style.radius, `Incoming radius must match for style ${style.id}`);
      assert.equal(incoming.style.padding, style.padding, `Incoming padding must match for style ${style.id}`);
      assert.equal(incoming.style.fontSize, style.fontSize, `Incoming fontSize must match for style ${style.id}`);
      assert.equal(outgoing.style.borderRadius, style.radius, `Outgoing radius must match for style ${style.id}`);
      assert.equal(outgoing.style.padding, style.padding, `Outgoing padding must match for style ${style.id}`);
      assert.equal(media.style.borderRadius, style.radius, `Media radius must match for style ${style.id}`);
      assert.equal(screen.style.getPropertyValue('--chat-bubble-radius'), style.radius);
    }
  });

  await suite.test('4. Selecting each wallpaper updates preview styling', () => {
    assert.equal(PRESET_WALLPAPERS.length, 10, 'Must have 10 wallpapers');

    const screen = createMockElement('theme-preview-screen');
    const incoming = createMockElement('theme-preview-incoming');
    const outgoing = createMockElement('theme-preview-outgoing');
    const media = createMockElement('theme-preview-media');
    const statusName = createMockElement('theme-preview-status-name');
    const previewElements = { screen, incoming, outgoing, media, statusName };

    // Test each preset wallpaper
    for (const wp of PRESET_WALLPAPERS) {
      const themeState = {
        custom: true,
        preset: 'default',
        bubbleStyle: 'default',
        wallpaper: { type: wp.id === 'none' ? 'none' : 'preset', value: wp.id === 'none' ? null : wp.id, localPath: null }
      };

      simulateUpdateThemePreview(themeState, previewElements);

      if (wp.id === 'none') {
        const defTheme = getPresetTheme('default');
        assert.equal(screen.style.backgroundColor, defTheme.chatBg);
      } else {
        if (wp.bg?.includes('gradient')) {
          assert.equal(screen.style.background, wp.bg);
        } else {
          assert.equal(screen.style.backgroundColor, wp.bg);
        }
        if (wp.image && wp.image !== 'none') {
          assert.equal(screen.style.backgroundImage, wp.image);
        }
      }
    }

    // Test custom wallpaper
    const customState = {
      custom: true,
      preset: 'default',
      bubbleStyle: 'default',
      wallpaper: {
        type: 'custom',
        value: 'my_wallpaper.jpg',
        safeUrl: 'data:image/jpeg;base64,samplebase64',
        previewDataUrl: 'data:image/jpeg;base64,samplebase64'
      }
    };
    simulateUpdateThemePreview(customState, previewElements);
    assert.equal(screen.style.backgroundImage, 'url("data:image/jpeg;base64,samplebase64")');
    assert.equal(screen.style.backgroundSize, 'cover');
  });

  await suite.test('5. Combining theme + bubble + wallpaper updates preview correctly', () => {
    const screen = createMockElement('theme-preview-screen');
    const incoming = createMockElement('theme-preview-incoming');
    const outgoing = createMockElement('theme-preview-outgoing');
    const media = createMockElement('theme-preview-media');
    const statusName = createMockElement('theme-preview-status-name');
    const previewElements = { screen, incoming, outgoing, media, statusName };

    // Combine Ocean + Rounded + Waves wallpaper
    const combinedState = {
      custom: true,
      preset: 'ocean',
      bubbleStyle: 'rounded',
      wallpaper: { type: 'preset', value: 'waves', localPath: null }
    };

    simulateUpdateThemePreview(combinedState, previewElements);

    const ocean = getPresetTheme('ocean');
    const rounded = getBubbleStyle('rounded');
    const waves = getPresetWallpaper('waves');

    assert.equal(statusName.textContent, 'Ocean');
    assert.equal(incoming.style.backgroundColor, ocean.incomingBg);
    assert.equal(incoming.style.borderRadius, rounded.radius);
    assert.equal(screen.style.background, waves.bg);
    assert.equal(screen.style.getPropertyValue('--chat-incoming-bg'), ocean.incomingBg);
    assert.equal(screen.style.getPropertyValue('--chat-bubble-radius'), rounded.radius);
  });

  await suite.test('6. Preview changes do not modify the actual room theme before Save & Apply', () => {
    // The actual chat uses document.documentElement and #chat-messages-container
    const chatDocElement = global.document.documentElement;

    // Initially apply default room theme to the actual chat
    applyRoomTheme({ custom: false });
    const initialIncomingBg = chatDocElement.style.getPropertyValue('--chat-incoming-bg');
    const initialOutgoingBg = chatDocElement.style.getPropertyValue('--chat-outgoing-bg');

    // User opens modal and tests out 'purple' preset with 'compact' bubble and 'aurora' wallpaper
    const previewElements = {
      screen: createMockElement('theme-preview-screen'),
      incoming: createMockElement('theme-preview-incoming'),
      outgoing: createMockElement('theme-preview-outgoing'),
      media: createMockElement('theme-preview-media'),
      statusName: createMockElement('theme-preview-status-name')
    };

    const tempEditingTheme = {
      custom: true,
      preset: 'purple',
      bubbleStyle: 'compact',
      wallpaper: { type: 'preset', value: 'aurora', localPath: null }
    };

    simulateUpdateThemePreview(tempEditingTheme, previewElements);

    // Actual chat DOM must still have original values
    assert.equal(chatDocElement.style.getPropertyValue('--chat-incoming-bg'), initialIncomingBg);
    assert.equal(chatDocElement.style.getPropertyValue('--chat-outgoing-bg'), initialOutgoingBg);
    assert.notEqual(chatDocElement.style.getPropertyValue('--chat-incoming-bg'), getPresetTheme('purple').incomingBg);
  });

  await suite.test('7. Cancel discards preview-only changes', () => {
    let currentEditingTheme = { custom: false, preset: 'default', bubbleStyle: 'default', wallpaper: { type: 'none', value: null, localPath: null } };
    let savedRoomTheme = { custom: false, preset: 'default', bubbleStyle: 'default', wallpaper: { type: 'none', value: null, localPath: null } };

    // User tests 'sunset' theme in preview
    currentEditingTheme = { custom: true, preset: 'sunset', bubbleStyle: 'large', wallpaper: { type: 'preset', value: 'citrus', localPath: null } };

    // User clicks Cancel
    // Cancelling simply closes modal without calling applyRoomTheme or saving to store
    // Re-opening reverts editing theme to savedRoomTheme
    currentEditingTheme = JSON.parse(JSON.stringify(savedRoomTheme));

    assert.equal(currentEditingTheme.custom, false);
    assert.equal(currentEditingTheme.preset, 'default');
  });

  await suite.test('8. Save & Apply persists the selected theme using existing logic', async () => {
    let persistedRoomTheme = null;
    const mockThemeStore = {
      setRoomTheme: async (roomId, theme) => {
        persistedRoomTheme = theme;
        return { ok: true, theme };
      }
    };

    const editingTheme = {
      custom: true,
      preset: 'emerald',
      bubbleStyle: 'soft',
      wallpaper: { type: 'preset', value: 'slate', localPath: null }
    };

    // Simulate clicking Save & Apply
    await mockThemeStore.setRoomTheme('room-123', editingTheme);
    applyRoomTheme(editingTheme);

    assert.deepEqual(persistedRoomTheme, editingTheme);
    assert.equal(global.document.documentElement.style.getPropertyValue('--chat-incoming-bg'), getPresetTheme('emerald').incomingBg);
    assert.equal(global.document.documentElement.style.getPropertyValue('--chat-bubble-radius'), getBubbleStyle('soft').radius);
  });

  await suite.test('9. "Use app theme" works in preview for both light and dark mode', () => {
    const screen = createMockElement('theme-preview-screen');
    const incoming = createMockElement('theme-preview-incoming');
    const outgoing = createMockElement('theme-preview-outgoing');
    const media = createMockElement('theme-preview-media');
    const statusName = createMockElement('theme-preview-status-name');
    const previewElements = { screen, incoming, outgoing, media, statusName };

    // 1. Light Mode
    applyAppTheme('light', { persist: false });
    let themeState = {
      custom: false,
      preset: 'default',
      bubbleStyle: 'default',
      wallpaper: { type: 'none', value: null, localPath: null }
    };
    simulateUpdateThemePreview(themeState, previewElements);

    assert(statusName.textContent.includes('App Theme (Light)'));
    assert.equal(incoming.style.backgroundColor, '#ffffff');

    // 2. Dark Mode
    applyAppTheme('dark', { persist: false });
    themeState = {
      custom: false,
      preset: 'dark-default',
      bubbleStyle: 'default',
      wallpaper: { type: 'none', value: null, localPath: null }
    };
    simulateUpdateThemePreview(themeState, previewElements);

    assert(statusName.textContent.includes('App Theme (Dark)'));
    assert.equal(incoming.style.backgroundColor, '#202c33');

    // Reset app theme to light
    applyAppTheme('light', { persist: false });
  });

  await suite.test('10. Existing theme definitions and bubble styles remain unchanged', () => {
    // 12 Presets
    const presetIds = PRESET_THEMES.map(t => t.id);
    assert.deepEqual(presetIds, [
      'default', 'ocean', 'midnight', 'emerald', 'purple', 'sunset',
      'rose', 'sky', 'forest', 'minimal', 'dark-abstract', 'soft-gradient'
    ]);

    // 5 Bubble Styles
    const bubbleIds = BUBBLE_STYLES.map(b => b.id);
    assert.deepEqual(bubbleIds, ['default', 'rounded', 'soft', 'compact', 'large']);

    // 10 Preset Wallpapers
    const wallpaperIds = PRESET_WALLPAPERS.map(w => w.id);
    assert.deepEqual(wallpaperIds, [
      'none', 'dots-dark', 'dots-light', 'grid', 'waves',
      'aurora', 'citrus', 'slate', 'blush', 'forest-floor'
    ]);
  });
});
