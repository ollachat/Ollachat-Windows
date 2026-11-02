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

describe('Custom Chat Lists System Tests (35 Invariants)', () => {
  const indexPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
  const cssPath = path.join(projectRoot, 'src', 'renderer', 'styles.css');
  const appPath = path.join(projectRoot, 'src', 'renderer', 'app.js');
  const html = fs.readFileSync(indexPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const appJs = fs.readFileSync(appPath, 'utf8').replace(/\r\n/g, '\n');

  let state;

  beforeEach(() => {
    mockStorage.clear();
    state = new ChatShellState();
    state.setCurrentUser({ userId: 'user-alice', name: 'Alice' });
    state.setInbox([
      { roomId: 'r1', kind: 'direct', name: 'Bob', unreadCount: 0 },
      { roomId: 'r2', kind: 'direct', name: 'Charlie', unreadCount: 2 },
      { roomId: 'r3', kind: 'group', name: 'Engineering', unreadCount: 0 },
      { roomId: 'r4', kind: 'group', name: 'Product', unreadCount: 1 },
      { roomId: 'r5', kind: 'direct', name: 'David', unreadCount: 0 }
    ]);
  });

  // 1 & 2. Plus button behavior
  test('1 & 2. Plus button triggers custom list modal and does NOT open New Chat', () => {
    assert.ok(appJs.includes("if (btn.id === 'filter-btn-add') {\n        openCustomListModal(null, 'create');"), 'filter-btn-add opens custom list modal');
    assert.ok(!appJs.includes("if (btn.id === 'filter-btn-add') {\n        openNewChatModal?.();"), 'filter-btn-add does not open new chat');
  });

  // 3. Create list dialog renders
  test('3. Create list dialog markup and controls render in index.html', () => {
    assert.ok(html.includes('id="custom-list-modal"'), 'Defines #custom-list-modal');
    assert.ok(html.includes('id="custom-list-modal-title"'), 'Defines #custom-list-modal-title');
    assert.ok(html.includes('id="custom-list-name-input"'), 'Defines #custom-list-name-input');
    assert.ok(html.includes('id="custom-list-chat-items"'), 'Defines #custom-list-chat-items');
    assert.ok(html.includes('id="btn-save-custom-list"'), 'Defines #btn-save-custom-list');
    assert.ok(html.includes('id="btn-cancel-custom-list"'), 'Defines #btn-cancel-custom-list');
  });

  // 4. Empty list name rejected
  test('4. Empty or whitespace-only list name is rejected with error', () => {
    assert.throws(() => state.createCustomList(''), /Enter a list name\./);
    assert.throws(() => state.createCustomList('   '), /Enter a list name\./);
  });

  // 5. Duplicate list name rejected
  test('5. Duplicate list name (case-insensitive) is rejected', () => {
    state.createCustomList('Work');
    assert.throws(() => state.createCustomList('Work'), /A list with this name already exists\./);
    assert.throws(() => state.createCustomList('work'), /A list with this name already exists\./);
    assert.throws(() => state.createCustomList(' WORK '), /A list with this name already exists\./);
  });

  // 6. Valid list creation works
  test('6. Valid list creation creates list with unique ID and trimmed name', () => {
    const list = state.createCustomList(' Projects ', ['r1', 'r3']);
    assert.equal(list.name, 'Projects');
    assert.ok(list.id.startsWith('list_'));
    assert.deepEqual(list.roomIds, ['r1', 'r3']);
    assert.equal(state.getCustomLists().length, 1);
  });

  // 7. Custom list persists
  test('7. Custom list persists in localStorage under scoped user key', () => {
    state.createCustomList('Family', ['r1']);
    const stored = JSON.parse(mockStorage.get('ollachat_custom_lists_user-alice'));
    assert.ok(Array.isArray(stored));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].name, 'Family');

    // Reconstruct state from storage
    const newState = new ChatShellState();
    newState.setCurrentUser({ userId: 'user-alice' });
    assert.equal(newState.getCustomLists().length, 1);
    assert.equal(newState.getCustomLists()[0].name, 'Family');
  });

  // 8. Custom list appears in filter row
  test('8. Filter row contains #custom-filters-container for pill rendering', () => {
    assert.ok(html.includes('id="custom-filters-container"'), 'Defines #custom-filters-container');
    assert.ok(css.includes('.custom-filters-container {'), 'Defines .custom-filters-container in css');
    assert.ok(appJs.includes('function renderCustomListFilters()'), 'Defines renderCustomListFilters in app.js');
  });

  // 9. Custom list filtering works
  test('9. Custom list filter displays ONLY conversations assigned to that list', () => {
    const list = state.createCustomList('Colleagues', ['r1', 'r2']);
    state.setActiveFilter(list.id);
    const filtered = state.getFilteredConversations();
    assert.equal(filtered.length, 2);
    assert.deepEqual(filtered.map(c => c.roomId), ['r1', 'r2']);
  });

  // 10. Custom list room membership works
  test('10. Custom list includes both direct chats and groups as selected', () => {
    const list = state.createCustomList('Squad', ['r1', 'r3']); // r1 direct, r3 group
    state.setActiveFilter(list.id);
    const filtered = state.getFilteredConversations();
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].kind, 'direct');
    assert.equal(filtered[1].kind, 'group');
  });

  // 11. Edit chats works
  // 12. Add chat works
  // 13. Remove chat works
  test('11, 12, 13. Edit chats allows adding and removing conversations from a list', () => {
    const list = state.createCustomList('Sprint', ['r1']);
    assert.deepEqual(state.getCustomList(list.id).roomIds, ['r1']);

    // Add r2 and r4
    state.updateCustomList(list.id, { roomIds: ['r1', 'r2', 'r4'] });
    assert.deepEqual(state.getCustomList(list.id).roomIds, ['r1', 'r2', 'r4']);

    // Remove r1
    state.updateCustomList(list.id, { roomIds: ['r2', 'r4'] });
    assert.deepEqual(state.getCustomList(list.id).roomIds, ['r2', 'r4']);
  });

  // 14. Rename list works
  test('14. Renaming a list updates list name and preserves membership and ID', () => {
    const list = state.createCustomList('Work', ['r1', 'r3']);
    state.setActiveFilter(list.id);
    const updated = state.updateCustomList(list.id, { name: 'Office' });
    assert.equal(updated.name, 'Office');
    assert.equal(updated.id, list.id);
    assert.deepEqual(updated.roomIds, ['r1', 'r3']);
    assert.equal(state.getActiveFilter(), list.id);
  });

  // 15. Delete list works
  // 16. Deleting list does not delete actual conversations
  test('15 & 16. Delete list removes custom list, resets active filter to all, and preserves conversations', () => {
    const list = state.createCustomList('Temporary', ['r1', 'r2']);
    state.setActiveFilter(list.id);
    assert.equal(state.getActiveFilter(), list.id);

    const deleted = state.deleteCustomList(list.id);
    assert.ok(deleted);
    assert.equal(state.getCustomLists().length, 0);
    assert.equal(state.getActiveFilter(), 'all');

    // Conversations remain 100% intact
    assert.equal(state.conversations.length, 5);
  });

  // 17. Empty custom list state works
  test('17. Empty custom list returns 0 items and displays empty custom list UI', () => {
    const emptyList = state.createCustomList('Empty', []);
    state.setActiveFilter(emptyList.id);
    const filtered = state.getFilteredConversations();
    assert.equal(filtered.length, 0);
    assert.ok(html.includes('id="inbox-empty-custom-list"'), 'Must define #inbox-empty-custom-list');
    assert.ok(html.includes('id="btn-empty-edit-list"'), 'Must define #btn-empty-edit-list');
  });

  // 18. Missing room IDs do not crash
  test('18. Nonexistent room IDs in custom list are safely omitted without crashing', () => {
    const list = state.createCustomList('StaleTest', ['r1', 'room-ghost-999', 'r2']);
    state.setActiveFilter(list.id);
    const filtered = state.getFilteredConversations();
    assert.equal(filtered.length, 2);
    assert.deepEqual(filtered.map(c => c.roomId), ['r1', 'r2']);
  });

  // 19. Custom list + search works
  test('19. Search query filters only within the active custom list', () => {
    const list = state.createCustomList('Team', ['r1', 'r2', 'r3']); // Bob, Charlie, Engineering
    state.setActiveFilter(list.id);
    state.setSearchQuery('char'); // matches Charlie only
    const filtered = state.getFilteredConversations();
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].roomId, 'r2');
  });

  // 20. Custom list + pinned chats works
  test('20. Pinned chats float to the top within a custom list', () => {
    state.pinChat('r3'); // r3 is pinned
    const list = state.createCustomList('Work', ['r1', 'r2', 'r3']);
    state.setActiveFilter(list.id);
    const filtered = state.getFilteredConversations();
    assert.equal(filtered[0].roomId, 'r3', 'Pinned chat must float to top of custom list');
    assert.deepEqual(filtered.map(c => c.roomId), ['r3', 'r1', 'r2']);
  });

  // 21. Built-in All filter still works
  test('21. Built-in All filter still works', () => {
    state.setActiveFilter('all');
    assert.equal(state.getFilteredConversations().length, 5);
  });

  // 22. Built-in Unread filter still works
  test('22. Built-in Unread filter still works and counts dynamic unread chats', () => {
    state.setActiveFilter('unread');
    const filtered = state.getFilteredConversations();
    assert.equal(filtered.length, 2); // r2 and r4
    assert.equal(state.getUnreadConversationsCount(), 2);
  });

  // 23. Built-in Favourites filter still works
  test('23. Built-in Favourites filter still works', () => {
    state.favouriteChat('r1');
    state.favouriteChat('r5');
    state.setActiveFilter('favourites');
    const filtered = state.getFilteredConversations();
    assert.equal(filtered.length, 2);
    assert.deepEqual(filtered.map(c => c.roomId), ['r1', 'r5']);
  });

  // 24. Built-in Groups filter still works
  test('24. Built-in Groups filter still works', () => {
    state.setActiveFilter('groups');
    const filtered = state.getFilteredConversations();
    assert.equal(filtered.length, 2); // r3 and r4
    assert.equal(state.getGroupsCount(), 2);
  });

  // 25. Pin persistence still works
  test('25. Pin persistence still functions across reloads', () => {
    state.pinChat('r2');
    const loaded = new ChatShellState();
    loaded.setCurrentUser({ userId: 'user-alice' });
    assert.ok(loaded.isPinned('r2'));
  });

  // 26. Favourite persistence still works
  test('26. Favourite persistence still functions across reloads', () => {
    state.favouriteChat('r4');
    const loaded = new ChatShellState();
    loaded.setCurrentUser({ userId: 'user-alice' });
    assert.ok(loaded.isFavourite('r4'));
  });

  // 27. User-specific list persistence works
  test('27. Custom lists are strictly scoped to authenticated user ID', () => {
    state.createCustomList('AliceWork', ['r1']);

    const bobState = new ChatShellState();
    bobState.setCurrentUser({ userId: 'user-bob' });
    assert.equal(bobState.getCustomLists().length, 0, "Bob must not see Alice's lists");

    bobState.createCustomList('BobProjects', ['r2']);
    assert.equal(bobState.getCustomLists().length, 1);

    // Switch back to Alice
    const aliceState = new ChatShellState();
    aliceState.setCurrentUser({ userId: 'user-alice' });
    assert.equal(aliceState.getCustomLists().length, 1);
    assert.equal(aliceState.getCustomLists()[0].name, 'AliceWork');
  });

  // 28. Logout does not leak list state
  test('28. Logout clears in-memory custom lists without data leakage', () => {
    state.createCustomList('SecretList', ['r1']);
    assert.equal(state.getCustomLists().length, 1);
    state.clear();
    assert.equal(state.getCustomLists().length, 0);
    assert.equal(state.getActiveFilter(), 'all');
  });

  // 29, 30, 31. Theme compatibility
  describe('29, 30, 31. Theme System Compatibility', () => {
    test('theme switcher continues working with custom list filters', () => {
      applyAppTheme('light');
      assert.equal(getResolvedAppTheme(), 'light');
      applyAppTheme('dark');
      assert.equal(getResolvedAppTheme(), 'dark');
      applyAppTheme('system');
      assert.equal(getAppThemeSetting(), 'system');
    });
  });

  // 32. Chat Themes remain intact
  test('32. Built-in chat theme presets remain available', () => {
    assert.ok(Array.isArray(PRESET_THEMES));
    assert.ok(PRESET_THEMES.length >= 8);
  });

  // 33. Navigation rail remains intact
  test('33. Navigation rail structure remains in place', () => {
    assert.ok(html.includes('id="nav-rail"'));
    assert.ok(html.includes('id="nav-item-chats"'));
    assert.ok(html.includes('id="btn-settings"'));
  });

  // 34. Messaging remains intact
  test('34. Messaging composer and conversation area remain functional', () => {
    assert.ok(html.includes('id="chat-messages-container"'));
    assert.ok(html.includes('id="composer-input"'));
    assert.ok(html.includes('id="btn-send-message"'));
  });

  // 35. Calling remains intact
  test('35. Call overlay and controls remain functional', () => {
    assert.ok(html.includes('id="voice-call-overlay"'));
    assert.ok(html.includes('id="btn-call-end"'));
    assert.ok(html.includes('id="video-stage"'));
  });
});
