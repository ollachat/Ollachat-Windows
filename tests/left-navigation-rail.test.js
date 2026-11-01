import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatShellState } from '../src/renderer/chat-shell-state.js';
import {
  applyAppTheme,
  getAppThemeSetting,
  getResolvedAppTheme,
  PRESET_THEMES
} from '../src/renderer/theme-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Mock localStorage for node test runner environment
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (key) => (mockStorage.has(key) ? mockStorage.get(key) : null),
  setItem: (key, val) => mockStorage.set(key, String(val)),
  removeItem: (key) => mockStorage.delete(key),
  clear: () => mockStorage.clear()
};

describe('Left Navigation Rail & Profile Relocation Tests', () => {
  const indexPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
  const cssPath = path.join(projectRoot, 'src', 'renderer', 'styles.css');
  const html = fs.readFileSync(indexPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');

  // ════════════════════════════════════════════════════════════════════
  // 1. Navigation rail renders
  // ════════════════════════════════════════════════════════════════════
  describe('1. Navigation Rail Structure & DOM Placement', () => {
    test('renders #nav-rail inside .chat-shell-body before .chat-sidebar', () => {
      assert.ok(html.includes('<nav class="nav-rail" id="nav-rail"'), 'Must define #nav-rail');
      const railIndex = html.indexOf('id="nav-rail"');
      const sidebarIndex = html.indexOf('class="chat-sidebar"');
      const mainAreaIndex = html.indexOf('class="chat-main-area"');

      assert.ok(railIndex > 0, '#nav-rail must be present');
      assert.ok(sidebarIndex > railIndex, '.chat-sidebar must come after #nav-rail');
      assert.ok(mainAreaIndex > sidebarIndex, '.chat-main-area must come after .chat-sidebar');
    });

    test('nav rail has top section and bottom section', () => {
      assert.ok(html.includes('class="nav-rail-top"'), 'Must contain .nav-rail-top');
      assert.ok(html.includes('class="nav-rail-bottom"'), 'Must contain .nav-rail-bottom');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 2. Chats navigation works
  // ════════════════════════════════════════════════════════════════════
  describe('2. Chats Navigation Item', () => {
    test('#nav-item-chats exists in top rail with active state and SVG icon', () => {
      assert.ok(html.includes('id="nav-item-chats"'), 'Must define #nav-item-chats');
      assert.ok(html.includes('nav-rail-btn active'), 'Chats button starts active');
      assert.ok(html.includes('title="Chats"'), 'Chats button has title="Chats"');
      assert.ok(html.includes('aria-label="Chats"'), 'Chats button has accessible aria-label');
      assert.ok(html.includes('<span class="nav-rail-tooltip">Chats</span>'), 'Has tooltip for Chats');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 3. Settings button works
  // ════════════════════════════════════════════════════════════════════
  describe('3. Settings Navigation Button', () => {
    test('#btn-settings exists in bottom rail with gear icon and tooltip', () => {
      assert.ok(html.includes('id="btn-settings"'), 'Must define #btn-settings');
      assert.ok(html.includes('title="Settings"'), 'Settings button has title');
      assert.ok(html.includes('aria-label="Settings"'), 'Settings button has aria-label');
      assert.ok(html.includes('<span class="nav-rail-tooltip">Settings</span>'), 'Has tooltip for Settings');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 4. Profile button works
  // ════════════════════════════════════════════════════════════════════
  describe('4. Profile Navigation Button & Avatar', () => {
    test('#user-profile-trigger exists in bottom rail with avatar and identifiers', () => {
      assert.ok(html.includes('id="user-profile-trigger"'), 'Must define #user-profile-trigger');
      assert.ok(html.includes('id="current-user-avatar"'), 'Must define #current-user-avatar');
      assert.ok(html.includes('id="current-user-name"'), 'Must define #current-user-name');
      assert.ok(html.includes('id="current-user-phone"'), 'Must define #current-user-phone');
      assert.ok(html.includes('id="rail-profile-tooltip"'), 'Must define #rail-profile-tooltip');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 5. Logout remains accessible
  // ════════════════════════════════════════════════════════════════════
  describe('5. Logout Button Accessibility', () => {
    test('#btn-logout exists in navigation rail and #btn-modal-logout in Settings modal', () => {
      assert.ok(html.includes('id="btn-logout"'), 'Must define #btn-logout in navigation rail');
      assert.ok(html.includes('id="btn-modal-logout"'), 'Must define #btn-modal-logout in modal');
      assert.ok(html.includes('<span class="nav-rail-tooltip">Log Out</span>'), 'Has tooltip for Log Out');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 6. Chat sidebar no longer contains the old profile footer
  // 7. Conversation list gains the freed vertical space
  // ════════════════════════════════════════════════════════════════════
  describe('6 & 7. Chat Sidebar Layout & Vertical Space', () => {
    test('.chat-sidebar does not contain .sidebar-footer', () => {
      const sidebarStart = html.indexOf('<aside class="chat-sidebar">');
      const sidebarEnd = html.indexOf('</aside>');
      const sidebarHtml = html.substring(sidebarStart, sidebarEnd);

      assert.ok(!sidebarHtml.includes('class="sidebar-footer"'), '.chat-sidebar must not contain .sidebar-footer');
      assert.ok(!sidebarHtml.includes('class="user-meta"'), '.chat-sidebar must not contain .user-meta');
    });

    test('#conversation-list-container has flex: 1 to occupy full freed vertical space', () => {
      assert.ok(css.includes('.conversation-list-container {'), 'Defines .conversation-list-container');
      assert.ok(css.includes('flex: 1;'), 'Contains flex: 1 for full height');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 8. Light theme works
  // 9. Dark theme works
  // 10. System theme works
  // ════════════════════════════════════════════════════════════════════
  describe('8, 9, 10. Theme System Integration', () => {
    beforeEach(() => {
      mockStorage.clear();
    });

    test('styles.css defines --bg-rail in light and dark palettes', () => {
      assert.ok(css.includes('--bg-rail: var(--app-surface-secondary);'), 'Light theme defines --bg-rail');
      assert.ok(css.includes('--bg-rail: #0b0f19;'), 'Dark theme defines --bg-rail');
    });

    test('theme-manager supports light, dark, and system', () => {
      applyAppTheme('light');
      assert.equal(getAppThemeSetting(), 'light');
      assert.equal(getResolvedAppTheme(), 'light');

      applyAppTheme('dark');
      assert.equal(getAppThemeSetting(), 'dark');
      assert.equal(getResolvedAppTheme(), 'dark');

      applyAppTheme('system');
      assert.equal(getAppThemeSetting(), 'system');
      const resolved = getResolvedAppTheme();
      assert.ok(['light', 'dark'].includes(resolved), 'Resolved system theme is light or dark');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 11. Chat themes remain unaffected
  // ════════════════════════════════════════════════════════════════════
  describe('11. Chat Themes Isolation', () => {
    test('chat theme presets exist independently from global app theme', () => {
      assert.ok(Array.isArray(PRESET_THEMES), 'PRESET_THEMES is an array');
      assert.ok(PRESET_THEMES.length >= 8, 'Has at least 8 presets');

      // Global theme remains unchanged
      assert.equal(getAppThemeSetting(), 'system');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 12. Filters remain functional
  // 13. Pinned chats remain functional
  // ════════════════════════════════════════════════════════════════════
  describe('12 & 13. Filter Row & Pinned Chats Integrity', () => {
    let state;

    beforeEach(() => {
      mockStorage.clear();
      state = new ChatShellState();
      state.setInbox([
        { roomId: 'r1', kind: 'direct', name: 'Alice', unreadCount: 0 },
        { roomId: 'r2', kind: 'direct', name: 'Bob', unreadCount: 2 },
        { roomId: 'r3', kind: 'group', name: 'Core Team', unreadCount: 0 },
        { roomId: 'r4', kind: 'group', name: 'Support', unreadCount: 1 }
      ]);
    });

    test('filter tabs remain intact in sidebar header', () => {
      assert.ok(html.includes('id="chat-filter-row"'), 'Filter row is in HTML');
      assert.ok(html.includes('id="filter-btn-all"'), 'All tab is present');
      assert.ok(html.includes('id="filter-btn-unread"'), 'Unread tab is present');
      assert.ok(html.includes('id="filter-btn-favourites"'), 'Favourites tab is present');
      assert.ok(html.includes('id="filter-btn-groups"'), 'Groups tab is present');
    });

    test('counts and filter logic work seamlessly with navigation rail', () => {
      assert.equal(state.getUnreadConversationsCount(), 2);
      assert.equal(state.getGroupsCount(), 2);

      state.setActiveFilter('unread');
      assert.equal(state.getFilteredConversations().length, 2);

      state.setActiveFilter('groups');
      assert.equal(state.getFilteredConversations().length, 2);
    });

    test('pinned chats float to top regardless of active filter', () => {
      state.pinChat('r4');
      state.setActiveFilter('all');
      let filtered = state.getFilteredConversations();
      assert.equal(filtered[0].roomId, 'r4', 'Pinned chat floats to top of all');

      state.setActiveFilter('groups');
      filtered = state.getFilteredConversations();
      assert.equal(filtered[0].roomId, 'r4', 'Pinned chat floats to top of groups');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 14 & 15. Messaging & Calling remain functional
  // ════════════════════════════════════════════════════════════════════
  describe('14 & 15. Messaging and Calling Integrity', () => {
    test('calling overlay dialog elements exist outside the chat-shell-body', () => {
      assert.ok(html.includes('id="voice-call-overlay"'), 'Call overlay exists');
      assert.ok(html.includes('id="video-stage"'), 'Video stage exists');
      assert.ok(html.includes('id="remote-video"'), 'Remote video element exists');
      assert.ok(html.includes('id="local-video"'), 'Local video element exists');
      assert.ok(html.includes('id="btn-call-end"'), 'End call button exists');
      assert.ok(html.includes('id="btn-call-mute"'), 'Mute button exists');
      assert.ok(html.includes('id="btn-call-camera"'), 'Camera button exists');
      assert.ok(html.includes('id="btn-call-add-participant"'), 'Add participant button exists');

      // Must be outside .chat-shell-body
      const bodyEnd = html.indexOf('</main>\n      </div>');
      const callOverlay = html.indexOf('id="voice-call-overlay"');
      assert.ok(callOverlay > bodyEnd, 'Call overlay must sit above/outside .chat-shell-body');
    });

    test('messaging composer and message container elements exist in chat-main-area', () => {
      assert.ok(html.includes('id="chat-messages-container"'), 'Messages container exists');
      assert.ok(html.includes('id="chat-composer-container"'), 'Composer container exists');
      assert.ok(html.includes('id="composer-input"'), 'Composer textarea input exists');
      assert.ok(html.includes('id="btn-send-message"'), 'Send message button exists');
    });
  });
});
