/**
 * theme-manager.js
 *
 * OllaChat Chat Theme Engine (renderer-side).
 *
 * Responsibilities:
 *  - Define all 12 preset themes and 5 bubble styles
 *  - Apply CSS variable overrides to #chat-messages-container and .message-bubble
 *  - Load/save per-room preferences via window.ollacoreDesktop.theme IPC bridge
 *  - Never touch message data, call state, or WebSocket behavior
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. PRESET THEME DEFINITIONS
//    Colors only; wallpapers use CSS backgrounds (no external URLs).
// ─────────────────────────────────────────────────────────────────────────────

export const PRESET_THEMES = [
  {
    id: 'default',
    name: 'Default',
    incomingBg: '#ffffff',
    incomingText: '#111b21',
    outgoingBg: '#005c4b',
    outgoingText: '#e9edef',
    chatBg: '#f0f2f5',
    chatBgImage: 'radial-gradient(rgba(0,0,0,0.03) 1px, transparent 0)',
    chatBgSize: '24px 24px',
    composerBg: '#f0f2f5',
    accent: '#00a884',
    secondaryText: '#54656f',
    bubbleBorder: '1px solid rgba(0,0,0,0.08)'
  },
  {
    id: 'ocean',
    name: 'Ocean',
    incomingBg: '#d0eaf8',
    incomingText: '#0a2d3f',
    outgoingBg: '#006994',
    outgoingText: '#e8f4fc',
    chatBg: '#0a2d3f',
    chatBgImage: 'linear-gradient(135deg, rgba(0,105,148,0.15) 25%, transparent 25%), linear-gradient(225deg, rgba(0,105,148,0.15) 25%, transparent 25%), linear-gradient(315deg, rgba(0,105,148,0.15) 25%, transparent 25%), linear-gradient(45deg, rgba(0,105,148,0.15) 25%, transparent 25%)',
    chatBgSize: '30px 30px',
    composerBg: 'rgba(0,41,61,0.9)',
    accent: '#00bcd4',
    secondaryText: '#80cfe6',
    bubbleBorder: 'none'
  },
  {
    id: 'midnight',
    name: 'Midnight',
    incomingBg: '#1e1e2e',
    incomingText: '#cdd6f4',
    outgoingBg: '#313244',
    outgoingText: '#cdd6f4',
    chatBg: '#11111b',
    chatBgImage: 'radial-gradient(rgba(137,180,250,0.05) 1px, transparent 0)',
    chatBgSize: '20px 20px',
    composerBg: '#181825',
    accent: '#89b4fa',
    secondaryText: '#a6adc8',
    bubbleBorder: '1px solid rgba(137,180,250,0.15)'
  },
  {
    id: 'emerald',
    name: 'Emerald',
    incomingBg: '#d1fae5',
    incomingText: '#064e3b',
    outgoingBg: '#059669',
    outgoingText: '#f0fdf4',
    chatBg: '#f0fdf4',
    chatBgImage: 'radial-gradient(rgba(5,150,105,0.06) 1px, transparent 0)',
    chatBgSize: '24px 24px',
    composerBg: '#ecfdf5',
    accent: '#059669',
    secondaryText: '#047857',
    bubbleBorder: '1px solid rgba(5,150,105,0.15)'
  },
  {
    id: 'purple',
    name: 'Purple',
    incomingBg: '#ede9fe',
    incomingText: '#2e1065',
    outgoingBg: '#7c3aed',
    outgoingText: '#f5f3ff',
    chatBg: '#2e1065',
    chatBgImage: 'radial-gradient(rgba(167,139,250,0.12) 1px, transparent 0)',
    chatBgSize: '22px 22px',
    composerBg: 'rgba(46,16,101,0.92)',
    accent: '#a78bfa',
    secondaryText: '#c4b5fd',
    bubbleBorder: 'none'
  },
  {
    id: 'sunset',
    name: 'Sunset',
    incomingBg: '#fff1f2',
    incomingText: '#881337',
    outgoingBg: '#e11d48',
    outgoingText: '#fff1f2',
    chatBg: '#fff7ed',
    chatBgImage: 'linear-gradient(135deg, rgba(251,146,60,0.08) 25%, transparent 25%), linear-gradient(225deg, rgba(251,146,60,0.08) 25%, transparent 25%), linear-gradient(315deg, rgba(251,146,60,0.08) 25%, transparent 25%), linear-gradient(45deg, rgba(251,146,60,0.08) 25%, transparent 25%)',
    chatBgSize: '28px 28px',
    composerBg: '#fff1e6',
    accent: '#f97316',
    secondaryText: '#9a3412',
    bubbleBorder: '1px solid rgba(225,29,72,0.12)'
  },
  {
    id: 'rose',
    name: 'Rose',
    incomingBg: '#fff0f6',
    incomingText: '#630030',
    outgoingBg: '#f43f5e',
    outgoingText: '#fff0f6',
    chatBg: '#fce7f3',
    chatBgImage: 'radial-gradient(rgba(244,63,94,0.08) 1px, transparent 0)',
    chatBgSize: '20px 20px',
    composerBg: '#fce7f3',
    accent: '#f43f5e',
    secondaryText: '#9d174d',
    bubbleBorder: '1px solid rgba(244,63,94,0.15)'
  },
  {
    id: 'sky',
    name: 'Sky',
    incomingBg: '#f0f9ff',
    incomingText: '#0c4a6e',
    outgoingBg: '#0284c7',
    outgoingText: '#f0f9ff',
    chatBg: '#e0f2fe',
    chatBgImage: 'radial-gradient(rgba(2,132,199,0.07) 1px, transparent 0)',
    chatBgSize: '24px 24px',
    composerBg: '#e0f2fe',
    accent: '#0284c7',
    secondaryText: '#0369a1',
    bubbleBorder: '1px solid rgba(2,132,199,0.15)'
  },
  {
    id: 'forest',
    name: 'Forest',
    incomingBg: '#f0fdf4',
    incomingText: '#14532d',
    outgoingBg: '#166534',
    outgoingText: '#dcfce7',
    chatBg: '#052e16',
    chatBgImage: 'linear-gradient(135deg, rgba(21,128,61,0.15) 25%, transparent 25%), linear-gradient(225deg, rgba(21,128,61,0.15) 25%, transparent 25%), linear-gradient(315deg, rgba(21,128,61,0.15) 25%, transparent 25%), linear-gradient(45deg, rgba(21,128,61,0.15) 25%, transparent 25%)',
    chatBgSize: '32px 32px',
    composerBg: 'rgba(5,46,22,0.95)',
    accent: '#22c55e',
    secondaryText: '#86efac',
    bubbleBorder: 'none'
  },
  {
    id: 'minimal',
    name: 'Minimal',
    incomingBg: '#f8f8f8',
    incomingText: '#1a1a1a',
    outgoingBg: '#1a1a1a',
    outgoingText: '#f8f8f8',
    chatBg: '#ffffff',
    chatBgImage: 'none',
    chatBgSize: 'auto',
    composerBg: '#f8f8f8',
    accent: '#1a1a1a',
    secondaryText: '#6b7280',
    bubbleBorder: '1px solid rgba(0,0,0,0.1)'
  },
  {
    id: 'dark-abstract',
    name: 'Dark Abstract',
    incomingBg: '#1c1917',
    incomingText: '#e7e5e4',
    outgoingBg: '#292524',
    outgoingText: '#e7e5e4',
    chatBg: '#0c0a09',
    chatBgImage: 'radial-gradient(ellipse 80px 40px at 50% 50%, rgba(234,179,8,0.06) 0%, transparent 100%), radial-gradient(ellipse 60px 60px at 20% 80%, rgba(239,68,68,0.05) 0%, transparent 100%), radial-gradient(ellipse 80px 50px at 80% 20%, rgba(99,102,241,0.06) 0%, transparent 100%)',
    chatBgSize: 'auto',
    composerBg: '#1c1917',
    accent: '#eab308',
    secondaryText: '#a8a29e',
    bubbleBorder: '1px solid rgba(255,255,255,0.07)'
  },
  {
    id: 'soft-gradient',
    name: 'Soft Gradient',
    incomingBg: '#faf5ff',
    incomingText: '#2d1b69',
    outgoingBg: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    outgoingText: '#ffffff',
    chatBg: '#f3e8ff',
    chatBgImage: 'linear-gradient(180deg, rgba(167,139,250,0.12) 0%, rgba(244,114,182,0.08) 100%)',
    chatBgSize: '100% 100%',
    composerBg: 'rgba(243,232,255,0.95)',
    accent: '#9333ea',
    secondaryText: '#7e22ce',
    bubbleBorder: '1px solid rgba(147,51,234,0.12)'
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. BUBBLE STYLES
// ─────────────────────────────────────────────────────────────────────────────

export const BUBBLE_STYLES = [
  { id: 'default',  name: 'Default', radius: '8px',  padding: '6px 10px 6px 12px', fontSize: '0.9rem' },
  { id: 'rounded',  name: 'Rounded', radius: '18px', padding: '8px 14px',          fontSize: '0.9rem' },
  { id: 'soft',     name: 'Soft',    radius: '12px', padding: '8px 14px',          fontSize: '0.9rem' },
  { id: 'compact',  name: 'Compact', radius: '6px',  padding: '4px 8px',           fontSize: '0.82rem' },
  { id: 'large',    name: 'Large',   radius: '14px', padding: '10px 16px',         fontSize: '1rem' }
];

// ─────────────────────────────────────────────────────────────────────────────
// 3. PRESET WALLPAPERS (CSS backgrounds only — no external URLs)
// ─────────────────────────────────────────────────────────────────────────────

export const PRESET_WALLPAPERS = [
  { id: 'none',          name: 'None',              bg: 'var(--chat-wallpaper-base)', image: 'none' },
  { id: 'dots-dark',     name: 'Dark Dots',         bg: '#0f172a', image: 'radial-gradient(rgba(255,255,255,0.07) 1px, transparent 0)', size: '20px 20px' },
  { id: 'dots-light',    name: 'Light Dots',        bg: '#f8fafc', image: 'radial-gradient(rgba(0,0,0,0.07) 1px, transparent 0)', size: '20px 20px' },
  { id: 'grid',          name: 'Grid',              bg: '#0f172a', image: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)', size: '30px 30px' },
  { id: 'waves',         name: 'Waves',             bg: 'linear-gradient(135deg, #1e293b 0%, #0f172a 50%, #1e293b 100%)', image: 'repeating-linear-gradient(-45deg, transparent, transparent 10px, rgba(99,102,241,0.05) 10px, rgba(99,102,241,0.05) 20px)', size: 'auto' },
  { id: 'aurora',        name: 'Aurora',            bg: 'linear-gradient(135deg, #0f0c29, #302b63, #24243e)', image: 'radial-gradient(ellipse 200px 150px at 30% 40%, rgba(167,139,250,0.2) 0%, transparent 60%), radial-gradient(ellipse 150px 200px at 70% 60%, rgba(244,114,182,0.15) 0%, transparent 60%)', size: 'auto' },
  { id: 'citrus',        name: 'Citrus',            bg: 'linear-gradient(135deg, #fff7ed, #fef3c7)', image: 'radial-gradient(circle at 20% 80%, rgba(251,146,60,0.15) 0%, transparent 50%), radial-gradient(circle at 80% 20%, rgba(234,179,8,0.12) 0%, transparent 50%)', size: 'auto' },
  { id: 'slate',         name: 'Slate',             bg: '#1e293b', image: 'linear-gradient(135deg, rgba(30,41,59,0.8) 25%, rgba(15,23,42,0.8) 25%), linear-gradient(225deg, rgba(30,41,59,0.8) 25%, transparent 25%)', size: '40px 40px' },
  { id: 'blush',         name: 'Blush',             bg: 'linear-gradient(135deg, #fce7f3, #fff1f2)', image: 'radial-gradient(circle at 80% 20%, rgba(244,63,94,0.1) 0%, transparent 50%)', size: 'auto' },
  { id: 'forest-floor',  name: 'Forest Floor',      bg: 'linear-gradient(160deg, #052e16, #14532d)', image: 'radial-gradient(ellipse at 50% 50%, rgba(34,197,94,0.08) 0%, transparent 70%)', size: 'auto' }
];

export const LIGHT_DEFAULT_THEME = Object.freeze({
  id: 'default',
  name: 'Default',
  custom: false,
  incomingBg: '#ffffff',
  incomingText: '#111b21',
  outgoingBg: '#005c4b',
  outgoingText: '#e9edef',
  chatBg: '#f0f2f5',
  chatBgImage: 'radial-gradient(rgba(0,0,0,0.03) 1px, transparent 0)',
  chatBgSize: '24px 24px',
  composerBg: '#f0f2f5',
  accent: '#00a884',
  secondaryText: '#54656f',
  bubbleBorder: '1px solid rgba(0,0,0,0.08)'
});

export const DARK_DEFAULT_THEME = Object.freeze({
  id: 'dark-default',
  name: 'Dark Default',
  custom: false,
  incomingBg: '#202c33',
  incomingText: '#e9edef',
  outgoingBg: '#005c4b',
  outgoingText: '#e9edef',
  chatBg: '#0b141a',
  chatBgImage: 'radial-gradient(rgba(255,255,255,0.04) 1px, transparent 0)',
  chatBgSize: '24px 24px',
  composerBg: '#202c33',
  accent: '#00a884',
  secondaryText: '#8696a0',
  bubbleBorder: '1px solid rgba(255,255,255,0.05)'
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GLOBAL APP THEME ENGINE
// ─────────────────────────────────────────────────────────────────────────────

let currentAppThemeSetting = 'system'; // 'light' | 'dark' | 'system'

/** Returns the stored setting ('light' | 'dark' | 'system'). */
export function getAppThemeSetting() {
  return currentAppThemeSetting;
}

/** Resolves 'system' against prefers-color-scheme, returning 'light' or 'dark'. */
export function getResolvedAppTheme() {
  if (currentAppThemeSetting === 'light') return 'light';
  if (currentAppThemeSetting === 'dark') return 'dark';
  // 'system'
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

/**
 * Applies the global app theme to the DOM and optionally persists it.
 * @param {'light' | 'dark' | 'system'} themeSetting
 * @param {object} options - { persist: boolean }
 * @returns {'light' | 'dark'} The resolved applied theme
 */
export function applyAppTheme(themeSetting, options = {}) {
  const valid = ['light', 'dark', 'system'].includes(themeSetting) ? themeSetting : 'system';
  currentAppThemeSetting = valid;

  const resolved = getResolvedAppTheme();
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-app-theme', resolved);
    document.documentElement.setAttribute('data-app-theme-preference', valid);
  }

  if (options.persist !== false) {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('ollachat_app_theme', valid);
      } catch {}
    }
    if (typeof window !== 'undefined' && window.ollacoreDesktop?.theme?.setAppTheme) {
      window.ollacoreDesktop.theme.setAppTheme(valid).catch(err => {
        console.error('[Theme] Failed to persist app theme setting:', err);
      });
    }
  }

  return resolved;
}

/**
 * Listens for OS color scheme changes and updates the app if in 'system' mode.
 * @param {function} onResolvedChange - callback(resolvedTheme)
 * @returns {function} unregister function
 */
export function initSystemThemeListener(onResolvedChange) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }

  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const listener = (e) => {
    if (currentAppThemeSetting === 'system') {
      const newResolved = e.matches ? 'dark' : 'light';
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.setAttribute('data-app-theme', newResolved);
      }
      if (typeof onResolvedChange === 'function') {
        onResolvedChange(newResolved);
      }
    }
  };

  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  } else if (typeof mql.addListener === 'function') {
    mql.addListener(listener);
    return () => mql.removeListener(listener);
  }
  return () => {};
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

export function getPresetTheme(id) {
  if (id === 'dark-default') return DARK_DEFAULT_THEME;
  if (!Array.isArray(PRESET_THEMES) || PRESET_THEMES.length === 0) {
    return { id: 'default', name: 'Default', incomingBg: '#ffffff', incomingText: '#111b21', outgoingBg: '#005c4b', outgoingText: '#e9edef', chatBg: '#f0f2f5', composerBg: '#f0f2f5', accent: '#00a884', secondaryText: '#54656f', bubbleBorder: '1px solid rgba(0,0,0,0.08)' };
  }
  return PRESET_THEMES.find(t => t && t.id === id) || PRESET_THEMES[0];
}

export function getBubbleStyle(id) {
  if (!Array.isArray(BUBBLE_STYLES) || BUBBLE_STYLES.length === 0) {
    return { id: 'default', name: 'Default', radius: '8px', padding: '6px 10px 6px 12px', fontSize: '0.9rem' };
  }
  return BUBBLE_STYLES.find(b => b && b.id === id) || BUBBLE_STYLES[0];
}

export function getPresetWallpaper(id) {
  if (!Array.isArray(PRESET_WALLPAPERS) || PRESET_WALLPAPERS.length === 0) {
    return { id: 'none', name: 'None', bg: '#f0f2f5', image: 'none' };
  }
  return PRESET_WALLPAPERS.find(w => w && w.id === id) || PRESET_WALLPAPERS[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. CHAT THEME APPLICATION & FALLBACK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculates the effective theme for a room:
 * - If room has a custom theme, returns the custom theme.
 * - Otherwise returns the fallback theme derived from the global App Theme.
 * Never copies global theme into room storage.
 * @param {string} roomId
 * @returns {Promise<object>} The effective theme object
 */
export async function getEffectiveChatTheme(roomId) {
  const resolved = getResolvedAppTheme();
  const defaultThemeObj = resolved === 'dark' ? DARK_DEFAULT_THEME : LIGHT_DEFAULT_THEME;
  const fallback = {
    custom: false,
    preset: defaultThemeObj.id,
    bubbleStyle: 'default',
    wallpaper: { type: 'none', value: null, localPath: null },
    ...defaultThemeObj
  };

  if (!roomId || typeof roomId !== 'string') {
    return fallback;
  }

  try {
    const desktopTheme = (typeof window !== 'undefined' && window.ollacoreDesktop?.theme)
      ? window.ollacoreDesktop.theme
      : null;
    let res = null;
    if (desktopTheme && typeof desktopTheme.getRoomTheme === 'function') {
      res = await desktopTheme.getRoomTheme(roomId);
    }
    const theme = (res && res.ok && res.theme) ? res.theme : null;
    if (theme && theme.custom !== false) {
      return {
        ...theme,
        custom: true
      };
    }
    return fallback;
  } catch (err) {
    return fallback;
  }
}

/**
 * Applies a full room theme to the chat DOM.
 * @param {object} roomTheme - { preset, bubbleStyle, wallpaper, custom }
 */
export function applyRoomTheme(roomTheme) {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  const container = document.getElementById('chat-messages-container');
  const composerContainer = document.getElementById('chat-composer-container');

  if (!el) return;

  const isExplicitCustom = roomTheme?.custom === true || (
    roomTheme?.custom !== false &&
    roomTheme?.preset &&
    roomTheme?.preset !== 'default' &&
    roomTheme?.preset !== 'dark-default'
  );

  let theme;
  let bubble;
  let wallpaper;

  if (isExplicitCustom) {
    theme = getPresetTheme(roomTheme?.preset || 'default');
    bubble = getBubbleStyle(roomTheme?.bubbleStyle || 'default');
    wallpaper = roomTheme?.wallpaper || { type: 'none', value: null, localPath: null };
  } else {
    // Falls back to theme derived from global App Theme
    const resolved = getResolvedAppTheme();
    theme = resolved === 'dark' ? DARK_DEFAULT_THEME : LIGHT_DEFAULT_THEME;
    bubble = getBubbleStyle('default');
    wallpaper = { type: 'none', value: null, localPath: null };
  }

  // ── Bubble colors ──
  el.style.setProperty('--chat-incoming-bg', theme.incomingBg);
  el.style.setProperty('--chat-incoming-text', theme.incomingText);
  el.style.setProperty('--chat-outgoing-bg', theme.outgoingBg);
  el.style.setProperty('--chat-outgoing-text', theme.outgoingText);
  el.style.setProperty('--chat-secondary-text', theme.secondaryText);
  el.style.setProperty('--chat-incoming-border', theme.bubbleBorder);

  // ── Bubble shape ──
  el.style.setProperty('--chat-bubble-radius', bubble.radius);
  el.style.setProperty('--chat-bubble-padding', bubble.padding);
  el.style.setProperty('--chat-bubble-font-size', bubble.fontSize);

  // ── Composer ──
  el.style.setProperty('--chat-composer-bg', theme.composerBg);

  // ── Wallpaper ──
  if (container) {
    if (wallpaper.type === 'custom' && wallpaper.localPath) {
      const safePath = wallpaper.safeUrl || null;
      if (safePath) {
        container.style.setProperty('background-image', `url("${safePath}")`);
        container.style.setProperty('background-color', theme.chatBg);
        container.style.setProperty('background-size', 'cover');
        container.style.setProperty('background-position', 'center');
        container.style.setProperty('background-repeat', 'no-repeat');
      } else {
        _applyPresetBackground(container, theme);
      }
    } else if (wallpaper.type === 'preset' && wallpaper.value) {
      const wp = getPresetWallpaper(wallpaper.value);
      _applyWallpaperPreset(container, wp);
    } else {
      _applyPresetBackground(container, theme);
    }
  }

  if (composerContainer) {
    composerContainer.style.setProperty('background-color', theme.composerBg);
  }
}

function _applyPresetBackground(container, theme) {
  container.style.removeProperty('background-image');
  container.style.removeProperty('background-size');
  container.style.removeProperty('background-position');
  container.style.removeProperty('background-repeat');
  container.style.setProperty('background-color', theme.chatBg);
  if (theme.chatBgImage && theme.chatBgImage !== 'none') {
    container.style.setProperty('background-image', theme.chatBgImage);
    container.style.setProperty('background-size', theme.chatBgSize || '24px 24px');
    container.style.setProperty('background-repeat', 'repeat');
    container.style.removeProperty('background-position');
  }
}

function _applyWallpaperPreset(container, wp) {
  if (!wp) return;
  container.style.removeProperty('background-image');
  container.style.removeProperty('background-size');
  container.style.removeProperty('background-position');
  container.style.removeProperty('background-repeat');

  if (wp.bg && wp.bg.includes('gradient')) {
    container.style.setProperty('background', wp.bg);
  } else {
    container.style.setProperty('background-color', wp.bg || '#f0f2f5');
  }

  if (wp.image && wp.image !== 'none') {
    container.style.setProperty('background-image', wp.image);
    container.style.setProperty('background-size', wp.size || '24px 24px');
    container.style.setProperty('background-repeat', 'repeat');
  }
}

/**
 * Applies a custom wallpaper data URL to the chat container.
 * Called after a data URL has been fetched from the main process.
 */
export function applyCustomWallpaperDataUrl(dataUrl) {
  if (typeof document === 'undefined') return;
  const container = document.getElementById('chat-messages-container');
  if (!container) return;
  container.style.setProperty('background-image', `url("${dataUrl}")`);
  container.style.setProperty('background-color', '#000000');
  container.style.setProperty('background-size', 'cover');
  container.style.setProperty('background-position', 'center');
  container.style.setProperty('background-repeat', 'no-repeat');
}

/**
 * Resets the chat container to the default theme derived from global app theme.
 */
export function resetThemeToDefault() {
  const resolved = getResolvedAppTheme();
  const theme = resolved === 'dark' ? DARK_DEFAULT_THEME : LIGHT_DEFAULT_THEME;
  applyRoomTheme({ custom: false, preset: theme.id, bubbleStyle: 'default', wallpaper: { type: 'none', value: null, localPath: null } });
}

/**
 * Loads the effective theme preference for a room and applies it.
 * Falls back safely to app theme default if IPC fails, if no custom theme is saved, or on any error.
 * Guaranteed never to reject or throw.
 * @param {string} roomId
 * @returns {Promise<object>} The applied room theme object
 */
export async function loadAndApplyThemeForRoom(roomId) {
  try {
    const effectiveTheme = await getEffectiveChatTheme(roomId);

    if (effectiveTheme.wallpaper?.type === 'custom' && effectiveTheme.wallpaper.localPath) {
      const desktopTheme = (typeof window !== 'undefined' && window.ollacoreDesktop?.theme) ? window.ollacoreDesktop.theme : null;
      if (desktopTheme && typeof desktopTheme.loadWallpaperData === 'function') {
        try {
          const loadRes = await desktopTheme.loadWallpaperData(effectiveTheme.wallpaper.localPath);
          if (loadRes && loadRes.ok && loadRes.dataUrl) {
            effectiveTheme.wallpaper.safeUrl = loadRes.dataUrl;
          }
        } catch (wpErr) {
          console.error('[Theme] Failed to load wallpaper data url:', wpErr);
        }
      }
    }

    applyRoomTheme(effectiveTheme);
    return effectiveTheme;
  } catch (err) {
    console.error('[Theme] Failed to load and apply room theme:', err);
    try {
      resetThemeToDefault();
    } catch {}
    const resolved = getResolvedAppTheme();
    const fallbackObj = resolved === 'dark' ? DARK_DEFAULT_THEME : LIGHT_DEFAULT_THEME;
    return { custom: false, preset: fallbackObj.id, bubbleStyle: 'default', wallpaper: { type: 'none', value: null, localPath: null } };
  }
}
