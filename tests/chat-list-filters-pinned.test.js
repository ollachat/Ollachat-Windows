import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatShellState } from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// In-memory mock localStorage for Node.js test environment
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (key) => mockStorage.get(key) || null,
  setItem: (key, val) => mockStorage.set(key, String(val)),
  removeItem: (key) => mockStorage.delete(key),
  clear: () => mockStorage.clear()
};

describe('Chat List Filters & Pinned Chats Architecture', () => {
  let state;

  beforeEach(() => {
    mockStorage.clear();
    state = new ChatShellState();
    state.setCurrentUser({ userId: 'user-alice', name: 'Alice' });
  });

  describe('1. Filter State Management & Default Behavior', () => {
    test('default active filter is "all"', () => {
      assert.equal(state.getActiveFilter(), 'all');
    });

    test('setActiveFilter accepts valid filters (all, unread, favourites, groups)', () => {
      state.setActiveFilter('unread');
      assert.equal(state.getActiveFilter(), 'unread');

      state.setActiveFilter('favourites');
      assert.equal(state.getActiveFilter(), 'favourites');

      state.setActiveFilter('groups');
      assert.equal(state.getActiveFilter(), 'groups');

      state.setActiveFilter('all');
      assert.equal(state.getActiveFilter(), 'all');
    });

    test('setActiveFilter falls back to "all" for invalid filter values', () => {
      state.setActiveFilter('communities'); // Communities should not exist
      assert.equal(state.getActiveFilter(), 'all');

      state.setActiveFilter('unknown-filter');
      assert.equal(state.getActiveFilter(), 'all');

      state.setActiveFilter(null);
      assert.equal(state.getActiveFilter(), 'all');
    });
  });

  describe('2. Pin and Unpin Chat Management', () => {
    test('pins and unpins conversations properly', () => {
      assert.equal(state.isPinned('room-1'), false);

      state.pinChat('room-1');
      assert.equal(state.isPinned('room-1'), true);

      state.unpinChat('room-1');
      assert.equal(state.isPinned('room-1'), false);
    });

    test('togglePinChat toggles pinned state', () => {
      assert.equal(state.togglePinChat('room-1'), true);
      assert.equal(state.isPinned('room-1'), true);

      assert.equal(state.togglePinChat('room-1'), false);
      assert.equal(state.isPinned('room-1'), false);
    });

    test('pins persist to localStorage and reload on user login', () => {
      state.pinChat('room-101');
      state.pinChat('room-102');

      const savedData = mockStorage.get('ollachat_pinned_chats_user-alice');
      assert.ok(savedData, 'Must write pinned state to user-scoped key in localStorage');
      assert.ok(savedData.includes('room-101'));
      assert.ok(savedData.includes('room-102'));

      // New instance loading for the same user restores pins
      const newState = new ChatShellState();
      newState.setCurrentUser({ userId: 'user-alice' });
      assert.equal(newState.isPinned('room-101'), true);
      assert.equal(newState.isPinned('room-102'), true);
      assert.equal(newState.isPinned('room-999'), false);
    });
  });

  describe('3. Favourite and Unfavourite Chat Management', () => {
    test('marks and unmarks conversations as favourites', () => {
      assert.equal(state.isFavourite('room-1'), false);

      state.favouriteChat('room-1');
      assert.equal(state.isFavourite('room-1'), true);

      state.unfavouriteChat('room-1');
      assert.equal(state.isFavourite('room-1'), false);
    });

    test('toggleFavouriteChat toggles favourite state', () => {
      assert.equal(state.toggleFavouriteChat('room-202'), true);
      assert.equal(state.isFavourite('room-202'), true);

      assert.equal(state.toggleFavouriteChat('room-202'), false);
      assert.equal(state.isFavourite('room-202'), false);
    });

    test('favourites persist to localStorage and reload on user login', () => {
      state.favouriteChat('room-fav-1');

      const savedData = mockStorage.get('ollachat_favourite_chats_user-alice');
      assert.ok(savedData, 'Must write favourites state to user-scoped key in localStorage');
      assert.ok(savedData.includes('room-fav-1'));

      const newState = new ChatShellState();
      newState.setCurrentUser({ userId: 'user-alice' });
      assert.equal(newState.isFavourite('room-fav-1'), true);
    });
  });

  describe('4. Dynamic Counters for Filter Pills', () => {
    beforeEach(() => {
      state.setInbox([
        { roomId: 'r1', kind: 'direct', title: 'Bob', unreadCount: 2 },
        { roomId: 'r2', kind: 'direct', title: 'Charlie', unreadCount: 0 },
        { roomId: 'r3', kind: 'group', title: 'Team Alpha', unreadCount: 5 },
        { roomId: 'r4', kind: 'group', title: 'Project Beta', unreadCount: 0 },
        { roomId: 'r5', kind: 'direct', title: 'Dave', unread_count: 1 }
      ]);
    });

    test('getUnreadConversationsCount accurately counts conversations with unread > 0', () => {
      // r1 (2), r3 (5), r5 (1) have unread messages -> 3 conversations
      assert.equal(state.getUnreadConversationsCount(), 3);
    });

    test('getGroupsCount accurately counts group conversations', () => {
      // r3, r4 are groups -> 2 groups
      assert.equal(state.getGroupsCount(), 2);
    });

    test('getFavouritesCount reflects favourite chats in inbox', () => {
      state.favouriteChat('r1');
      state.favouriteChat('r3');
      assert.equal(state.getFavouritesCount(), 2);
    });
  });

  describe('5. getFilteredConversations with Active Filter & Pinned Sorting', () => {
    beforeEach(() => {
      state.setInbox([
        { roomId: 'r1', kind: 'direct', title: 'Bob', unreadCount: 0 },
        { roomId: 'r2', kind: 'direct', title: 'Charlie', unreadCount: 3 },
        { roomId: 'r3', kind: 'group', title: 'Dev Team', unreadCount: 1 },
        { roomId: 'r4', kind: 'group', title: 'General', unreadCount: 0 },
        { roomId: 'r5', kind: 'direct', title: 'Zara', unreadCount: 0 }
      ]);
    });

    test('"all" filter returns all conversations', () => {
      state.setActiveFilter('all');
      const filtered = state.getFilteredConversations();
      assert.equal(filtered.length, 5);
    });

    test('"unread" filter returns only conversations with unread > 0', () => {
      state.setActiveFilter('unread');
      const filtered = state.getFilteredConversations();
      assert.equal(filtered.length, 2);
      assert.deepEqual(filtered.map(c => c.roomId), ['r2', 'r3']);
    });

    test('"favourites" filter returns only favourite conversations', () => {
      state.favouriteChat('r1');
      state.favouriteChat('r4');
      state.setActiveFilter('favourites');
      const filtered = state.getFilteredConversations();
      assert.equal(filtered.length, 2);
      assert.deepEqual(filtered.map(c => c.roomId), ['r1', 'r4']);
    });

    test('"groups" filter returns only group conversations', () => {
      state.setActiveFilter('groups');
      const filtered = state.getFilteredConversations();
      assert.equal(filtered.length, 2);
      assert.deepEqual(filtered.map(c => c.roomId), ['r3', 'r4']);
    });

    test('pinned chats float to the top of the conversation list', () => {
      // Pin r5 (which was originally last in list)
      state.pinChat('r5');
      state.setActiveFilter('all');
      const filtered = state.getFilteredConversations();
      assert.equal(filtered[0].roomId, 'r5', 'Pinned chat must float to top');
      assert.deepEqual(filtered.map(c => c.roomId), ['r5', 'r1', 'r2', 'r3', 'r4']);
    });

    test('pinned chats float to top inside specific filter (e.g. unread or groups)', () => {
      state.pinChat('r4'); // r4 is group
      state.setActiveFilter('groups');
      const filtered = state.getFilteredConversations();
      assert.equal(filtered[0].roomId, 'r4', 'Pinned group must float to top of groups filter');
      assert.deepEqual(filtered.map(c => c.roomId), ['r4', 'r3']);
    });

    test('search query works concurrently with active filter', () => {
      state.setActiveFilter('groups');
      state.setSearchQuery('dev');
      const filtered = state.getFilteredConversations();
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].roomId, 'r3');
    });
  });

  describe('6. DOM Structure & Accessibility in index.html', () => {
    const indexPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
    const html = fs.readFileSync(indexPath, 'utf8');

    test('index.html contains #chat-filter-row with All, Unread, Favourites, Groups, and Add buttons', () => {
      assert.ok(html.includes('id="chat-filter-row"'), 'Must define #chat-filter-row');
      assert.ok(html.includes('id="filter-btn-all"'), 'Must define #filter-btn-all');
      assert.ok(html.includes('id="filter-btn-unread"'), 'Must define #filter-btn-unread');
      assert.ok(html.includes('id="filter-count-unread"'), 'Must define #filter-count-unread');
      assert.ok(html.includes('id="filter-btn-favourites"'), 'Must define #filter-btn-favourites');
      assert.ok(html.includes('id="filter-btn-groups"'), 'Must define #filter-btn-groups');
      assert.ok(html.includes('id="filter-count-groups"'), 'Must define #filter-count-groups');
      assert.ok(html.includes('id="filter-btn-add"'), 'Must define #filter-btn-add');
    });

    test('index.html does NOT contain Communities filter', () => {
      assert.ok(!html.includes('data-filter="communities"'), 'Must not include Communities filter');
      assert.ok(!html.includes('Communities'), 'Must not include Communities text');
    });

    test('index.html defines #conversation-context-menu with Pin, Favourite, and Mark Unread actions', () => {
      assert.ok(html.includes('id="conversation-context-menu"'), 'Must define #conversation-context-menu');
      assert.ok(html.includes('data-action="pin"'), 'Must have pin action');
      assert.ok(html.includes('data-action="favourite"'), 'Must have favourite action');
      assert.ok(html.includes('data-action="toggle-unread"'), 'Must have toggle-unread action');
      assert.ok(html.includes('id="ctx-chat-pin-text"'), 'Must have #ctx-chat-pin-text');
      assert.ok(html.includes('id="ctx-chat-fav-text"'), 'Must have #ctx-chat-fav-text');
      assert.ok(html.includes('id="ctx-chat-unread-text"'), 'Must have #ctx-chat-unread-text');
    });
  });

  describe('7. CSS Styling Rules in styles.css', () => {
    const cssPath = path.join(projectRoot, 'src', 'renderer', 'styles.css');
    const css = fs.readFileSync(cssPath, 'utf8');

    test('styles.css defines .chat-filter-row and .chat-filter-btn', () => {
      assert.ok(css.includes('.chat-filter-row'), 'Must define .chat-filter-row');
      assert.ok(css.includes('.chat-filter-btn'), 'Must define .chat-filter-btn');
      assert.ok(css.includes('.chat-filter-btn.active'), 'Must define .chat-filter-btn.active');
      assert.ok(css.includes('.filter-count'), 'Must define .filter-count');
    });

    test('styles.css defines conversation badge indicators for pinned and favourite chats', () => {
      assert.ok(css.includes('.conversation-badges'), 'Must define .conversation-badges');
      assert.ok(css.includes('.chat-pin-badge'), 'Must define .chat-pin-badge');
      assert.ok(css.includes('.chat-fav-badge'), 'Must define .chat-fav-badge');
    });

    test('styles.css defines .conversation-context-menu', () => {
      assert.ok(css.includes('.conversation-context-menu'), 'Must define .conversation-context-menu');
    });
  });
});
